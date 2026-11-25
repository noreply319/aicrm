import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanPhone, extractBusinessCard, parseCardJson } from "@/lib/businessCard";
import { sniffImage } from "@/lib/validate";

const chatResponse = (content: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 }));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("cleanPhone (명함 전화번호 정리)", () => {
  it("M./Tel 표시를 빼고 공백을 하이픈으로", () => {
    expect(cleanPhone("M. 010 1234 5678")).toBe("010-1234-5678");
    expect(cleanPhone("Tel: +82-2-555-1234")).toBe("+82-2-555-1234");
    expect(cleanPhone("02)555-1234")).toBe("02)555-1234");
  });
  it("번호가 아니면 빈 값", () => {
    expect(cleanPhone("없음")).toBe("");
    expect(cleanPhone("123")).toBe("");
    expect(cleanPhone(null)).toBe("");
  });
});

describe("parseCardJson (모델 응답 정리)", () => {
  it("회사 도메인은 회사 메일에서, 휴대폰이 유선 칸에 있으면 옮긴다", () => {
    const d = parseCardJson(JSON.stringify({
      company: { name: "(주)블루웨이브", website: "bluewave.io", businessNumber: "123-45-67890" },
      contact: { name: "이준호", title: "팀장", email: "JH@BlueWave.io", mobile: "", officePhone: "010-1111-2222" },
    }));
    expect(d.company).toMatchObject({ name: "(주)블루웨이브", website: "https://bluewave.io", emailDomain: "bluewave.io" });
    expect(d.contact).toMatchObject({ email: "jh@bluewave.io", mobile: "010-1111-2222", officePhone: "" });
  });

  it("무료 메일이면 웹사이트 도메인을 쓰고, 형식이 틀린 값은 버린다", () => {
    const d = parseCardJson(JSON.stringify({
      company: { name: "에이크미", website: "www.acme.co.kr", businessNumber: "12345" },
      contact: { name: "김", email: "kim@gmail.com", linkedinUrl: "example.com/me" },
    }));
    expect(d.company.emailDomain).toBe("acme.co.kr");
    expect(d.company.businessNumber).toBe("");
    expect(d.contact.email).toBe("kim@gmail.com");
    expect(d.contact.linkedinUrl).toBe("");
  });

  it("+82 10 휴대폰은 휴대폰 칸, +82 2 번호는 유선 칸", () => {
    const d = parseCardJson(JSON.stringify({ contact: { name: "박", mobile: "", officePhone: "+82 10 1234 5678" } }));
    expect(d.contact).toMatchObject({ mobile: "+82-10-1234-5678", officePhone: "" });
    const e = parseCardJson(JSON.stringify({ contact: { name: "박", mobile: "+82-2-555-1234" } }));
    expect(e.contact).toMatchObject({ mobile: "", officePhone: "+82-2-555-1234" });
  });

  it("JSON이 아니면 모두 빈 값", () => {
    const d = parseCardJson("not json");
    expect(d.company.name).toBe("");
    expect(d.contact.name).toBe("");
  });
});

describe("extractBusinessCard", () => {
  it("이미지를 image_url 파트(data URL)로 보내고 JSON 응답을 강제한다", async () => {
    const fetchMock = chatResponse({ company: { name: "에이크미" }, contact: { name: "김민수" } });
    vi.stubGlobal("fetch", fetchMock);
    const d = await extractBusinessCard([{ mime: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 1]) }]);
    expect(d.contact.name).toBe("김민수");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    const parts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/jpeg;base64,"))).toBe(true);
  });
});

describe("sniffImage (업로드 형식 확인)", () => {
  it("JPEG·PNG·WebP만 인식", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});
