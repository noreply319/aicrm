"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentDecision, AgentEvent, AgentMessage, AgentPlan, AgentStep, ConversationDetail, ConversationSummary } from "./types";

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
    case "conversation":
      return m;
  }
}

/**
 * AI Assistant 대화 상태. CrmApp에서 호출해 화면을 옮겨도 대화가 유지된다.
 * 답변은 /api/assistant의 NDJSON 스트림을 줄 단위로 읽어 진행 단계·답변·실행 계획을 바로 반영한다.
 * 승인·취소는 /api/agent/actions.
 * 대화 기록은 서버에 저장된다: 처음에 가장 최근 대화를 불러오고(다른 기기에서 이어 보기), 이전 대화는 목록에서 연다.
 */
const ENDPOINT = "/api/assistant";

export function useAgentChat({ onChanged }: { onChanged: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [busy, setBusy] = useState(false);
  /** 지금 보고 있는 저장된 대화 (null = 아직 저장 안 된 새 대화) */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /** 처음 불러오기 끝났는지 (그 전에는 빈 화면 안내를 보이지 않는다) */
  const [loaded, setLoaded] = useState(false);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
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
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...history, { role: "user", content }], conversationId: conversationRef.current }),
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

        // 대화 이벤트: 저장될 대화를 기억하고 목록 맨 위로 (나머지는 답변 메시지에 반영)
        const handle = (event: AgentEvent) => {
          if (event.type !== "conversation") return patchMessage(replyId, (m) => applyEvent(m, event));
          const c = { ...event.conversation, updatedAt: new Date().toISOString() };
          conversationRef.current = c.id;
          setConversationId(c.id);
          setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)]);
        };
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
            if (event) handle(event);
          }
        }
        const last = buf.trim() ? parseEvent(buf) : null;
        if (last) handle(last);
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
        const { followUps, ...next } = await api<AgentDecision>(`/api/agent/actions/${encodeURIComponent(plan.id)}/${action}`, { method: "POST" });
        setPlan(next);
        // 실행 뒤 이어서 제안하는 계획 카드 (예: 발송 후 단계 이동)
        if (followUps?.length) patchMessage(messageId, (m) => ({ ...m, plans: followUps.reduce(upsertPlan, m.plans ?? []) }));
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

  /**
   * 한 답변의 승인 대기 계획을 차례로 모두 승인 (각각 따로 실행되고, 실패는 카드마다 표시).
   * 발송·삭제 같은 되돌릴 수 없는 계획(danger)은 빼고 카드에서 하나씩 승인하게 한다
   */
  const approveAll = useCallback(
    async (messageId: string) => {
      const pending = messagesRef.current.find((m) => m.id === messageId)?.plans?.filter((p) => p.status === "pending" && !p.danger) ?? [];
      for (const p of pending) await decide(messageId, p, "approve");
    },
    [decide]
  );

  /** 멈추기: 받는 중인 답변을 끊는다 (그때까지 온 답변·계획 카드는 남긴다) */
  const stop = useCallback(() => {
    const ctrl = abortRef.current;
    if (!ctrl) return;
    ctrl.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages((list) =>
      list.map((m) =>
        m.streaming ? { ...m, streaming: false, error: m.content || m.plans?.length ? m.error : "답변을 멈췄습니다" } : m
      )
    );
  }, []);

  /** 새 대화: 받는 중인 답변은 중단 (이전 대화는 목록에 남는다 — 답변은 서버가 끝까지 저장) */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages([]);
    conversationRef.current = null;
    setConversationId(null);
  }, []);

  /** 저장된 대화 열기 (받는 중인 답변은 중단). quiet: 다시 불러오기 — 실패해도 지금 화면 유지 */
  const open = useCallback(async (id: string, { quiet = false } = {}) => {
    if (!quiet) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(false);
    }
    try {
      const c = await api<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`);
      // 불러오는 사이 다른 대화로 바뀌었거나 답변을 받는 중이면 덮어쓰지 않는다
      if (quiet && (conversationRef.current !== id || abortRef.current)) return;
      conversationRef.current = c.id;
      setConversationId(c.id);
      setMessages(c.messages);
    } catch (e) {
      if (quiet) return;
      // 지워진 대화 등: 목록에서 빼고 새 대화로
      setConversations((list) => list.filter((x) => x.id !== id));
      conversationRef.current = null;
      setConversationId(null);
      setMessages([{ id: newId(), role: "assistant", content: "", error: (e as Error).message }]);
    }
  }, []);

  /** 대화 삭제 (지금 보던 대화면 새 대화로) */
  const remove = useCallback(
    async (id: string) => {
      await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConversations((list) => list.filter((x) => x.id !== id));
      if (conversationRef.current === id) reset();
    },
    [reset]
  );

  /** 목록 다시 불러오기 → first면 가장 최근 대화를 연다 (처음 불러오기는 실패하면 한 번 더) */
  const refresh = useCallback(
    async (first: boolean) => {
      const load = () => api<ConversationSummary[]>("/api/conversations").catch(() => null);
      let list = await load();
      if (!list && first) list = await new Promise<ConversationSummary[] | null>((r) => setTimeout(() => load().then(r), 1500));
      if (!list) return;
      setConversations(list);
      if (first && list[0] && !conversationRef.current && messagesRef.current.length === 0) await open(list[0].id);
    },
    [open]
  );

  // 처음: 가장 최근 대화를 이어서 보여준다 (다른 기기에서 하던 대화 포함)
  useEffect(() => {
    let alive = true;
    refresh(true).finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 다시 이 탭·앱으로 돌아오면 목록과 보던 대화를 새로 불러온다 (다른 기기에서 이어 쓴 내용·승인 상태)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || abortRef.current) return;
      refresh(false);
      if (conversationRef.current) open(conversationRef.current, { quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh, open]);

  /** 대화 목록을 열 때: 다른 기기에서 새로 만든 대화까지 */
  const refreshList = useCallback(() => {
    refresh(false);
  }, [refresh]);

  return { messages, busy, send, stop, approve, approveAll, cancel, reset, conversationId, conversations, loaded, open, remove, refreshList };
}

export type AgentChat = ReturnType<typeof useAgentChat>;
