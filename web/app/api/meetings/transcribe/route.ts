import { NextResponse } from "next/server";
import { AUDIO_MAX_BYTES } from "@/lib/constants";
import { AiError, MAX_KNOWN_SPEAKERS, transcribeAudio, type KnownSpeaker } from "@/lib/openai";

export const dynamic = "force-dynamic";
// 2분 구간 전사 대기 시간 (Vercel 함수 실행 시간)
export const maxDuration = 60;

// 화자 참조 음성 1개 최대 크기 (16kHz WAV 10초 ≈ 320KB)
const REF_MAX_BYTES = 400 * 1024;
// 요청 전체 한도 (Vercel 요청 본문 4.5MB보다 작게)
const TOTAL_MAX_BYTES = 4.4 * 1024 * 1024;

/**
 * 녹음 구간 1개 전사 (multipart)
 *  - audio: 음성 파일
 *  - speakerName / speakerRef (선택, 여러 개): 이미 확인된 화자 이름과 2~10초 참조 음성
 * → { text, utterances: [{ speaker, start, end, text }] | null }. 원본 음성은 저장하지 않는다.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "녹음 파일이 없습니다" }, { status: 400 });
  }
  if (audio.size > AUDIO_MAX_BYTES) {
    return NextResponse.json({ error: "녹음 구간이 너무 큽니다" }, { status: 413 });
  }
  if (audio.type && !/^(audio|video)\//.test(audio.type)) {
    return NextResponse.json({ error: "지원하지 않는 파일 형식입니다" }, { status: 415 });
  }

  const names = form!.getAll("speakerName");
  const refs = form!.getAll("speakerRef");
  if (names.length !== refs.length || names.length > MAX_KNOWN_SPEAKERS) {
    return NextResponse.json({ error: "화자 정보가 올바르지 않습니다" }, { status: 400 });
  }
  const speakers: KnownSpeaker[] = [];
  let total = audio.size;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const ref = refs[i];
    if (typeof name !== "string" || !name.trim() || name.length > 30 || !(ref instanceof File) || ref.size > REF_MAX_BYTES) {
      return NextResponse.json({ error: "화자 정보가 올바르지 않습니다" }, { status: 400 });
    }
    total += ref.size;
    speakers.push({ name: name.trim(), ref });
  }
  if (total > TOTAL_MAX_BYTES) {
    return NextResponse.json({ error: "녹음 구간이 너무 큽니다" }, { status: 413 });
  }

  try {
    return NextResponse.json(await transcribeAudio(audio, speakers));
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
