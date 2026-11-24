"use client";

/**
 * 녹음 파일 업로드용: 휴대폰 음성 메모 등으로 녹음한 파일을 브라우저에서 디코딩해
 * 약 1분 30초 단위 16kHz 모노 WAV로 나눈다. (구간 1개 ≈ 3MB, 화자 참조 음성과 함께 업로드 한도 이하)
 * 잠금 화면에서도 녹음이 필요할 때 쓰는 대안 경로다.
 */

// 16kHz를 지원하지 않는 브라우저는 22.05kHz로 디코딩하고 구간을 짧게 나눈다
const RATES = [16_000, 22_050];
// WAV 구간 최대 크기: 화자 참조 음성(최대 4개 ≈ 1MB)과 함께 Vercel 요청 한도(4.5MB) 안에 들어가도록
const CHUNK_MAX_BYTES = 3_000_000;
/** 디코딩 메모리 부담 때문에 길이 제한 (16kHz 모노 기준 90분 ≈ 350MB) */
export const FILE_MAX_SEC = 90 * 60;

export interface AudioChunk {
  blob: Blob;
  startSec: number;
  endSec: number;
}

export function wav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** 오디오 파일 → 업로드 가능한 크기의 WAV 구간 목록 */
export async function splitAudioFile(file: File): Promise<AudioChunk[]> {
  // 낮은 샘플레이트 컨텍스트로 디코딩하면 브라우저가 리샘플링까지 해 준다
  let ctx: OfflineAudioContext | null = null;
  for (const r of RATES) {
    try {
      ctx = new OfflineAudioContext(1, 1, r);
      break;
    } catch {}
  }
  if (!ctx) throw new Error("이 브라우저는 파일 변환을 지원하지 않습니다.");
  const rate = ctx.sampleRate;

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("이 파일 형식은 읽을 수 없습니다. m4a, mp3, wav, webm 파일을 사용하세요.");
  }
  if (decoded.duration > FILE_MAX_SEC) {
    throw new Error(`파일이 너무 깁니다. ${FILE_MAX_SEC / 60}분 이하로 나눠서 올려 주세요.`);
  }

  // 모노로 합치기 (이미 모노면 복사하지 않는다)
  const len = decoded.length;
  const chs = decoded.numberOfChannels;
  let mono: Float32Array;
  if (chs === 1) {
    mono = decoded.getChannelData(0);
  } else {
    mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / chs;
    }
  }

  const per = Math.floor((CHUNK_MAX_BYTES - 44) / 2);
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < len; i += per) {
    const part = mono.subarray(i, Math.min(len, i + per));
    chunks.push({ blob: wav(part, rate), startSec: i / rate, endSec: (i + part.length) / rate });
  }
  return chunks;
}

// 화자 참조 음성 길이 (OpenAI 허용 2~10초)
const CLIP_MIN_SEC = 2;
const CLIP_MAX_SEC = 8;

/**
 * 녹음 구간에서 [start, end] 부분을 16kHz WAV로 잘라낸다 (화자 참조 음성용).
 * 2초보다 짧거나 디코딩할 수 없으면 null.
 */
export async function extractClip(blob: Blob, start: number, end: number): Promise<Blob | null> {
  if (end - start < CLIP_MIN_SEC) return null;
  try {
    let ctx: OfflineAudioContext | null = null;
    for (const r of RATES) {
      try {
        ctx = new OfflineAudioContext(1, 1, r);
        break;
      } catch {}
    }
    if (!ctx) return null;
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = decoded.sampleRate;
    const from = Math.max(0, Math.floor(start * rate));
    const to = Math.min(decoded.length, Math.floor(Math.min(end, start + CLIP_MAX_SEC) * rate));
    if ((to - from) / rate < CLIP_MIN_SEC) return null;
    const mono = new Float32Array(to - from);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c).subarray(from, to);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    return wav(mono, rate);
  } catch {
    return null;
  }
}
