/**
 * 메일(RFC 2822 / MIME) 만들기 — Gmail messages.send의 raw 값. 첨부가 없으면 text/plain 한 부분만
 * 제목·파일명은 RFC 2047/2231로 인코딩하고, 본문·첨부는 base64(76자 줄바꿈)로 넣는다.
 */

export interface MimeInput {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachment?: { fileName: string; contentType: string; data: Uint8Array };
}

/** 첨부 포함 메일 크기 상한 (Gmail 발송 한도 안쪽) */
export const MAX_MAIL_BYTES = 10 * 1024 * 1024;
export const MAIL_TOO_LARGE = "첨부 파일이 너무 큽니다 (10MB 이하)";
/** 첨부 크기 → 메일에 넣었을 때 크기 어림 (base64 + 줄바꿈) */
export const encodedSize = (bytes: number) => Math.ceil(bytes / 3) * 4 * (78 / 76);

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** 헤더 인젝션 방지: 줄바꿈 제거 */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 encoded-word (줄당 75자 제한 → 글자 단위로 나눠 여러 단어로) */
export function encodeHeader(value: string, fold = true): string {
  const text = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    // UTF-8 45바이트 이하 → base64 60자 이하 + 12자 = 72자
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join(fold ? "\r\n " : " ");
}

/** RFC 2231 파일명 (filename*=UTF-8''...) */
const encodeFileName = (name: string) =>
  encodeURIComponent(oneLine(name)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function buildMime(input: MimeInput, boundary = `crm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`): string {
  const { attachment: a } = input;
  const headers = [
    `To: ${input.to.map(oneLine).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  const text = wrap76(b64(input.body.replace(/\r?\n/g, "\r\n")));
  if (!a) {
    return [...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", text, ""].join("\r\n");
  }
  const fileName = oneLine(a.fileName);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    text,
    `--${boundary}`,
    `Content-Type: ${a.contentType}; name="${encodeHeader(fileName, false)}"`,
    `Content-Disposition: attachment; filename="${encodeHeader(fileName, false)}"; filename*=UTF-8''${encodeFileName(fileName)}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(a.data).toString("base64")),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
