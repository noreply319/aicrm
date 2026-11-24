"use client";

import { useEffect, useState } from "react";

/**
 * CSS 미디어 쿼리 일치 여부. 첫 렌더는 false(서버 렌더와 같게)이고 마운트 후 실제 값으로 바뀐다.
 * 레이아웃은 CSS로 처리하고, CSS로 못 바꾸는 것(입력 안내 문구 등)에만 쓴다.
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
