"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { contextOf, KIND_LABEL } from "@/lib/docTemplate";
import { docListQuery, type DocListQuery } from "@/lib/docQuery";
import { useDocDraft } from "@/lib/useDocDraft";
import type { Me } from "@/lib/types";
import DocAssistant from "./DocAssistant";
import DocBadge from "./DocBadge";
import DocPaper from "./DocPaper";
import RecentDocs from "./RecentDocs";
import SendDocModal from "./SendDocModal";
import { Button, Modal, ModalFooter, ModalHeader } from "./ui";

interface Props {
  me: Me | null;
  onLeadsChanged: () => void;
  onNotice: (msg: string) => void;
}

/**
 * AI Assistant의 "문서" 탭: 견적서·계약서 템플릿을 골라 대화로 작성 → 완성 → PDF·메일.
 * 작성한 문서(계약서 메뉴와 같은 목록)를 열어 이어 쓰기·PDF·메일도 할 수 있다. 미리보기는 "문서 보기" 모달.
 */
export default function QuoteChat({ me, onLeadsChanged, onNotice }: Props) {
  const draft = useDocDraft({ onLeadsChanged });
  const { templates, loadTemplates, doc, busy } = draft;
  const [preview, setPreview] = useState(false);
  /** "작성한 문서 보여줘"처럼 물었을 때: 물은 말 + 찾을 조건 (처음에는 목록을 보여주지 않는다) */
  const [asked, setAsked] = useState<{ text: string; query: DocListQuery } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // 견적서 템플릿을 먼저, 그다음 계약서
  const sorted = useMemo(
    () => (templates ? [...templates].sort((a, b) => Number(a.kind !== "quote") - Number(b.kind !== "quote")) : null),
    [templates]
  );
  const kindLabel = doc ? KIND_LABEL[doc.kind] : "문서";
  const ctx = useMemo(() => (doc ? contextOf(doc) : null), [doc]);
  const currentKey = doc?.step.type === "field" ? doc.step.key : doc?.step.type === "items" ? "품목표" : null;

  const loadDefaults = async () => {
    const n = await draft.loadDefaults();
    if (n !== null) onNotice(n ? `기본 템플릿 ${n}개를 불러왔습니다` : "이미 기본 템플릿이 있습니다");
  };

  return (
    <>
      <DocAssistant
        doc={doc}
        templates={sorted}
        busy={busy}
        error={draft.error}
        title="문서 작성"
        singleLine
        headActions={doc && (
          <div className="quote-head-actions">
            <Button size="sm" variant="ghost" icon="plus" onClick={() => { draft.reset(); setAsked(null); }}>새 문서</Button>
            <Button size="sm" onClick={() => setPreview(true)}>문서 보기</Button>
          </div>
        )}
        onPickTemplate={draft.pickTemplate}
        onSend={(message) => draft.chat({ message })}
        onAction={(action, value) => draft.chat({ action, value })}
        onDownload={draft.download}
        onEmail={() => setSending(true)}
        onLoadDefaults={loadDefaults}
        greetingNote="작성한 문서는 ‘작성한 견적서 보여줘’, ‘엔에스 계약서 찾아줘’처럼 물어보세요."
        onStartText={(text) => {
          const query = docListQuery(text);
          if (query) setAsked({ text, query });
          return !!query;
        }}
        startExtra={asked && (
          <>
            <div className="bubble bubble-user">{asked.text}</div>
            <RecentDocs query={asked.query} onOpen={draft.openDoc} disabled={busy} />
          </>
        )}
      />

      {/* 패널(sticky)이 쌓임 맥락을 만들어 메뉴·상단 바 아래에 깔리지 않도록 모달은 body에 그린다 */}
      {preview && doc && ctx && createPortal(
        <Modal label={`${kindLabel} 미리보기`} size="wide" className="quote-preview-modal" onClose={() => setPreview(false)}>
          <ModalHeader
            title={<>{doc.title} <DocBadge status={doc.status} /></>}
            onClose={() => setPreview(false)}
          />
          <div className="quote-preview">
            <DocPaper
              body={doc.body}
              ctx={ctx}
              currentKey={doc.status === "draft" ? currentKey : null}
              plain={doc.status !== "draft"}
              onEdit={doc.status === "sent" ? undefined : draft.editValue}
            />
          </div>
          <ModalFooter start={<Button variant="ghost" href={`/contracts?doc=${doc.id}`}>계약서 메뉴에서 열기</Button>}>
            {doc.status !== "draft" && (
              <>
                <Button onClick={draft.download}>⬇ PDF</Button>
                <Button variant="primary" icon="mail" onClick={() => { setPreview(false); setSending(true); }}>메일</Button>
              </>
            )}
          </ModalFooter>
        </Modal>,
        document.body,
      )}

      {sending && doc && createPortal(
        <SendDocModal
          doc={doc}
          me={me}
          onClose={() => setSending(false)}
          onSent={(r) => {
            setSending(false);
            draft.applyResult(r);
            onNotice(`${doc.company ? `${doc.company}에 ` : ""}${kindLabel}를 보냈어요`);
            if (r.document.leadId) onLeadsChanged();
          }}
        />,
        document.body,
      )}
    </>
  );
}
