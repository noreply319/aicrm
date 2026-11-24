"use client";

import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from "@/lib/docSamples";
import {
  CALC_KEYS, FIELD_TYPE_LABEL, ITEMS_KEY, KIND_LABEL, LEAD_SOURCE_LABEL, SYSTEM_KEYS, syncFields, TEMPLATE_LIMITS,
  todayKst, type DocContext,
} from "@/lib/docTemplate";
import type { DocKind, DocTemplate, DocTemplateInput, FieldType, LeadSource, TemplateField } from "@/lib/types";
import DocPaper from "./DocPaper";

interface Props {
  /** null = 새 템플릿 */
  template: DocTemplate | null;
  onSaved: (t: DocTemplate) => void;
  onClose: () => void;
}

const NEW_BODY = `# 계약서 제목

{{회사명}}(이하 "고객")와 우리 회사(이하 "회사")는 다음과 같이 계약을 체결한다.

## 제1조 (목적)
여기에 계약서 본문을 붙여넣고, 문서마다 바뀌는 글자를 드래그해 ‘항목으로 지정’을 누르세요.

계약일: {{계약일}}`;

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 템플릿 등록·수정: 본문 붙여넣기 → 바뀌는 글자 드래그 → ‘항목으로 지정’ (또는 {{항목}} 직접 입력)
 * 오른쪽 항목 패널에서 유형·질문·필수·리드 자동 채움·순서를 정한다.
 */
