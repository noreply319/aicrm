import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { leadEmailsBody, resolveLeadTarget, syncLeadEmails } from "@/lib/emailStore";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import { PAGE_TOKEN_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Gmail 동기화: { pageToken? } — 없으면 최신 페이지, 있으면 이전 페이지.
 * 아직 저장하지 않은 메일만 헤더를 읽어 저장하고(요약은 pending), 저장된 전체 목록을 돌려준다.
 */
export async function POST(req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body: unknown = await req.json().catch(() => ({}));
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).pageToken : undefined;
  if (raw !== undefined && raw !== null && (typeof raw !== "string" || !PAGE_TOKEN_RE.test(raw))) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const { id } = await params;
  const r = await resolveLeadTarget(id, user.email);
  if (!r.ok) return r.response;

  try {
    const { added, nextPageToken } = await syncLeadEmails(user, id, r.target, typeof raw === "string" ? raw : undefined);
    return NextResponse.json(await leadEmailsBody(user.id, id, r.target, { added, nextPageToken }));
  } catch (e) {
    return googleErrorResponse(e);
  }
}
