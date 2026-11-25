import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { deleteConversation, getConversation } from "@/lib/chatStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "대화를 찾을 수 없습니다" }, { status: 404 });

/** 대화 + 메시지 (본인 것만, 계획 카드는 지금 승인 상태로) */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const conversation = await getConversation(userId, id);
  return conversation ? NextResponse.json(conversation) : notFound();
}

/** 대화 삭제 (본인 것만). 실행한 계획의 감사 기록(agent_actions)은 그대로 남는다 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const userId = await requestUserId();
  if (!userId) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  return (await deleteConversation(userId, id)) ? new NextResponse(null, { status: 204 }) : notFound();
}
