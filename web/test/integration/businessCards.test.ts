import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as SAVE } from "@/app/api/business-cards/route";
import { POST as EXTRACT } from "@/app/api/business-cards/extract/route";
import { POST as CREATE_COMPANY } from "@/app/api/companies/route";
import { POST as CREATE_CONTACT } from "@/app/api/contacts/route";
import { pool } from "@/lib/db";
import type { BusinessCardExtract, BusinessCardSaved, Company, Contact } from "@/lib/types";
import { closeDb, req, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  process.env.OPENAI_API_KEY = "test-key";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

const save = async (body: unknown) => {
  const res = await SAVE(req("POST", body));
  return { status: res.status, body: (await res.json()) as BusinessCardSaved & { error?: string; contact?: Contact } };
};
const count = async (table: "companies" | "contacts") => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

/** OpenAI 비전 응답 흉내 */
const fakeVision = (content: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })));

const extract = async (files: Blob[]) => {
  const form = new FormData();
  files.forEach((f, i) => form.append("image", f, `c${i}.jpg`));
  const res = await EXTRACT(new Request("http://test.local/api", { method: "POST", body: form }));
  return { status: res.status, body: (await res.json()) as BusinessCardExtract & { error?: string } };
};

describe("명함 분석 API", () => {
  it("기존 회사(도메인)·같은 이메일 연락처를 찾아 돌려주고 DB에는 쓰지 않는다", async () => {
    await CREATE_COMPANY(req("POST", { name: "블루웨이브", emailDomain: "bluewave.io" }));
    await CREATE_CONTACT(req("POST", { name: "이준호", email: "jh@bluewave.io" }));
    fakeVision({ company: { name: "(주)블루웨이브 코리아" }, contact: { name: "이준호", email: "jh@bluewave.io", mobile: "M. 010 1111 2222" } });

    const { status, body } = await extract([new Blob([JPEG], { type: "image/jpeg" })]);
    expect(status).toBe(200);
    expect(body.draft.contact.mobile).toBe("010-1111-2222");
    expect(body.match.company?.name).toBe("블루웨이브");
    expect(body.match.companyByDomain).toBe(true);
    expect(body.match.contactByEmail?.name).toBe("이준호");
    expect(await count("companies")).toBe(1);
    expect(await count("contacts")).toBe(1);
  });

  it("이미지가 아니면 415, 없으면 400, 3장이면 400", async () => {
    expect((await extract([new Blob(["<svg/>"], { type: "image/jpeg" })])).status).toBe(415);
    expect((await extract([])).status).toBe(400);
    const j = new Blob([JPEG]);
    expect((await extract([j, j, j])).status).toBe(400);
  });

  it("이름·회사명을 못 읽으면 422", async () => {
    fakeVision({ company: {}, contact: {} });
    expect((await extract([new Blob([JPEG])])).status).toBe(422);
  });
});

describe("명함 저장 API", () => {
  it("새 회사 + 연락처를 만들고 연락처에 명함 태그·메모를 남긴다", async () => {
    const { status, body } = await save({
      companyId: null,
      company: { name: "에이크미", emailDomain: "acme.co.kr", phone: "02-555-1234" },
      contact: { name: "김민수", title: "팀장", email: "MS@acme.co.kr", mobile: "010-1234-5678" },
    });
    expect(status).toBe(201);
    expect(body.companyCreated).toBe(true);
    expect(body.company).toMatchObject({ name: "에이크미", emailDomain: "acme.co.kr" });
    expect(body.contact).toMatchObject({ name: "김민수", email: "ms@acme.co.kr", companyId: body.company!.id, tags: ["명함"] });
    expect(body.contact.notes).toMatch(/^명함으로 등록 \(\d{4}-\d{2}-\d{2}\)$/);
  });

  it("같은 이름의 회사가 있으면 새로 만들지 않고 연결한다", async () => {
    const existing = (await (await CREATE_COMPANY(req("POST", { name: "(주)에이크미" }))).json()) as Company;
    const { status, body } = await save({ companyId: null, company: { name: "에이크미 주식회사" }, contact: { name: "김민수" } });
    expect(status).toBe(201);
    expect(body.companyCreated).toBe(false);
    expect(body.contact.companyId).toBe(existing.id);
    expect(await count("companies")).toBe(1);
  });

  it("같은 이메일 연락처가 있으면 409 + 기존 연락처, 새 회사도 만들지 않는다 (한 트랜잭션)", async () => {
    await CREATE_CONTACT(req("POST", { name: "이준호", email: "jh@bluewave.io" }));
    const { status, body } = await save({ companyId: null, company: { name: "블루웨이브" }, contact: { name: "이준호", email: "jh@bluewave.io" } });
    expect(status).toBe(409);
    expect(body.contact?.name).toBe("이준호");
    expect(await count("companies")).toBe(0);
  });

  it("기존 회사 id로 연결, 없는 id면 404, 잘못된 입력은 400", async () => {
    const c = (await (await CREATE_COMPANY(req("POST", { name: "그린랩" }))).json()) as Company;
    expect((await save({ companyId: c.id, company: null, contact: { name: "박" } })).body.contact.companyId).toBe(c.id);
    expect((await save({ companyId: "00000000-0000-4000-8000-000000000000", company: null, contact: { name: "최" } })).status).toBe(404);
    expect((await save({ companyId: null, company: null, contact: { name: "" } })).status).toBe(400);
    expect((await save({ companyId: null, company: null, contact: { name: "정", mobile: "010-abc" } })).status).toBe(400);
  });
});
