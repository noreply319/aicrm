"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { AUDIO_MAX_BYTES, RECORD_MAX_SEC, RECORD_SEGMENT_SEC, RECORD_WARN_SEC } from "@/lib/constants";

type SegStatus = "recording" | "queued" | "working" | "done" | "error";

interface Segment {
  index: number;
  startSec: number;
  endSec: number;
  status: SegStatus;
  blob?: Blob;
  error?: string;
}

type Phase = "idle" | "recording" | "paused" | "stopping";

export interface RecorderStatus {
  /** 녹음 중(일시정지 포함) */
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
}

// 저비트레이트 음성 녹음 (5분 ≈ 1.2MB)
const AUDIO_BPS = 32_000;
// 브라우저가 비트레이트를 무시해 구간이 커지면 업로드 한도 전에 구간을 넘긴다
const ROTATE_BYTES = AUDIO_MAX_BYTES * 0.85;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

const pickMime = () =>
  MIME_CANDIDATES.find((m) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(m)) ?? "";

const extOf = (mime: string) => (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");

const mmss = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const labelOf = (s: Segment) => `${mmss(s.startSec)}~${mmss(s.endSec)}`;

export default function MeetingRecorder({ disabled, onTranscript, onStatus }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);

  const phaseRef = useRef<Phase>("idle");
  const elapsedRef = useRef(0);
  const segsRef = useRef<Segment[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const segBytesRef = useRef(0);
  const mimeRef = useRef("");
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const queueBusyRef = useRef(false);
  const mountedRef = useRef(true);

  // 콜백은 최신 값을 ref로 참조 (녹음 중 부모가 리렌더돼도 MediaRecorder 핸들러 재생성 없이)
  const onTranscriptRef = useRef(onTranscript);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onStatusRef.current = onStatus;
  });

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const updateSeg = useCallback((index: number, patch: Partial<Segment>) => {
    segsRef.current = segsRef.current.map((s) => (s.index === index ? { ...s, ...patch } : s));
    if (mountedRef.current) setSegments(segsRef.current);
  }, []);

  // 부모에게 상태 알림
  useEffect(() => {
    onStatusRef.current({
      recording: phase !== "idle",
      pending: segments.filter((s) => s.status === "queued" || s.status === "working").length,
      failed: segments.filter((s) => s.status === "error").length,
    });
  }, [phase, segments]);

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
          const { text } = await api<{ text: string }>("/api/meetings/transcribe", { method: "POST", body: form });
          if (!mountedRef.current) return;
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

  const cleanup = () => {
    clearInterval(tickRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    releaseWakeLock();
  };

  /** 새 구간 녹음 시작. 구간마다 MediaRecorder를 새로 만들어 각 구간이 독립된 파일이 되게 한다. */
  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = mimeRef.current;
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: AUDIO_BPS });
    const parts: Blob[] = [];
    const seg: Segment = {
      index: segsRef.current.length,
      startSec: elapsedRef.current,
      endSec: elapsedRef.current,
      status: "recording",
    };
    segsRef.current = [...segsRef.current, seg];
    setSegments(segsRef.current);
    segBytesRef.current = 0;

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        parts.push(e.data);
        segBytesRef.current += e.data.size;
      }
    };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
      const end = elapsedRef.current;
      // 1초 미만 빈 구간은 버린다
      updateSeg(seg.index, blob.size > 0 && end > seg.startSec ? { status: "queued", blob, endSec: end } : { status: "done", endSec: end });
      if (phaseRef.current === "recording" || phaseRef.current === "paused") {
        startSegment(); // 구간 교체
      } else {
        cleanup();
        if (mountedRef.current) setPhaseBoth("idle");
      }
      processQueue();
    };
    rec.onerror = () => {
      setError("녹음 중 오류가 발생했습니다. 지금까지 녹음된 부분은 전사됩니다.");
      phaseRef.current = "stopping";
      if (rec.state !== "inactive") rec.stop();
    };
    // 1초마다 데이터를 받아 구간 크기를 추적한다
    rec.start(1000);
    recRef.current = rec;
  }, [processQueue, updateSeg]);

  const stop = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "stopping") return;
    setPhaseBoth("stopping");
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else {
      cleanup();
      setPhaseBoth("idle");
    }
  }, []);

  const tick = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    elapsedRef.current += 1;
    setElapsed(elapsedRef.current);
    const seg = segsRef.current.at(-1);
    if (elapsedRef.current >= RECORD_MAX_SEC) {
      stop();
    } else if (
      seg &&
      (elapsedRef.current - seg.startSec >= RECORD_SEGMENT_SEC || segBytesRef.current >= ROTATE_BYTES)
    ) {
      // 구간 교체: onstop에서 다음 구간을 시작한다
      recRef.current?.stop();
    }
    if (elapsedRef.current === RECORD_WARN_SEC) setWarned(true);
  }, [stop]);

  const start = async () => {
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("이 브라우저는 녹음을 지원하지 않습니다. 직접 입력/붙여넣기를 사용하세요.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용하거나, 직접 입력/붙여넣기를 사용하세요."
          : name === "NotFoundError"
            ? "사용할 수 있는 마이크가 없습니다."
            : "마이크를 사용할 수 없습니다. (HTTPS 또는 localhost에서만 녹음할 수 있습니다)"
      );
      return;
    }
    mimeRef.current = pickMime();
    elapsedRef.current = 0;
    setElapsed(0);
    setWarned(false);
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
    setPhaseBoth("recording");
  };

  const retry = (index: number) => {
    updateSeg(index, { status: "queued", error: undefined });
    processQueue();
  };

  // 화면이 다시 보이면 화면 꺼짐 방지를 다시 요청 (탭 전환 시 자동 해제됨)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && phaseRef.current !== "idle") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
  const totalSlots = Math.max(segments.length, Math.ceil(RECORD_MAX_SEC / RECORD_SEGMENT_SEC));

  return (
    <div className="recorder">
      <div className="notice">
        ⚠ 녹음 전에 참석자에게 녹음 사실을 알리세요. 음성은 텍스트 변환을 위해 OpenAI로 전송되며 원본은 저장되지 않습니다.
      </div>

      <div className={`rec-box${phase === "recording" ? " live" : ""}`}>
        <span className="rec-dot" aria-hidden />
        <span className="rec-state">
          {phase === "recording" ? "녹음 중" : phase === "paused" ? "일시정지" : phase === "stopping" ? "마무리 중…" : "녹음 대기"}
        </span>
        <span className="rec-time">{mmss(elapsed)}</span>
        <span className="rec-max">/ {mmss(RECORD_MAX_SEC)}</span>
        <div className="rec-actions">
          {!active && (
            <button type="button" className="btn btn-primary" onClick={start} disabled={disabled || pending > 0}>
              ● 녹음 시작
            </button>
          )}
          {phase === "recording" && (
            <button type="button" className="btn" onClick={pause}>❚❚ 일시정지</button>
          )}
          {phase === "paused" && (
            <button type="button" className="btn" onClick={resume}>▶ 재개</button>
          )}
          {(phase === "recording" || phase === "paused") && (
            <button type="button" className="btn btn-primary" onClick={stop}>■ 녹음 종료</button>
          )}
        </div>
      </div>

      {active && (
        <div className="rec-hint">
          {warned ? "⏰ 녹음 가능 시간이 5분 남았습니다. 60분이 되면 자동으로 종료됩니다. " : ""}
          화면을 켜 둔 채로 녹음하세요. 화면이 꺼지거나 다른 앱으로 전환하면 녹음이 끊길 수 있습니다.
        </div>
      )}

      {segments.length > 0 && (
        <>
          <div className="rec-progress-label">
            전사 진행 ({RECORD_SEGMENT_SEC / 60}분 구간)
            {pending > 0 && ` · 전사 중 ${segments.filter((s) => s.status === "done").length}/${segments.length}`}
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

      {failed.map((s) => (
        <div key={s.index} className="rec-error" role="alert">
          <span>
            {s.index + 1}구간({labelOf(s)}) 전사 실패: {s.error}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => retry(s.index)} disabled={!s.blob}>
            ↻ 다시 시도
          </button>
        </div>
      ))}

      {error && <div className="rec-error" role="alert"><span>⚠ {error}</span></div>}
    </div>
  );
}
