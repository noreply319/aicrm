"use client";

import type { AgentMessage, AgentPlan, AgentPlanStatus, AgentStep, AgentTarget } from "@/lib/types";
import { Alert, Badge, Button, Icon, type BadgeTone } from "./ui";

/**
 * 실행 엔진의 답변 한 턴: 진행 단계 + 답변 + 실행 계획 카드(승인·취소·수정 요청) + 모두 승인.
 * Sales Agent(AgentView)·AI Assistant(AssistantPanel) 공용.
 */
interface Props {
  message: AgentMessage;
  onApprove: (plan: AgentPlan) => void;
  onCancel: (plan: AgentPlan) => void;
  onApproveAll: () => void;
  /** 수정 요청: 계획을 취소하고 입력창에 고칠 내용을 적게 한다 */
  onRevise: (plan: AgentPlan) => void;
  /** 초안 카드: 이 내용으로 발송 계획을 만들어 달라고 요청 (초안 도구가 없는 화면은 생략) */
  onSendDraft?: (plan: AgentPlan) => void;
  onOpenTarget: (target: AgentTarget) => void;
}

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
  draft: { tone: "info", label: "초안" },
};

const TARGET_LABEL: Record<AgentTarget["kind"], string> = {
  lead: "리드 열기",
  company: "회사 보기",
  contact: "연락처 보기",
  note: "노트 보기",
  document: "문서 보기",
  event: "일정 보기",
};

/** "모두 승인"으로 함께 승인할 수 있는 계획 수 (되돌릴 수 없는 danger 계획은 하나씩) / 빠지는 danger 계획 수 */
const bulkCount = (m: AgentMessage) => m.plans?.filter((p) => p.status === "pending" && !p.danger).length ?? 0;
const dangerPending = (m: AgentMessage) => m.plans?.filter((p) => p.status === "pending" && p.danger).length ?? 0;

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
  plan, onApprove, onCancel, onRevise, onSendDraft, onOpenTarget,
}: {
  plan: AgentPlan;
  onApprove: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onSendDraft?: () => void;
  onOpenTarget: (target: AgentTarget) => void;
}) {
  const badge = PLAN_BADGE[plan.status];
  const pending = plan.status === "pending";
  const running = plan.status === "running";
  const draft = plan.status === "draft";
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
      {plan.notice && (pending || draft) && (
        <Alert tone={plan.notice.tone} plain>
          {plan.notice.text}
        </Alert>
      )}
      {plan.message && (
        <Alert tone={plan.status === "done" ? "success" : plan.status === "canceled" ? "neutral" : "danger"} plain>
          {plan.message}
        </Alert>
      )}
      {(pending || running || draft || plan.target) && (
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
                {running ? "처리 중…" : (plan.approveLabel ?? "승인")}
              </Button>
            </>
          )}
          {draft && (
            <>
              <span className="spacer" />
              <Button size="sm" variant="secondary" icon="edit" onClick={onRevise}>수정 요청</Button>
              {onSendDraft && <Button size="sm" variant="primary" icon="mail" onClick={onSendDraft}>이대로 보내기 요청</Button>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default function AgentTurn({ message: m, onApprove, onCancel, onApproveAll, onRevise, onSendDraft, onOpenTarget }: Props) {
  return (
    <div className="agent-turn" aria-busy={m.streaming || undefined}>
      {m.steps && m.steps.length > 0 && <StepList steps={m.steps} />}
      {m.content && <div className="bubble bubble-assistant">{m.content}</div>}
      {m.streaming && !m.content && <div className="bubble bubble-assistant bubble-loading">작업 중…</div>}
      {m.plans?.map((p) => (
        <PlanCard
          key={p.id}
          plan={p}
          onApprove={() => onApprove(p)}
          onCancel={() => onCancel(p)}
          onRevise={() => onRevise(p)}
          onSendDraft={onSendDraft && (() => onSendDraft(p))}
          onOpenTarget={onOpenTarget}
        />
      ))}
      {bulkCount(m) >= 2 && (
        <div className="plan-all">
          <Button size="sm" variant="primary" onClick={onApproveAll}>
            모두 승인 ({bulkCount(m)}){dangerPending(m) > 0 ? " · 발송·삭제 제외" : ""}
          </Button>
        </div>
      )}
      {m.error && <Alert tone="danger">{m.error}</Alert>}
    </div>
  );
}
