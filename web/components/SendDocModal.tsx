"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DocChatResult, DocEmailDraft, DocumentRecord, Me } from "@/lib/types";
import { Alert, Button, Field, Input, Modal, ModalFooter, ModalHeader, Textarea } from "./ui";

interface Props {
  doc: DocumentRecord;
  me: Me | null;
  onSent: (r: DocChatResult) => void;
  onClose: () => void;
}

const ADDRESS_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 메일 보내기: 받는 사람(사용자 입력, 기본 리드 이메일)·참조·제목·본문·첨부 PDF 확인 → 내 Gmail로 발송 */
export default function SendDocModal({ doc, me, onSent, onClose }: Props) {
  const [draft, setDraft] = useState<DocEmailDraft | null>(null);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needScope, setNeedScope] = useState(false);

  const gmail = me?.gmail;
  const canSend = gmail?.state === "connected" && gmail.canSend;
  const connectHref = `/api/gmail/connect?next=${encodeURIComponent(`/contracts?doc=${doc.id}`)}`;

  useEffect(() => {
    api<DocEmailDraft>(`/api/documents/${doc.id}/email-draft`)
      .then((d) => {
        setDraft(d);
        setTo(d.to);
        setSubject(d.subject);
        setBody(d.body);
        setFileName(d.fileName);
      })
      .catch((e: Error) => setError(e.message));
  }, [doc.id]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await api<DocChatResult>(`/api/documents/${doc.id}/send`, {
        method: "POST",
        body: JSON.stringify({ to, cc, subject, body, fileName }),
      });
      onSent(r);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      if (/권한|연동/.test(msg)) setNeedScope(true);
      setSending(false);
    }
  };

  const ready = canSend && draft && to.length > 0 && subject.trim() && fileName.trim() && !sending;

  return (
    <Modal label="메일 보내기" size="lg" className="send-modal" onClose={() => !sending && onClose()}>
      <ModalHeader title="✉ 메일 보내기" onClose={sending ? undefined : onClose} />

      {(!canSend || needScope) && (
        <Alert
          tone="warning"
          className="send-warn"
          action={<Button size="sm" variant="primary" href={connectHref}>Gmail 연동</Button>}
        >
          {gmail?.state === "expired" ? "Gmail 연동이 만료되었어요." : "메일을 보내려면 Gmail 발송 권한이 필요해요."}{" "}
          {gmail?.state === "connected" && "이미 Gmail을 연동했어도 발송 권한을 위해 한 번 다시 연동해야 합니다."} 연동 후 이 문서로 돌아와요.
        </Alert>
      )}

      <div className="send-body">
        <Field label="보낸 사람">
          <span className="muted">{draft?.from ?? me?.email ?? ""} (내 Gmail)</span>
        </Field>
        <AddressInput label="받는 사람 *" values={to} onChange={setTo} placeholder="주소 입력 후 Enter" hint={draft && draft.to.length ? "리드 담당자 이메일로 채웠어요. 여러 명은 쉼표 또는 Enter" : "고객사 이메일을 입력하세요. 여러 명은 쉼표 또는 Enter"} />
        <AddressInput label="참조 (CC)" values={cc} onChange={setCc} placeholder="선택" />
        <Field label="제목">
          <Input aria-label="제목" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="본문">
          <Textarea aria-label="본문" className="send-text" value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="첨부">
          <div className="attach-row">
            <span className="file-icon">PDF</span>
            <div className="attach-main">
              <Input aria-label="첨부 파일 이름" value={fileName} maxLength={120} onChange={(e) => setFileName(e.target.value)} />
              <span className="muted">{draft ? `${formatSize(draft.size)} · ${draft.pages}쪽` : "PDF 만드는 중…"}</span>
            </div>
            <Button size="sm" href={`/api/documents/${doc.id}/pdf?inline=1`} target="_blank" rel="noreferrer">미리보기</Button>
          </div>
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      <ModalFooter start={<span className="muted">보낸편지함에 저장되고{doc.leadId ? " 리드 이력에 기록돼요" : "요"}</span>}>
        <Button onClick={onClose} disabled={sending}>취소</Button>
        <Button variant="primary" icon="mail" disabled={!ready} onClick={send}>
          {sending ? "보내는 중…" : "보내기"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** 이메일 주소 칩 입력: Enter·쉼표·공백으로 추가, 형식이 틀리면 추가하지 않음 */
function AddressInput({ label, values, onChange, placeholder, hint }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; hint?: string;
}) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const commit = () => {
    const parts = text.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return true;
    if (!parts.every((x) => ADDRESS_RE.test(x))) {
      setBad(true);
      return false;
    }
    onChange([...new Set([...values, ...parts])]);
    setText("");
    setBad(false);
    return true;
  };
  return (
    <Field label={label}>
      <div className={`chip-input${bad ? " bad" : ""}`}>
        {values.map((v) => (
          <span key={v} className="addr-chip">
            {v}
            <button type="button" aria-label={`${v} 삭제`} onClick={() => onChange(values.filter((x) => x !== v))}>✕</button>
          </span>
        ))}
        <input
          value={text}
          placeholder={values.length ? "" : placeholder}
          aria-label={label}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === "," || e.key === " ") && !e.nativeEvent.isComposing) {
              if (text.trim()) e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
      </div>
      {bad ? <span className="field-error">이메일 주소 형식을 확인하세요</span> : hint && <span className="muted">{hint}</span>}
    </Field>
  );
}
