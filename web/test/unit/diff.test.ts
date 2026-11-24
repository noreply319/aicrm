import { describe, expect, it } from "vitest";
import { diffLead, snapshot } from "@/lib/events";
import { diffNote, noteSnapshot } from "@/lib/meetings";
import type { Lead, MeetingNote } from "@/lib/types";

const lead: Lead = {
  id: "l1", companyId: null, company: "A사", contactId: null, contact: "김", title: "팀장", email: "a@a.com", phone: "010",
  value: 100, closeDate: "2026-12-01", stage: "new", priority: "mid", notes: "", createdAt: 0,
};

describe("diffLead (리드 변경 이력)", () => {
  it("바뀐 필드만 { from, to }로 기록한다", () => {
    const { id: _i, createdAt: _c, ...input } = lead;
    expect(diffLead(lead, { ...input, value: 200, stage: "contacted" })).toEqual({
      value: { from: 100, to: 200 },
      stage: { from: "new", to: "contacted" },
    });
    expect(diffLead(lead, input)).toEqual({});
  });

  it("스냅샷에는 이메일·전화번호를 넣지 않는다", () => {
    const s = snapshot(lead);
    expect(s).not.toHaveProperty("email");
    expect(s).not.toHaveProperty("phone");
  });
});

const note: MeetingNote = {
  id: "n1", leadId: null, title: "미팅", metAt: "2026-11-24T05:00:00.000Z", source: "recording",
  summary: "", nextActions: "", body: "본문", createdAt: "", updatedAt: "",
};

describe("diffNote (노트 변경 이력)", () => {
  it("리드 연결 변경을 { from, to }로 남기고, 본문은 내용 대신 changed만 남긴다", () => {
    const changes = diffNote(note, { ...note, leadId: "l1", body: "새 본문" });
    expect(changes).toEqual({ leadId: { from: null, to: "l1" }, body: "changed" });
  });

  it("요약·다음 액션 변경은 summary: changed", () => {
    expect(diffNote(note, { ...note, nextActions: "견적서 발송" })).toEqual({ summary: "changed" });
  });

  it("노트 스냅샷에는 본문을 넣지 않는다", () => {
    expect(noteSnapshot(note)).toEqual({ noteId: "n1", title: "미팅", metAt: note.metAt, source: "recording" });
  });
});
