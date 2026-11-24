import { NOTE_SOURCE_LABEL, STAGES } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Lead, MeetingNoteSummary } from "@/lib/types";
import { Badge } from "./ui";

interface Props {
  note: MeetingNoteSummary;
  /** 리드 정보(회사명·단계)를 보여줄 때만 전달 — 리드 상세 안에서는 생략 */
  lead?: Lead;
  onClick: () => void;
}

/** 요약이 있으면 요약 첫 단락, 없으면 본문 앞부분 */
const previewOf = (n: MeetingNoteSummary) => (n.summary ? n.summary.split("\n\n")[0] : n.preview);

export default function NoteListItem({ note, lead, onClick }: Props) {
  const stage = lead ? STAGES.find((s) => s.id === lead.stage) : undefined;
  const firstAction = note.nextActions.split("\n").find((l) => l.trim());
  const actionCount = note.nextActions.split("\n").filter((l) => l.trim()).length;

  return (
    <button type="button" className="note-item" onClick={onClick}>
      <span className="note-icon" title={NOTE_SOURCE_LABEL[note.source]} aria-hidden>
        {note.source === "manual" ? "📋" : "🎙"}
      </span>
      <span className="note-main">
        <span className="note-title-row">
          <span className="note-title">{note.title}</span>
          {stage && <Badge color={stage.color} shape="pill">{stage.name}</Badge>}
          {note.leadId === null && <Badge tone="warning" shape="pill" className="unassigned-pill">리드 미지정</Badge>}
          {note.summary && <Badge tone="brand" shape="pill">AI 요약</Badge>}
        </span>
        {lead && (
          <span className="note-lead">
            {lead.company}
            {lead.contact ? ` · ${lead.contact}` : ""}
            {lead.title ? ` ${lead.title}` : ""}
          </span>
        )}
        <span className="note-preview">{previewOf(note)}</span>
        {firstAction && (
          <span className="note-action">
            다음 액션 {actionCount}개 · {firstAction.replace(/^[-*]\s*/, "")}
          </span>
        )}
      </span>
      <span className="note-meta">
        <span>{formatDateTime(note.metAt)}</span>
        <span>{NOTE_SOURCE_LABEL[note.source]}</span>
      </span>
    </button>
  );
}
