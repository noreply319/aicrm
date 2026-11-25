"use client";

import { useEffect, useRef, useState } from "react";
import { MOBILE_QUERY } from "@/lib/constants";
import type { AgentTarget } from "@/lib/types";
import type { AgentChat } from "@/lib/useAgentChat";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useReviseInput } from "@/lib/useReviseInput";
import AgentTurn from "./AgentTurn";
import { Badge, Button, EmptyState, Icon, Textarea } from "./ui";

interface Props {
  /** 대화 상태는 CrmApp이 가진다 (메뉴를 옮겨도 유지) */
  chat: AgentChat;
  onOpenTarget: (target: AgentTarget) => void;
}

const SUGGESTIONS = [
  "오늘 할 일 정리해줘",
  "이번 주 미팅 일정 알려줘",
  "협상 단계 리드 중 금액이 큰 순서로 보여줘",
  "오션핀테크 리드를 협상 단계로 옮겨줘",
];

/** Sales Agent: 대화로 요청하면 조회는 바로, 변경은 실행 계획 카드로 승인받아 처리한다 */
export default function AgentView({ chat, onOpenTarget }: Props) {
  const { messages, busy, send, approve, approveAll, cancel, reset } = chat;
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mobile = useMediaQuery(MOBILE_QUERY);

  // 새 메시지·진행 단계가 오면 맨 아래로
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = async (text: string) => {
    if (busy || !text.trim()) return;
    setInput("");
    await send(text);
  };

  const revise = useReviseInput(inputRef, setInput, cancel);

  return (
    <section className="agent" aria-label="Sales Agent">
      <div className="agent-head">
        <Badge tone="brand">Agent</Badge>
        <span className="agent-desc muted">조회는 바로 답하고, 리드 변경은 실행 계획을 보여드린 뒤 승인하면 처리합니다.</span>
        {messages.length > 0 && (
          <Button size="sm" variant="ghost" icon="refresh" onClick={reset}>
            새 대화
          </Button>
        )}
      </div>

      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && (
          <EmptyState
            icon={<Icon name="agent" size={28} />}
            title="무엇을 도와드릴까요?"
            description="리드 조회·생성·수정·단계 이동·삭제를 말로 요청하세요."
            action={
              <div className="agent-suggestions">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} size="sm" variant="secondary" onClick={() => submit(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            }
          />
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bubble bubble-user">{m.content}</div>
          ) : (
            <AgentTurn
              key={m.id}
              message={m}
              onApprove={(p) => approve(m.id, p)}
              onCancel={(p) => cancel(m.id, p)}
              onApproveAll={() => approveAll(m.id)}
              onRevise={(p) => revise(m.id, p)}
              onSendDraft={(p) => submit(`「${p.title}」 초안 그대로 메일을 보내줘`)}
              onOpenTarget={onOpenTarget}
            />
          )
        )}
      </div>

      <form
        className="agent-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <Textarea
          ref={inputRef}
          value={input}
          aria-label="Sales Agent에게 요청"
          placeholder={mobile ? "할 일을 요청하세요…" : "할 일을 요청하세요… (Enter 전송, Shift+Enter 줄바꿈)"}
          rows={2}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter는 무시 (마지막 글자 중복 전송 방지)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(input);
            }
          }}
        />
        <Button variant="primary" type="submit" disabled={busy || !input.trim()}>
          전송
        </Button>
      </form>
    </section>
  );
}
