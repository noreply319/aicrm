import { NextResponse } from "next/server";
import { docErrorResponse, handleDocChat } from "@/lib/docChat";
import { parseDocChatInput, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 문서 작성 Assistant: { message } 또는 { action, value } → { document, changed, leadChanged } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });
  const parsed = parseDocChatInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await handleDocChat(id, parsed.data));
  } catch (e) {
    return docErrorResponse(e);
  }
}
