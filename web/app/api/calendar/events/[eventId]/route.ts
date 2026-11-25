import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import { cancelSchedule, findOwnedSchedule, updateSchedule } from "@/lib/scheduleOps";
import { pool } from "@/lib/db";
import { parseEventInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ eventId: string }> };

/** 일정 변경 (재확정) → 구글 이벤트 갱신. CRM에서 등록한 내 일정만 (구글 캘린더의 다른 일정은 읽기 전용) */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { eventId } = await params;
  const owned = await findOwnedSchedule(pool, { eventId }, user.id);
  if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status });

  const parsed = parseEventInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const r = await updateSchedule(user, owned.row, parsed.data);
    return r.ok ? NextResponse.json({ event: r.event, schedule: r.schedule }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) {
    return googleErrorResponse(e);
  }
}

/** 일정 취소 → 구글 이벤트 삭제 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { eventId } = await params;
  const owned = await findOwnedSchedule(pool, { eventId }, user.id);
  if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status });
  try {
    await cancelSchedule(user, owned.row);
  } catch (e) {
    return googleErrorResponse(e);
  }
  return new NextResponse(null, { status: 204 });
}
