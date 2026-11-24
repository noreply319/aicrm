import { NextResponse } from "next/server";
import { docErrorResponse, patchDocument } from "@/lib/docChat";
import { getDocument, publicDocument } from "@/lib/documents";
import { pool } from "@/lib/db";
import { parseDocPatch, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const doc = UUID_RE.test(id) ? await getDocument(id) : null;
  return doc ? NextResponse.json(publicDocument(doc)) : notFound();
}

/** 오른쪽 문서에서 직접 수정: { values?, lineItems?, title? } → { document, changed } */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const parsed = parseDocPatch(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await patchDocument(id, parsed.data));
  } catch (e) {
    return docErrorResponse(e);
  }
}

/** 삭제: 작성 중·완성 문서만 (발송한 문서는 이력 보존) */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rows } = await pool.query<{ status: string }>("SELECT status FROM documents WHERE id = $1", [id]);
  if (!rows[0]) return notFound();
  if (rows[0].status === "sent") return NextResponse.json({ error: "발송한 문서는 삭제할 수 없습니다" }, { status: 409 });
  await pool.query("DELETE FROM documents WHERE id = $1 AND status <> 'sent'", [id]);
  return new NextResponse(null, { status: 204 });
}
