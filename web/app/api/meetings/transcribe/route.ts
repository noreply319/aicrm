import { NextResponse } from "next/server";
import { AUDIO_MAX_BYTES } from "@/lib/constants";
import { AiError, transcribeAudio } from "@/lib/openai";

export const dynamic = "force-dynamic";
// 5분 구간 전사 대기 시간 (Vercel 함수 실행 시간)
export const maxDuration = 60;

/** 녹음 구간 1개(multipart "audio") → { text }. 원본 음성은 저장하지 않는다. */
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

  try {
    const text = await transcribeAudio(audio);
    return NextResponse.json({ text });
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
