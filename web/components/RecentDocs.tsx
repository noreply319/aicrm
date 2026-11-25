"use client";

import { useEffect, useState } from "react";
import { KIND_LABEL } from "@/lib/docTemplate";
import type { DocListQuery } from "@/lib/docQuery";
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
 * 작성한 문서(견적서·계약서) 목록 — AI Assistant 문서 탭에서 "작성한 문서 보여줘"처럼 물으면 답으로 보여준다.
 * 열어서 이어 쓰기·PDF·메일. 계약서 메뉴의 "작성한 문서"와 같은 데이터(/api/documents, 최근 수정 순).
 */
export default function RecentDocs({ query, onOpen, disabled }: { query: DocListQuery; onOpen: (id: string) => void; disabled?: boolean }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    setDocs(null);
    setAll(false);
    const sp = new URLSearchParams();
    if (query.kind) sp.set("kind", query.kind);
    if (query.q) sp.set("q", query.q);
    api<DocumentSummary[]>(`/api/documents?${sp}`)
      .then((d) => alive && setDocs(d))
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [query.kind, query.q]);

  const what = `${query.q ? `‘${query.q}’ ` : ""}${query.kind ? KIND_LABEL[query.kind] : "문서"}`;
  if (error) return <div className="bubble bubble-assistant">작성한 문서를 불러오지 못했어요: {error}</div>;
  if (!docs) return <div className="bubble bubble-assistant bubble-loading">작성한 {what}를 찾는 중…</div>;
  if (docs.length === 0) return <div className="bubble bubble-assistant">작성한 {what}가 없어요.</div>;
  const shown = all ? docs : docs.slice(0, SHOW);
  return (
    <section className="recent-docs" aria-label="작성한 문서">
      <div className="recent-docs-head">
        <b>작성한 {what} {docs.length}건</b>
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
