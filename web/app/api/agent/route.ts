import { NextResponse } from "next/server";
import { AssistantError, askAssistant } from "@/lib/assistant";
import type { AgentEvent } from "@/lib/types";
import { parseChatInput } from "@/lib/validate";

export const dynamic = "force-dynamic";
// 도구 호출(function calling)로 OpenAI를 여러 번 호출할 수 있다
export const maxDuration = 60;

/**
 * Sales Agent: { messages } → NDJSON 스트림 (한 줄에 AgentEvent 하나, 마지막은 done)
 * 지금은 조회형 Assistant로 답하고 도구 호출을 진행 단계로 보낸다.
 * 변경 작업(plan 이벤트)과 승인 실행은 AIC-3 실행 엔진에서 추가한다.
 */
export async function POST(req: Request) {
  const parsed = parseChatInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const messages = parsed.data;

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
      const context = { id: "context", label: "CRM 데이터 확인" };
      let contextDone = false;
      emit({ type: "step", step: { ...context, status: "running" } });
      try {
        const reply = await askAssistant(messages, {
          onContext: () => {
            contextDone = true;
            emit({ type: "step", step: { ...context, status: "done" } });
          },
          onStep: (step) => emit({ type: "step", step }),
        });
        emit({ type: "reply", content: reply });
      } catch (e) {
        // 데이터 확인 단계에서 실패했을 때만 그 단계를 실패로 표시 (OpenAI 실패는 에러 메시지로)
        if (!contextDone) emit({ type: "step", step: { ...context, status: "failed" } });
        if (!(e instanceof AssistantError)) console.error("[agent]", e);
        emit({ type: "error", error: e instanceof AssistantError ? e.message : "답변을 만들지 못했습니다. 잠시 후 다시 시도하세요" });
      }
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
