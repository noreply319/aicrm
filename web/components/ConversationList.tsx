"use client";

import { useState } from "react";
import type { ConversationSummary } from "@/lib/types";
import { Button, EmptyState, Icon, IconButton } from "./ui";

interface Props {
  conversations: ConversationSummary[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onNew: () => void;
  onClose: () => void;
}

/** 오늘이면 시:분, 올해면 월·일, 아니면 연.월.일 */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/**
 * 저장된 대화 목록 (AI Assistant). 대화 영역 자리에 보여준다.
 * 삭제는 한 번 더 눌러 확인한다 (브라우저 확인 창 대신).
 */
export default function ConversationList({ conversations, currentId, onOpen, onDelete, onNew, onClose }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (id: string) => {
    if (confirmId !== id) return setConfirmId(id);
    setConfirmId(null);
    setError(null);
    await onDelete(id).catch((e: unknown) => setError((e as Error).message));
  };

  return (
    <section className="conv-list" aria-label="대화 목록">
      <div className="conv-list-head">
        <b>대화 목록</b>
        <span className="spacer" />
        <Button size="sm" variant="secondary" icon="plus" onClick={onNew}>새 대화</Button>
        <IconButton icon="close" size="sm" label="대화 목록 닫기" onClick={onClose} />
      </div>
      {error && <p className="conv-list-error" role="alert">{error}</p>}
      {conversations.length === 0 ? (
        <EmptyState icon={<Icon name="history" size={24} />} title="저장된 대화가 없어요" description="질문하면 대화가 자동으로 저장돼요." />
      ) : (
        <ul className="conv-items">
          {conversations.map((c) => (
            <li key={c.id} className={`conv-item${c.id === currentId ? " on" : ""}`}>
              <button type="button" className="conv-open" aria-current={c.id === currentId || undefined} onClick={() => onOpen(c.id)}>
                <span className="conv-title">{c.title}</span>
                <span className="conv-when">{when(c.updatedAt)}</span>
              </button>
              {confirmId === c.id ? (
                <Button size="sm" variant="danger" onClick={() => remove(c.id)} onBlur={() => setConfirmId(null)} autoFocus>
                  삭제 확인
                </Button>
              ) : (
                <IconButton icon="trash" size="sm" label={`「${c.title}」 대화 삭제`} onClick={() => remove(c.id)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
