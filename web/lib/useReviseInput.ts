"use client";

import { useCallback, type RefObject } from "react";
import type { AgentPlan } from "./types";

/**
 * 실행 계획 카드의 "수정 요청": 계획은 취소하고(초안은 저장된 게 없어 그대로), 입력창에 고칠 내용을 적게 한다.
 * AI Assistant(AssistantPanel).
 */
export function useReviseInput(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  setInput: (text: string) => void,
  cancel: (messageId: string, plan: AgentPlan) => void
) {
  return useCallback(
    (messageId: string, plan: AgentPlan) => {
      if (plan.status !== "draft") cancel(messageId, plan);
      setInput(`「${plan.title}」 계획 수정: `);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [inputRef, setInput, cancel]
  );
}
