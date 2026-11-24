import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 구글 리프레시 토큰 암호화 (AES-256-GCM)
 * 키: TOKEN_ENCRYPTION_KEY (32바이트 base64, `openssl rand -base64 32`)
 * 저장 형식: v1.<iv>.<tag>.<암호문> (각 base64url)
 */

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY는 32바이트 base64 값이어야 합니다");
  return k;
}

export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), enc].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** 복호화 실패(키 변경 등) 시 null */
export function decrypt(value: string): string | null {
  const [v, iv, tag, enc] = value.split(".");
  if (v !== "v1" || !iv || !tag || !enc) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");
