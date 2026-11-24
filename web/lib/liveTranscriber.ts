"use client";

import { api } from "./api";

/**
 * 실시간 자막 (OpenAI Realtime 전사, gpt-live-transcribe)
 *  - 서버(/api/meetings/realtime-token)가 발급한 임시 키로 브라우저가 WebSocket에 직접 연결
 *  - 마이크 → AudioWorklet(24kHz PCM16) → input_audio_buffer.append
 *  - 서버 VAD를 쓰지 않으므로 무음이 이어지거나 너무 길어지면 클라이언트가 직접 commit
 *  - 연결이 끊기면(세션 시간 한도·네트워크) 새 키로 자동 재연결
 * 실시간 자막은 미리보기다. 본문에는 5분 구간 전사(gpt-transcribe) 결과가 들어간다.
 */

const WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const WORKLET_URL = "/worklets/pcm24k-worklet.js";

// 무음 감지: 말소리 뒤 이 시간 동안 조용하면 한 줄로 확정
const SPEECH_RMS = 0.015;
const SILENCE_COMMIT_MS = 800;
// 계속 말하는 중이어도 이 시간이 지나면 확정 (자막 줄이 너무 길어지지 않게)
const MAX_UTTERANCE_MS = 15_000;
const MAX_RECONNECTS = 5;

export type LiveState = "connecting" | "live" | "reconnecting" | "unavailable" | "stopped";

export interface LiveLine {
  id: string;
  text: string;
  final: boolean;
}

interface Handlers {
  /** 자막 줄 목록이 바뀔 때 (완료된 줄 + 작성 중인 줄) */
  onLines: (lines: LiveLine[]) => void;
  /** 한 줄이 확정될 때 */
  onFinal: (text: string) => void;
  onState: (state: LiveState, message?: string) => void;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class LiveTranscriber {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private lines: LiveLine[] = [];
  private paused = false;
  private stopped = false;
  private reconnects = 0;
  private hasSpeech = false;
  private uncommitted = false;
  private lastVoiceAt = 0;
  private utteranceStart = 0;

  constructor(private readonly handlers: Handlers) {}

  /** 마이크 스트림을 받아 시작. 오디오 처리 준비는 사용자 클릭 안에서 호출해야 한다 (iOS). */
  async start(stream: MediaStream) {
    this.stopped = false;
    await this.attach(stream);
    await this.connect();
  }

  /** 마이크 스트림 교체 (잠금 화면 등으로 끊긴 뒤 다시 연결할 때) */
  async attach(stream: MediaStream) {
    this.detachAudio();
    if (!this.ctx) {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm24k");
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => this.onAudio(e.data);
    this.source.connect(this.node);
  }

  /** 오디오 처리가 멈췄는지 (iOS 잠금 후 돌아오면 suspended/interrupted가 됨) */
  get audioRunning() {
    return this.ctx?.state === "running";
  }

  async resumeAudio() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    return this.audioRunning;
  }

  pause() {
    this.paused = true;
    this.commit();
  }

  resume() {
    this.paused = false;
    if (!this.ws && !this.stopped) this.connect();
  }

  /** 마지막 줄을 확정하고 잠시 후 연결 종료 */
  async stop() {
    this.stopped = true;
    this.commit();
    this.detachAudio();
    await new Promise((r) => setTimeout(r, 1500)); // 마지막 확정 결과 대기
    this.ws?.close();
    this.ws = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.handlers.onState("stopped");
  }

  private detachAudio() {
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.source = null;
    this.node = null;
  }

  private async connect() {
    if (this.stopped) return;
    this.handlers.onState(this.reconnects ? "reconnecting" : "connecting");
    let token: { value: string };
    try {
      token = await api<{ value: string; expiresAt: number }>("/api/meetings/realtime-token", { method: "POST" });
    } catch (e) {
      this.handlers.onState("unavailable", (e as Error).message);
      return;
    }
    if (this.stopped) return;

    // 브라우저 WebSocket은 헤더를 못 붙이므로 서브프로토콜로 임시 키를 전달한다
    const ws = new WebSocket(WS_URL, ["realtime", `openai-insecure-api-key.${token.value}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnects = 0;
      this.handlers.onState("live");
    };
    ws.onmessage = (m: MessageEvent<string>) => this.onEvent(m.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.hasSpeech = false;
      this.uncommitted = false;
      if (this.stopped) return;
      if (this.reconnects >= MAX_RECONNECTS) {
        this.handlers.onState("unavailable", "실시간 자막 연결이 끊겼습니다. 녹음과 구간 전사는 계속됩니다.");
        return;
      }
      this.reconnects++;
      setTimeout(() => this.connect(), 1000 * this.reconnects);
    };
  }

  private onAudio({ pcm, rms }: { pcm: ArrayBuffer; rms: number }) {
    const ws = this.ws;
    if (this.paused || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }));
    this.uncommitted = true;

    const now = performance.now();
    if (rms >= SPEECH_RMS) {
      if (!this.hasSpeech) this.utteranceStart = now;
      this.hasSpeech = true;
      this.lastVoiceAt = now;
    }
    if (
      this.hasSpeech &&
      (now - this.lastVoiceAt >= SILENCE_COMMIT_MS || now - this.utteranceStart >= MAX_UTTERANCE_MS)
    ) {
      this.commit();
    }
  }

  private commit() {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.uncommitted && this.hasSpeech) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else if (ws && ws.readyState === WebSocket.OPEN && this.uncommitted) {
      // 말소리 없이 쌓인 오디오는 버린다 (불필요한 전사 비용 방지)
      ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    }
    this.hasSpeech = false;
    this.uncommitted = false;
  }

  private line(id: string): LiveLine {
    let l = this.lines.find((x) => x.id === id);
    if (!l) {
      l = { id, text: "", final: false };
      this.lines = [...this.lines, l];
    }
    return l;
  }

  private onEvent(raw: string) {
    let e: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    switch (e.type) {
      case "conversation.item.input_audio_transcription.delta": {
        if (!e.item_id || !e.delta) return;
        const l = this.line(e.item_id);
        this.lines = this.lines.map((x) => (x === l ? { ...x, text: x.text + e.delta } : x));
        this.handlers.onLines(this.lines);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (!e.item_id) return;
        this.line(e.item_id);
        const text = (e.transcript ?? "").trim();
        this.lines = this.lines
          .map((x) => (x.id === e.item_id ? { ...x, text, final: true } : x))
          .filter((x) => !x.final || x.text);
        this.handlers.onLines(this.lines);
        if (text) this.handlers.onFinal(text);
        return;
      }
      case "error":
        // 빈 버퍼 commit 등 사소한 오류는 무시하고 기록만 남긴다
        console.warn("[live] error", e.error?.message);
        return;
    }
  }
}
