"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 바닥에서 이 거리(px) 안이면 "맨 아래를 보는 중"으로 본다 */
const NEAR_BOTTOM = 80;

/**
 * 대화 목록 자동 스크롤: 사용자가 맨 아래를 보고 있을 때만 새 내용이 오면 따라 내려간다.
 * 위로 올려 읽는 중에는 스트리밍 답변이 와도 위치를 바꾸지 않는다 (모바일에서 끌어내려 화면이 떨리던 문제).
 * signals(대화 목록·카드 수 등)가 바뀔 때마다, 그리고 목록 높이가 바뀔 때(키보드) 확인한다 (signals 개수는 호출마다 같아야 한다). 돌려주는 함수는 "맨 아래로 (이후 갱신도 따라가기)" — 메시지를 보낼 때·모바일 입력칸을 누를 때 호출.
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
    // 목록 높이가 줄어도(모바일 키보드가 올라옴) 맨 아래를 보던 중이면 마지막 대화가 계속 보이게
    const resize = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    // 부드러운 스크롤은 애니메이션 중 scroll 이벤트로 "바닥 아님"이 되어 따라가기가 끊기므로 바로 이동
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signals는 호출마다 개수가 같다
  }, [ref, ...signals]);

  return useCallback(() => {
    atBottom.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);
}
