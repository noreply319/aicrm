import { agentActionNotReady } from "@/lib/agent";

type Ctx = { params: Promise<{ id: string }> };

/** 실행 계획 승인 → 실행 후 AgentPlan. 실행 엔진(AIC-3) 전까지는 501 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return agentActionNotReady(id);
}
