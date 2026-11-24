"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { EmailDetail, EmailSummary, LeadEmails as LeadEmailsData, Me, StoredEmail } from "@/lib/types";
import { Alert, Badge, Button, EmptyState } from "./ui";

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

/** 요약이 남아 있을 때 연달아 요청할 최대 횟수 (1회 최대 20건) */
const MAX_SUMMARIZE_ROUNDS = 5;

/**
 * 리드 상세 → 이메일 탭: 로그인 사용자의 Gmail에서 리드 주소와 주고받은 메일
 * 1) 저장된 메일(제목·AI 요약)을 바로 표시 → 2) Gmail에서 새 메일만 가져와 저장 → 3) 새 메일만 AI 요약
 */
export default function LeadEmails({ leadId, leadEmail, gmailState, meEmail, onExpired }: Props) {
  const [data, setData] = useState<LeadEmailsData | null>(null);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "syncing" | "summarizing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EmailDetail | { error: string }>>({});
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : "메일을 불러오지 못했습니다";
    // 연동 만료·해제 메시지면 상단 상태도 갱신
    if (msg.includes("연동")) expiredRef.current();
    return msg;
  }, []);

  const base = `/api/leads/${leadId}/emails`;
  const post = useCallback(
    (path: string, body: Record<string, unknown> = {}) =>
      api<LeadEmailsData>(`${base}/${path}`, { method: "POST", body: JSON.stringify(body) }),
    [base]
  );

  /** 요약 안 된 메일이 있으면 요약 (진행이 없으면 중단) */
  const summarize = useCallback(
    async (pending: number, retryFailed = false) => {
      let left = pending;
      for (let round = 0; (left > 0 || (retryFailed && round === 0)) && round < MAX_SUMMARIZE_ROUNDS; round++) {
        setStatus("summarizing");
        const d = await post("summarize", { retryFailed: retryFailed && round === 0 });
        if (!alive.current) return;
        setData(d);
        if (d.pending >= left && !(retryFailed && round === 0)) break;
        left = d.pending;
      }
    },
    [post]
  );

  /** Gmail에서 새 메일 동기화 → 요약. retryFailed면 요약 실패했던 메일도 다시 */
  const refresh = useCallback(
    async (retryFailed = false) => {
      setError(null);
      try {
        setStatus("syncing");
        const d = await post("sync");
        if (!alive.current) return;
        setData(d);
        setNextPage(d.nextPageToken);
        await summarize(d.pending, retryFailed);
      } catch (e) {
        if (alive.current) setError(fail(e));
      } finally {
        if (alive.current) setStatus("idle");
      }
    },
    [post, summarize, fail]
  );

  const hasEmail = Boolean(leadEmail.trim());
  useEffect(() => {
    if (gmailState === "none" || !hasEmail) return;
    // 저장된 메일을 먼저 보여준 뒤 (연동 중이면) 새 메일 동기화
    api<LeadEmailsData>(base)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        if (gmailState === "connected") return refresh();
      })
      .catch((e: unknown) => alive.current && setError(fail(e)));
  }, [base, gmailState, hasEmail, refresh, fail]);

  const more = async () => {
    if (!nextPage) return;
    setLoadingMore(true);
    setError(null);
    try {
      const d = await post("sync", { pageToken: nextPage });
      if (!alive.current) return;
      setData(d);
      setNextPage(d.nextPageToken);
      await summarize(d.pending);
    } catch (e) {
      if (alive.current) setError(fail(e));
    } finally {
      if (alive.current) {
        setLoadingMore(false);
        setStatus("idle");
      }
    }
  };

  const toggle = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    if (details[id] && !("error" in details[id])) return;
    api<EmailDetail>(`${base}/${id}`)
      .then((d) => setDetails((m) => ({ ...m, [id]: d })))
      .catch((e: unknown) => setDetails((m) => ({ ...m, [id]: { error: fail(e) } })));
  };

  if (gmailState === "none") {
    return (
      <div className="lead-notes">
        <EmptyState
          small
          icon="✉️"
          title="Gmail이 연동되지 않았습니다"
          description="설정에서 Gmail을 연동하면 이 리드와 주고받은 메일을 볼 수 있습니다."
          action={<Button variant="primary" href="/settings">설정으로 이동</Button>}
        />
      </div>
    );
  }
  if (!hasEmail) {
    return (
      <div className="lead-notes">
        <EmptyState
          small
          icon="✉️"
          title="리드에 이메일 주소가 없습니다"
          description="리드 정보 탭에서 담당자 이메일을 입력하고 저장하세요."
        />
      </div>
    );
  }

  const messages = data?.messages ?? null;
  const domain = data?.domain ?? null;
  const busy = status !== "idle" || loadingMore;
  const failedCount = messages?.filter((m) => m.summaryStatus === "failed").length ?? 0;

  const gmailLink = (m: EmailSummary) =>
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(meEmail)}#all/${encodeURIComponent(m.threadId || m.id)}`;

  return (
    <div className="lead-notes">
      <div className="lead-notes-head">
        <span className="muted">
          {domain ? `${leadEmail} 및 @${domain} 회사 메일` : `${leadEmail}와 주고받은 메일`} · 최신순
        </span>
        <span className="spacer" />
        <span className="muted email-status">
          {status === "syncing" ? "새 메일 확인 중…" : status === "summarizing" ? `AI 요약 중… (${data?.pending ?? 0}건 남음)` : ""}
        </span>
        <Button
          size="sm"
          icon="refresh"
          disabled={busy || gmailState !== "connected"}
          title="Gmail에서 새 메일만 가져와 요약합니다"
          onClick={() => refresh(failedCount > 0)}
        >
          새로고침
        </Button>
      </div>
      {gmailState === "expired" && (
        <Alert tone="warning">Gmail 연동이 만료되어 저장된 메일만 표시합니다. 설정에서 다시 연동하세요.</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {!messages && !error ? (
        <span className="muted">불러오는 중…</span>
      ) : messages && messages.length === 0 && status === "syncing" ? (
        <span className="muted">Gmail에서 불러오는 중…</span>
      ) : messages && messages.length === 0 ? (
        <EmptyState small icon="📭" title="주고받은 메일이 없습니다" />
      ) : (
        messages && (
          <div className="email-list">
            {messages.map((m) => {
              const open = openId === m.id;
              const d = details[m.id];
              return (
                <div key={m.id} className={`email-item${open ? " open" : ""}`}>
                  <button type="button" className="email-row" aria-expanded={open} onClick={() => toggle(m.id)}>
                    <Badge tone={m.direction === "sent" ? "neutral" : "brand"} shape="pill">{m.direction === "sent" ? "보냄" : "받음"}</Badge>
                    {m.viaDomain && <Badge tone="warning" shape="pill" title="담당자 외 같은 회사 도메인 메일">회사</Badge>}
                    <span className="email-main">
                      <span className={`email-subject${m.unread ? " unread" : ""}`}>
                        {m.subject}
                        {m.hasAttachments && <span className="muted"> 📎</span>}
                      </span>
                      <span className="email-meta muted">
                        {m.direction === "sent" ? `받는 사람: ${shortName(m.to)}` : shortName(m.from)}
                      </span>
                      <SummaryLine m={m} summarizing={status === "summarizing"} />
                    </span>
                    <span className="email-date muted">{formatDateTime(m.date)}</span>
                  </button>
                  {open && (
                    <div className="email-body">
                      {!d ? (
                        <span className="muted">본문을 불러오는 중…</span>
                      ) : "error" in d ? (
                        <Alert tone="danger">{d.error}</Alert>
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
                          <Button size="sm" href={gmailLink(m)} target="_blank" rel="noreferrer">Gmail에서 열기 ↗</Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {nextPage && (
              <Button onClick={more} disabled={busy}>
                {loadingMore ? "불러오는 중…" : "Gmail에서 이전 메일 더 가져오기"}
              </Button>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** 목록의 요약 줄: AI 요약 → (요약 전·실패면) Gmail 미리보기 */
function SummaryLine({ m, summarizing }: { m: StoredEmail; summarizing: boolean }) {
  if (m.summaryStatus === "done" && m.summary) return <span className="email-summary">{m.summary}</span>;
  return (
    <span className="email-meta muted">
      {m.summaryStatus === "pending" && <Badge shape="pill">{summarizing ? "요약 중" : "요약 전"}</Badge>}
      {m.summaryStatus === "failed" && <Badge tone="danger" shape="pill">요약 실패</Badge>}
      {m.snippet}
    </span>
  );
}
