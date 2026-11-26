import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { listConversations } from "@/lib/chatStore";

export const dynamic = "force-dynamic";

/** 내 대화 목록 (최근 50개, 통합 전 Sales Agent 대화 포함) */
export async function GET() {
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  return NextResponse.json(await listConversations(userId));
}
