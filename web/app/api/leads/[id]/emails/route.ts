import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { involvesAddress, leadTarget, listLeadMessages } from "@/lib/gmail";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import type { LeadEmails } from "@/lib/types";
import { PAGE_TOKEN_RE, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 리드 이메일 주소(회사 도메인이면 같은 도메인 전체)와 주고받은 메일 (로그인 사용자의 Gmail, 최신순 20건씩). ?pageToken= 으로 다음 페이지.
 * 메일은 저장하지 않고 매번 Gmail에서 읽는다.
 */
export async function GET(req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });
  const pageToken = new URL(req.url).searchParams.get("pageToken");
  if (pageToken !== null && !PAGE_TOKEN_RE.test(pageToken)) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const { rows } = await pool.query<{ email: string }>("SELECT email FROM leads WHERE id = $1", [id]);
  if (!rows[0]) return NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });
  if (!rows[0].email.trim()) return NextResponse.json({ error: "리드에 이메일 주소가 없습니다", code: "no_email" }, { status: 400 });
  const target = leadTarget(rows[0].email, user.email);
  if (!target) {
    return NextResponse.json({ error: "리드 이메일 주소 형식이 올바르지 않습니다", code: "bad_email" }, { status: 400 });
  }

  try {
    const { messages, nextPageToken } = await listLeadMessages(user, [target], { pageToken: pageToken ?? undefined });
    const body: LeadEmails = {
      address: target.address,
      domain: target.domain,
      messages: messages.map((m) => (involvesAddress(m, target.address) ? m : { ...m, viaDomain: true })),
      nextPageToken,
    };
    return NextResponse.json(body);
  } catch (e) {
    return googleErrorResponse(e);
  }
}
