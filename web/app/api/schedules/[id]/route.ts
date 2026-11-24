import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 일정 후보 무시: { status: "dismissed" } (같은 일정을 다시 제안하지 않도록 남겨 둔다) */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "일정 후보를 찾을 수 없습니다" }, { status: 404 });
  const body: unknown = await req.json().catch(() => null);
  const status = body && typeof body === "object" ? (body as Record<string, unknown>).status : null;
  if (status !== "dismissed") return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });

  const { rowCount } = await pool.query(
    `UPDATE scheduled_meetings SET status = 'dismissed', updated_at = now() WHERE id = $1 AND status = 'candidate'`,
    [id]
  );
  return rowCount ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "이미 처리된 일정 후보입니다" }, { status: 409 });
}
