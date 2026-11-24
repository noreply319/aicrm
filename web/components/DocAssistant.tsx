"use client";

import { useEffect, useRef, useState } from "react";
import type { DocAction, DocMessage, DocTemplate, DocumentRecord } from "@/lib/types";
import DocBadge from "./DocBadge";
import { Alert, Badge, Button, Input, Textarea } from "./ui";

interface Props {
  /** null = 아직 문서를 고르지 않음 (템플릿 선택 단계) */
  doc: DocumentRecord | null;
  templates: DocTemplate[] | null;
  busy: boolean;
  error: string | null;
  onPickTemplate: (t: DocTemplate) => void;
  onSend: (text: string) => void;
  onAction: (action: DocAction, value?: string, label?: string) => void;
  onDownload: () => void;
  onEmail: () => void;
  onLoadDefaults: () => void;
  onNewTemplate: () => void;
}

const MAX_TEMPLATE_BUTTONS = 6;

/** 왼쪽 문서 작성 Assistant: 템플릿 선택 → 리드 → 한 번에 하나씩 질문 → 완성 → PDF·메일 */
export default function DocAssistant(p: Props) {
  const { doc, busy } = p;
  const [input, setInput] = useState("");
  const [showAll, setShowAll] = useState(false);
  /** 템플릿 선택 단계에서 이름으로 찾은 결과 */
  const [startReply, setStartReply] = useState<{ text: string; matches: DocTemplate[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [doc?.messages.length, busy, startReply]);

  useEffect(() => setStartReply(null), [doc?.id]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (doc) return p.onSend(text);
    // 템플릿 선택 단계: 이름·종류로 찾는다
    const list = p.templates ?? [];
    const norm = text.replace(/\s/g, "");
    const kind = /견적|인보이스|invoice/i.test(text) ? "quote" : /계약/.test(text) ? "contract" : null;
    let matches = list.filter((t) => norm.includes(t.name.replace(/\s/g, "")) || t.name.replace(/\s/g, "").includes(norm));
    if (matches.length === 0 && kind) matches = list.filter((t) => t.kind === kind);
    if (matches.length === 1) return p.onPickTemplate(matches[0]);
    setStartReply({
      text: matches.length ? `‘${text}’에 맞는 템플릿이 ${matches.length}개 있어요. 골라 주세요.` : `‘${text}’에 맞는 템플릿을 찾지 못했어요.`,
      matches,
    });
  };

  const messages = doc?.messages ?? [];
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  const lastResult = messages.findLastIndex((m) => m.kind === "result" || m.kind === "sent");
  const progress = doc?.progress;

  return (
    <section className="doc-chat" aria-label="문서 작성 Assistant">
      <div className="doc-chat-head">
        <div className="assistant-title">
          <Badge tone="brand">AI</Badge> 문서 작성 Assistant
          {doc && <span className="muted">· {doc.title}</span>}
        </div>
        {doc && progress && progress.total > 0 && (
          <>
            <div className="doc-progress-row muted">
              필수 {progress.filled}/{progress.total}
              <span className="spacer" />
              {busy ? "저장 중…" : "자동 저장됨 ✓"}
            </div>
            <div className="doc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.filled}>
              <i style={{ width: `${(progress.filled / progress.total) * 100}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="doc-chat-messages" ref={listRef} aria-live="polite">
        {!doc && (
          <div className="bubble bubble-assistant">
            {p.templates === null ? (
              "템플릿을 불러오는 중…"
            ) : p.templates.length === 0 ? (
              <>
                등록된 템플릿이 없어요. 기본 템플릿(계약서·견적서)을 불러오거나 새로 등록해 주세요.
                <div className="quick-row">
                  <button type="button" className="quick-btn primary" onClick={p.onLoadDefaults}>기본 템플릿 불러오기</button>
                  <button type="button" className="quick-btn" onClick={p.onNewTemplate}>+ 새 템플릿 등록</button>
                </div>
              </>
            ) : (
              <>
                안녕하세요! 어떤 문서를 만들까요?
                <div className="tpl-buttons">
                  {(showAll ? p.templates : p.templates.slice(0, MAX_TEMPLATE_BUTTONS)).map((t) => (
                    <TemplateButton key={t.id} t={t} disabled={busy} onClick={() => p.onPickTemplate(t)} />
                  ))}
                  {!showAll && p.templates.length > MAX_TEMPLATE_BUTTONS && (
                    <button type="button" className="quick-btn" onClick={() => setShowAll(true)}>더 보기 ({p.templates.length - MAX_TEMPLATE_BUTTONS})</button>
                  )}
                  <button type="button" className="quick-btn" onClick={p.onNewTemplate}>+ 새 템플릿 등록</button>
                </div>
              </>
            )}
          </div>
        )}
        {!doc && startReply && (
          <div className="bubble bubble-assistant">
            {startReply.text}
            {startReply.matches.length > 0 && (
              <div className="tpl-buttons">
                {startReply.matches.map((t) => <TemplateButton key={t.id} t={t} disabled={busy} onClick={() => p.onPickTemplate(t)} />)}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <Message
            key={i}
            m={m}
            doc={doc!}
            active={i === lastAssistant && !busy}
            showResult={i === lastResult && doc?.status !== "draft"}
            onAction={p.onAction}
            onDownload={p.onDownload}
            onEmail={p.onEmail}
          />
        ))}
        {busy && <div className="bubble bubble-assistant bubble-loading">확인 중…</div>}
      </div>

      {p.error && <Alert tone="danger">{p.error}</Alert>}

      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          value={input}
          rows={2}
          maxLength={2000}
          placeholder={
            !doc ? "버튼을 누르거나 ‘견적서’처럼 입력하세요"
              : doc.status === "sent" ? "발송한 문서는 수정할 수 없어요"
                : doc.status === "completed" ? "수정할 내용을 말씀하세요 (예: 계약 기간 2년으로 바꿔줘)"
                  : "답변 입력… ‘완료’라고 하면 지금 상태로 완성 (Enter 전송)"
          }
          disabled={doc?.status === "sent"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button variant="primary" type="submit" disabled={busy || !input.trim() || doc?.status === "sent"}>전송</Button>
      </form>
    </section>
  );
}

function TemplateButton({ t, disabled, onClick }: { t: DocTemplate; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="tpl-btn" disabled={disabled} onClick={onClick}>
      <DocBadge kind={t.kind} />
      <span className="tpl-btn-name">{t.name}</span>
      <span className="muted">항목 {t.fields.length}{t.lineItems ? " + 품목" : ""}</span>
    </button>
  );
}

function Message({ m, doc, active, showResult, onAction, onDownload, onEmail }: {
  m: DocMessage; doc: DocumentRecord; active: boolean; showResult: boolean;
  onAction: Props["onAction"]; onDownload: () => void; onEmail: () => void;
}) {
  const [date, setDate] = useState("");
  if (m.role === "user") return <div className="bubble bubble-user">{m.text}</div>;
  const field = m.fieldKey ? doc.fields.find((f) => f.key === m.fieldKey) : undefined;
  return (
    <div className={`bubble bubble-assistant${m.kind === "filled" || m.kind === "sent" ? " bubble-done" : ""}`}>
      {m.text}
      {m.kind === "sent" && m.link && (
        <div><a href={m.link} target="_blank" rel="noreferrer">Gmail에서 보기 ↗</a></div>
      )}
      {active && m.quick && m.quick.length > 0 && (
        <div className="quick-row">
          {m.quick.map((q, i) => (
            <button
              key={i}
              type="button"
              className={`quick-btn${q.action === "complete" || q.action === "items_done" || q.action === "move_stage" ? " primary" : ""}`}
              onClick={() => onAction(q.action, q.value, q.label)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      {active && field?.type === "date" && (
        <div className="quick-row">
          <Input type="date" className="quick-date" aria-label={`${field.key} 날짜 선택`} value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="quick-btn" disabled={!date} onClick={() => onAction("answer", date)}>입력</button>
        </div>
      )}
      {m.kind === "result" && showResult && (
        <div className="result-card">
          <div className="result-file">
            <span className="file-icon">PDF</span>
            <div>
              <b>{doc.title}{doc.company ? ` — ${doc.company}` : ""}</b>
              <div className="muted">{doc.docNumber}</div>
            </div>
          </div>
          <div className="quick-row">
            <Button size="sm" onClick={onDownload}>⬇ PDF 다운로드</Button>
            <Button size="sm" variant="primary" icon="mail" onClick={onEmail}>메일로 보내기</Button>
            {doc.status === "completed" && <Button size="sm" variant="ghost" onClick={() => onAction("reopen")}>계속 수정</Button>}
          </div>
        </div>
      )}
      {m.kind === "sent" && showResult && (
        <div className="quick-row">
          <Button size="sm" onClick={onDownload}>⬇ PDF 다운로드</Button>
          <Button size="sm" icon="mail" onClick={onEmail}>다시 보내기</Button>
        </div>
      )}
    </div>
  );
}
