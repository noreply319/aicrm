import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { addDays, fromKst, listEvents, MAX_RANGE_DAYS } from "@/lib/calendar";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import { registerSchedule, ScheduleError } from "@/lib/schedules";
import { parseDateRange, parseEventInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 내 캘린더 일정: ?start=YYYY-MM-DD&end=YYYY-MM-DD (end 포함, 한국 시간) */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const sp = new URL(req.url).searchParams;
  const range = parseDateRange(sp.get("start"), sp.get("end"), MAX_RANGE_DAYS);
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });
  try {
    const events = await listEvents(user, fromKst(range.data.start), fromKst(addDays(range.data.end, 1)));
    return NextResponse.json(events);
  } catch (e) {
    return googleErrorResponse(e);
  }
}

/** 일정 등록 → 내 구글 캘린더에 이벤트 생성 + CRM 일정 저장 (scheduleId가 있으면 후보 확정) */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const parsed = parseEventInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await registerSchedule(user, parsed.data), { status: 201 });
  } catch (e) {
    if (e instanceof ScheduleError) return NextResponse.json({ error: e.message }, { status: e.status });
    return googleErrorResponse(e);
  }
}
