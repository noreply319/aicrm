import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { AiError } from "@/lib/openai";
import { extractAndAutoRegister } from "@/lib/schedules";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 저장된 미팅 노트에서 다음 미팅을 찾는다.
 * 날짜·시간이 확정된 일정은 확인 없이 로그인 사용자의 구글 캘린더에 바로 등록하고,
 * 시간 미정이거나 캘린더를 쓸 수 없으면 "확인 필요" 후보로 남긴다. → { registered, candidates, calendarError? }
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "미팅 노트를 찾을 수 없습니다" }, { status: 404 });
  try {
    return NextResponse.json(await extractAndAutoRegister(id, await getSessionUser()));
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
