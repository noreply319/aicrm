import "server-only";
import { NextResponse } from "next/server";
import { UUID_RE } from "./validate";

/**
 * Sales Agent 서버 로직. 지금은 승인/취소 API 자리만 있다 —
 * 도구 레지스트리·계획 저장(agent_actions)·승인 실행은 AIC-3에서 이 파일에 추가한다.
 */
export function agentActionNotReady(id: string): NextResponse {
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "실행 계획을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ error: "실행 기능은 준비 중입니다" }, { status: 501 });
}
