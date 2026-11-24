import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { pool } from "@/lib/db";
import { insertTemplate, TEMPLATE_COLUMNS, TEMPLATE_FROM, toTemplate, type TemplateRow } from "@/lib/documents";
import { isDocKind, parseTemplateInput } from "@/lib/validate";

export const dynamic = "force-dynamic";


/** 템플릿 목록 (최근 수정순). ?kind=contract|quote, ?archived=1이면 보관한 템플릿 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind");
  if (kind !== null && !isDocKind(kind)) return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  const { rows } = await pool.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM ${TEMPLATE_FROM}
     WHERE t.archived = $1 AND ($2::text IS NULL OR t.kind = $2)
     ORDER BY t.updated_at DESC`,
    [sp.get("archived") === "1", kind]
  );
  return NextResponse.json(rows.map(toTemplate));
}

export async function POST(req: Request) {
  const parsed = parseTemplateInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const t = await insertTemplate(parsed.data, await requestUserId());
  return NextResponse.json(t, { status: 201 });
}
