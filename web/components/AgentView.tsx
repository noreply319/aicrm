"use client";

import { useEffect, useRef, useState } from "react";
import { MOBILE_QUERY } from "@/lib/constants";
import type { AgentMessage, AgentPlan, AgentPlanStatus, AgentStep, AgentTarget } from "@/lib/types";
import type { AgentChat } from "@/lib/useAgentChat";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { Alert, Badge, Button, EmptyState, Icon, Textarea, type BadgeTone } from "./ui";

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

const STEP_BADGE: Record<AgentStep["status"], { tone: BadgeTone; label: string }> = {
  running: { tone: "info", label: "진행 중" },
  done: { tone: "success", label: "완료" },
  failed: { tone: "danger", label: "실패" },
};

const PLAN_BADGE: Record<AgentPlanStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: "warning", label: "승인 대기" },
  running: { tone: "info", label: "실행 중" },
  done: { tone: "success", label: "완료" },
  failed: { tone: "danger", label: "실패" },
  canceled: { tone: "neutral", label: "취소됨" },
};

const TARGET_LABEL: Record<AgentTarget["kind"], string> = {
  lead: "리드 열기",
  company: "회사 보기",
  contact: "연락처 보기",
  document: "문서 보기",
  event: "일정 보기",
};

/** 승인 대기 중인 계획 수 (2개 이상이면 "모두 승인") */
const pendingCount = (m: AgentMessage) => m.plans?.filter((p) => p.status === "pending").length ?? 0;

/** 진행 단계 목록 (도구 호출 상태) */
function StepList({ steps }: { steps: AgentStep[] }) {
  return (
    <ol className="agent-steps" aria-label="진행 단계">
      {steps.map((s) => (
        <li key={s.id} className={`agent-step agent-step-${s.status}`}>
          <span className="agent-step-label">{s.label}</span>
          {s.detail && <span className="agent-step-detail">{s.detail}</span>}
          <Badge tone={STEP_BADGE[s.status].tone}>{STEP_BADGE[s.status].label}</Badge>
        </li>
      ))}
    </ol>
  );
}

/** 실행 계획 카드: 바뀌는 값(전/후) + 승인·취소·수정 요청 */
function PlanCard({
  plan, onApprove, onCancel, onRevise, onOpenTarget,
}: {
  plan: AgentPlan;
  onApprove: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onOpenTarget: (target: AgentTarget) => void;
}) {
  const badge = PLAN_BADGE[plan.status];
  const pending = plan.status === "pending";
  const running = plan.status === "running";
  return (
    <section className={`plan-card plan-${plan.status}`} aria-label={`실행 계획: ${plan.title}`}>
      <div className="plan-head">
        <Icon name="agent" size={15} />
        <b className="plan-title">{plan.title}</b>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {plan.changes.length > 0 && (
        <table className="plan-diff">
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">현재</th>
              <th scope="col">변경 후</th>
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((c, i) => (
              <tr key={`${c.field}-${i}`}>
                <th scope="row">{c.field}</th>
                <td className="plan-before">{c.before ?? <span className="muted">없음</span>}</td>
                <td className="plan-after">{c.after ?? <span className="muted">삭제</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.message && (
        <Alert tone={plan.status === "done" ? "success" : plan.status === "canceled" ? "neutral" : "danger"} plain>
          {plan.message}
        </Alert>
      )}
      {(pending || running || plan.target) && (
        <div className="plan-actions">
          {plan.target && plan.status !== "canceled" && (
            <Button size="sm" variant="ghost" icon="link" onClick={() => onOpenTarget(plan.target!)}>
              {TARGET_LABEL[plan.target.kind]}
            </Button>
          )}
          {(pending || running) && (
            <>
              <span className="spacer" />
              <Button size="sm" variant="ghost" disabled={running} onClick={onCancel}>취소</Button>
              <Button size="sm" variant="secondary" icon="edit" disabled={running} onClick={onRevise}>수정 요청</Button>
              <Button size="sm" variant={plan.danger ? "danger" : "primary"} disabled={running} onClick={onApprove}>
                {running ? "처리 중…" : plan.danger ? "삭제 승인" : "승인"}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

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

  /** 수정 요청: 기존 계획은 취소하고, 입력창에 고칠 내용을 적게 한다 */
  const revise = (messageId: string, plan: AgentPlan) => {
    cancel(messageId, plan);
    setInput(`「${plan.title}」 계획 수정: `);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

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
            <div key={m.id} className="agent-turn" aria-busy={m.streaming || undefined}>
              {m.steps && m.steps.length > 0 && <StepList steps={m.steps} />}
              {m.content && <div className="bubble bubble-assistant">{m.content}</div>}
              {m.streaming && !m.content && <div className="bubble bubble-assistant bubble-loading">작업 중…</div>}
              {m.plans?.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  onApprove={() => approve(m.id, p)}
                  onCancel={() => cancel(m.id, p)}
                  onRevise={() => revise(m.id, p)}
                  onOpenTarget={onOpenTarget}
                />
              ))}
              {pendingCount(m) >= 2 && (
                <div className="plan-all">
                  <Button size="sm" variant="primary" onClick={() => approveAll(m.id)}>
                    모두 승인 ({pendingCount(m)})
                  </Button>
                </div>
              )}
              {m.error && <Alert tone="danger">{m.error}</Alert>}
            </div>
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
