import { NextResponse } from "next/server";
import { AiError, createLiveTranscribeSecret } from "@/lib/openai";

export const dynamic = "force-dynamic";

/** 실시간 자막용 임시 키 발급: → { value, expiresAt(ms) }. 응답은 캐시하지 않는다. */
export async function POST() {
  try {
    const secret = await createLiveTranscribeSecret();
    return NextResponse.json(secret, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
