"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentEvent, AgentMessage, AgentPlan, AgentStep } from "./types";

let seq = 0;
const newId = () => `m${Date.now().toString(36)}-${++seq}`;

/** NDJSON 한 줄 → AgentEvent (모르는 형식은 무시) */
function parseEvent(line: string): AgentEvent | null {
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== "object" || typeof (v as { type?: unknown }).type !== "string") return null;
    return v as AgentEvent;
  } catch {
    return null;
  }
}

/** 같은 id의 단계는 갱신, 새 id는 뒤에 추가 */
const upsertStep = (steps: AgentStep[] = [], step: AgentStep) =>
  steps.some((s) => s.id === step.id) ? steps.map((s) => (s.id === step.id ? step : s)) : [...steps, step];
const upsertPlan = (plans: AgentPlan[] = [], plan: AgentPlan) =>
  plans.some((p) => p.id === plan.id) ? plans.map((p) => (p.id === plan.id ? plan : p)) : [...plans, plan];

function applyEvent(m: AgentMessage, e: AgentEvent): AgentMessage {
  switch (e.type) {
    case "step":
      return { ...m, steps: upsertStep(m.steps, e.step) };
    case "reply":
      return { ...m, content: m.content ? `${m.content}\n\n${e.content}` : e.content };
    case "plan":
      return { ...m, plans: upsertPlan(m.plans, e.plan) };
    case "error":
      return { ...m, error: e.error };
    case "done":
      return { ...m, streaming: false };
  }
}

/**
 * Sales Agent 대화 상태. CrmApp에서 호출해 화면을 옮겨도 대화가 유지된다 (새로고침 시 초기화).
 * 답변은 /api/agent의 NDJSON 스트림을 줄 단위로 읽어 진행 단계·답변·실행 계획을 바로 반영한다.
 */
export function useAgentChat({ onChanged }: { onChanged: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** send에서 최신 대화 내역을 읽기 위한 참조 */
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchMessage = useCallback((id: string, fn: (m: AgentMessage) => AgentMessage) => {
    setMessages((list) => list.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const content = text.trim();
      if (!content || abortRef.current) return false;
      // 서버에는 역할·본문만 보낸다 (실패한 답변·빈 답변 제외)
      const history = messagesRef.current
        .filter((m) => m.content.trim() && !m.streaming)
        .map((m) => ({ role: m.role, content: m.content }));
      const userMsg: AgentMessage = { id: newId(), role: "user", content };
      const replyId = newId();
      setMessages((list) => [...list, userMsg, { id: replyId, role: "assistant", content: "", streaming: true }]);
      setBusy(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...history, { role: "user", content }] }),
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return true;
        }
        if (!res.ok || !res.body) {
          const body: unknown = await res.json().catch(() => ({}));
          const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
          throw new Error(msg || `요청 실패 (${res.status})`);
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const event = line.trim() ? parseEvent(line) : null;
            if (event) patchMessage(replyId, (m) => applyEvent(m, event));
          }
        }
        const last = buf.trim() ? parseEvent(buf) : null;
        if (last) patchMessage(replyId, (m) => applyEvent(m, last));
        // done 이벤트 없이 끊겨도 진행 중 표시는 끝낸다
        patchMessage(replyId, (m) =>
          m.streaming ? { ...m, streaming: false, error: m.error ?? (m.content ? undefined : "응답이 중간에 끊겼습니다") } : m
        );
      } catch (e) {
        if (ctrl.signal.aborted) return true;
        patchMessage(replyId, (m) => ({ ...m, streaming: false, error: (e as Error).message }));
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setBusy(false);
        }
      }
      return true;
    },
    [patchMessage]
  );

  /** 계획 승인/취소: 서버가 돌려준 계획으로 카드를 바꾼다. 실패하면 카드에 사유를 보여주고 다시 누를 수 있게 둔다 */
  const decide = useCallback(
    async (messageId: string, plan: AgentPlan, action: "approve" | "cancel") => {
      const setPlan = (p: AgentPlan) => patchMessage(messageId, (m) => ({ ...m, plans: upsertPlan(m.plans, p) }));
      setPlan({ ...plan, status: "running", message: undefined });
      try {
        const next = await api<AgentPlan>(`/api/agent/actions/${encodeURIComponent(plan.id)}/${action}`, { method: "POST" });
        setPlan(next);
        // 실행되면 리드·노트·일정·회사·연락처 화면 데이터를 새로 불러온다
        if (next.status === "done") onChanged();
      } catch (e) {
        setPlan({ ...plan, status: "pending", message: (e as Error).message });
      }
    },
    [patchMessage, onChanged]
  );

  const approve = useCallback((messageId: string, plan: AgentPlan) => decide(messageId, plan, "approve"), [decide]);
  const cancel = useCallback((messageId: string, plan: AgentPlan) => decide(messageId, plan, "cancel"), [decide]);

  /** 한 답변의 승인 대기 계획을 차례로 모두 승인 (각각 따로 실행되고, 실패는 카드마다 표시) */
  const approveAll = useCallback(
    async (messageId: string) => {
      const pending = messagesRef.current.find((m) => m.id === messageId)?.plans?.filter((p) => p.status === "pending") ?? [];
      for (const p of pending) await decide(messageId, p, "approve");
    },
    [decide]
  );

  /** 새 대화: 받는 중인 답변은 중단 */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages([]);
  }, []);

  return { messages, busy, send, approve, approveAll, cancel, reset };
}

export type AgentChat = ReturnType<typeof useAgentChat>;
