"use client";

import { CARD_IMAGE_MAX_BYTES, CARD_IMAGE_MAX_SIDE } from "./constants";

/**
 * 업로드할 사진을 줄인다: 긴 변 maxSide 이하 JPEG (휴대폰 사진 수 MB → 수백 KB, Vercel 요청 크기 한도 대응).
 * 브라우저가 열 수 없는 형식(일부 HEIC 등)은 원본이 한도 안이면 그대로, 아니면 예외.
 */
export async function shrinkImage(file: File, maxSide = CARD_IMAGE_MAX_SIDE): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // 사진의 회전(EXIF) 정보는 기본으로 반영된다 (옵션을 주면 오래된 Safari가 예외를 던져 옵션 없이 연다)
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size <= CARD_IMAGE_MAX_BYTES && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    throw new Error("이 이미지 형식은 열 수 없습니다. JPG·PNG로 올려 주세요");
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이미지를 처리하지 못했습니다");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // 품질을 낮춰 가며 한도 안으로
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= CARD_IMAGE_MAX_BYTES) return blob;
  }
  throw new Error("이미지가 너무 큽니다");
}
