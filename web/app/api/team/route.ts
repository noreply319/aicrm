import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import type { TeamMember } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 팀원 목록 (회사 담당 영업 선택용): 이름만. 이메일·토큰은 내려주지 않는다 */
export async function GET() {
  const { rows } = await pool.query<TeamMember>(
    `SELECT id, coalesce(nullif(name, ''), split_part(email, '@', 1)) AS name FROM users ORDER BY name`
  );
  return NextResponse.json(rows);
}
