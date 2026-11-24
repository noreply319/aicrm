import { NextResponse } from "next/server";
import { featureState, getSessionUser } from "@/lib/auth";
import { listCalendars } from "@/lib/calendar";
import { pool } from "@/lib/db";
import { canSendGmail, googleErrorResponse, unauthorized } from "@/lib/google";
import type { Me } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 로그인 사용자 + 캘린더·Gmail 연동 상태 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const me: Me = {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    calendar: {
      state: featureState(user, "calendar"),
      calendarId: user.calendarId,
    },
    gmail: { state: featureState(user, "gmail"), canSend: canSendGmail(user) },
  };
  return NextResponse.json(me);
}

/** 일정을 등록·조회할 캘린더 변경: { calendarId } (쓰기 가능한 캘린더만) */
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body: unknown = await req.json().catch(() => null);
  const calendarId = body && typeof body === "object" ? (body as Record<string, unknown>).calendarId : null;
  if (typeof calendarId !== "string" || !calendarId || calendarId.length > 300) {
    return NextResponse.json({ error: "캘린더를 선택하세요" }, { status: 400 });
  }
  try {
    const calendars = await listCalendars(user);
    if (!calendars.some((c) => c.id === calendarId)) {
      return NextResponse.json({ error: "선택할 수 없는 캘린더입니다" }, { status: 400 });
    }
    await pool.query("UPDATE users SET calendar_id = $2, updated_at = now() WHERE id = $1", [user.id, calendarId]);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return googleErrorResponse(e);
  }
}
