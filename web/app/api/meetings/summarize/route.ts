import { NextResponse } from "next/server";
import { summarizeNote } from "@/lib/meetings";
import { AiError } from "@/lib/openai";
import { parseSummarizeInput } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AI 요약: { title, body } → { summary, nextActions }
 * 저장 전(작성 중) 노트에도 쓸 수 있도록 결과만 반환하고, 저장은 노트 저장 API가 한다. (조회 전용)
 */
export async function POST(req: Request) {
  const parsed = parseSummarizeInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    return NextResponse.json(await summarizeNote(parsed.data.title, parsed.data.body));
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
