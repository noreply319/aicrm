import { NextResponse } from "next/server";
import { featureState, getSessionUser } from "@/lib/auth";
import { leadEmailsBody, resolveLeadTarget } from "@/lib/emailStore";
import { notConnectedError, googleErrorResponse, unauthorized } from "@/lib/google";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 저장된 리드 메일 (Gmail 호출 없음 → 바로 표시). 새 메일은 POST ./sync, 요약은 POST ./summarize.
 * 리드 이메일 주소(회사 도메인이면 같은 도메인 전체)와 주고받은 메일, 로그인 사용자 본인 것만.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const state = featureState(user, "gmail");
  // 연동 만료 상태여도 저장된 메일은 보여준다
  if (state === "none") return googleErrorResponse(notConnectedError("gmail", false));
  const { id } = await params;
  const r = await resolveLeadTarget(id, user.email);
  if (!r.ok) return r.response;
  return NextResponse.json(await leadEmailsBody(user.id, id, r.target));
}
