"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * 입력 내용에 맞춰 textarea 높이를 늘린다 (기본 한 줄 → 최대 maxRows줄, 넘으면 내부 스크롤).
 * enabled가 false면 아무것도 하지 않는다 (CSS 높이를 그대로 쓴다).
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxRows = 5, enabled = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = (parseFloat(cs.lineHeight) || 20) * maxRows + padding + border;
    el.style.height = "auto";
    const full = el.scrollHeight + border; // box-sizing: border-box
    el.style.height = `${Math.min(full, max)}px`;
    el.style.overflowY = full > max ? "auto" : "hidden";
  }, [ref, value, maxRows, enabled]);
}
