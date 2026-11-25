import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { documentEmailDraft } from "@/lib/docOps";
import { getDocument } from "@/lib/documents";
import { unauthorized } from "@/lib/google";
import type { DocEmailDraft } from "@/lib/types";
import { isMailAddress, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 메일 작성 기본값: 받는 사람(리드 이메일)·제목·본문(템플릿 메일 양식에 값 채움)·첨부 파일 정보 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const doc = UUID_RE.test(id) ? await getDocument(id) : null;
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });

  const lead = doc.leadId
    ? (await pool.query<{ email: string }>("SELECT email FROM leads WHERE id = $1", [doc.leadId])).rows[0]
    : undefined;
  const { subject, body, fileName, bytes, pages } = await documentEmailDraft(doc);
  const draft: DocEmailDraft = {
    from: user.email,
    to: lead?.email && isMailAddress(lead.email.trim().toLowerCase()) ? [lead.email.trim().toLowerCase()] : [],
    subject,
    body,
    fileName,
    size: bytes.length,
    pages,
  };
  return NextResponse.json(draft);
}
