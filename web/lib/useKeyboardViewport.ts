"use client";

import { useEffect } from "react";

/** 보이는 영역이 창보다 이만큼(px) 이상 작으면 키보드가 열린 것으로 본다 */
const KEYBOARD_MIN = 120;

/**
 * 모바일 AI 채팅 화면(첫 화면·전체 화면 채팅)용.
 *  - 채팅 화면은 페이지 자체가 스크롤되지 않게 잠근다(html.chat-screen). iOS는 100vh가 보이는 영역보다 커서
 *    대화 목록 끝에서 위로 더 끌면 페이지가 같이 출렁이고, 아래 보정과 맞물려 화면이 떨렸다.
 *  - 키보드가 열려도 상단(상단 바·헤더)은 제자리에 두고 입력창만 키보드 위로 올린다.
 *    iOS Safari는 키보드가 열리면 화면 크기는 그대로 두고 페이지 전체를 밀어 올린다
 *    → 보이는 영역(visualViewport)의 높이·위치를 CSS 변수(--vv-h, --vv-top)로 넘겨 채팅 화면을 거기에 맞추고,
 *      밀린 페이지 스크롤은 되돌린다. 이 보정은 키보드가 열린 동안에만 한다.
 *  - Android Chrome은 viewport의 interactive-widget=resizes-content로 화면 자체가 줄어든다 (layout.tsx).
 * 키보드가 열린 동안 html에 .kb-open을 붙인다. active가 false가 되면 모두 지워 CSS 기본값(100dvh)으로 돌아간다.
 */
export function useKeyboardViewport(active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    root.classList.add("chat-screen");
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const keyboard = window.innerHeight - vv.height > KEYBOARD_MIN;
        root.classList.toggle("kb-open", keyboard);
        if (!keyboard) {
          // 키보드가 없으면 보정하지 않는다 (스크롤 중 주소창 변화·튕김마다 화면을 옮기면 떨린다)
          root.style.removeProperty("--vv-h");
          root.style.removeProperty("--vv-top");
          return;
        }
        if (window.scrollY !== 0) window.scrollTo(0, 0);
        root.style.setProperty("--vv-h", `${vv.height}px`);
        root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
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
      root.classList.remove("kb-open", "chat-screen");
    };
  }, [active]);
}
