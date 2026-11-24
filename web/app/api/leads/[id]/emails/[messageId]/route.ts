import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getMessage, involvesAddress, involvesTarget, leadTarget } from "@/lib/gmail";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import type { EmailDetail } from "@/lib/types";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; messageId: string }> };

const notFound = () => NextResponse.json({ error: "메일을 찾을 수 없습니다" }, { status: 404 });

/** 메일 본문. 이 리드 주소(또는 회사 도메인)와 주고받은 메일만 보여준다 (CRM을 일반 메일함으로 쓰지 않도록) */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id, messageId } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const { rows } = await pool.query<{ email: string }>("SELECT email FROM leads WHERE id = $1", [id]);
  const target = rows[0] ? leadTarget(rows[0].email, user.email) : null;
  if (!target) return notFound();

  try {
    const msg = await getMessage(user, messageId);
    if (!msg || !involvesTarget(msg, target)) return notFound();
    const { bcc: _bcc, ...rest } = msg;
    const detail: EmailDetail = involvesAddress(msg, target.address) ? rest : { ...rest, viaDomain: true };
    return NextResponse.json(detail);
  } catch (e) {
    return googleErrorResponse(e);
  }
}
