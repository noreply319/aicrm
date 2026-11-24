import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getTemplate } from "@/lib/documents";
import { parseTemplateInput, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "템플릿을 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const t = await getTemplate(id);
  return t ? NextResponse.json(t) : notFound();
}

/** 템플릿 수정 (전체 값) 또는 보관·복원 { archived } */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const body: unknown = await req.json().catch(() => null);
  const userId = await requestUserId();

  if (body && typeof body === "object" && Object.keys(body).length === 1 && "archived" in body) {
    const archived = (body as { archived: unknown }).archived;
    if (typeof archived !== "boolean") return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
    const { rowCount } = await pool.query(
      "UPDATE document_templates SET archived = $2, updated_by = $3, updated_at = now() WHERE id = $1",
      [id, archived, userId]
    );
    return rowCount ? NextResponse.json(await getTemplate(id)) : notFound();
  }

  const parsed = parseTemplateInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;
  // 이미 만든 문서는 생성 시점의 본문·항목을 따로 가지고 있어 영향 없음
  const { rowCount } = await pool.query(
    `UPDATE document_templates SET kind=$2, name=$3, description=$4, body=$5, fields=$6, line_items=$7,
            email_subject=$8, email_body=$9, updated_by=$10, updated_at=now()
     WHERE id = $1`,
    [id, d.kind, d.name, d.description, d.body, JSON.stringify(d.fields), d.lineItems ? JSON.stringify(d.lineItems) : null, d.emailSubject, d.emailBody, userId]
  );
  return rowCount ? NextResponse.json(await getTemplate(id)) : notFound();
}

/** 삭제는 보관한 템플릿만 (만든 문서는 남는다) */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const t = await getTemplate(id);
  if (!t) return notFound();
  if (!t.archived) return NextResponse.json({ error: "보관한 템플릿만 삭제할 수 있습니다" }, { status: 409 });
  await pool.query("DELETE FROM document_templates WHERE id = $1", [id]);
  return new NextResponse(null, { status: 204 });
}
