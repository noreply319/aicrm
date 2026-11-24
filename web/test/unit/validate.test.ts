import { describe, expect, it } from "vitest";
import { NOTE_BODY_MAX } from "@/lib/constants";
import { parseChatInput, parseLeadInput, parseNoteInput, parseSummarizeInput } from "@/lib/validate";

const UUID = "3f2b8c1e-5d4a-4b6f-9a1e-2c3d4e5f6a7b";

describe("parseLeadInput", () => {
  it("정상 입력을 정리해 반환한다 (공백 제거, 금액 반올림)", () => {
    const r = parseLeadInput({ company: "  에이아이랩스 ", value: "1234.6", stage: "proposal", priority: "high" });
    expect(r).toEqual({
      ok: true,
      data: expect.objectContaining({ company: "에이아이랩스", value: 1235, stage: "proposal", priority: "high" }),
    });
  });

  it("회사명이 없으면 거부한다", () => {
    expect(parseLeadInput({ company: "   " })).toEqual({ ok: false, error: "회사명은 필수입니다" });
  });

  it("음수·숫자가 아닌 금액, 잘못된 날짜를 거부한다", () => {
    expect(parseLeadInput({ company: "A", value: -1 }).ok).toBe(false);
    expect(parseLeadInput({ company: "A", value: "abc" }).ok).toBe(false);
    expect(parseLeadInput({ company: "A", closeDate: "2026/12/31" }).ok).toBe(false);
  });

  it("알 수 없는 단계·우선순위는 기본값으로 바꾼다", () => {
    const r = parseLeadInput({ company: "A", stage: "unknown", priority: "urgent" });
    expect(r.ok && r.data.stage).toBe("new");
    expect(r.ok && r.data.priority).toBe("mid");
  });

  it("객체가 아니면 거부한다", () => {
    expect(parseLeadInput(null).ok).toBe(false);
    expect(parseLeadInput("x").ok).toBe(false);
  });
});

describe("parseNoteInput", () => {
  const base = { title: "미팅", metAt: "2026-11-24T05:00:00Z", body: "본문" };

  it("리드 없이도 저장할 수 있다 (null·빈 문자열 → null)", () => {
    for (const leadId of [null, "", undefined]) {
      const r = parseNoteInput({ ...base, leadId });
      expect(r.ok && r.data.leadId).toBeNull();
    }
  });

  it("리드 id는 UUID만 허용한다", () => {
    expect(parseNoteInput({ ...base, leadId: UUID }).ok).toBe(true);
    expect(parseNoteInput({ ...base, leadId: "not-a-uuid" })).toEqual({ ok: false, error: "리드가 올바르지 않습니다" });
  });

  it("미팅 일시를 ISO로 정규화하고, 잘못된 값은 거부한다", () => {
    const r = parseNoteInput(base);
    expect(r.ok && r.data.metAt).toBe("2026-11-24T05:00:00.000Z");
    expect(parseNoteInput({ ...base, metAt: "어제" }).ok).toBe(false);
  });

  it("본문은 줄바꿈·들여쓰기를 보존하고 앞뒤 빈 줄만 지운다", () => {
    const r = parseNoteInput({ ...base, body: "\n\n화자 1: 안녕하세요\n  - 항목\n\n" });
    expect(r.ok && r.data.body).toBe("화자 1: 안녕하세요\n  - 항목");
  });

  it("빈 본문·제목, 너무 긴 본문을 거부한다", () => {
    expect(parseNoteInput({ ...base, body: "  \n " }).ok).toBe(false);
    expect(parseNoteInput({ ...base, title: " " }).ok).toBe(false);
    expect(parseNoteInput({ ...base, body: "가".repeat(NOTE_BODY_MAX + 1) }).ok).toBe(false);
  });

  it("알 수 없는 입력 방식은 manual로 둔다", () => {
    const r = parseNoteInput({ ...base, source: "video" });
    expect(r.ok && r.data.source).toBe("manual");
  });
});

describe("parseChatInput", () => {
  it("마지막 메시지가 사용자 질문이어야 한다", () => {
    expect(parseChatInput({ messages: [{ role: "user", content: "리드 몇 개?" }] }).ok).toBe(true);
    expect(parseChatInput({ messages: [{ role: "assistant", content: "답변" }] }).ok).toBe(false);
  });

  it("잘못된 역할·너무 긴 메시지를 거부하고, 최근 20개만 남긴다", () => {
    expect(parseChatInput({ messages: [{ role: "system", content: "x" }] }).ok).toBe(false);
    expect(parseChatInput({ messages: [{ role: "user", content: "a".repeat(2001) }] }).ok).toBe(false);
    const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    many.push({ role: "user", content: "마지막" });
    const r = parseChatInput({ messages: many });
    expect(r.ok && r.data).toHaveLength(20);
  });
});

describe("parseSummarizeInput", () => {
  it("본문이 있어야 한다", () => {
    expect(parseSummarizeInput({ title: "t", body: "  " }).ok).toBe(false);
    expect(parseSummarizeInput({ title: "t", body: "내용" })).toEqual({ ok: true, data: { title: "t", body: "내용" } });
  });
});
