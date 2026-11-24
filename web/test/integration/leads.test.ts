import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/leads/route";
import { DELETE, PATCH } from "@/app/api/leads/[id]/route";
import { POST as MOVE } from "@/app/api/leads/[id]/move/route";
import type { Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(closeDb);

const create = async (over = {}) => (await (await POST(req("POST", leadInput(over)))).json()) as Lead;

describe("리드 API + 변경 이력", () => {
  it("생성 시 created 이력을 같은 트랜잭션에 남긴다", async () => {
    const res = await POST(req("POST", leadInput()));
    expect(res.status).toBe(201);
    const lead = (await res.json()) as Lead;
    expect(lead).toMatchObject({ company: "테스트상사", stage: "new", closeDate: "2026-12-31" });

    const ev = await events(lead.id);
    expect(ev.map((e) => e.type)).toEqual(["created"]);
    expect(ev[0].changes).not.toHaveProperty("email"); // 스냅샷에 개인정보 없음
  });

  it("잘못된 입력은 400 + 한국어 메시지, DB에 아무것도 남기지 않는다", async () => {
    const res = await POST(req("POST", { company: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "회사명은 필수입니다" });
    expect(await (await GET()).json()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("수정 시 바뀐 필드만 updated 이력에 남기고, 변경이 없으면 이력을 남기지 않는다", async () => {
    const lead = await create();
    const res = await PATCH(req("PATCH", leadInput({ value: 2_000_000 })), ctx(lead.id));
    expect((await res.json()).value).toBe(2_000_000);
    await PATCH(req("PATCH", leadInput({ value: 2_000_000 })), ctx(lead.id));

    const ev = await events(lead.id);
    expect(ev.map((e) => e.type)).toEqual(["created", "updated"]);
    expect(ev[1].changes).toEqual({ value: { from: 1_000_000, to: 2_000_000 } });
  });

  it("없는 리드·잘못된 id는 404", async () => {
    expect((await PATCH(req("PATCH", leadInput()), ctx("not-a-uuid"))).status).toBe(404);
    expect((await DELETE(req("DELETE"), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("삭제 시 deleted 이력은 남는다 (리드가 없어져도 이력 보존)", async () => {
    const lead = await create();
    expect((await DELETE(req("DELETE"), ctx(lead.id))).status).toBe(204);
    expect(await (await GET()).json()).toEqual([]);
    expect((await events(lead.id)).map((e) => e.type)).toEqual(["created", "deleted"]);
  });
});

describe("카드 이동 (단계 + 순서)", () => {
  const order = async () => ((await (await GET()).json()) as Lead[]).map((l) => `${l.company}:${l.stage}`);

  it("다른 단계로 옮기고 beforeId 카드 앞에 배치한다", async () => {
    const a = await create({ company: "A" });
    const b = await create({ company: "B", stage: "contacted" });
    const c = await create({ company: "C", stage: "contacted" });

    // A를 contacted 단계의 C 앞으로
    const res = await MOVE(req("POST", { stage: "contacted", beforeId: c.id }), ctx(a.id));
    expect(res.ok).toBe(true);
    expect(await order()).toEqual(["B:contacted", "A:contacted", "C:contacted"]);
    expect(b.id).toBeTruthy();

    const ev = await events(a.id);
    expect(ev.at(-1)).toMatchObject({ type: "moved" });
  });

  it("beforeId가 null이면 맨 뒤로", async () => {
    const a = await create({ company: "A" });
    await create({ company: "B" });
    await MOVE(req("POST", { stage: "new", beforeId: null }), ctx(a.id));
    expect(await order()).toEqual(["B:new", "A:new"]);
  });

  it("잘못된 단계는 400", async () => {
    const a = await create();
    expect((await MOVE(req("POST", { stage: "closed", beforeId: null }), ctx(a.id))).status).toBe(400);
  });
});
