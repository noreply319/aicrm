import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { createDocument } from "@/lib/docChat";
import { getDocument, getTemplate, listDocuments, publicDocument } from "@/lib/documents";
import type { DocStatus } from "@/lib/types";
import { isDocKind, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["draft", "completed", "sent"]);

/** 작성한 문서 목록. ?kind= &status= &mine=1 &q= */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind");
  const status = sp.get("status");
  if ((kind !== null && !isDocKind(kind)) || (status !== null && !STATUSES.has(status))) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const docs = await listDocuments({
    kind: kind as "contract" | "quote" | null,
    status: status as DocStatus | null,
    userId: sp.get("mine") === "1" ? await requestUserId() : null,
    q: (sp.get("q") ?? "").trim().slice(0, 100),
  });
  return NextResponse.json(docs);
}

/** 템플릿으로 새 문서 만들기 { templateId } → Assistant 첫 질문(리드 선택)까지 담긴 문서 */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  const templateId = body && typeof body === "object" ? (body as Record<string, unknown>).templateId : null;
  if (typeof templateId !== "string" || !UUID_RE.test(templateId)) {
    return NextResponse.json({ error: "템플릿을 선택하세요" }, { status: 400 });
  }
  const template = await getTemplate(templateId);
  if (!template || template.archived) return NextResponse.json({ error: "템플릿을 찾을 수 없습니다" }, { status: 404 });
  const id = await createDocument(template, await requestUserId());
  return NextResponse.json(publicDocument((await getDocument(id))!), { status: 201 });
}
