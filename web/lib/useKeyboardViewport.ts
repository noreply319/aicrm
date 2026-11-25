"use client";

import { useEffect } from "react";

/**
 * 모바일 키보드가 열려도 상단(상단 바·헤더)은 제자리에 두고 입력창만 키보드 위로 올린다.
 *  - iOS Safari는 키보드가 열리면 화면 크기는 그대로 두고 페이지 전체를 밀어 올린다.
 *    → 보이는 영역(visualViewport)의 높이·위치를 CSS 변수(--vv-h, --vv-top)로 넘겨
 *      채팅 화면을 보이는 영역에 딱 맞추고, 밀린 페이지 스크롤은 되돌린다.
 *  - Android Chrome은 viewport의 interactive-widget=resizes-content로 화면 자체가 줄어든다 (layout.tsx).
 * 키보드가 열린 동안 html에 .kb-open을 붙인다. active가 false가 되면 변수를 지워 CSS 기본값(100dvh)으로 돌아간다.
 */
export function useKeyboardViewport(active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (window.scrollY !== 0) window.scrollTo(0, 0);
        root.style.setProperty("--vv-h", `${vv.height}px`);
        root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
        // 키보드가 열린 동안은 하단 안전 영역(홈 인디케이터) 여백이 필요 없다
        root.classList.toggle("kb-open", window.innerHeight - vv.height > 120);
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--vv-h");
      root.style.removeProperty("--vv-top");
      root.classList.remove("kb-open");
    };
  }, [active]);
}
