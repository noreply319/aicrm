"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DocumentSummary } from "@/lib/types";
import DocBadge from "./DocBadge";
import { Button } from "./ui";

const SHOW = 8;

/** 오늘이면 시:분, 아니면 월·일 */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return d.toDateString() === new Date().toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * 작성한 문서(견적서·계약서) 최근 목록 — AI Assistant 문서 탭에서 이어 쓰기·PDF·메일하려고 연다.
 * 계약서 메뉴의 "작성한 문서"와 같은 데이터(/api/documents, 최근 수정 순).
 */
export default function RecentDocs({ onOpen, disabled }: { onOpen: (id: string) => void; disabled?: boolean }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api<DocumentSummary[]>("/api/documents")
      .then((d) => alive && setDocs(d))
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="bubble bubble-assistant">작성한 문서를 불러오지 못했어요: {error}</div>;
  if (!docs || docs.length === 0) return null;
  const shown = all ? docs : docs.slice(0, SHOW);
  return (
    <section className="recent-docs" aria-label="작성한 문서">
      <div className="recent-docs-head">
        <b>작성한 문서</b>
        <span className="muted">이어서 작성하거나 PDF·메일로 보내려면 여세요</span>
      </div>
      <ul>
        {shown.map((d) => (
          <li key={d.id}>
            <button type="button" className="recent-doc" disabled={disabled} onClick={() => onOpen(d.id)}>
              <DocBadge kind={d.kind} />
              <span className="recent-doc-title">{d.title}{d.company ? ` · ${d.company}` : ""}</span>
              <DocBadge status={d.status} />
              <span className="recent-doc-when">{when(d.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {!all && docs.length > SHOW && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>더 보기 ({docs.length - SHOW})</Button>
      )}
    </section>
  );
}
