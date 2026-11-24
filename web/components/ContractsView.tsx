"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { contextOf, KIND_LABEL } from "@/lib/docTemplate";
import type {
  DocAction, DocChatResult, DocKind, DocStatus, DocTemplate, DocumentRecord, DocumentSummary, Me,
} from "@/lib/types";
import DocAssistant from "./DocAssistant";
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

const STATUS_LABEL: Record<DocStatus, string> = { draft: "작성 중", completed: "완성", sent: "발송됨" };
const fmtDate = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 16).replace("-", "/");

/** 계약서 메뉴: 새 문서(왼쪽 Assistant + 오른쪽 문서) / 작성한 문서 / 템플릿 */
export default function ContractsView({ me, onLeadsChanged, onMeChanged, onNotice }: Props) {
  const [tab, setTab] = useState<Tab>("new");
  const [templates, setTemplates] = useState<DocTemplate[] | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<DocTemplate | "new" | null>(null);
  /** 모바일: 대화 / 문서 */
  const [pane, setPane] = useState<"chat" | "doc">("chat");
  const [docDot, setDocDot] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api<DocTemplate[]>("/api/templates"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const openDoc = useCallback(async (id: string) => {
    setError(null);
    try {
      setDoc(await api<DocumentRecord>(`/api/documents/${id}`));
      setTab("new");
      setPane("chat");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

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

  const applyResult = (r: DocChatResult) => {
    setDoc(r.document);
    if (r.changed.length) {
      setFlash(r.changed);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash([]), 1600);
      // 모바일: 대화 화면에 있으면 "문서에 반영됨" 알림
      if (window.matchMedia("(max-width: 760px)").matches && pane === "chat") {
        setDocDot(true);
        onNotice(`${r.changed.filter((k) => k !== "품목표").join(", ") || "품목"} 반영됨`);
      }
    }
    if (r.leadChanged) onLeadsChanged();
  };

  const pickTemplate = async (t: DocTemplate) => {
    setBusy(true);
    setError(null);
    try {
      setDoc(await api<DocumentRecord>("/api/documents", { method: "POST", body: JSON.stringify({ templateId: t.id }) }));
      setTab("new");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chat = async (payload: { message?: string; action?: DocAction; value?: string }) => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    // 보낸 말은 바로 보이게 (응답이 오면 서버 기록으로 바뀐다)
    const optimistic = payload.message ?? null;
    if (optimistic) setDoc({ ...doc, messages: [...doc.messages, { role: "user", text: optimistic, at: new Date().toISOString() }] });
    try {
      applyResult(await api<DocChatResult>(`/api/documents/${doc.id}/chat`, { method: "POST", body: JSON.stringify(payload) }));
    } catch (e) {
      setError((e as Error).message);
      setDoc(doc);
    } finally {
      setBusy(false);
    }
  };

  const editValue = async (key: string, value: string) => {
    if (!doc) return;
    const r = await api<DocChatResult>(`/api/documents/${doc.id}`, { method: "PATCH", body: JSON.stringify({ values: { [key]: value } }) });
    applyResult(r);
  };

  const download = () => {
    if (!doc) return;
    window.location.href = `/api/documents/${doc.id}/pdf`;
  };

  const loadDefaults = async () => {
    try {
      const added = await api<DocTemplate[]>("/api/templates/defaults", { method: "POST" });
      onNotice(added.length ? `기본 템플릿 ${added.length}개를 불러왔습니다` : "이미 기본 템플릿이 있습니다");
      await loadTemplates();
    } catch (e) {
      setError((e as Error).message);
    }
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
      <nav className="sub-tabs" aria-label="계약서 메뉴">
        {([["new", "새 문서"], ["docs", "작성한 문서"], ["templates", "템플릿"]] as const).map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        {tab === "new" && doc && (
          <button type="button" className="btn btn-sm sub-tabs-action" onClick={() => { setDoc(null); setError(null); }}>+ 새 문서</button>
        )}
      </nav>

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
                    <span className={`status-badge ${doc.status}`}>{STATUS_LABEL[doc.status]}</span>
                    {doc.company && <span className="muted">{doc.company}</span>}
                    <span className="spacer" />
                    {doc.status === "draft" && missing > 0 && (
                      <button type="button" className="pill-btn" title="미입력 필수 항목으로 이동"
                        onClick={() => document.querySelector<HTMLElement>(".paper .fchip:not(.ok):not(.calc)")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                        미입력 {missing}
                      </button>
                    )}
                    {doc.status === "draft" ? (
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => chat({ action: "complete" })}>완성하기</button>
                    ) : (
                      <>
                        <button type="button" className="btn btn-sm" onClick={download}>⬇ PDF</button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setSending(true)}>✉ 메일</button>
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
                <div className="doc-empty">
                  <div className="empty-icon">📄</div>
                  <b>템플릿을 고르면 여기에 문서가 표시돼요</b>
                  <p className="muted">답변할 때마다 바뀌는 부분이 채워집니다</p>
                </div>
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
        <input type="search" className="list-search" placeholder="제목·회사명·문서번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value as DocKind | "")}>
          <option value="">종류: 전체</option><option value="contract">계약서</option><option value="quote">견적서</option>
        </select>
        <select aria-label="상태" value={status} onChange={(e) => setStatus(e.target.value as DocStatus | "")}>
          <option value="">상태: 전체</option><option value="draft">작성 중</option><option value="completed">완성</option><option value="sent">발송됨</option>
        </select>
        <label className="check-row"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 내 문서만</label>
      </div>
      {error && <div className="modal-error" role="alert">⚠ {error}</div>}
      {docs === null ? (
        <div className="loading">불러오는 중…</div>
      ) : docs.length === 0 ? (
        <div className="empty-state"><div className="empty-icon">🗂</div><p>작성한 문서가 없습니다.</p></div>
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
                  <td><span className={`kind-pill ${d.kind}`}>{KIND_LABEL[d.kind]}</span></td>
                  <td>{d.company || <span className="muted">— 리드 없음</span>}</td>
                  <td>
                    <span className={`status-badge ${d.status}`}>
                      {STATUS_LABEL[d.status]}{d.status === "draft" && d.progress.total ? ` ${d.progress.filled}/${d.progress.total}` : ""}
                    </span>
                  </td>
                  <td>{d.createdByName || "—"}</td>
                  <td className="muted">
                    {d.sentAt ? `${fmtDate(d.sentAt)} 발송${d.sendCount > 1 ? ` (${d.sendCount}회)` : ""}` : fmtDate(d.updatedAt)}
                  </td>
                  <td className="doc-actions" onClick={(e) => e.stopPropagation()}>
                    {d.status !== "draft" && <a className="btn btn-sm" href={`/api/documents/${d.id}/pdf`} title="PDF 다운로드">⬇</a>}
                    <button type="button" className="btn btn-sm" onClick={() => duplicate(d)}>복제</button>
                    {d.status !== "sent" && <button type="button" className="btn btn-sm btn-danger" aria-label="삭제" onClick={() => remove(d)}>🗑</button>}
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
        <div className="seg" role="radiogroup" aria-label="종류">
          {([["", "전체"], ["contract", "계약서"], ["quote", "견적서"]] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={kind === v} className={kind === v ? "on" : ""} onClick={() => setKind(v)}>{l}</button>
          ))}
        </div>
        <label className="check-row"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관함 보기</label>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={onNew}>+ 템플릿 등록</button>
      </div>
      {error && <div className="modal-error" role="alert">⚠ {error}</div>}
      {list === null ? (
        <div className="loading">불러오는 중…</div>
      ) : (
        <div className="tpl-grid">
          {list.map((t) => (
            <div key={t.id} className="tpl-card">
              <span className={`kind-pill ${t.kind}`}>{KIND_LABEL[t.kind]}</span>
              <h3>{t.name}</h3>
              {t.description && <p className="muted">{t.description}</p>}
              <div className="muted">항목 {t.fields.length}{t.lineItems ? " + 품목 표" : ""} · 문서 {t.documentCount}건</div>
              <div className="muted">{fmtDate(t.updatedAt)} {t.updatedByName} 수정</div>
              <div className="tpl-card-actions">
                {showArchived ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => run(() => api(`/api/templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }), "템플릿을 복원했습니다")}>복원</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => confirm(`‘${t.name}’ 템플릿을 삭제할까요?\n이 템플릿으로 만든 문서는 그대로 남습니다.`) && run(() => api(`/api/templates/${t.id}`, { method: "DELETE" }), "템플릿을 삭제했습니다")}>삭제</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => onEdit(t)}>수정</button>
                    <button type="button" className="btn btn-sm" onClick={() => run(() => api(`/api/templates/${t.id}/duplicate`, { method: "POST" }), "템플릿을 복제했습니다")}>복제</button>
                    <button type="button" className="btn btn-sm" onClick={() => run(() => api(`/api/templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }), "템플릿을 보관했습니다")}>보관</button>
                    <span className="spacer" />
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => onUse(t)}>이걸로 작성</button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!showArchived && (
            <div className="tpl-card tpl-card-new">
              <button type="button" className="btn" onClick={onNew}>+ 새 템플릿</button>
              <button type="button" className="btn btn-sm" onClick={onLoadDefaults}>기본 템플릿 불러오기</button>
            </div>
          )}
          {showArchived && list.length === 0 && <p className="muted">보관한 템플릿이 없습니다.</p>}
        </div>
      )}
    </div>
  );
}
