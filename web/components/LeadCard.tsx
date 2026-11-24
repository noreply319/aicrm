"use client";

import { AVATAR_COLORS, PRIORITY_LABEL } from "@/lib/constants";
import { formatWon, isOverdue } from "@/lib/format";
import type { Lead } from "@/lib/types";

interface Props {
  lead: Lead;
  /** 미팅 노트 개수 (0이면 배지 숨김) */
  noteCount: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}

export default function LeadCard({ lead, noteCount, dragging, onDragStart, onDragEnd, onClick }: Props) {
  const initial = (lead.contact || lead.company || "?").trim().slice(0, 1);
  const colorIdx =
    [...(lead.company || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const overdue = lead.stage !== "won" && lead.stage !== "lost" && isOverdue(lead.closeDate);

  return (
    <article
      className={`card${dragging ? " dragging" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", lead.id);
        // 드래그 고스트 이미지가 생성된 뒤 원본을 흐리게 처리
        requestAnimationFrame(onDragStart);
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <div className="card-top">
        <div>
          <div className="card-company">{lead.company}</div>
          <div className="card-contact">
            {lead.contact}
            {lead.title ? ` · ${lead.title}` : ""}
          </div>
        </div>
        <div className="avatar" style={{ background: AVATAR_COLORS[colorIdx] }}>
          {initial}
        </div>
      </div>
      <div className="card-value">{formatWon(lead.value)}</div>
      <div className="card-foot">
        <span className="card-tags">
          <span className={`tag prio-${lead.priority}`}>{PRIORITY_LABEL[lead.priority] ?? "보통"}</span>
          {noteCount > 0 && (
            <span className="note-badge" title={`미팅 노트 ${noteCount}개`}>📝 {noteCount}</span>
          )}
        </span>
        {lead.closeDate && (
          <span className={`card-date${overdue ? " overdue" : ""}`}>
            📅 {lead.closeDate.slice(5).replace("-", "/")}
          </span>
        )}
      </div>
    </article>
  );
}
