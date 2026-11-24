"use client";

import { PRIORITY_LABEL, PRIORITY_TONE } from "@/lib/constants";
import { formatDateTime, formatWon, isOverdue } from "@/lib/format";
import type { Lead } from "@/lib/types";
import { Avatar, Badge } from "./ui";

interface Props {
  lead: Lead;
  /** 미팅 노트 개수 (0이면 배지 숨김) */
  noteCount: number;
  /** 다음 미팅 시작 시각 (ISO). 없으면 배지 숨김 */
  nextMeeting: string | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}

export default function LeadCard({ lead, noteCount, nextMeeting, dragging, onDragStart, onDragEnd, onClick }: Props) {
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
        <Avatar name={lead.contact || lead.company} seed={lead.company} size="sm" />
      </div>
      <div className="card-value">{formatWon(lead.value)}</div>
      <div className="card-foot">
        <span className="card-tags">
          <Badge tone={PRIORITY_TONE[lead.priority] ?? "warning"}>{PRIORITY_LABEL[lead.priority] ?? "보통"}</Badge>
          {noteCount > 0 && (
            <Badge tone="brand" className="note-badge" title={`미팅 노트 ${noteCount}개`}>📝 {noteCount}</Badge>
          )}
          {nextMeeting && (
            <Badge tone="info" className="meeting-badge" title={`다음 미팅 ${formatDateTime(nextMeeting)}`}>
              🗓 {formatDateTime(nextMeeting).slice(5, 10).replace("-", "/")}
            </Badge>
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
