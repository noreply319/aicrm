import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { DELETE as DELETE_LEAD } from "@/app/api/leads/[id]/route";
import { GET as LIST, POST as CREATE } from "@/app/api/meetings/route";
import { DELETE, GET, PATCH } from "@/app/api/meetings/[id]/route";
import { POST as TRANSCRIBE } from "@/app/api/meetings/transcribe/route";
import type { Lead, MeetingNote, MeetingNoteSummary } from "@/lib/types";
import { closeDb, ctx, events, leadInput, noteInput, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(closeDb);

const newLead = async (company = "한빛소프트") =>
  (await (await CREATE_LEAD(req("POST", leadInput({ company })))).json()) as Lead;
const newNote = async (over = {}) => (await (await CREATE(req("POST", noteInput(over)))).json()) as MeetingNote;
const noteEvents = async (leadId: string) => (await events(leadId)).filter((e) => e.type.startsWith("note_"));

describe("미팅 노트 API", () => {
  it("리드 없이 저장할 수 있고(녹음 자동 저장), 이때는 리드 이력을 남기지 않는다", async () => {
    const res = await CREATE(req("POST", noteInput()));
    expect(res.status).toBe(201);
    const note = (await res.json()) as MeetingNote;
    expect(note.leadId).toBeNull();
    expect(await events()).toEqual([]);
  });

  it("나중에 리드를 연결하면 그 리드에, 연결을 해제하면 이전 리드에 note_updated를 남긴다", async () => {
    const lead = await newLead();
    const note = await newNote();

    const linked = await PATCH(req("PATCH", noteInput({ leadId: lead.id })), ctx(note.id));
    expect((await linked.json()).leadId).toBe(lead.id);

    await PATCH(req("PATCH", noteInput({ leadId: null })), ctx(note.id));

    const ev = await noteEvents(lead.id);
    expect(ev.map((e) => e.type)).toEqual(["note_updated", "note_updated"]);
    expect(ev[0].changes.leadId).toEqual({ from: null, to: lead.id });
    expect(ev[1].changes.leadId).toEqual({ from: lead.id, to: null });
  });

  it("리드에 연결해 만들면 note_created, 삭제하면 note_deleted", async () => {
    const lead = await newLead();
    const note = await newNote({ leadId: lead.id });
    expect((await DELETE(req("DELETE"), ctx(note.id))).status).toBe(204);
    expect((await GET(req("GET"), ctx(note.id))).status).toBe(404);
    expect((await noteEvents(lead.id)).map((e) => e.type)).toEqual(["note_created", "note_deleted"]);
  });

  it("없는 리드에 연결하려 하면 400, 노트는 만들어지지 않는다", async () => {
    const res = await CREATE(req("POST", noteInput({ leadId: "00000000-0000-4000-8000-000000000000" })));
    expect(res.status).toBe(400);
    expect(await (await LIST(req("GET"))).json()).toEqual([]);
  });

  it("목록은 미팅 일시 최신순 + 본문 미리보기, ?leadId=로 리드별 조회", async () => {
    const lead = await newLead();
    await newNote({ title: "이전", metAt: "2026-11-01T00:00:00.000Z", leadId: lead.id });
    await newNote({ title: "최근", metAt: "2026-11-20T00:00:00.000Z", body: "가".repeat(500) });

    const all = (await (await LIST(req("GET", undefined, "http://test.local/api/meetings"))).json()) as MeetingNoteSummary[];
    expect(all.map((n) => n.title)).toEqual(["최근", "이전"]);
    expect(all[0].preview).toHaveLength(200);
    expect(all[0]).not.toHaveProperty("body");

    const byLead = (await (
      await LIST(req("GET", undefined, `http://test.local/api/meetings?leadId=${lead.id}`))
    ).json()) as MeetingNoteSummary[];
    expect(byLead.map((n) => n.title)).toEqual(["이전"]);

    expect((await LIST(req("GET", undefined, "http://test.local/api/meetings?leadId=bad"))).status).toBe(400);
  });

  it("리드를 삭제하면 연결된 노트도 함께 삭제된다 (리드 미지정 노트는 남는다)", async () => {
    const lead = await newLead();
    await newNote({ leadId: lead.id });
    await newNote({ leadId: null, title: "미지정" });
    await DELETE_LEAD(req("DELETE"), ctx(lead.id));
    const rest = (await (await LIST(req("GET", undefined, "http://test.local/api/meetings"))).json()) as MeetingNoteSummary[];
    expect(rest.map((n) => n.title)).toEqual(["미지정"]);
  });
});

describe("전사 API 입력 검증 (OpenAI는 가짜 응답)", () => {
  const form = (fill: (f: FormData) => void) => {
    const f = new FormData();
    fill(f);
    return new Request("http://test.local/api/meetings/transcribe", { method: "POST", body: f });
  };
  const audio = (size = 10, type = "audio/webm") => new File([new Uint8Array(size)], "seg.webm", { type });
  afterEach(() => vi.unstubAllGlobals());

  it("파일이 없거나 형식이 다르면 거부한다", async () => {
    expect((await TRANSCRIBE(form(() => {}))).status).toBe(400);
    expect((await TRANSCRIBE(form((f) => f.append("audio", audio(10, "text/plain"))))).status).toBe(415);
  });

  it("화자 정보는 이름·참조 음성 쌍으로 최대 4개", async () => {
    const tooMany = form((f) => {
      f.append("audio", audio());
      for (let i = 0; i < 5; i++) {
        f.append("speakerName", `화자 ${i}`);
        f.append("speakerRef", audio(10, "audio/wav"));
      }
    });
    expect((await TRANSCRIBE(tooMany)).status).toBe(400);
    const unpaired = form((f) => {
      f.append("audio", audio());
      f.append("speakerName", "화자 1");
    });
    expect((await TRANSCRIBE(unpaired)).status).toBe(400);
  });

  it("정상 요청은 화자별 발화를 돌려주고, OpenAI 오류는 한국어 메시지로 바꾼다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      text: "안녕하세요",
      segments: [{ speaker: "A", start: 0, end: 1, text: "안녕하세요" }],
    }))));
    const ok = await TRANSCRIBE(form((f) => f.append("audio", audio())));
    expect(await ok.json()).toEqual({ text: "안녕하세요", utterances: [{ speaker: "A", start: 0, end: 1, text: "안녕하세요" }] });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    const limited = await TRANSCRIBE(form((f) => f.append("audio", audio())));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/한도/);
  });
});
