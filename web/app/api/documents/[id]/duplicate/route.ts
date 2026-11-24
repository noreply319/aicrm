import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { duplicateDocument } from "@/lib/docChat";
import { getDocument, publicDocument } from "@/lib/documents";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 문서 복제 (발송한 문서를 고칠 때): 새 문서번호의 작성 중 문서 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const src = UUID_RE.test(id) ? await getDocument(id) : null;
  if (!src) return NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });
  const copyId = await duplicateDocument(src, await requestUserId());
  return NextResponse.json(publicDocument((await getDocument(copyId))!), { status: 201 });
}
