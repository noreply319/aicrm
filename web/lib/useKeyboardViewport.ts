"use client";

import { useEffect } from "react";

/** 보이는 영역이 창보다 이만큼(px) 이상 작으면 키보드가 열린 것으로 본다 */
const KEYBOARD_MIN = 120;
/** 입력칸을 누르거나 벗어난 뒤 키보드가 올라오고 내려가는 동안 매 프레임 맞추는 시간 (ms) */
const TRACK_MS = 700;

/**
 * 모바일 AI 채팅 화면(첫 화면·전체 화면 채팅)용.
 *  - 채팅 화면은 페이지 자체가 스크롤되지 않게 잠근다(html.chat-screen). iOS는 100vh가 보이는 영역보다 커서
 *    대화 목록 끝에서 위로 더 끌면 페이지가 같이 출렁이고, 아래 보정과 맞물려 화면이 떨렸다.
 *  - 키보드가 열려도 화면이 통째로 밀려 올라가지 않고 입력창만 키보드 위에 붙는다.
 *    iOS Safari는 키보드가 열리면 화면 크기는 그대로 두고 페이지 전체를 밀어 올린다
 *    → 보이는 영역(visualViewport)의 높이·위치를 CSS 변수(--vv-h, --vv-top)로 넘겨 채팅 화면을 거기에 맞추고,
 *      밀린 페이지 스크롤은 되돌린다. 이 보정은 키보드가 열린 동안에만 한다.
 *  - Android Chrome은 viewport의 interactive-widget=resizes-content로 화면 자체가 줄어든다 (layout.tsx).
 * 키보드가 열린 동안 html에 .kb-open을 붙인다(채팅 화면은 상단 바를 숨기고 탭 줄을 줄여 대화 공간을 넓힌다).
 * 입력칸을 누르면 키보드가 올라오는 동안 매 프레임 맞춰, 키보드가 다 열린 뒤 한 번에 맞추며 화면이 튀던 것을 줄인다.
 * active가 false가 되면 모두 지워 CSS 기본값(100dvh)으로 돌아간다.
 */
export function useKeyboardViewport(active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    root.classList.add("chat-screen");
    const apply = () => {
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
    };
    let frame = 0;
    let trackUntil = 0;
    const update = () => {
      if (performance.now() < trackUntil) return; // 매 프레임 맞추는 중이면 그쪽에 맡긴다
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    // 키보드가 올라오고 내려가는 동안 매 프레임 (resize 이벤트는 애니메이션이 끝난 뒤에야 오기도 한다)
    const tick = () => {
      apply();
      frame = performance.now() < trackUntil ? requestAnimationFrame(tick) : 0;
    };
    const track = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])")) return;
      trackUntil = performance.now() + TRACK_MS;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", track);
    document.addEventListener("focusout", track);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", track);
      document.removeEventListener("focusout", track);
      root.style.removeProperty("--vv-h");
      root.style.removeProperty("--vv-top");
      root.classList.remove("kb-open", "chat-screen");
    };
  }, [active]);
}
