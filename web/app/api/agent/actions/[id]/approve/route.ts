import { NextResponse } from "next/server";
import { decideAction } from "@/lib/agent";
import { requestUserId } from "@/lib/auth";
import { attachFollowUps } from "@/lib/chatStore";
import type { AgentDecision } from "@/lib/types";

// 승인 후 구글 캘린더 호출·AI 요약(후속 작업)이 이어질 수 있다
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** 실행 계획 승인 → 실행 결과 → AgentPlan. 요청한 본인만, 한 번만 (이미 처리됐으면 409) */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const r = await decideAction(id, userId, "approve");
  // 이어서 제안한 계획은 대화 기록에도 붙여 다른 기기에서 열어도 보이게 한다
  if (r.ok && r.followUps?.length) {
    await attachFollowUps(userId, id, r.followUps.map((f) => f.id)).catch((e: unknown) => console.error("[agent] 대화 기록", e));
  }
  return r.ok
    ? NextResponse.json({ ...r.plan, ...(r.followUps ? { followUps: r.followUps } : {}) } satisfies AgentDecision)
    : NextResponse.json({ error: r.error }, { status: r.status });
}
