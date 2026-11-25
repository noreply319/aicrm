import { agentStreamResponse } from "@/lib/agentStream";

export const dynamic = "force-dynamic";
// 조회·계획 작성으로 OpenAI를 여러 번(최대 6번) 호출할 수 있다
export const maxDuration = 120;

/** Sales Agent: { messages } → NDJSON 스트림 (모든 도구, 변경은 실행 계획으로) */
export async function POST(req: Request) {
  return agentStreamResponse(req, "agent");
}
