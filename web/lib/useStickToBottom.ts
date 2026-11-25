"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 바닥에서 이 거리(px) 안이면 "맨 아래를 보는 중"으로 본다 */
const NEAR_BOTTOM = 80;

/**
 * 대화 목록 자동 스크롤: 사용자가 맨 아래를 보고 있을 때만 새 내용이 오면 따라 내려간다.
 * 위로 올려 읽는 중에는 스트리밍 답변이 와도 위치를 바꾸지 않는다 (모바일에서 끌어내려 화면이 떨리던 문제).
 * signals(대화 목록·카드 수 등)가 바뀔 때마다 확인한다 (호출마다 개수는 같아야 한다). 돌려주는 함수는 "다음 갱신 때 맨 아래로" (메시지를 보낼 때 호출).
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, ...signals: unknown[]) {
  const atBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    // 부드러운 스크롤은 애니메이션 중 scroll 이벤트로 "바닥 아님"이 되어 따라가기가 끊기므로 바로 이동
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signals는 호출마다 개수가 같다
  }, [ref, ...signals]);

  return useCallback(() => {
    atBottom.current = true;
  }, []);
}
