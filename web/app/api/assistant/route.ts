import { agentStreamResponse } from "@/lib/agentStream";

export const dynamic = "force-dynamic";
// 조회·계획 작성으로 OpenAI를 여러 번 호출할 수 있다
export const maxDuration = 120;

/** AI Assistant: { messages } → NDJSON 스트림 (조회 + 리드 생성·수정·단계 이동·삭제 계획만, 실행은 승인 API) */
export async function POST(req: Request) {
  return agentStreamResponse(req, "assistant");
}
