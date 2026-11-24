"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { extractClip, splitAudioFile } from "@/lib/audioFile";
import { AUDIO_MAX_BYTES, RECORD_MAX_SEC, RECORD_SEGMENT_SEC, RECORD_WARN_SEC } from "@/lib/constants";
import { Alert, Button, Input, buttonClass } from "./ui";

/**
 * 미팅 녹음
 *  - 본문: 5분 구간마다 화자 구분 전사(gpt-4o-transcribe-diarize)한 텍스트를 "화자 1: …" 형식으로 이어 붙임
 *    구간마다 따로 전사해도 같은 사람이 같은 이름을 갖도록, 처음 나온 화자의 2~8초 음성을 참조로 다음 구간에 보낸다
 *  - 화면 잠금·앱 전환으로 마이크가 끊기면 돌아왔을 때 자동으로 이어서 녹음
 *  - 잠금 중에도 녹음해야 하면 휴대폰 녹음 앱 파일을 업로드해 구간 전사
 */

type SegStatus = "recording" | "queued" | "working" | "done" | "error";

interface Segment {
  index: number;
  startSec: number;
  endSec: number;
  status: SegStatus;
  /** 라벨 앞에 붙일 출처 (파일 업로드면 "파일") */
  prefix?: string;
  blob?: Blob;
  error?: string;
}

type Phase = "idle" | "recording" | "paused" | "interrupted" | "stopping";

export interface RecorderStatus {
  /** 녹음 중(일시정지·중단 포함) 또는 파일 변환 중 */
  recording: boolean;
  /** 전사 대기·진행 중인 구간 수 */
  pending: number;
  /** 전사 실패 구간 수 */
  failed: number;
}

interface Props {
  disabled?: boolean;
  /** 구간 전사가 끝날 때마다 호출 (label 예: "05:00~10:00") */
  onTranscript: (label: string, text: string) => void;
  onStatus: (s: RecorderStatus) => void;
  /** 화자 이름을 바꾸면 본문의 "이전 이름:"도 바꾸도록 알린다 */
  onRenameSpeaker?: (from: string, to: string) => void;
}

/** 화자 구분 전사 응답 */
interface TranscribeResult {
  text: string;
  utterances: { speaker: string; start: number; end: number; text: string }[] | null;
}

// 참조 음성을 함께 보낼 수 있는 화자 수 (OpenAI 제한)
const MAX_KNOWN_SPEAKERS = 4;

// 저비트레이트 음성 녹음 (5분 ≈ 1.2MB)
const AUDIO_BPS = 32_000;
// 브라우저가 비트레이트를 무시해 구간이 커지면 업로드 한도 전에 구간을 넘긴다
// (화자 참조 음성 최대 ≈1MB와 함께 Vercel 요청 한도 4.5MB 안에 들어가도록 3MB)
const ROTATE_BYTES = Math.min(3_000_000, AUDIO_MAX_BYTES);
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
// 화면이 이 시간 이상 가려졌는데 녹음 데이터가 늘지 않았으면 끊긴 것으로 본다
const HIDDEN_CHECK_MS = 3000;

const pickMime = () =>
  MIME_CANDIDATES.find((m) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(m)) ?? "";

const extOf = (mime: string) =>
  mime.includes("wav") ? "wav" : mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";

const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const labelOf = (s: Segment) => `${s.prefix ? `${s.prefix} ` : ""}${mmss(s.startSec)}~${mmss(s.endSec)}`;

const micError = (e: unknown) => {
  const name = e instanceof DOMException ? e.name : "";
  return name === "NotAllowedError"
    ? "마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용하거나, 직접 입력/붙여넣기를 사용하세요."
    : name === "NotFoundError"
      ? "사용할 수 있는 마이크가 없습니다."
      : "마이크를 사용할 수 없습니다. (HTTPS 또는 localhost에서만 녹음할 수 있습니다)";
};

