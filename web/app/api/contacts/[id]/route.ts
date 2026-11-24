import { NextResponse } from "next/server";
import {
  checkContactRefs, CONTACT_COLUMNS, ContactConflictError, contactConflict, contactParams, syncLeadCopies, toContact,
  unlinkLeads, type ContactRow,
} from "@/lib/contacts";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { parseContactInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "연락처를 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rows } = await pool.query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1`, [id]);
  return rows[0] ? NextResponse.json(toContact(rows[0])) : notFound();
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
  const d = parsed.data;

  try {
    const result = await withTransaction(async (client) => {
      const exists = (await client.query("SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE", [id])).rowCount;
      if (!exists) return null;
      const refError = await checkContactRefs(client, d);
      if (refError) return refError;

      let row: ContactRow;
      try {
        await client.query("SAVEPOINT upd");
        row = (
          await client.query<ContactRow>(
            `UPDATE contacts SET name=$1, company_id=$2, department=$3, title=$4, email=$5, mobile=$6, office_phone=$7,
                    linkedin_url=$8, role=$9, owner_id=$10, tags=$11, notes=$12, updated_at=now()
             WHERE id=$13
             RETURNING ${CONTACT_COLUMNS}`,
            [...contactParams(d), id]
          )
        ).rows[0];
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT upd");
        return contactConflict(client, e, d, id);
      }
      const contact = toContact(row);
      await syncLeadCopies(client, id, contact);
      return contact;
    });
    if (typeof result === "string") return NextResponse.json({ error: result }, { status: 400 });
    return result ? NextResponse.json(result) : notFound();
  } catch (e) {
    if (e instanceof ContactConflictError) return NextResponse.json({ error: e.message, contact: e.existing }, { status: 409 });
    throw e;
  }
}

/** 연락처 삭제. 연결 리드는 연결만 끊고 담당자 사본은 남긴다 (리드마다 이력) */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<{ name: string }>("SELECT name FROM contacts WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) return false;
    await unlinkLeads(client, id, rows[0].name);
    await client.query("DELETE FROM contacts WHERE id = $1", [id]);
    return true;
  });
  return deleted ? new NextResponse(null, { status: 204 }) : notFound();
}
