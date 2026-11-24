import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { leadEmailsBody, resolveLeadTarget, summarizePending } from "@/lib/emailStore";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import { AiError } from "@/lib/openai";

export const dynamic = "force-dynamic";
// 메일 본문 읽기 + OpenAI 요약 (10건씩 묶어 호출)
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** 아직 요약하지 않은 메일 요약 (최신순 최대 20건): { retryFailed? } → 저장된 전체 목록 */
export async function POST(req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body: unknown = await req.json().catch(() => ({}));
  const retryFailed = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).retryFailed === true);
  const { id } = await params;
  const r = await resolveLeadTarget(id, user.email);
  if (!r.ok) return r.response;

  try {
    await summarizePending(user, { leadId: id, retryFailed });
    return NextResponse.json(await leadEmailsBody(user.id, id, r.target));
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    return googleErrorResponse(e);
  }
}
