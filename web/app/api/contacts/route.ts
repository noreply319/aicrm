import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { createContact } from "@/lib/contactOps";
import { CONTACT_COLUMNS, toContact, type ContactRow } from "@/lib/contacts";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { parseContactInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 연락처 목록 (이름순). 연결 리드 집계는 클라이언트가 leads로 계산한다. */
export async function GET() {
  const { rows } = await pool.query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts ORDER BY name, created_at`);
  return NextResponse.json(rows.map(toContact));
}

/** 연락처 생성. 이름만 보내도 된다. 같은 이메일이 있으면 409 + { error, contact: 기존 연락처 } */
export async function POST(req: Request) {
  const parsed = parseContactInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const userId = await requestUserId();

  const r = await withTransaction((client) => createContact(client, userId, parsed.data));
  if (r.ok) return NextResponse.json(r.contact, { status: 201 });
  return NextResponse.json(r.status === 409 ? { error: r.error, contact: r.existing } : { error: r.error }, { status: r.status });
}
