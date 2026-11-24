"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { EmailDetail, EmailSummary, LeadEmails as LeadEmailsData, Me } from "@/lib/types";

interface Props {
  leadId: string;
  /** 저장된 리드 이메일 주소 */
  leadEmail: string;
  gmailState: Me["gmail"]["state"];
  /** Gmail 웹에서 열 때 계정 선택용 */
  meEmail: string;
  /** API가 연동 만료·해제(409)를 알려주면 연동 상태를 다시 읽는다 */
  onExpired: () => void;
}

/** "홍길동 <a@b.com>" → "홍길동" (이름이 없으면 주소) */
const shortName = (h: string) => {
  const first = h.split(",")[0] ?? "";
  const name = first.replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  return name || first.trim();
};

/** 리드 상세 → 이메일 탭: 로그인 사용자의 Gmail에서 리드 주소와 주고받은 메일 */
export default function LeadEmails({ leadId, leadEmail, gmailState, meEmail, onExpired }: Props) {
  const [messages, setMessages] = useState<EmailSummary[] | null>(null);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EmailDetail | { error: string }>>({});
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;

  const fail = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : "메일을 불러오지 못했습니다";
    // 연동 만료·해제 메시지면 상단 상태도 갱신
    if (msg.includes("연동")) expiredRef.current();
    return msg;
  }, []);

  const load = useCallback(
    async (pageToken?: string) => {
      const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
      const data = await api<LeadEmailsData>(`/api/leads/${leadId}/emails${qs}`);
      setMessages((prev) => (pageToken && prev ? [...prev, ...data.messages] : data.messages));
      setNextPage(data.nextPageToken);
      setDomain(data.domain);
      setError(null);
    },
    [leadId]
  );

  const canLoad = gmailState === "connected" && Boolean(leadEmail.trim());
  useEffect(() => {
    if (!canLoad) return;
    load().catch((e: unknown) => setError(fail(e)));
  }, [canLoad, load, fail]);

  const more = async () => {
    if (!nextPage) return;
    setLoadingMore(true);
    try {
      await load(nextPage);
    } catch (e) {
      setError(fail(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    if (details[id] && !("error" in details[id])) return;
    api<EmailDetail>(`/api/leads/${leadId}/emails/${id}`)
      .then((d) => setDetails((m) => ({ ...m, [id]: d })))
      .catch((e: unknown) => setDetails((m) => ({ ...m, [id]: { error: fail(e) } })));
  };

  if (gmailState !== "connected") {
    return (
      <div className="lead-notes">
        <div className="empty-state small">
          <div className="empty-icon">✉️</div>
          <b>{gmailState === "expired" ? "Gmail 연동이 만료되었습니다" : "Gmail이 연동되지 않았습니다"}</b>
          <p>설정에서 Gmail을 연동하면 이 리드와 주고받은 메일을 볼 수 있습니다.</p>
          <a className="btn btn-primary" href="/settings">설정으로 이동</a>
        </div>
      </div>
    );
  }
  if (!leadEmail.trim()) {
    return (
      <div className="lead-notes">
        <div className="empty-state small">
          <div className="empty-icon">✉️</div>
          <b>리드에 이메일 주소가 없습니다</b>
          <p>리드 정보 탭에서 담당자 이메일을 입력하고 저장하세요.</p>
        </div>
      </div>
    );
  }

  const gmailLink = (m: EmailSummary) =>
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(meEmail)}#all/${encodeURIComponent(m.threadId || m.id)}`;

  return (
    <div className="lead-notes">
      <div className="lead-notes-head">
        <span className="muted">
          {domain ? `${leadEmail} 및 @${domain} 회사 메일` : `${leadEmail}와 주고받은 메일`} · 최신순
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setMessages(null);
            setDetails({});
            load().catch((e: unknown) => setError(fail(e)));
          }}
        >
          새로고침
        </button>
      </div>
      {error && <div className="modal-error">⚠ {error}</div>}
      {!messages && !error ? (
        <span className="muted">Gmail에서 불러오는 중…</span>
      ) : messages && messages.length === 0 ? (
        <div className="empty-state small">
          <div className="empty-icon">📭</div>
          <b>주고받은 메일이 없습니다</b>
        </div>
      ) : (
        messages && (
          <div className="email-list">
            {messages.map((m) => {
              const open = openId === m.id;
              const d = details[m.id];
              return (
                <div key={m.id} className={`email-item${open ? " open" : ""}`}>
                  <button type="button" className="email-row" aria-expanded={open} onClick={() => toggle(m.id)}>
                    <span className={`email-dir ${m.direction}`}>{m.direction === "sent" ? "보냄" : "받음"}</span>
                    {m.viaDomain && <span className="email-dir domain" title="담당자 외 같은 회사 도메인 메일">회사</span>}
                    <span className="email-main">
                      <span className={`email-subject${m.unread ? " unread" : ""}`}>
                        {m.subject}
                        {m.hasAttachments && <span className="muted"> 📎</span>}
                      </span>
                      <span className="email-meta muted">
                        {m.direction === "sent" ? `받는 사람: ${shortName(m.to)}` : shortName(m.from)}
                        {!open && m.snippet ? ` · ${m.snippet}` : ""}
                      </span>
                    </span>
                    <span className="email-date muted">{formatDateTime(m.date)}</span>
                  </button>
                  {open && (
                    <div className="email-body">
                      {!d ? (
                        <span className="muted">본문을 불러오는 중…</span>
                      ) : "error" in d ? (
                        <div className="modal-error">⚠ {d.error}</div>
                      ) : (
                        <>
                          <div className="email-headers muted">
                            <div>보낸 사람: {d.from}</div>
                            <div>받는 사람: {d.to}</div>
                            {d.cc && <div>참조: {d.cc}</div>}
                          </div>
                          <pre className="email-text">{d.body || "(본문 없음)"}</pre>
                          {d.attachments.length > 0 && (
                            <div className="muted email-attach">📎 {d.attachments.join(", ")}</div>
                          )}
                          <a className="btn btn-sm" href={gmailLink(m)} target="_blank" rel="noreferrer">Gmail에서 열기 ↗</a>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {nextPage && (
              <button type="button" className="btn" onClick={more} disabled={loadingMore}>
                {loadingMore ? "불러오는 중…" : "더 보기"}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
