import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import {
  checkContactRefs, CONTACT_COLUMNS, ContactConflictError, contactConflict, contactParams, toContact, type ContactRow,
} from "@/lib/contacts";
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
  const d = parsed.data;
  const userId = await requestUserId();

  try {
    const result = await withTransaction(async (client) => {
      const refError = await checkContactRefs(client, d);
      if (refError) return refError;
      try {
        await client.query("SAVEPOINT ins");
        const { rows } = await client.query<ContactRow>(
          `INSERT INTO contacts (name, company_id, department, title, email, mobile, office_phone,
                                 linkedin_url, role, owner_id, tags, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING ${CONTACT_COLUMNS}`,
          [...contactParams(d), userId]
        );
        return toContact(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT ins");
        return contactConflict(client, e, d);
      }
    });
    if (typeof result === "string") return NextResponse.json({ error: result }, { status: 400 });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ContactConflictError) return NextResponse.json({ error: e.message, contact: e.existing }, { status: 409 });
    throw e;
  }
}
