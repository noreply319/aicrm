"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useDocDraft } from "@/lib/useDocDraft";
import { contextOf, KIND_LABEL } from "@/lib/docTemplate";
import type {
  DocKind, DocStatus, DocTemplate, DocumentRecord, DocumentSummary, Me,
} from "@/lib/types";
import DocAssistant from "./DocAssistant";
import DocBadge from "./DocBadge";
import { Alert, Button, Checkbox, EmptyState, Input, Select, Tabs } from "./ui";
import DocPaper from "./DocPaper";
import SendDocModal from "./SendDocModal";
import TemplateEditor from "./TemplateEditor";

interface Props {
  me: Me | null;
  /** 리드 단계가 바뀌었을 때 (발송 후 단계 이동) */
  onLeadsChanged: () => void;
  /** Gmail 연동 후 돌아왔을 때 연동 상태 다시 읽기 */
  onMeChanged: () => void;
  onNotice: (msg: string) => void;
}

type Tab = "new" | "docs" | "templates";

const fmtDate = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 16).replace("-", "/");

/** 계약서 메뉴: 새 문서(왼쪽 Assistant + 오른쪽 문서) / 작성한 문서 / 템플릿 */
export default function ContractsView({ me, onLeadsChanged, onMeChanged, onNotice }: Props) {
  const [tab, setTab] = useState<Tab>("new");
  const [flash, setFlash] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<DocTemplate | "new" | null>(null);
  /** 모바일: 대화 / 문서 */
  const [pane, setPane] = useState<"chat" | "doc">("chat");
  const [docDot, setDocDot] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const draft = useDocDraft({
    onLeadsChanged,
    onResult: (r) => {
      if (!r.changed.length) return;
      setFlash(r.changed);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash([]), 1600);
      // 모바일: 대화 화면에 있으면 "문서에 반영됨" 알림
      if (window.matchMedia("(max-width: 760px)").matches && pane === "chat") {
        setDocDot(true);
        onNotice(`${r.changed.filter((k) => k !== "품목표").join(", ") || "품목"} 반영됨`);
      }
    },
  });
  const { templates, loadTemplates, doc, busy, error, chat, editValue, download, applyResult } = draft;
  const { openDoc: loadDoc, pickTemplate: createDoc } = draft;

  const openDoc = useCallback(async (id: string) => {
    if (await loadDoc(id)) {
      setTab("new");
      setPane("chat");
    }
  }, [loadDoc]);

  useEffect(() => {
    loadTemplates();
    // /contracts?doc=…: Gmail 연동 후 돌아오거나 링크로 열 때
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("doc");
    if (id) openDoc(id);
    if (sp.get("gmail") === "connected") {
      onNotice("Gmail이 연동되었습니다. 이제 메일을 보낼 수 있어요");
      onMeChanged();
    }
    if (sp.get("gmail_error")) onNotice("Gmail 연동에 실패했습니다. 설정에서 다시 시도하세요");
    if (sp.toString()) window.history.replaceState(null, "", "/contracts");
  }, [loadTemplates, openDoc, onMeChanged, onNotice]);

  const pickTemplate = async (t: DocTemplate) => {
    if (await createDoc(t)) setTab("new");
  };

  const loadDefaults = async () => {
    const n = await draft.loadDefaults();
    if (n !== null) onNotice(n ? `기본 템플릿 ${n}개를 불러왔습니다` : "이미 기본 템플릿이 있습니다");
  };

  const ctx = useMemo(() => (doc ? contextOf(doc) : null), [doc]);
  const currentKey = doc?.step.type === "field" ? doc.step.key : doc?.step.type === "items" ? "품목표" : null;
  const missing = doc ? doc.progress.total - doc.progress.filled : 0;

  if (editing) {
    return (
      <TemplateEditor
        template={editing === "new" ? null : editing}
        onSaved={() => {
          onNotice(editing === "new" ? "템플릿을 등록했습니다" : "템플릿을 저장했습니다");
          setEditing(null);
          setTab("templates");
          loadTemplates();
        }}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="contracts">
      <div className="sub-tabs">
        <Tabs
          items={[{ id: "new", label: "새 문서" }, { id: "docs", label: "작성한 문서" }, { id: "templates", label: "템플릿" }]}
          value={tab}
          onChange={setTab}
        />
        {tab === "new" && doc && (
          <Button size="sm" icon="plus" className="sub-tabs-action" onClick={draft.reset}>새 문서</Button>
        )}
      </div>

      {tab === "new" && (
        <>
          <div className="pane-toggle" role="tablist" aria-label="화면 전환">
            <button type="button" role="tab" aria-selected={pane === "chat"} className={pane === "chat" ? "on" : ""} onClick={() => setPane("chat")}>💬 대화</button>
            <button type="button" role="tab" aria-selected={pane === "doc"} className={pane === "doc" ? "on" : ""} onClick={() => { setPane("doc"); setDocDot(false); }}>
              📄 문서{docDot && <i className="pane-dot" aria-label="새 내용" />}
            </button>
          </div>
          <div className={`doc-split pane-${pane}`}>
            <DocAssistant
              doc={doc}
              templates={templates}
              busy={busy}
              error={error}
              onPickTemplate={pickTemplate}
              onSend={(message) => chat({ message })}
              onAction={(action, value) => chat({ action, value })}
              onDownload={download}
              onEmail={() => setSending(true)}
              onLoadDefaults={loadDefaults}
              onNewTemplate={() => setEditing("new")}
            />
            <section className="doc-pane" aria-label="문서 미리보기">
              {doc && ctx ? (
                <>
                  <div className="doc-tool">
                    <b className="doc-tool-title">{doc.title}</b>
                    <DocBadge status={doc.status} />
                    {doc.company && <span className="muted">{doc.company}</span>}
                    <span className="spacer" />
                    {doc.status === "draft" && missing > 0 && (
                      <button type="button" className="pill-btn" title="미입력 필수 항목으로 이동"
                        onClick={() => document.querySelector<HTMLElement>(".paper .fchip:not(.ok):not(.calc)")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                        미입력 {missing}
                      </button>
                    )}
                    {doc.status === "draft" ? (
                      <Button size="sm" disabled={busy} onClick={() => chat({ action: "complete" })}>완성하기</Button>
                    ) : (
                      <>
                        <Button size="sm" onClick={download}>⬇ PDF</Button>
                        <Button size="sm" variant="primary" icon="mail" onClick={() => setSending(true)}>메일</Button>
                      </>
                    )}
                  </div>
                  <DocPaper
                    body={doc.body}
                    ctx={ctx}
                    currentKey={doc.status === "draft" ? currentKey : null}
                    flash={flash}
                    plain={doc.status !== "draft"}
                    onEdit={doc.status === "sent" ? undefined : editValue}
                  />
                </>
              ) : (
                <EmptyState icon="📄" title="템플릿을 고르면 여기에 문서가 표시돼요" description="답변할 때마다 바뀌는 부분이 채워집니다" />
              )}
            </section>
          </div>
        </>
      )}

      {tab === "docs" && <DocumentList onOpen={openDoc} onNotice={onNotice} />}

      {tab === "templates" && (
        <TemplateList
          templates={templates}
          onReload={loadTemplates}
          onEdit={(t) => setEditing(t)}
          onNew={() => setEditing("new")}
          onUse={pickTemplate}
          onLoadDefaults={loadDefaults}
          onNotice={onNotice}
        />
      )}

      {sending && doc && (
        <SendDocModal
          doc={doc}
          me={me}
          onClose={() => setSending(false)}
          onSent={(r) => {
            setSending(false);
            applyResult(r);
            onNotice(`${doc.company ? `${doc.company}에 ` : ""}${KIND_LABEL[doc.kind]}를 보냈어요`);
            if (r.document.leadId) onLeadsChanged();
          }}
        />
      )}
    </div>
  );
}

// ───────── 작성한 문서 ─────────

function DocumentList({ onOpen, onNotice }: { onOpen: (id: string) => void; onNotice: (m: string) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [kind, setKind] = useState<DocKind | "">("");
  const [status, setStatus] = useState<DocStatus | "">("");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sp = new URLSearchParams();
    if (kind) sp.set("kind", kind);
    if (status) sp.set("status", status);
    if (mine) sp.set("mine", "1");
    if (q.trim()) sp.set("q", q.trim());
    try {
      setDocs(await api<DocumentSummary[]>(`/api/documents?${sp}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kind, status, mine, q]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const duplicate = async (d: DocumentSummary) => {
    try {
      const copy = await api<DocumentRecord>(`/api/documents/${d.id}/duplicate`, { method: "POST" });
      onNotice(`${copy.docNumber}로 복제했습니다`);
      onOpen(copy.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (d: DocumentSummary) => {
    if (!confirm(`‘${d.title}’ (${d.docNumber}) 문서를 삭제할까요?`)) return;
    try {
      await api(`/api/documents/${d.id}`, { method: "DELETE" });
      onNotice("문서를 삭제했습니다");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="contracts-main">
      <div className="list-toolbar">
        <Input type="search" className="list-search" aria-label="문서 검색" placeholder="제목·회사명·문서번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value as DocKind | "")}>
          <option value="">종류: 전체</option><option value="contract">계약서</option><option value="quote">견적서</option>
        </Select>
        <Select aria-label="상태" value={status} onChange={(e) => setStatus(e.target.value as DocStatus | "")}>
          <option value="">상태: 전체</option><option value="draft">작성 중</option><option value="completed">완성</option><option value="sent">발송됨</option>
        </Select>
        <Checkbox label="내 문서만" checked={mine} onChange={setMine} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {docs === null ? (
        <div className="loading">불러오는 중…</div>
      ) : docs.length === 0 ? (
        <EmptyState icon="🗂" title="작성한 문서가 없습니다" />
      ) : (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr><th>제목</th><th>종류</th><th>리드</th><th>상태</th><th>작성자</th><th>수정·발송</th><th /></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} onClick={() => onOpen(d.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(d.id)}>
                  <td><b>{d.title}</b><div className="muted">{d.docNumber}</div></td>
                  <td><DocBadge kind={d.kind} /></td>
                  <td>{d.company || <span className="muted">— 리드 없음</span>}</td>
                  <td>
                    <DocBadge status={d.status} suffix={d.status === "draft" && d.progress.total ? ` ${d.progress.filled}/${d.progress.total}` : ""} />
                  </td>
                  <td>{d.createdByName || "—"}</td>
                  <td className="muted">
                    {d.sentAt ? `${fmtDate(d.sentAt)} 발송${d.sendCount > 1 ? ` (${d.sendCount}회)` : ""}` : fmtDate(d.updatedAt)}
                  </td>
                  <td className="doc-actions" onClick={(e) => e.stopPropagation()}>
                    {d.status !== "draft" && <Button size="sm" href={`/api/documents/${d.id}/pdf`} title="PDF 다운로드">⬇</Button>}
                    <Button size="sm" onClick={() => duplicate(d)}>복제</Button>
                    {d.status !== "sent" && <Button size="sm" variant="danger" aria-label="삭제" onClick={() => remove(d)}>삭제</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────── 템플릿 ─────────

function TemplateList({ templates, onReload, onEdit, onNew, onUse, onLoadDefaults, onNotice }: {
  templates: DocTemplate[] | null;
  onReload: () => Promise<void>;
  onEdit: (t: DocTemplate) => void;
  onNew: () => void;
  onUse: (t: DocTemplate) => void;
  onLoadDefaults: () => void;
  onNotice: (m: string) => void;
}) {
  const [kind, setKind] = useState<DocKind | "">("");
  const [archived, setArchived] = useState<DocTemplate[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArchived = useCallback(async () => {
    try {
      setArchived(await api<DocTemplate[]>("/api/templates?archived=1"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      onNotice(msg);
      await onReload();
      if (showArchived) await loadArchived();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const list = (showArchived ? archived : templates)?.filter((t) => !kind || t.kind === kind) ?? null;

  return (
    <div className="contracts-main">
      <div className="list-toolbar">
        <Tabs
          items={[{ id: "all", label: "전체" }, { id: "contract", label: "계약서" }, { id: "quote", label: "견적서" }]}
          value={kind || "all"}
          onChange={(v) => setKind(v === "all" ? "" : v)}
        />
        <Checkbox label="보관함 보기" checked={showArchived} onChange={setShowArchived} />
        <span className="spacer" />
        <Button variant="primary" icon="plus" onClick={onNew}>템플릿 등록</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {list === null ? (
        <div className="loading">불러오는 중…</div>
      ) : (
        <div className="tpl-grid">
          {list.map((t) => (
            <div key={t.id} className="tpl-card">
              <DocBadge kind={t.kind} />
              <h3>{t.name}</h3>
              {t.description && <p className="muted">{t.description}</p>}
              <div className="muted">항목 {t.fields.length}{t.lineItems ? " + 품목 표" : ""} · 문서 {t.documentCount}건</div>
              <div className="muted">{fmtDate(t.updatedAt)} {t.updatedByName} 수정</div>
              <div className="tpl-card-actions">
                {showArchived ? (
                  <>
                    <Button size="sm" onClick={() => run(() => api(`/api/templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }), "템플릿을 복원했습니다")}>복원</Button>
                    <Button size="sm" variant="danger" onClick={() => confirm(`‘${t.name}’ 템플릿을 삭제할까요?\n이 템플릿으로 만든 문서는 그대로 남습니다.`) && run(() => api(`/api/templates/${t.id}`, { method: "DELETE" }), "템플릿을 삭제했습니다")}>삭제</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" onClick={() => onEdit(t)}>수정</Button>
                    <Button size="sm" onClick={() => run(() => api(`/api/templates/${t.id}/duplicate`, { method: "POST" }), "템플릿을 복제했습니다")}>복제</Button>
                    <Button size="sm" onClick={() => run(() => api(`/api/templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }), "템플릿을 보관했습니다")}>보관</Button>
                    <span className="spacer" />
                    <Button size="sm" variant="primary" onClick={() => onUse(t)}>이걸로 작성</Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!showArchived && (
            <div className="tpl-card tpl-card-new">
              <Button icon="plus" onClick={onNew}>새 템플릿</Button>
              <Button size="sm" variant="ghost" onClick={onLoadDefaults}>기본 템플릿 불러오기</Button>
            </div>
          )}
          {showArchived && list.length === 0 && <p className="muted">보관한 템플릿이 없습니다.</p>}
        </div>
      )}
    </div>
  );
}
