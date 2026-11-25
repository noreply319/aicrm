import { NextResponse } from "next/server";
import { summarizeAndSaveNote } from "@/lib/noteOps";
import { AiError } from "@/lib/openai";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "미팅 노트를 찾을 수 없습니다" }, { status: 404 });

/**
 * 저장된 노트를 AI로 요약해 summary·next_actions에 저장한다 → 저장된 MeetingNote.
 * 미팅(녹음) 완료 후 자동 요약에 쓴다. 서버가 저장까지 하므로 사용자가 작성 화면을 닫아도 요약이 남는다.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  try {
    const r = await summarizeAndSaveNote(id);
    return r.ok ? NextResponse.json(r.note) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
