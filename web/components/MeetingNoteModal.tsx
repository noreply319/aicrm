"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "@/lib/api";
import { NOTE_BODY_MAX, NOTE_SOURCE_LABEL, STAGES } from "@/lib/constants";
import { formatDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import type { Lead, MeetingNote, MeetingNoteInput, NoteSource, NoteSummaryResult } from "@/lib/types";
import MeetingRecorder, { type RecorderStatus } from "./MeetingRecorder";

interface Props {
  /** 수정/보기할 노트 id. null이면 새 노트 */
  noteId: string | null;
  /** 새 노트의 기본 리드 */
  leadId: string | null;
  /** 리드 상세에서 열었으면 리드 변경 불가 */
  lockLead: boolean;
  leads: Lead[];
  getNote: (id: string) => Promise<MeetingNote>;
  onSave: (input: MeetingNoteInput, id: string | null) => Promise<MeetingNote>;
  onDelete: (id: string) => Promise<void>;
  onOpenLead: (leadId: string) => void;
  onClose: () => void;
}

type Tab = "record" | "paste";

const nowIso = () => new Date().toISOString();

export default function MeetingNoteModal({
  noteId, leadId, lockLead, leads, getNote, onSave, onDelete, onOpenLead, onClose,
}: Props) {
  const [note, setNote] = useState<MeetingNote | null>(null);
  const [loading, setLoading] = useState(noteId !== null);
  const [editing, setEditing] = useState(noteId === null);
  const [error, setError] = useState<string | null>(null);

  // 폼 상태
  const [formLeadId, setFormLeadId] = useState(leadId ?? "");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [metAt, setMetAt] = useState(() => toLocalInput(nowIso()));
  const [body, setBody] = useState("");
  const [summary, setSummary] = useState("");
  const [nextActions, setNextActions] = useState("");
  const [tab, setTab] = useState<Tab>("record");
  const [recorded, setRecorded] = useState(false); // 녹음 전사가 본문에 들어갔는지
  const [typed, setTyped] = useState(false); // 직접 입력/붙여넣기가 있었는지
  const [dirty, setDirty] = useState(false);

  const [rec, setRec] = useState<RecorderStatus>({ recording: false, pending: 0, failed: 0 });
  const [summarizing, setSummarizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const sortedLeads = useMemo(
    () => [...leads].sort((a, b) => a.company.localeCompare(b.company, "ko")),
    [leads]
  );
  const lead = leads.find((l) => l.id === (editing ? formLeadId : note?.leadId));

  // 폼을 노트 값으로 채운다
  const fillForm = useCallback((n: MeetingNote) => {
    setFormLeadId(n.leadId);
    setTitle(n.title);
    setTitleTouched(true);
    setMetAt(toLocalInput(n.metAt));
    setBody(n.body);
    setSummary(n.summary);
    setNextActions(n.nextActions);
    setRecorded(n.source !== "manual");
    setTyped(n.source !== "recording");
    setTab("paste");
    setDirty(false);
  }, []);

  // 기존 노트 불러오기
  useEffect(() => {
    if (!noteId) return;
    let alive = true;
    getNote(noteId)
      .then((n) => {
        if (!alive) return;
        setNote(n);
        fillForm(n);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [noteId, getNote, fillForm]);

  // 리드를 고르면 기본 제목 "{회사명} 미팅"
  useEffect(() => {
    if (!editing || titleTouched) return;
    const company = leads.find((l) => l.id === formLeadId)?.company;
    setTitle(company ? `${company} 미팅` : "");
  }, [formLeadId, titleTouched, editing, leads]);

  const busy = rec.recording || rec.pending > 0;

  const requestClose = useCallback(() => {
    if (busy && !confirm("녹음 또는 전사가 진행 중입니다. 닫으면 진행 중인 내용이 사라집니다. 닫을까요?")) return;
    if (!busy && editing && dirty && !confirm("저장하지 않은 변경 사항이 있습니다. 닫을까요?")) return;
    onClose();
  }, [busy, editing, dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /** 구간 전사 결과를 본문 끝에 이어 붙인다 */
  const appendTranscript = useCallback((label: string, text: string) => {
    setBody((prev) => {
      const line = `[${label}] ${text}`;
      return (prev.trimEnd() ? prev.trimEnd() + "\n\n" : "") + line;
    });
    setRecorded(true);
    setDirty(true);
  }, []);

  const source: NoteSource = recorded ? (typed ? "mixed" : "recording") : "manual";

  /** AI 요약 생성 → 폼에 채움 (보기 모드에서는 바로 저장) */
  const runSummary = async () => {
    const text = editing ? body : note?.body ?? "";
    if (!text.trim()) return;
    const hasExisting = editing ? summary || nextActions : note?.summary || note?.nextActions;
    if (hasExisting && !confirm("기존 AI 요약을 새 결과로 덮어쓸까요?")) return;
    setSummarizing(true);
    setError(null);
    try {
      const r = await api<NoteSummaryResult>("/api/meetings/summarize", {
        method: "POST",
        body: JSON.stringify({ title: editing ? title : note?.title, body: text }),
      });
      if (editing) {
        setSummary(r.summary);
        setNextActions(r.nextActions);
        setDirty(true);
      } else if (note) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = note;
        const saved = await onSave({ ...rest, summary: r.summary, nextActions: r.nextActions }, note.id);
        setNote(saved);
        fillForm(saved);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  const save = async () => {
    if (rec.recording) {
      setError("녹음을 종료한 뒤 저장하세요.");
      return;
    }
    if (rec.pending > 0 && !confirm(`전사가 아직 끝나지 않았습니다 (${rec.pending}개 구간). 지금 저장하면 해당 구간 결과는 포함되지 않습니다. 저장할까요?`)) return;
    if (rec.failed > 0 && !confirm(`전사에 실패한 구간이 ${rec.failed}개 있습니다. 그대로 저장할까요?`)) return;

    const iso = fromLocalInput(metAt);
    if (!formLeadId) return setError("연결할 리드를 선택하세요");
    if (!title.trim()) return setError("제목을 입력하세요");
    if (!iso) return setError("미팅 일시를 입력하세요");
    if (!body.trim()) return setError("본문을 입력하거나 녹음하세요");

    setSaving(true);
    setError(null);
    try {
      const saved = await onSave(
        { leadId: formLeadId, title: title.trim(), metAt: iso, body, source, summary, nextActions },
        note?.id ?? null
      );
      if (note) {
        // 수정 완료 → 보기 모드
        setNote(saved);
        fillForm(saved);
        setEditing(false);
      } else {
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!note || !confirm("이 미팅 노트를 삭제할까요?")) return;
    try {
      await onDelete(note.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const stage = lead ? STAGES.find((s) => s.id === lead.stage) : undefined;
  const actions = (editing ? nextActions : note?.nextActions ?? "").split("\n").filter((l) => l.trim());
  const summaryText = editing ? summary : note?.summary ?? "";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal modal-wide note-modal" role="dialog" aria-modal="true" aria-label="미팅 노트">
        <div className="modal-head">
          <h2>{!note ? "미팅 노트 작성" : editing ? "미팅 노트 수정" : note.title}</h2>
          <span className="spacer" />
          {note && !editing && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>✎ 수정</button>
          )}
          <button type="button" className="btn icon-btn" title="닫기" onClick={requestClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="loading">불러오는 중…</div>
        ) : !editing && note ? (
          /* ───── 보기 모드 ───── */
          <div className="note-view">
            <div className="note-view-meta">
              <span>📅 {formatDateTime(note.metAt)}</span>
              {lead && (
                <button type="button" className="link-btn" onClick={() => onOpenLead(lead.id)}>
                  🔗 {lead.company}{lead.contact ? ` — ${lead.contact}` : ""}
                </button>
              )}
              {stage && <span className="stage-pill" style={{ "--stage": stage.color } as CSSProperties}>{stage.name}</span>}
              <span>{note.source === "manual" ? "📋" : "🎙"} {NOTE_SOURCE_LABEL[note.source]}</span>
              <span className="spacer" />
              <span className="muted">작성 {formatDateTime(note.createdAt)} · 수정 {formatDateTime(note.updatedAt)}</span>
            </div>
            <SummaryCard
              summary={summaryText}
              actions={actions}
              loading={summarizing}
              onGenerate={runSummary}
            />
            <div className="field">
              <label>본문</label>
              <div className="note-body-view">{note.body}</div>
            </div>
          </div>
        ) : (
          /* ───── 작성/수정 모드 ───── */
          <div className="note-form">
            <div className="note-form-grid">
              <div className="field">
                <label>연결 리드 *{lockLead && <span className="muted"> · 고정</span>}</label>
                <select
                  value={formLeadId}
                  disabled={lockLead}
                  onChange={(e) => { setFormLeadId(e.target.value); setDirty(true); }}
                >
                  <option value="">리드 선택…</option>
                  {sortedLeads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.company}{l.contact ? ` — ${l.contact}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>미팅 일시 *</label>
                <input type="datetime-local" value={metAt} onChange={(e) => { setMetAt(e.target.value); setDirty(true); }} />
              </div>
            </div>
            <div className="field">
              <label>제목 *</label>
              <input
                value={title}
                maxLength={200}
                placeholder="예: 한빛소프트 미팅"
                onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); setDirty(true); }}
              />
            </div>

            <div className="seg-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "record"} className={tab === "record" ? "on" : ""} onClick={() => setTab("record")}>
                🎙 녹음하기{busy ? " •" : ""}
              </button>
              <button type="button" role="tab" aria-selected={tab === "paste"} className={tab === "paste" ? "on" : ""} onClick={() => setTab("paste")}>
                📋 직접 입력 / 붙여넣기
              </button>
            </div>

            {/* 탭을 바꿔도 녹음이 끊기지 않도록 언마운트하지 않고 숨긴다 */}
            <div hidden={tab !== "record"}>
              <MeetingRecorder onTranscript={appendTranscript} onStatus={setRec} />
            </div>

            <div className="field">
              <label>
                본문 *{" "}
                <span className="muted">
                  {tab === "record" ? "— 전사 결과가 구간 순서대로 이어 붙음, 직접 수정 가능" : "— Ctrl/⌘+V로 붙여넣기, 줄바꿈 유지"}
                </span>
              </label>
              <textarea
                ref={bodyRef}
                className="note-body-input"
                value={body}
                maxLength={NOTE_BODY_MAX}
                placeholder={tab === "record" ? "녹음을 시작하면 5분마다 전사 결과가 여기에 추가됩니다." : "회의록이나 메모를 입력하거나 붙여넣으세요."}
                onChange={(e) => {
                  setBody(e.target.value);
                  // 전사 결과를 고치는 것은 붙여넣기로 보지 않는다
                  if (!recorded) setTyped(true);
                  setDirty(true);
                }}
                onPaste={() => setTyped(true)}
              />
              <div className="char-count">
                {body.length.toLocaleString()} / {NOTE_BODY_MAX.toLocaleString()}자
              </div>
            </div>

            <SummaryCard
              summary={summary}
              actions={actions}
              loading={summarizing}
              disabled={!body.trim() || busy}
              hint={busy ? "전사가 끝나면 사용할 수 있습니다" : !body.trim() ? "본문을 입력하면 사용할 수 있습니다" : undefined}
              onGenerate={runSummary}
              editable={{
                onSummary: (v) => { setSummary(v); setDirty(true); },
                onActions: (v) => { setNextActions(v); setDirty(true); },
                actionsText: nextActions,
              }}
            />
          </div>
        )}

        {error && <div className="modal-error" role="alert">⚠ {error}</div>}

        <div className="modal-foot">
          {note && (
            <button type="button" className="btn btn-danger" onClick={remove}>삭제</button>
          )}
          <div className="spacer" />
          {editing ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (note) {
                    if (busy && !confirm("녹음 또는 전사가 진행 중입니다. 수정을 취소할까요?")) return;
                    fillForm(note);
                    setEditing(false);
                  } else requestClose();
                }}
              >
                취소
              </button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving || rec.recording}>
                {saving ? "저장 중…" : rec.recording ? "녹음 종료 후 저장" : "저장"}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={onClose}>닫기</button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SummaryCardProps {
  summary: string;
  actions: string[];
  loading: boolean;
  disabled?: boolean;
  hint?: string;
  onGenerate: () => void;
  /** 작성/수정 모드: 텍스트 영역으로 편집 */
  editable?: { onSummary: (v: string) => void; onActions: (v: string) => void; actionsText: string };
}

/** AI 요약·다음 액션 카드 */
function SummaryCard({ summary, actions, loading, disabled, hint, onGenerate, editable }: SummaryCardProps) {
  const has = Boolean(summary || actions.length);
  return (
    <section className="ai-card">
      <div className="ai-card-head">
        <b>✨ AI 요약</b>
        {hint && <span className="muted">{hint}</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onGenerate} disabled={disabled || loading}>
          {loading ? "생성 중…" : has ? "↻ 다시 생성" : "AI 요약 생성"}
        </button>
      </div>
      {editable && has ? (
        <div className="ai-card-grid">
          <div className="field">
            <label>요약 · 고객 니즈/이슈</label>
            <textarea rows={6} value={summary} onChange={(e) => editable.onSummary(e.target.value)} />
          </div>
          <div className="field">
            <label>다음 액션 (한 줄에 하나)</label>
            <textarea rows={6} value={editable.actionsText} onChange={(e) => editable.onActions(e.target.value)} />
          </div>
        </div>
      ) : has ? (
        <div className="ai-card-grid">
          <div>
            <h4>요약</h4>
            <div className="ai-summary">{summary || "—"}</div>
          </div>
          <div>
            <h4>다음 액션</h4>
            {actions.length ? (
              <ul className="ai-actions">
                {actions.map((a, i) => <li key={i}>{a.replace(/^[-*]\s*/, "")}</li>)}
              </ul>
            ) : (
              <div className="muted">—</div>
            )}
          </div>
        </div>
      ) : (
        <p className="muted ai-empty">미팅 내용을 요약하고 고객 니즈와 다음 액션을 정리합니다.</p>
      )}
    </section>
  );
}
