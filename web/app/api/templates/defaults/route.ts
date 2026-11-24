import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { pool } from "@/lib/db";
import { SAMPLE_TEMPLATES } from "@/lib/docSamples";
import { insertTemplate } from "@/lib/documents";
import type { DocTemplate } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 기본 템플릿 불러오기: 같은 이름의 템플릿이 없는 샘플만 추가 */
export async function POST() {
  const userId = await requestUserId();
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM document_templates");
  const added: DocTemplate[] = [];
  for (const t of SAMPLE_TEMPLATES) {
    if (!rows.some((r) => r.name === t.name)) added.push(await insertTemplate(t, userId));
  }
  return NextResponse.json(added, { status: 201 });
}
