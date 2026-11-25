"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { CARD_MAX_FILES } from "./constants";
import { shrinkImage } from "./imageFile";
import { conflictContact } from "./useContacts";
import type { BusinessCardDraft, BusinessCardExtract, BusinessCardMatch, BusinessCardSaved, BusinessCardSaveInput, Contact } from "./types";

/**
 * 대화 화면(AI Assistant 패널·Sales Agent)의 명함 카드 목록.
 * 카드는 화면 전용 항목이라 OpenAI로 보내는 대화에는 들어가지 않는다 (명함의 이메일·전화가 이후 대화로 새지 않게).
 * afterIndex: 카드를 올릴 때의 대화 메시지 수 → 그 메시지 뒤에 보여준다.
 */
export type CardStatus = "reading" | "review" | "saving" | "saved" | "duplicate" | "error";

export interface CardItem {
  id: string;
  afterIndex: number;
  status: CardStatus;
  /** 미리보기 (object URL) */
  previews: string[];
  /** 분석할 때 보낸 이미지 (뒷면 추가 시 함께 다시 분석) */
  images: Blob[];
  error: string | null;
  draft: BusinessCardDraft | null;
  match: BusinessCardMatch | null;
  saved: BusinessCardSaved | null;
  /** 같은 이메일의 기존 연락처 */
  existing: Contact | null;
}

let seq = 0;

export function useBusinessCards() {
  const [cards, setCards] = useState<CardItem[]>([]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const patch = useCallback((id: string, p: Partial<CardItem>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }, []);

  /** 이미지 분석 → 확인 카드 (같은 이메일 연락처가 있으면 바로 중복 안내) */
  const extract = useCallback(
    async (id: string, images: Blob[]) => {
      patch(id, { status: "reading", error: null });
      const form = new FormData();
      images.forEach((b, i) => form.append("image", b, `card-${i + 1}.jpg`));
      try {
        const r = await api<BusinessCardExtract>("/api/business-cards/extract", { method: "POST", body: form });
        patch(id, {
          status: r.match.contactByEmail ? "duplicate" : "review",
          draft: r.draft,
          match: r.match,
          existing: r.match.contactByEmail,
        });
      } catch (e) {
        patch(id, { status: "error", error: (e as Error).message });
      }
    },
    [patch]
  );

  /** 사진 여러 장 → 장마다 카드 1개 (최대 CARD_MAX_FILES장) */
  const addFiles = useCallback(
    (files: File[], afterIndex: number): string | null => {
      const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
      if (images.length === 0) return "이미지 파일만 올릴 수 있습니다";
      const picked = images.slice(0, CARD_MAX_FILES);
      for (const file of picked) {
        const id = `card-${Date.now()}-${++seq}`;
        const preview = URL.createObjectURL(file);
        setCards((prev) => [
          ...prev,
          { id, afterIndex, status: "reading", previews: [preview], images: [], error: null, draft: null, match: null, saved: null, existing: null },
        ]);
        shrinkImage(file)
          .then((blob) => {
            patch(id, { images: [blob] });
            return extract(id, [blob]);
          })
          .catch((e: unknown) => patch(id, { status: "error", error: (e as Error).message }));
      }
      return images.length > CARD_MAX_FILES ? `한 번에 ${CARD_MAX_FILES}장까지 올릴 수 있어 앞의 ${CARD_MAX_FILES}장만 읽습니다` : null;
    },
    [extract, patch]
  );

  /** 뒷면(또는 다른 면) 추가: 두 장을 함께 다시 분석 */
  const addBack = useCallback(
    async (id: string, file: File) => {
      const card = cardsRef.current.find((c) => c.id === id);
      if (!card || card.images.length !== 1) return;
      const preview = URL.createObjectURL(file);
      patch(id, { previews: [...card.previews, preview], status: "reading", error: null });
      try {
        const blob = await shrinkImage(file);
        const images = [card.images[0], blob];
        patch(id, { images });
        await extract(id, images);
      } catch (e) {
        patch(id, { status: "error", error: (e as Error).message });
      }
    },
    [extract, patch]
  );

  /** 다시 시도 (분석 실패) */
  const retry = useCallback((id: string) => {
    const card = cardsRef.current.find((c) => c.id === id);
    if (card?.images.length) extract(id, card.images);
  }, [extract]);

  /** 저장: 성공하면 saved, 같은 이메일이면 duplicate. 실패 메시지는 카드에 */
  const save = useCallback(
    async (id: string, input: BusinessCardSaveInput): Promise<BusinessCardSaved | null> => {
      patch(id, { status: "saving", error: null });
      try {
        const saved = await api<BusinessCardSaved>("/api/business-cards", { method: "POST", body: JSON.stringify(input) });
        patch(id, { status: "saved", saved });
        return saved;
      } catch (e) {
        const existing = conflictContact(e);
        if (existing) patch(id, { status: "duplicate", existing, error: null });
        else patch(id, { status: "review", error: (e as Error).message });
        return null;
      }
    },
    [patch]
  );

  const remove = useCallback((id: string) => {
    setCards((prev) => {
      prev.find((c) => c.id === id)?.previews.forEach((u) => URL.revokeObjectURL(u));
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setCards((prev) => {
      prev.forEach((c) => c.previews.forEach((u) => URL.revokeObjectURL(u)));
      return [];
    });
  }, []);

  // 화면을 떠나면 미리보기 URL 정리
  useEffect(() => () => cardsRef.current.forEach((c) => c.previews.forEach((u) => URL.revokeObjectURL(u))), []);

  return { cards, addFiles, addBack, retry, save, patch, remove, clear };
}

export type BusinessCards = ReturnType<typeof useBusinessCards>;
