import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { recordDocumentSend, sentLink } from "@/lib/docOps";
import { documentPdf, getDocument } from "@/lib/documents";
import { withTransaction } from "@/lib/events";
import { sendRawMessage } from "@/lib/gmail";
import { canSendGmail, googleErrorResponse, unauthorized } from "@/lib/google";
import { buildMime, MAIL_TOO_LARGE, MAX_MAIL_BYTES } from "@/lib/mime";
import type { DocChatResult } from "@/lib/types";
import { parseSendInput, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * 완성한 문서를 내 Gmail로 발송: { to[], cc[], subject, body, fileName }
 * 발송 성공 후 같은 트랜잭션에서 발송 기록·문서 상태(sent)·리드 이력(document_sent)을 남긴다.
 * 리드 이력에는 받는 사람 주소를 넣지 않는다 (AI Assistant 컨텍스트로 쓰이므로). 주소는 document_sends에만.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const doc = UUID_RE.test(id) ? await getDocument(id) : null;
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });
  if (doc.status === "draft") return NextResponse.json({ error: "먼저 문서를 완성하세요" }, { status: 409 });
  if (!canSendGmail(user)) {
    return NextResponse.json(
      { error: "메일을 보내려면 Gmail 발송 권한이 필요합니다. 설정에서 Gmail을 다시 연동하세요", code: "no_send_scope" },
      { status: 409 }
    );
  }
  const parsed = parseSendInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const m = parsed.data;

  const { bytes } = await documentPdf(doc);
  const raw = buildMime({
    to: m.to, cc: m.cc, subject: m.subject, body: m.body,
    attachment: { fileName: m.fileName, contentType: "application/pdf", data: bytes },
  });
  if (raw.length > MAX_MAIL_BYTES) return NextResponse.json({ error: MAIL_TOO_LARGE }, { status: 413 });

  let sent: { id: string; threadId: string };
  try {
    sent = await sendRawMessage(user, raw);
  } catch (e) {
    return googleErrorResponse(e);
  }
  const link = sentLink(user.email, sent);

  const result = await withTransaction(async (c): Promise<DocChatResult> =>
    (await recordDocumentSend(c, id, user.id, m, { id: sent.id, link })).result
  );
  return NextResponse.json(result);
}
