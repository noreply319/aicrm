import { describe, expect, it } from "vitest";
import { docListQuery } from "@/lib/docQuery";

describe("docListQuery (문서 탭: 작성한 문서 요청 읽기)", () => {
  it("목록을 원하는 말이 있으면 종류·검색어를 뽑는다", () => {
    expect(docListQuery("작성한 문서 보여줘")).toEqual({ kind: null, q: "" });
    expect(docListQuery("견적서 목록")).toEqual({ kind: "quote", q: "" });
    expect(docListQuery("엔에스 계약서 찾아줘")).toEqual({ kind: "contract", q: "엔에스" });
    expect(docListQuery("엔에스의 견적서를 보여줘")).toEqual({ kind: "quote", q: "엔에스" });
    expect(docListQuery("최근 견적서 뭐 있어?")).toEqual({ kind: "quote", q: "" });
  });

  it("종류만 말하거나 새로 작성하려는 말은 템플릿 고르기로 둔다 (null)", () => {
    expect(docListQuery("견적서")).toBeNull();
    expect(docListQuery("계약서 작성할래")).toBeNull();
    expect(docListQuery("표준 견적서")).toBeNull();
  });
});
