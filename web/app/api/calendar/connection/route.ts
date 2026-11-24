import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { pool } from "@/lib/db";
import { forgetAccessToken, revokeToken, unauthorized } from "@/lib/google";

export const dynamic = "force-dynamic";

/** 캘린더 연동 해제: 구글에 토큰 폐기 요청 후 저장된 토큰 삭제 (이미 등록한 일정은 캘린더에 남는다) */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const refresh = user.refreshToken ? decrypt(user.refreshToken) : null;
  if (refresh) await revokeToken(refresh);
  await pool.query(
    `UPDATE users SET google_refresh_token = NULL, google_scopes = '', calendar_expired = false,
            calendar_id = 'primary', updated_at = now()
     WHERE id = $1`,
    [user.id]
  );
  forgetAccessToken(user.id);
  return new NextResponse(null, { status: 204 });
}
