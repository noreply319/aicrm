import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
import { recordEvent } from "@/lib/events";
import { isStage, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 카드 이동: { stage, beforeId }
 * beforeId 카드 바로 앞에 오도록 두 이웃 position의 중간값을 부여한다 (null이면 맨 뒤).
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const stage = body?.stage;
  const beforeId: string | null = body?.beforeId ?? null;

  if (!UUID_RE.test(id) || !isStage(stage) || (beforeId !== null && !UUID_RE.test(beforeId))) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let position: number;
    const before = beforeId
      ? (await client.query<{ position: number }>("SELECT position FROM leads WHERE id=$1", [beforeId])).rows[0]
      : undefined;

    if (before) {
      const { rows } = await client.query<{ prev: number | null }>(
        "SELECT max(position) AS prev FROM leads WHERE position < $1 AND id <> $2",
        [before.position, id]
      );
      const prev = rows[0].prev;
      position = prev === null ? before.position - 1 : (prev + before.position) / 2;
    } else {
      const { rows } = await client.query<{ max: number | null }>(
        "SELECT max(position) AS max FROM leads WHERE id <> $1",
        [id]
      );
      position = (rows[0].max ?? 0) + 1;
    }

    // 이력용: 이동 전 단계 (같은 단계 안에서 순서만 바뀐 경우는 기록하지 않음)
    const prev = (
      await client.query<{ stage: string }>("SELECT stage FROM leads WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];

    const { rows } = await client.query<LeadRow>(
      `UPDATE leads SET stage=$2, position=$3, updated_at=now() WHERE id=$1 RETURNING ${LEAD_COLUMNS}`,
      [id, stage, position]
    );
    if (rows[0] && prev && prev.stage !== stage) {
      await recordEvent(client, id, rows[0].company, "moved", { stage: { from: prev.stage, to: stage } });
    }
    await client.query("COMMIT");
    return rows[0]
      ? NextResponse.json(toLead(rows[0]))
      : NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
