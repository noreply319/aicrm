import { NextResponse } from "next/server";
import { decideAction } from "@/lib/agent";
import { requestUserId } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** 실행 계획 승인 → 실행 결과 → AgentPlan. 요청한 본인만, 한 번만 (이미 처리됐으면 409) */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const r = await decideAction(id, userId, "approve");
  return r.ok ? NextResponse.json(r.plan) : NextResponse.json({ error: r.error }, { status: r.status });
}
