import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listCalendars } from "@/lib/calendar";
import { googleErrorResponse, unauthorized } from "@/lib/google";

export const dynamic = "force-dynamic";

/** 일정을 쓸 수 있는 내 캘린더 목록 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  try {
    return NextResponse.json(await listCalendars(user));
  } catch (e) {
    return googleErrorResponse(e);
  }
}
