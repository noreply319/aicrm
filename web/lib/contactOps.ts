import "server-only";
import type { Pool, PoolClient } from "pg";
import {
  checkContactRefs, CONTACT_COLUMNS, contactConflict, contactParams, syncLeadCopies, toContact, type ContactConflict, type ContactRow,
} from "./contacts";
import type { Contact, ContactInput } from "./types";

/**
 * 연락처 생성·수정 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다). 호출한 쪽의 트랜잭션 client로 실행.
 * 같은 이메일(유니크 위반)은 SAVEPOINT로 되돌린 뒤 409 결과로 돌려준다.
 * meta는 담당자 사본이 바뀐 리드 이력에 남길 값 (기본 { via: "contact" }).
 */
export type ContactOpResult = { ok: true; contact: Contact } | { ok: false; status: 400 | 404; error: string } | ContactConflict;

export async function findContact(db: Pool | PoolClient, id: string, { lock = false } = {}): Promise<Contact | null> {
  const { rows } = await db.query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  return rows[0] ? toContact(rows[0]) : null;
}

/** 연락처 → 전체 교체용 입력 (updateContact는 모든 필드를 덮어쓰므로 일부만 바꿀 때 현재 값과 합친다) */
export const contactInputOf = (c: Contact): ContactInput => ({
  name: c.name, companyId: c.companyId, department: c.department, title: c.title, email: c.email, mobile: c.mobile,
  officePhone: c.officePhone, linkedinUrl: c.linkedinUrl, role: c.role, ownerId: c.ownerId, tags: c.tags, notes: c.notes,
});

export async function createContact(client: PoolClient, userId: string | null, d: ContactInput): Promise<ContactOpResult> {
  const refError = await checkContactRefs(client, d);
  if (refError) return { ok: false, status: 400, error: refError };
  try {
    await client.query("SAVEPOINT ins");
    const { rows } = await client.query<ContactRow>(
      `INSERT INTO contacts (name, company_id, department, title, email, mobile, office_phone,
                             linkedin_url, role, owner_id, tags, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${CONTACT_COLUMNS}`,
      [...contactParams(d), userId]
    );
    return { ok: true, contact: toContact(rows[0]) };
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT ins");
    return contactConflict(client, e, d);
  }
}

/** 전체 값 교체. 이름·직함·이메일·전화가 바뀌면 연결된 모든 리드의 담당자 사본도 바꾸고 리드마다 이력을 남긴다 */
export async function updateContact(
  client: PoolClient, id: string, d: ContactInput, meta: Record<string, unknown> = { via: "contact" }
): Promise<ContactOpResult> {
  const exists = (await client.query("SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE", [id])).rowCount;
  if (!exists) return { ok: false, status: 404, error: "연락처를 찾을 수 없습니다" };
  const refError = await checkContactRefs(client, d);
  if (refError) return { ok: false, status: 400, error: refError };

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
  await syncLeadCopies(client, id, contact, meta);
  return { ok: true, contact };
}
