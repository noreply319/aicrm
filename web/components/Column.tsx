"use client";

import { Fragment, useRef } from "react";
import { formatWon } from "@/lib/format";
import type { Lead, StageId } from "@/lib/types";
import LeadCard from "./LeadCard";

interface Props {
  stage: { id: StageId; name: string; color: string };
  leads: Lead[];
  draggingId: string | null;
  dropIndex: number | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onHover: (index: number) => void;
  onLeave: () => void;
  onDrop: () => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
}

export default function Column({
  stage, leads, draggingId, dropIndex,
  onDragStart, onDragEnd, onHover, onLeave, onDrop, onOpen, onAdd,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const total = leads.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const others = leads.filter((l) => l.id !== draggingId);

  // 마우스 Y 위치 기준으로 드래그 중이 아닌 카드들 사이의 삽입 위치를 계산
  const indexFromPointer = (y: number) => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>(".card:not(.dragging)") ?? [];
    let index = 0;
    for (const card of Array.from(cards)) {
      const box = card.getBoundingClientRect();
      if (y > box.top + box.height / 2) index++;
      else break;
    }
    return index;
  };

  return (
    <section
      className={`column${dropIndex !== null ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const idx = indexFromPointer(e.clientY);
        if (idx !== dropIndex) onHover(idx);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onLeave();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="col-head">
        <div className="col-title">
          <span className="dot" style={{ background: stage.color }} />
          {stage.name}
          <span className="count">{leads.length}</span>
        </div>
        <div className="col-sum">{formatWon(total)}</div>
      </div>

      <div className="cards" ref={listRef}>
        {leads.length === 0 && dropIndex === null && (
          <div className="empty">여기로 카드를 끌어오세요</div>
        )}
        {leads.map((lead) => {
          const otherIdx = others.findIndex((l) => l.id === lead.id);
          return (
            <Fragment key={lead.id}>
              {dropIndex !== null && otherIdx === dropIndex && <div className="placeholder" />}
              <LeadCard
                lead={lead}
                dragging={lead.id === draggingId}
                onDragStart={() => onDragStart(lead.id)}
                onDragEnd={onDragEnd}
                onClick={() => onOpen(lead.id)}
              />
            </Fragment>
          );
        })}
        {dropIndex !== null && dropIndex >= others.length && <div className="placeholder" />}
      </div>

      <button className="add-inline" onClick={onAdd}>+ 리드 추가</button>
    </section>
  );
}
