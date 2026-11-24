import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { getTemplate, insertTemplate } from "@/lib/documents";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 템플릿 복제 → "(사본)" */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = UUID_RE.test(id) ? await getTemplate(id) : null;
  if (!t) return NextResponse.json({ error: "템플릿을 찾을 수 없습니다" }, { status: 404 });
  const copy = await insertTemplate({ ...t, name: `${t.name} (사본)`.slice(0, 100) }, await requestUserId());
  return NextResponse.json(copy, { status: 201 });
}
