import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { disconnectFeature, unauthorized } from "@/lib/google";

export const dynamic = "force-dynamic";

/**
 * 캘린더 연동 해제 (이미 등록한 일정은 캘린더에 남는다).
 * Gmail이 연동돼 있으면 토큰은 그대로 두고 캘린더만 끈다.
 */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  await disconnectFeature(user, "calendar");
  return new NextResponse(null, { status: 204 });
}
