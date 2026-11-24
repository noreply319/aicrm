/**
 * 첨부 파일이 있는 메일(RFC 2822 / MIME) 만들기 — Gmail messages.send의 raw 값
 * 제목·파일명은 RFC 2047/2231로 인코딩하고, 본문·첨부는 base64(76자 줄바꿈)로 넣는다.
 */

export interface MimeInput {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachment: { fileName: string; contentType: string; data: Uint8Array };
}

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
  const fileName = oneLine(a.fileName);
  const headers = [
    `To: ${input.to.map(oneLine).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(input.body.replace(/\r?\n/g, "\r\n"))),
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