export default function MeetingRecorder({ disabled, onTranscript, onStatus, onRenameSpeaker }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [mode, setMode] = useState<"mic" | "file">("mic");
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [warned, setWarned] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);

  const phaseRef = useRef<Phase>("idle");
  const elapsedRef = useRef(0);
  const lastTickRef = useRef(0);
  const segsRef = useRef<Segment[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const segBytesRef = useRef(0);
  const totalBytesRef = useRef(0);
  const mimeRef = useRef("");
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const hiddenRef = useRef<{ at: number; bytes: number; elapsed: number } | null>(null);
  const queueBusyRef = useRef(false);
  const mountedRef = useRef(true);
  // 확인된 화자 (참조 음성이 있는 화자만 다음 구간에 보낸다)
  const speakersRef = useRef<{ name: string; ref: Blob | null }[]>([]);
  const speakerSeqRef = useRef(0);
  const [speakers, setSpeakers] = useState<string[]>([]);

  // 콜백은 최신 값을 ref로 참조 (녹음 중 부모가 리렌더돼도 MediaRecorder 핸들러 재생성 없이)
  const onTranscriptRef = useRef(onTranscript);
  const onStatusRef = useRef(onStatus);
  const onRenameRef = useRef(onRenameSpeaker);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onStatusRef.current = onStatus;
    onRenameRef.current = onRenameSpeaker;
  });

  /**
   * 화자 구분 결과 → "화자 1: …" 줄. 처음 보는 화자(A, B…)에는 다음 번호를 붙이고,
   * 그 화자의 가장 긴 발화에서 참조 음성을 잘라 다음 구간부터 같은 이름으로 인식되게 한다.
   */
  const formatSpeakers = async (r: TranscribeResult, blob: Blob): Promise<string> => {
    const utts = r.utterances;
    if (!utts || utts.length === 0) return r.text;
    const known = new Set(speakersRef.current.map((s) => s.name));
    const rename = new Map<string, string>();
    for (const u of utts) {
      if (!known.has(u.speaker) && !rename.has(u.speaker)) rename.set(u.speaker, `화자 ${++speakerSeqRef.current}`);
    }
    const named = utts.map((u) => ({ ...u, speaker: rename.get(u.speaker) ?? u.speaker }));

    for (const name of rename.values()) {
      let ref: Blob | null = null;
      if (speakersRef.current.filter((s) => s.ref).length < MAX_KNOWN_SPEAKERS) {
        const best = named
          .filter((u) => u.speaker === name)
          .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
        ref = best ? await extractClip(blob, best.start, best.end) : null;
      }
      speakersRef.current = [...speakersRef.current, { name, ref }];
    }
    if (rename.size && mountedRef.current) setSpeakers(speakersRef.current.map((s) => s.name));

    // 같은 화자의 연속 발화는 한 줄로
    const lines: { speaker: string; text: string }[] = [];
    for (const u of named) {
      const last = lines.at(-1);
      if (last && last.speaker === u.speaker) last.text += ` ${u.text}`;
      else lines.push({ speaker: u.speaker, text: u.text });
    }
    return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
  };

  /** 화자 이름 바꾸기: 다음 구간부터 새 이름으로 인식되고, 본문의 기존 이름도 바뀐다 */
  const renameSpeaker = (from: string, raw: string) => {
    const to = raw.trim().replace(/[:\n]/g, "").slice(0, 30);
    if (!to || to === from || speakersRef.current.some((s) => s.name === to)) {
      setSpeakers(speakersRef.current.map((s) => s.name)); // 입력값 되돌리기
      return;
    }
    speakersRef.current = speakersRef.current.map((s) => (s.name === from ? { ...s, name: to } : s));
    setSpeakers(speakersRef.current.map((s) => s.name));
    onRenameRef.current?.(from, to);
  };

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    if (mountedRef.current) setPhase(p);
  };

  const updateSeg = useCallback((index: number, patch: Partial<Segment>) => {
    segsRef.current = segsRef.current.map((s) => (s.index === index ? { ...s, ...patch } : s));
    if (mountedRef.current) setSegments(segsRef.current);
  }, []);

  const pushSeg = (seg: Omit<Segment, "index">) => {
    const s = { ...seg, index: segsRef.current.length };
    segsRef.current = [...segsRef.current, s];
    setSegments(segsRef.current);
    return s;
  };

  // 부모에게 상태 알림
  useEffect(() => {
    onStatusRef.current({
      recording: phase !== "idle" || fileBusy,
      pending: segments.filter((s) => s.status === "queued" || s.status === "working").length,
      failed: segments.filter((s) => s.status === "error").length,
    });
  }, [phase, segments, fileBusy]);

  /** 대기 중인 구간을 순서대로 하나씩 전사 */
  const processQueue = useCallback(async () => {
    if (queueBusyRef.current) return;
    queueBusyRef.current = true;
    try {
      for (;;) {
        const seg = segsRef.current.find((s) => s.status === "queued");
        if (!seg || !seg.blob) break;
        updateSeg(seg.index, { status: "working", error: undefined });
        try {
          if (seg.blob.size > AUDIO_MAX_BYTES) throw new Error("녹음 구간이 너무 큽니다");
          const form = new FormData();
          form.append("audio", seg.blob, `segment-${seg.index + 1}.${extOf(seg.blob.type)}`);
          for (const sp of speakersRef.current) {
            if (!sp.ref) continue;
            form.append("speakerName", sp.name);
            form.append("speakerRef", sp.ref, "speaker.wav");
          }
          const result = await api<TranscribeResult>("/api/meetings/transcribe", { method: "POST", body: form });
          if (!mountedRef.current) return;
          const text = await formatSpeakers(result, seg.blob);
          // 전사가 끝난 구간의 음성은 메모리에서 버린다
          updateSeg(seg.index, { status: "done", blob: undefined });
          if (text) onTranscriptRef.current(labelOf(seg), text);
        } catch (e) {
          updateSeg(seg.index, {
            status: "error",
            error: (e as Error).message || "음성을 텍스트로 변환하지 못했습니다",
          });
        }
      }
    } finally {
      queueBusyRef.current = false;
    }
  }, [updateSeg]);

  const releaseWakeLock = () => {
    wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  };

  const requestWakeLock = async () => {
    try {
      if ("wakeLock" in navigator && !wakeRef.current) {
        wakeRef.current = await navigator.wakeLock.request("screen");
        wakeRef.current.addEventListener("release", () => (wakeRef.current = null));
      }
    } catch {
      // 지원하지 않거나 거부되면 안내 문구로 대체
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const cleanup = () => {
    clearInterval(tickRef.current);
    stopTracks();
    recRef.current = null;
    hiddenRef.current = null;
    releaseWakeLock();
  };

  /** 새 구간 녹음 시작. 구간마다 MediaRecorder를 새로 만들어 각 구간이 독립된 파일이 되게 한다. */
  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = mimeRef.current;
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: AUDIO_BPS });
    const parts: Blob[] = [];
    const seg = pushSeg({ startSec: elapsedRef.current, endSec: elapsedRef.current, status: "recording" });
    segBytesRef.current = 0;

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        parts.push(e.data);
        segBytesRef.current += e.data.size;
        totalBytesRef.current += e.data.size;
      }
    };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
      const end = elapsedRef.current;
      // 1초 미만 빈 구간은 버린다
      updateSeg(
        seg.index,
        blob.size > 0 && end > seg.startSec ? { status: "queued", blob, endSec: end } : { status: "done", endSec: end }
      );
      const p = phaseRef.current;
      const alive = stream.getAudioTracks().some((t) => t.readyState === "live");
      if ((p === "recording" || p === "paused") && !alive) {
        // 마이크가 끊겨 녹음기가 스스로 멈춘 경우 (화면 잠금 등) → 중단 처리 후 복귀 시 자동 재개
        interrupt();
      } else if (p === "recording" || p === "paused") {
        startSegment(); // 구간 교체
      } else if (p === "stopping") {
        cleanup();
        setPhaseBoth("idle");
      }
      // "interrupted"는 recover()가 이어서 처리
      processQueue();
    };
    rec.onerror = () => {
      if (phaseRef.current === "recording" || phaseRef.current === "paused") interrupt();
    };
    // 1초마다 데이터를 받아 구간 크기를 추적한다
    try {
      rec.start(1000);
    } catch {
      updateSeg(seg.index, { status: "done" });
      interrupt();
      return;
    }
    recRef.current = rec;
    // interrupt는 ref만 사용하는 함수 선언이라 의존성에 넣지 않는다
  }, [processQueue, updateSeg]);

  /** 마이크를 연다 */
  const openMic = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    // 다른 앱이 마이크를 가져가거나 기기가 분리되면 끊김 처리
    if (track) track.onended = () => {
      if (phaseRef.current === "recording" || phaseRef.current === "paused") interrupt();
    };
    return stream;
  };

  const stop = useCallback(() => {
    const p = phaseRef.current;
    if (p === "idle" || p === "stopping") return;
    setPhaseBoth("stopping");
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else {
      cleanup();
      setPhaseBoth("idle");
    }
  }, []);

  const tick = useCallback(() => {
    const now = Date.now();
    const delta = (now - lastTickRef.current) / 1000;
    lastTickRef.current = now;
    if (phaseRef.current !== "recording") return;
    // 백그라운드에서 타이머가 느려져도 실제 경과 시간으로 계산
    elapsedRef.current += delta;
    setElapsed(elapsedRef.current);
    const seg = segsRef.current.at(-1);
    if (elapsedRef.current >= RECORD_MAX_SEC) {
      stop();
    } else if (
      seg?.status === "recording" &&
      (elapsedRef.current - seg.startSec >= RECORD_SEGMENT_SEC || segBytesRef.current >= ROTATE_BYTES)
    ) {
      // 구간 교체: onstop에서 다음 구간을 시작한다
      recRef.current?.stop();
    }
    if (elapsedRef.current >= RECORD_WARN_SEC) setWarned(true);
  }, [stop]);

  /** 마이크가 끊김: 지금까지 녹음된 구간을 전사 대기열에 넣고 재개를 기다린다 */
  function interrupt() {
    if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
    setPhaseBoth("interrupted");
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recRef.current = null;
    stopTracks();
  }

  /** 끊긴 녹음 이어가기. 브라우저가 사용자 동작을 요구하면 '녹음 재개' 버튼으로 다시 호출된다. */
  const recover = async (gapSec?: number) => {
    if (phaseRef.current !== "interrupted") return;
    if (gapSec && gapSec >= 1) {
      setNotices((n) => [
        ...n,
        `${mmss(elapsedRef.current)} 지점에서 화면 잠금·앱 전환으로 약 ${mmss(gapSec)} 동안 녹음되지 않았습니다.`,
      ]);
    }
    try {
      await openMic();
      setPhaseBoth("recording");
      lastTickRef.current = Date.now();
      startSegment();
      requestWakeLock();
      setError(null);
    } catch {
      setError("녹음을 자동으로 이어가지 못했습니다. '녹음 재개'를 눌러 주세요.");
    }
  };

  const start = async () => {
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("이 브라우저는 녹음을 지원하지 않습니다. 직접 입력/붙여넣기 또는 파일 업로드를 사용하세요.");
      return;
    }
    try {
      await openMic();
    } catch (e) {
      setError(micError(e));
      return;
    }
    mimeRef.current = pickMime();
    elapsedRef.current = 0;
    totalBytesRef.current = 0;
    lastTickRef.current = Date.now();
    setElapsed(0);
    setWarned(false);
    setNotices([]);
    setMode("mic");
    speakersRef.current = [];
    speakerSeqRef.current = 0;
    setSpeakers([]);
    segsRef.current = [];
    setSegments([]);
    setPhaseBoth("recording");
    startSegment();
    tickRef.current = setInterval(tick, 1000);
    requestWakeLock();
  };

  const pause = () => {
    if (recRef.current?.state === "recording") recRef.current.pause();
    setPhaseBoth("paused");
  };

  const resume = () => {
    if (recRef.current?.state === "paused") recRef.current.resume();
    lastTickRef.current = Date.now();
    setPhaseBoth("recording");
  };

  const retry = (index: number) => {
    updateSeg(index, { status: "queued", error: undefined });
    processQueue();
  };

  /** 휴대폰 녹음 앱 등으로 녹음한 파일 업로드 → 구간으로 나눠 전사 */
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setFileBusy(true);
    try {
      const chunks = await splitAudioFile(file);
      speakersRef.current = [];
      speakerSeqRef.current = 0;
      setSpeakers([]);
      segsRef.current = [];
      setSegments([]);
      setMode("file");
      for (const c of chunks) pushSeg({ startSec: c.startSec, endSec: c.endSec, status: "queued", blob: c.blob, prefix: "파일" });
      processQueue();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFileBusy(false);
    }
  };

  // 화면 잠금·앱 전환 감지: 돌아왔을 때 녹음이 실제로 이어졌는지 확인하고, 끊겼으면 자동 복구
  useEffect(() => {
    const onVisibility = () => {
      const p = phaseRef.current;
      if (document.visibilityState === "hidden") {
        if (p === "recording") {
          hiddenRef.current = { at: Date.now(), bytes: totalBytesRef.current, elapsed: elapsedRef.current };
        }
        return;
      }
      // visible
      if (p === "idle" || p === "stopping") return;
      requestWakeLock();
      const hidden = hiddenRef.current;
      hiddenRef.current = null;
      const track = streamRef.current?.getAudioTracks()[0];
      const away = hidden ? Date.now() - hidden.at : 0;
      const noData = hidden !== null && away >= HIDDEN_CHECK_MS && totalBytesRef.current === hidden.bytes;
      const broken = !track || track.readyState === "ended" || track.muted || noData;

      if ((p === "recording" && broken) || p === "interrupted") {
        // 가려져 있던 동안은 녹음되지 않았으므로 녹음 시간에서 뺀다
        if (hidden) {
          elapsedRef.current = hidden.elapsed;
          // 가려진 동안 끝난 구간의 끝 시각도 맞춘다 (구간 라벨이 겹치지 않게)
          for (const sg of segsRef.current) {
            if (sg.endSec > hidden.elapsed) updateSeg(sg.index, { endSec: Math.max(sg.startSec, hidden.elapsed) });
          }
        }
        if (p === "recording") interrupt();
        recover(hidden ? away / 1000 : undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // 핸들러 안에서는 ref와 안정 함수만 사용
  }, []);

  // 모달이 닫히면 마이크를 끈다
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      phaseRef.current = "idle";
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") {
        rec.onstop = null;
        rec.stop();
      }
      cleanup();
    };
  }, []);

  const active = phase !== "idle";
  const pending = segments.filter((s) => s.status === "queued" || s.status === "working").length;
  const failed = segments.filter((s) => s.status === "error");
  const totalSlots =
    mode === "file" ? segments.length : Math.max(segments.length, Math.ceil(RECORD_MAX_SEC / RECORD_SEGMENT_SEC));

  return (
    <div className="recorder">
      <Alert tone="warning">
        녹음 전에 참석자에게 녹음 사실을 알리세요. 음성은 텍스트 변환을 위해 OpenAI로 전송되며 원본은 저장되지 않습니다.
      </Alert>

      <div className={`rec-box${phase === "recording" ? " live" : ""}`}>
        <span className="rec-dot" aria-hidden />
        <span className="rec-state">
          {phase === "recording"
            ? "녹음 중"
            : phase === "paused"
              ? "일시정지"
              : phase === "interrupted"
                ? "녹음 중단됨"
                : phase === "stopping"
                  ? "마무리 중…"
                  : fileBusy
                    ? "파일 변환 중…"
                    : "녹음 대기"}
        </span>
        <span className="rec-time">{mmss(elapsed)}</span>
        <span className="rec-max">/ {mmss(RECORD_MAX_SEC)}</span>
        <div className="rec-actions">
          {!active && (
            <Button variant="primary" onClick={start} disabled={disabled || pending > 0 || fileBusy}>
              ● 녹음 시작
            </Button>
          )}
          {phase === "recording" && (
            <Button onClick={pause}>❚❚ 일시정지</Button>
          )}
          {phase === "paused" && (
            <Button onClick={resume}>▶ 재개</Button>
          )}
          {phase === "interrupted" && (
            <Button onClick={() => recover()}>▶ 녹음 재개</Button>
          )}
          {(phase === "recording" || phase === "paused" || phase === "interrupted") && (
            <Button variant="primary" onClick={stop}>■ 녹음 종료</Button>
          )}
        </div>
      </div>

      {active && (
        <div className="rec-hint">
          {warned ? "⏰ 녹음 가능 시간이 5분 남았습니다. 60분이 되면 자동으로 종료됩니다. " : ""}
          화면을 켜 둔 채로 녹음하세요. 화면이 잠기거나 다른 앱으로 전환하면 녹음이 멈추고, 돌아오면 자동으로 이어집니다.
        </div>
      )}

      {notices.map((n, i) => (
        <Alert key={i} tone="neutral" plain>⏸ {n}</Alert>
      ))}

      {/* 잠금 화면에서도 녹음해야 할 때: 휴대폰 녹음 앱 파일 업로드 */}
      {!active && (
        <div className="rec-file">
          <label className={buttonClass({ size: "sm", disabled: disabled || pending > 0 || fileBusy })}>
            📁 녹음 파일 업로드
            <input
              type="file"
              accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg"
              hidden
              disabled={disabled || pending > 0 || fileBusy}
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <span className="muted">
            화면이 잠긴 상태에서도 녹음해야 하면 휴대폰 녹음 앱(음성 메모 등)으로 녹음한 뒤 파일을 올려 주세요. 최대 90분.
          </span>
        </div>
      )}

      {segments.length > 0 && (
        <>
          <div className="rec-progress-label">
            {mode === "file" ? "파일 전사 진행" : `구간 전사 진행 (${RECORD_SEGMENT_SEC / 60}분 구간)`}
            {` · 완료 ${segments.filter((s) => s.status === "done").length}/${segments.length}`}
          </div>
          <div className="chunks" role="list">
            {Array.from({ length: totalSlots }, (_, i) => {
              const s = segments[i];
              return (
                <div
                  key={i}
                  role="listitem"
                  className={`chunk${s ? ` chunk-${s.status}` : ""}`}
                  title={s ? `${i + 1}구간 ${labelOf(s)}` : undefined}
                >
                  {s?.status === "done" ? "✓" : s?.status === "error" ? "✕" : ""}
                </div>
              );
            })}
          </div>
        </>
      )}

      {speakers.length > 0 && (
        <div className="speakers">
          <span className="muted">화자 이름 (바꾸면 본문과 다음 구간에 반영)</span>
          <div className="speaker-list">
            {speakers.map((name) => (
              <Input
                key={name}
                className="speaker-input"
                defaultValue={name}
                maxLength={30}
                aria-label={`${name} 이름`}
                onBlur={(e) => renameSpeaker(name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      {failed.map((s) => (
        <Alert
          key={s.index}
          tone="danger"
          plain
          action={<Button size="sm" icon="refresh" onClick={() => retry(s.index)} disabled={!s.blob}>다시 시도</Button>}
        >
          {s.index + 1}구간({labelOf(s)}) 전사 실패: {s.error}
        </Alert>
      ))}

      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
