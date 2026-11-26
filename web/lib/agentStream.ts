import "server-only";
import { NextResponse } from "next/server";
import { runAgent } from "./agent";
import { requestLimitError } from "./agentLimits";
import type { AgentSource } from "./agentToolKit";
import { AssistantError } from "./assistant";
import { getSessionUser } from "./auth";
import { selectHistory } from "./chatContext";
import { conversationTitle, createConversation, findConversation, loadHistory, saveTurn } from "./chatStore";
import type { AgentEvent, AgentPlan, AgentStep } from "./types";
import { parseChatInput, UUID_RE } from "./validate";

/**
 * AI Assistant(/api/assistant): { messages } → NDJSON 스트림 (한 줄에 AgentEvent 하나, 마지막은 done)
 * 조회 도구는 바로 실행하고, 변경 도구는 실행 계획(plan)으로 보낸다 — 실행은 승인 API에서.
 * 대화 기록: { conversationId }가 있으면 그 대화에, 없으면 새 대화를 만들어(첫 이벤트로 알려줌) 답변이 끝나면 질문·답변을 저장한다.
 */
export async function agentStreamResponse(req: Request, source: AgentSource): Promise<Response> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = parseChatInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  // 계획은 요청한 사용자 것으로 저장한다
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const limited = await requestLimitError(user.id);
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });
  const question = parsed.data[parsed.data.length - 1].content;

  // 이어 쓸 대화는 본인·같은 화면의 대화만
  const requested = body && typeof body === "object" ? (body as Record<string, unknown>).conversationId : undefined;
  if (requested !== undefined && requested !== null && (typeof requested !== "string" || !UUID_RE.test(requested))) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const conversation = requested
    ? await findConversation(user.id, requested)
    : await createConversation(user.id, source, conversationTitle(question));
  if (!conversation) return NextResponse.json({ error: "대화를 찾을 수 없습니다" }, { status: 404 });
  // 이어 쓰는 대화는 저장된 기록(다른 기기에서 쓴 것 포함)에서 최근 + 이번 질문과 관련된 이전 대화를 골라 보낸다
  const messages = requested ? selectHistory(await loadHistory(conversation.id), question) : selectHistory(parsed.data.slice(0, -1), question);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 사용자가 새 대화·화면 이탈로 요청을 끊으면 스트림이 닫힌다 → 이후 쓰기는 무시
      let closed = false;
      const emit = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true;
        }
      };
      // 저장할 답변 (화면에 보낸 이벤트를 모은다 — 사용자가 연결을 끊어도 끝까지 모아 저장)
      const answer = { content: "", steps: [] as AgentStep[], plans: [] as AgentPlan[], error: undefined as string | undefined };
      const record = (event: AgentEvent) => {
        if (event.type === "reply") answer.content = answer.content ? `${answer.content}\n\n${event.content}` : event.content;
        else if (event.type === "step") answer.steps = [...answer.steps.filter((x) => x.id !== event.step.id), event.step];
        else if (event.type === "plan") answer.plans = [...answer.plans.filter((x) => x.id !== event.plan.id), event.plan];
        else if (event.type === "error") answer.error = event.error;
        emit(event);
      };
      emit({ type: "conversation", conversation });
      try {
        await runAgent(messages, user, record, source);
      } catch (e) {
        if (!(e instanceof AssistantError)) console.error(`[${source}]`, e);
        record({ type: "error", error: e instanceof AssistantError ? e.message : "답변을 만들지 못했습니다. 잠시 후 다시 시도하세요" });
      }
      await saveTurn(conversation.id, question, answer).catch((e: unknown) => console.error(`[${source}] 대화 저장`, e));
      emit({ type: "done" });
      if (!closed) {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
