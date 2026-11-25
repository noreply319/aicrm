import { NextResponse } from "next/server";
import { extractBusinessCard, findCardMatch } from "@/lib/businessCard";
import { CARD_IMAGE_MAX_BYTES } from "@/lib/constants";
import { pool } from "@/lib/db";
import { AiError } from "@/lib/openai";
import { sniffImage } from "@/lib/validate";

export const dynamic = "force-dynamic";
// 이미지 분석 대기 시간
export const maxDuration = 60;

/**
 * 명함 1장 분석 (multipart, image 1~2개: 앞·뒷면) → { draft, match }.
 * DB에 저장하지 않고 이미지도 남기지 않는다 (로그에도 남기지 않음).
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("image") ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return NextResponse.json({ error: "명함 이미지가 없습니다" }, { status: 400 });
  if (files.length > 2) return NextResponse.json({ error: "명함은 앞·뒷면 2장까지 올릴 수 있습니다" }, { status: 400 });
  if (files.some((f) => f.size > CARD_IMAGE_MAX_BYTES)) {
    return NextResponse.json({ error: "이미지가 너무 큽니다" }, { status: 413 });
  }

  const images: { mime: string; data: Uint8Array }[] = [];
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const mime = sniffImage(data);
    if (!mime) return NextResponse.json({ error: "JPG·PNG·WebP 이미지만 올릴 수 있습니다" }, { status: 415 });
    images.push({ mime, data });
  }

  try {
    const draft = await extractBusinessCard(images);
    if (!draft.contact.name && !draft.company.name) {
      return NextResponse.json({ error: "명함에서 이름이나 회사명을 읽지 못했습니다. 밝은 곳에서 명함이 꽉 차게 다시 찍어 주세요" }, { status: 422 });
    }
    return NextResponse.json({ draft, match: await findCardMatch(pool, draft) });
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
