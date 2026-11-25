import { NextResponse } from "next/server";
import { deleteContact, findContact, updateContact } from "@/lib/contactOps";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { parseContactInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "연락처를 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const contact = await findContact(pool, id);
  return contact ? NextResponse.json(contact) : notFound();
}

/**
 * 연락처 수정. 이름·직함·이메일·전화가 바뀌면 연결된 모든 리드의 담당자 사본도 바꾸고
 * 리드마다 updated 이력을 남긴다 (같은 트랜잭션).
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const parsed = parseContactInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const r = await withTransaction((client) => updateContact(client, id, parsed.data));
  if (r.ok) return NextResponse.json(r.contact);
  return NextResponse.json(r.status === 409 ? { error: r.error, contact: r.existing } : { error: r.error }, { status: r.status });
}

/** 연락처 삭제. 연결 리드는 연결만 끊고 담당자 사본은 남긴다 (리드마다 이력) */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const r = await withTransaction((client) => deleteContact(client, id));
  return r.ok ? new NextResponse(null, { status: 204 }) : notFound();
}
