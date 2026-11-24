"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { NOTE_BODY_MAX, NOTE_SOURCE_LABEL, STAGES } from "@/lib/constants";
import { formatDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import type { Lead, MeetingNote, MeetingNoteInput, NoteSource, NoteSummaryResult } from "@/lib/types";
import MeetingRecorder, { type RecorderStatus } from "./MeetingRecorder";
import { Alert, Badge, Button, Field, Input, Modal, ModalFooter, ModalHeader, Panel, Select, Tabs, Textarea } from "./ui";

interface Props {
  /** 수정/보기할 노트 id. null이면 새 노트 */
  noteId: string | null;
  /** 새 노트의 기본 리드 */
  leadId: string | null;
  /** 리드 상세에서 열었으면 리드 변경 불가 */
  lockLead: boolean;
  leads: Lead[];
  getNote: (id: string) => Promise<MeetingNote>;
  /** auto: 녹음 완료 후 자동 저장 */
  onSave: (input: MeetingNoteInput, id: string | null, opts?: { auto?: boolean }) => Promise<MeetingNote>;
  /** 미팅(녹음) 완료 후 자동 요약: 서버가 요약을 저장하고 저장된 노트를 돌려준다 */
  onAutoSummarize: (id: string) => Promise<MeetingNote>;
  onDelete: (id: string) => Promise<void>;
  onOpenLead: (leadId: string) => void;
  onClose: () => void;
}

type Tab = "record" | "paste";

const nowIso = () => new Date().toISOString();

/** 기본 제목: 리드가 있으면 "{회사명} 미팅", 없으면 "{날짜} 미팅" */
const defaultTitle = (company: string | undefined, metAtLocal: string) =>
  company ? `${company} 미팅` : `${metAtLocal.slice(0, 10) || nowIso().slice(0, 10)} 미팅`;

export default function MeetingNoteModal({
  noteId, leadId, lockLead, leads, getNote, onSave, onAutoSummarize, onDelete, onOpenLead, onClose,
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
  // 녹음 전사가 본문에 추가됐는데 아직 자동 저장하지 않았는지
  const autoSavePendingRef = useRef(false);
  const [autoSavedAt, setAutoSavedAt] = useState<string | null>(null);
  // 자동 요약 상태와 마지막 자동 요약 결과 (사용자가 고친 요약은 자동으로 덮어쓰지 않는다)
  const [autoSummary, setAutoSummary] = useState<"running" | "done" | "failed" | null>(null);
  const lastAutoSummaryRef = useRef<{ summary: string; nextActions: string } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sortedLeads = useMemo(
    () => [...leads].sort((a, b) => a.company.localeCompare(b.company, "ko")),
    [leads]
  );
  const lead = leads.find((l) => l.id === (editing ? formLeadId : note?.leadId));

  // 폼을 노트 값으로 채운다
  const fillForm = useCallback((n: MeetingNote) => {
    setFormLeadId(n.leadId ?? "");
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

  // 기본 제목: 리드를 고르면 "{회사명} 미팅", 리드가 없으면 "{날짜} 미팅"
  useEffect(() => {
    if (!editing || titleTouched) return;
    const company = leads.find((l) => l.id === formLeadId)?.company;
    setTitle(defaultTitle(company, metAt));
  }, [formLeadId, titleTouched, editing, leads, metAt]);

  const busy = rec.recording || rec.pending > 0;

  const requestClose = useCallback(() => {
    if (busy && !confirm("녹음 또는 전사가 진행 중입니다. 닫으면 진행 중인 내용이 사라집니다. 닫을까요?")) return;
    if (!busy && editing && dirty && !confirm("저장하지 않은 변경 사항이 있습니다. 닫을까요?")) return;
    onClose();
  }, [busy, editing, dirty, onClose]);

  /** 구간 전사 결과를 본문 끝에 이어 붙인다 */
  const appendTranscript = useCallback((label: string, text: string) => {
    setBody((prev) => {
      // 화자 구분 결과("화자 1: …" 여러 줄)는 구간 라벨 다음 줄부터
      const line = text.includes("\n") || /^[^:\n]{1,30}: /.test(text) ? `[${label}]\n${text}` : `[${label}] ${text}`;
      return (prev.trimEnd() ? prev.trimEnd() + "\n\n" : "") + line;
    });
    setRecorded(true);
    setDirty(true);
    autoSavePendingRef.current = true;
  }, []);

  /** 화자 이름 변경을 본문에 반영 ("화자 1:" → "김민수:") */
  const renameSpeakerInBody = useCallback((from: string, to: string) => {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setBody((prev) => prev.replace(new RegExp(`^${esc}:`, "gm"), `${to}:`));
    setDirty(true);
  }, []);

  const source: NoteSource = recorded ? (typed ? "mixed" : "recording") : "manual";

  // 자동 저장에서 최신 폼 값을 읽기 위한 ref (렌더마다 갱신)
  const latest = useRef({ formLeadId, title, metAt, body, source, summary, nextActions, note, saving });
  latest.current = { formLeadId, title, metAt, body, source, summary, nextActions, note, saving };

  /** 녹음(또는 파일 업로드) 전사가 모두 끝나면 리드가 없어도 자동 저장한다. 리드는 나중에 지정. */
  useEffect(() => {
    if (!editing || rec.recording || rec.pending > 0 || !autoSavePendingRef.current) return;
    const v = latest.current;
    const iso = fromLocalInput(v.metAt);
    if (v.saving || !v.body.trim() || !iso) return;
    autoSavePendingRef.current = false;
    const company = leads.find((l) => l.id === v.formLeadId)?.company;

    setSaving(true);
    onSave(
      {
        leadId: v.formLeadId || null,
        title: v.title.trim() || defaultTitle(company, v.metAt),
        metAt: iso,
        body: v.body,
        source: v.source,
        summary: v.summary,
        nextActions: v.nextActions,
      },
      v.note?.id ?? null,
      { auto: true }
    )
      .then((saved) => {
        setNote(saved);
        // 저장하는 사이 사용자가 고치지 않았으면 저장된 상태로 표시
        if (latest.current.body === v.body && latest.current.formLeadId === v.formLeadId) setDirty(false);
        setAutoSavedAt(formatDateTime(saved.updatedAt).slice(11));
        setError(null);
        autoSummarize(saved.id, v);
      })
      .catch((e: Error) => {
        autoSavePendingRef.current = true; // 다음 변경 때 다시 시도
        setError(`자동 저장 실패: ${e.message}`);
      })
      .finally(() => setSaving(false));
  }, [rec, editing, leads, onSave]);

  /**
   * 미팅 완료(녹음·파일 전사 끝 → 자동 저장) 후 자동 요약.
   * 요약이 비어 있거나 이전 자동 요약 그대로일 때만 실행 — 사용자가 고친 요약은 덮어쓰지 않는다.
   */
  const autoSummarize = (id: string, at: { summary: string; nextActions: string }) => {
    const last = lastAutoSummaryRef.current;
    const untouched =
      (!at.summary && !at.nextActions) ||
      (last !== null && at.summary === last.summary && at.nextActions === last.nextActions);
    if (!untouched) return;

    setAutoSummary("running");
    setSummarizing(true);
    onAutoSummarize(id)
      .then((n) => {
        lastAutoSummaryRef.current = { summary: n.summary, nextActions: n.nextActions };
        if (!mountedRef.current) return; // 화면을 닫았어도 서버에는 저장됨
        setNote(n);
        // 요약하는 동안 사용자가 요약 칸을 고치지 않았을 때만 폼에 반영
        if (latest.current.summary === at.summary && latest.current.nextActions === at.nextActions) {
          setSummary(n.summary);
          setNextActions(n.nextActions);
        }
        setAutoSummary("done");
      })
      .catch((e: Error) => {
        if (!mountedRef.current) return;
        setAutoSummary("failed");
        setError(`AI 요약 실패: ${e.message} — 'AI 요약 생성'으로 다시 시도할 수 있습니다`);
      })
      .finally(() => mountedRef.current && setSummarizing(false));
  };

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
    if (!title.trim()) return setError("제목을 입력하세요");
    if (!iso) return setError("미팅 일시를 입력하세요");
    if (!body.trim()) return setError("본문을 입력하거나 녹음하세요");

    setSaving(true);
    setError(null);
    try {
      const saved = await onSave(
        { leadId: formLeadId || null, title: title.trim(), metAt: iso, body, source, summary, nextActions },
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
    <Modal label="미팅 노트" size="wide" className="note-modal" onClose={requestClose}>
      <ModalHeader
        title={!note ? "미팅 노트 작성" : editing ? "미팅 노트 수정" : note.title}
        onClose={requestClose}
        actions={note && !editing && <Button size="sm" icon="edit" onClick={() => setEditing(true)}>수정</Button>}
      />

      {loading ? (
        <div className="loading">불러오는 중…</div>
      ) : !editing && note ? (
        /* ───── 보기 모드 ───── */
        <div className="note-view">
          <div className="note-view-meta">
            <span>📅 {formatDateTime(note.metAt)}</span>
            {lead ? (
              <button type="button" className="link-btn" onClick={() => onOpenLead(lead.id)}>
                🔗 {lead.company}{lead.contact ? ` — ${lead.contact}` : ""}
              </button>
            ) : (
              <>
                <Badge tone="warning" shape="pill" className="unassigned-pill">리드 미지정</Badge>
                <Button size="sm" icon="link" onClick={() => setEditing(true)}>리드 지정</Button>
              </>
            )}
            {stage && <Badge color={stage.color} shape="pill">{stage.name}</Badge>}
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
          <Field label="본문">
            <div className="note-body-view">{note.body}</div>
          </Field>
        </div>
      ) : (
        /* ───── 작성/수정 모드 ───── */
        <div className="note-form">
          <div className="note-form-grid">
            <Field label="연결 리드" hint={lockLead ? "· 고정" : "· 나중에 지정해도 됩니다"}>
              <Select
                value={formLeadId}
                disabled={lockLead}
                onChange={(e) => { setFormLeadId(e.target.value); setDirty(true); }}
              >
                <option value="">리드 미지정</option>
                {sortedLeads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.company}{l.contact ? ` — ${l.contact}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="미팅 일시 *">
              <Input type="datetime-local" value={metAt} onChange={(e) => { setMetAt(e.target.value); setDirty(true); }} />
            </Field>
          </div>
          <Field label="제목 *">
            <Input
              value={title}
              maxLength={200}
              placeholder="예: 한빛소프트 미팅"
              onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); setDirty(true); }}
            />
          </Field>

          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "record", label: `🎙 녹음하기${busy ? " •" : ""}` },
              { id: "paste", label: "📋 직접 입력 / 붙여넣기" },
            ]}
          />

          {/* 탭을 바꿔도 녹음이 끊기지 않도록 언마운트하지 않고 숨긴다 */}
          <div hidden={tab !== "record"}>
            <MeetingRecorder onTranscript={appendTranscript} onStatus={setRec} onRenameSpeaker={renameSpeakerInBody} />
          </div>

          <Field
            label="본문 *"
            hint={tab === "record" ? "— 전사 결과가 구간 순서대로 이어 붙음, 직접 수정 가능" : "— Ctrl/⌘+V로 붙여넣기, 줄바꿈 유지"}
          >
            <Textarea
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
          </Field>

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

      {editing && autoSavedAt && (
        <Alert tone="success" className="modal-alert autosave-note">
          녹음이 끝나 {autoSavedAt}에 자동 저장되었습니다.
          {autoSummary === "running" && " AI가 미팅 내용을 요약하는 중입니다… (창을 닫아도 계속됩니다)"}
          {autoSummary === "done" && " AI 요약과 다음 액션도 정리되었습니다."}
          {!formLeadId && " 연결 리드를 선택한 뒤 저장하면 리드에 연결됩니다."}
        </Alert>
      )}
      {error && <Alert tone="danger" className="modal-alert">{error}</Alert>}

      <ModalFooter start={note && <Button variant="danger" onClick={remove}>삭제</Button>}>
        {editing ? (
          <>
            <Button
              onClick={() => {
                if (note) {
                  if (busy && !confirm("녹음 또는 전사가 진행 중입니다. 수정을 취소할까요?")) return;
                  fillForm(note);
                  setEditing(false);
                } else requestClose();
              }}
            >
              취소
            </Button>
            <Button variant="primary" onClick={save} disabled={saving || rec.recording}>
              {saving ? "저장 중…" : rec.recording ? "녹음 종료 후 저장" : "저장"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>닫기</Button>
        )}
      </ModalFooter>
    </Modal>
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
    <Panel
      className="ai-card"
      title={<>✨ AI 요약{hint && <span className="muted"> {hint}</span>}</>}
      actions={
        <Button size="sm" icon={has ? "refresh" : "sparkle"} onClick={onGenerate} disabled={disabled || loading}>
          {loading ? "생성 중…" : has ? "다시 생성" : "AI 요약 생성"}
        </Button>
      }
    >
      {editable && has ? (
        <div className="ai-card-grid">
          <Field label="요약 · 고객 니즈/이슈">
            <Textarea rows={6} value={summary} onChange={(e) => editable.onSummary(e.target.value)} />
          </Field>
          <Field label="다음 액션 (한 줄에 하나)">
            <Textarea rows={6} value={editable.actionsText} onChange={(e) => editable.onActions(e.target.value)} />
          </Field>
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
    </Panel>
  );
}
