import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { CardContactConflict, CardSaveError, saveBusinessCard } from "@/lib/businessCard";
import { withTransaction } from "@/lib/events";
import { parseBusinessCardSave } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * 명함 저장: 회사(기존 연결 또는 새로 생성) + 연락처를 한 트랜잭션에서 만든다 → 201 BusinessCardSaved.
 * 같은 이메일 연락처가 있으면 409 + { error, contact: 기존 연락처 } (새 회사도 만들지 않음).
 */
export async function POST(req: Request) {
  const parsed = parseBusinessCardSave(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const userId = await requestUserId();

  try {
    const r = await withTransaction((client) => saveBusinessCard(client, userId, parsed.data));
    if (r.ok) return NextResponse.json(r.saved, { status: 201 });
    return NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) {
    if (e instanceof CardContactConflict) return NextResponse.json({ error: e.error, contact: e.existing }, { status: 409 });
    if (e instanceof CardSaveError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
