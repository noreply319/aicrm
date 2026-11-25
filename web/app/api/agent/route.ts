import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import { AssistantError } from "@/lib/assistant";
import { getSessionUser } from "@/lib/auth";
import type { AgentEvent } from "@/lib/types";
import { parseChatInput } from "@/lib/validate";

export const dynamic = "force-dynamic";
// 조회·계획 작성으로 OpenAI를 여러 번(최대 6번) 호출할 수 있다
export const maxDuration = 120;

/**
 * Sales Agent: { messages } → NDJSON 스트림 (한 줄에 AgentEvent 하나, 마지막은 done)
 * 조회 도구는 바로 실행하고, 변경 도구는 실행 계획(plan)으로 보낸다 — 실행은 승인 API에서.
 */
export async function POST(req: Request) {
  const parsed = parseChatInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  // 계획은 요청한 사용자 것으로 저장한다
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
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
      try {
        await runAgent(messages, user, emit);
      } catch (e) {
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