export default function TemplateEditor({ template, onSaved, onClose }: Props) {
  const [kind, setKind] = useState<DocKind>(template?.kind ?? "contract");
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [body, setBody] = useState(template?.body ?? NEW_BODY);
  const [emailSubject, setEmailSubject] = useState(template?.emailSubject ?? DEFAULT_EMAIL_SUBJECT);
  const [emailBody, setEmailBody] = useState(template?.emailBody ?? DEFAULT_EMAIL_BODY);
  const [lineItems, setLineItems] = useState(template?.lineItems ?? { spec: true, vat: "excluded" as const });
  const [config, setConfig] = useState<TemplateField[]>(template?.fields ?? []);
  const [tab, setTab] = useState<"body" | "email">("body");
  const [preview, setPreview] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const [naming, setNaming] = useState<{ name: string; all: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /** 본문·메일 양식의 {{항목}}과 설정을 맞춘 목록 (입력할 때마다) */
  const fields = useMemo(() => syncFields([body, emailSubject, emailBody], config), [body, emailSubject, emailBody, config]);
  const updateField = (key: string, patch: Partial<TemplateField>) =>
    setConfig(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const move = (key: string, to: number) => {
    const list = [...fields];
    const from = list.findIndex((f) => f.key === key);
    if (from < 0 || to < 0 || to >= list.length) return;
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    setConfig(list);
  };

  const readSelection = () => {
    const el = bodyRef.current;
    if (!el) return;
    const text = el.value.slice(el.selectionStart, el.selectionEnd);
    setSelection(text.trim() && !text.includes("\n") && text.length <= 80 ? { start: el.selectionStart, end: el.selectionEnd, text } : null);
  };

  const occurrences = selection ? body.split(selection.text).length - 1 : 0;

  const assign = () => {
    if (!selection || !naming) return;
    const key = naming.name.trim().replace(/[{}]/g, "").slice(0, TEMPLATE_LIMITS.key);
    if (!key) return;
    const token = `{{${key}}}`;
    const next = naming.all
      ? body.replace(new RegExp(escapeRe(selection.text), "g"), token)
      : body.slice(0, selection.start) + token + body.slice(selection.end);
    setBody(next);
    setSelection(null);
    setNaming(null);
    setOpen(key);
  };

  const insertAtCursor = (text: string) => {
    const el = bodyRef.current;
    const pos = el ? el.selectionStart : body.length;
    setBody(body.slice(0, pos) + text + body.slice(el ? el.selectionEnd : pos));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + text.length, pos + text.length);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const input: DocTemplateInput = {
      kind, name, description, body, fields, lineItems: kind === "quote" ? lineItems : null, emailSubject, emailBody,
    };
    try {
      const saved = template
        ? await api<DocTemplate>(`/api/templates/${template.id}`, { method: "PATCH", body: JSON.stringify(input) })
        : await api<DocTemplate>("/api/templates", { method: "POST", body: JSON.stringify(input) });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const previewCtx: DocContext = {
    fields, values: {}, lineItems: [], lineItemsConfig: kind === "quote" ? lineItems : null,
    docNumber: `${kind === "contract" ? "C" : "Q"}-0000-0000`, date: todayKst(), docName: name || "문서명", author: "작성자", authorEmail: "",
  };
  const hasItems = body.includes(`{{${ITEMS_KEY}}}`);

  return (
    <div className="tpl-editor">
      <div className="tpl-editor-bar">
        <button type="button" className="btn btn-sm" onClick={onClose}>← 템플릿</button>
        <input className="tpl-name" aria-label="템플릿 이름" placeholder="템플릿 이름 (예: SaaS 서비스 이용 계약서)" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <div className="seg" role="radiogroup" aria-label="문서 종류">
          {(["contract", "quote"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className={`btn btn-sm${preview ? " btn-active" : ""}`} aria-pressed={preview} onClick={() => setPreview((v) => !v)}>미리보기</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? "저장 중…" : "저장"}</button>
      </div>
      {error && <div className="modal-error tpl-error" role="alert">⚠ {error}</div>}

      <div className="tpl-editor-grid">
        <div className="tpl-main">
          <input className="tpl-desc" placeholder="설명 (선택)" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          <div className="tpl-tabs">
            <div className="seg">
              <button type="button" className={tab === "body" ? "on" : ""} onClick={() => setTab("body")}>본문</button>
              <button type="button" className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>메일 양식</button>
            </div>
            {tab === "body" && !preview && (
              <>
                <button type="button" className="btn btn-sm" disabled={!selection} onClick={() => setNaming({ name: "", all: true })} title="본문에서 바뀌는 글자를 드래그한 뒤 누르세요">
                  ⬚ 항목으로 지정
                </button>
                <button type="button" className="btn btn-sm" onClick={() => insertAtCursor("{{새 항목}}")}>+ 항목 삽입</button>
                {kind === "quote" && (
                  <button type="button" className="btn btn-sm" disabled={hasItems} onClick={() => insertAtCursor(`\n{{${ITEMS_KEY}}}\n`)}>▦ 품목 표 삽입</button>
                )}
              </>
            )}
            <span className="muted tpl-syntax"># 제목 · ## 조항 · - 목록 · 빈 줄 = 문단</span>
          </div>

          {naming && selection && (
            <div className="assign-pop" role="dialog" aria-label="항목으로 지정">
              <b>선택한 글자를 항목으로 지정</b> <span className="muted">“{selection.text}”</span>
              <div className="row">
                <input autoFocus placeholder="항목 이름 (예: 이용 요금)" value={naming.name} maxLength={TEMPLATE_LIMITS.key}
                  onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), assign())} />
                <button type="button" className="btn btn-sm" onClick={() => setNaming(null)}>취소</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={!naming.name.trim()} onClick={assign}>항목으로 지정</button>
              </div>
              {occurrences > 1 && (
                <label className="check-row">
                  <input type="checkbox" checked={naming.all} onChange={(e) => setNaming({ ...naming, all: e.target.checked })} />
                  본문의 같은 글자 {occurrences}곳 모두 바꾸기
                </label>
              )}
            </div>
          )}

          {tab === "body" ? (
            preview ? (
              <div className="tpl-preview"><DocPaper body={body} ctx={previewCtx} /></div>
            ) : (
              <textarea
                ref={bodyRef}
                className="tpl-source"
                aria-label="템플릿 본문"
                value={body}
                spellCheck={false}
                maxLength={TEMPLATE_LIMITS.body}
                onChange={(e) => setBody(e.target.value)}
                onSelect={readSelection}
                onKeyUp={readSelection}
                onMouseUp={readSelection}
              />
            )
          ) : (
            <div className="tpl-email">
              <div className="field">
                <label htmlFor="tpl-subject">메일 제목</label>
                <input id="tpl-subject" value={emailSubject} maxLength={200} onChange={(e) => setEmailSubject(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="tpl-mail-body">메일 본문</label>
                <textarea id="tpl-mail-body" rows={12} value={emailBody} maxLength={TEMPLATE_LIMITS.email} onChange={(e) => setEmailBody(e.target.value)} />
              </div>
              <p className="muted">메일에도 {"{{항목}}"}을 쓸 수 있어요. 보낼 때 값이 채워지고, 보내기 전에 수정할 수 있습니다.</p>
            </div>
          )}
        </div>

        <aside className="tpl-side" aria-label="항목">
          <div className="tpl-side-head"><b>항목 {fields.length}</b><span className="muted">질문 순서 (드래그)</span></div>
          {fields.length === 0 && <p className="muted">본문에서 바뀌는 글자를 드래그해 ‘항목으로 지정’을 누르거나 {"{{항목}}"}을 입력하세요.</p>}
          {fields.map((f, i) => (
            <div
              key={f.key}
              className={`field-row${open === f.key ? " open" : ""}${dragKey === f.key ? " dragging" : ""}`}
              draggable
              onDragStart={() => setDragKey(f.key)}
              onDragEnd={() => setDragKey(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dragKey && move(dragKey, i)}
            >
              <div className="field-row-head">
                <span className="grip" aria-hidden>⠿</span>
                <button type="button" className="field-row-name" aria-expanded={open === f.key} onClick={() => setOpen(open === f.key ? null : f.key)}>
                  {f.key}
                </button>
                <span className="pill">{FIELD_TYPE_LABEL[f.type]}</span>
                {f.required && <span className="pill">필수</span>}
                {f.leadSource && <span className="muted">← 리드: {LEAD_SOURCE_LABEL[f.leadSource]}</span>}
                <span className="spacer" />
                <button type="button" className="mini-btn" aria-label={`${f.key} 위로`} disabled={i === 0} onClick={() => move(f.key, i - 1)}>▲</button>
                <button type="button" className="mini-btn" aria-label={`${f.key} 아래로`} disabled={i === fields.length - 1} onClick={() => move(f.key, i + 1)}>▼</button>
              </div>
              {open === f.key && (
                <div className="field-row-body">
                  <div className="two">
                    <label>유형
                      <select value={f.type} onChange={(e) => updateField(f.key, { type: e.target.value as FieldType })}>
                        {Object.entries(FIELD_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </label>
                    <label>리드 자동 채움
                      <select value={f.leadSource} onChange={(e) => updateField(f.key, { leadSource: e.target.value as LeadSource })}>
                        {Object.entries(LEAD_SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>질문 문구<input value={f.question} maxLength={200} placeholder="비우면 자동 (예: 회사명을 알려주세요.)" onChange={(e) => updateField(f.key, { question: e.target.value })} /></label>
                  <label>예시·설명<input value={f.hint} maxLength={200} placeholder="예: 2026-12-01" onChange={(e) => updateField(f.key, { hint: e.target.value })} /></label>
                  {f.type === "choice" && (
                    <label>보기 (쉼표로 구분)
                      <input defaultValue={f.options.join(", ")} placeholder="월 분할, 연 일시불"
                        onBlur={(e) => updateField(f.key, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                    </label>
                  )}
                  <div className="two">
                    <label>기본값 (빠른 답변 버튼)<input value={f.defaultValue} maxLength={200} onChange={(e) => updateField(f.key, { defaultValue: e.target.value })} /></label>
                    <label className="check-row"><input type="checkbox" checked={f.required} onChange={(e) => updateField(f.key, { required: e.target.checked })} /> 필수</label>
                  </div>
                </div>
              )}
            </div>
          ))}

          {kind === "quote" && (
            <div className="tpl-items-config">
              <b>품목 표</b>
              {!hasItems && <p className="muted">본문에 ‘품목 표 삽입’으로 {`{{${ITEMS_KEY}}}`}를 넣으세요.</p>}
              <label className="check-row"><input type="checkbox" checked={lineItems.spec} onChange={(e) => setLineItems({ ...lineItems, spec: e.target.checked })} /> 규격 열 표시</label>
              <label>부가세
                <select value={lineItems.vat} onChange={(e) => setLineItems({ ...lineItems, vat: e.target.value as typeof lineItems.vat })}>
                  <option value="excluded">별도 (10% 추가)</option>
                  <option value="included">단가에 포함</option>
                  <option value="none">없음</option>
                </select>
              </label>
            </div>
          )}
          <p className="muted tpl-keys">
            자동 입력: {SYSTEM_KEYS.map((k) => `{{${k}}}`).join(" ")}
            {kind === "quote" && <><br />견적 계산: {CALC_KEYS.map((k) => `{{${k}}}`).join(" ")}</>}
            <br />계약 기간(기간 유형) + 이름에 ‘시작’·‘종료’가 들어간 날짜 항목이 있으면 종료일을 자동 계산해요.
          </p>
        </aside>
      </div>
    </div>
  );
}
