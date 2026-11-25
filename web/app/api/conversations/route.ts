import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { listConversations } from "@/lib/chatStore";

export const dynamic = "force-dynamic";

/** 내 대화 목록 (최근 50개): ?source=assistant(AI Assistant) | agent(Sales Agent) */
export async function GET(req: Request) {
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const source = new URL(req.url).searchParams.get("source");
  if (source !== "assistant" && source !== "agent") return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  return NextResponse.json(await listConversations(userId, source));
}
