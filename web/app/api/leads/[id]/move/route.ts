import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/events";
import { moveLead } from "@/lib/leadOps";
import { isStage, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 카드 이동: { stage, beforeId }
 * beforeId 카드 바로 앞에 오도록 두 이웃 position의 중간값을 부여한다 (null이면 맨 뒤).
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const stage = body?.stage;
  const beforeId: string | null = body?.beforeId ?? null;

  if (!UUID_RE.test(id) || !isStage(stage) || (beforeId !== null && !UUID_RE.test(beforeId))) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const result = await withTransaction((client) => moveLead(client, id, stage, beforeId));
  return result.ok ? NextResponse.json(result.lead) : NextResponse.json({ error: result.error }, { status: result.status });
}
