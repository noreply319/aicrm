import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatShortWon, formatWon, fromLocalInput, isOverdue, toLocalInput } from "@/lib/format";

describe("금액 표시", () => {
  it("formatWon: 천 단위 구분", () => {
    expect(formatWon(45_000_000)).toBe("₩45,000,000");
    expect(formatWon(0)).toBe("₩0");
  });

  it("formatShortWon: 억·만 단위 축약", () => {
    expect(formatShortWon(310_000_000)).toBe("₩3.1억");
    expect(formatShortWon(100_000_000)).toBe("₩1억");
    expect(formatShortWon(18_000_000)).toBe("₩1,800만");
    expect(formatShortWon(5_000)).toBe("₩5,000");
  });
});

describe("isOverdue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("오늘 이전 마감일만 지난 것으로 본다", () => {
    expect(isOverdue("2026-11-23")).toBe(true);
    expect(isOverdue("2026-11-25")).toBe(false);
    expect(isOverdue("")).toBe(false);
  });
});

describe("datetime-local 변환", () => {
  it("ISO ↔ 입력값 왕복 시 분 단위까지 같다", () => {
    const iso = new Date(2026, 10, 24, 14, 5).toISOString();
    const local = toLocalInput(iso);
    expect(local).toBe("2026-11-24T14:05");
    expect(fromLocalInput(local)).toBe(iso);
  });

  it("잘못된 값은 빈 문자열", () => {
    expect(fromLocalInput("not-a-date")).toBe("");
    expect(toLocalInput("not-a-date")).toBe("");
  });
});
