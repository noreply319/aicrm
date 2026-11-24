"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CalendarInfo, Me } from "@/lib/types";

interface Props {
  me: Me | null;
  onSetCalendar: (calendarId: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onLogout: () => void;
  onNotice: (msg: string) => void;
}

/** 구글 OAuth 콜백이 돌려준 결과 코드 → 안내 문구 */
const CALENDAR_ERRORS: Record<string, string> = {
  denied: "구글 동의 화면에서 취소했습니다.",
  state: "연동 요청이 만료되었습니다. 다시 시도하세요.",
  not_allowed: "허용되지 않은 계정입니다.",
  account_mismatch: "로그인한 계정과 같은 구글 계정으로 연동하세요.",
  scope: "캘린더 권한이 체크되지 않았습니다. 동의 화면에서 캘린더 항목을 모두 체크하세요.",
  no_refresh: "구글에서 연동 토큰을 받지 못했습니다. 구글 계정 → 보안 → 타사 앱 액세스에서 이 앱을 삭제한 뒤 다시 연동하세요.",
  config: "서버의 구글 설정(GOOGLE_CLIENT_ID 등)이 없습니다.",
  google: "구글 인증 중 문제가 발생했습니다. 잠시 후 다시 시도하세요.",
};

export default function SettingsView({ me, onSetCalendar, onDisconnect, onLogout, onNotice }: Props) {
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const state = me?.calendar.state ?? "none";

  // OAuth 콜백 결과 표시 후 주소창 정리
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const err = sp.get("calendar_error");
    if (sp.get("calendar") === "connected") setMessage({ ok: true, text: "구글 캘린더가 연동되었습니다." });
    else if (err) setMessage({ ok: false, text: CALENDAR_ERRORS[err] ?? "캘린더 연동에 실패했습니다." });
    if (sp.has("calendar") || err) window.history.replaceState(null, "", "/settings");
  }, []);

  useEffect(() => {
    if (state !== "connected") return;
    api<CalendarInfo[]>("/api/calendar/calendars")
      .then((list) => {
        setCalendars(list);
        setCalendarError(null);
      })
      .catch((e: Error) => setCalendarError(e.message));
  }, [state]);

  const changeCalendar = async (id: string) => {
    setBusy(true);
    try {
      await onSetCalendar(id);
      onNotice("일정을 등록할 캘린더를 변경했습니다");
    } catch (e) {
      setCalendarError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("구글 캘린더 연동을 해제할까요?\n이미 등록한 일정은 캘린더에 그대로 남습니다.")) return;
    setBusy(true);
    try {
      await onDisconnect();
      setCalendars(null);
      onNotice("캘린더 연동을 해제했습니다");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!me) return <div className="loading">불러오는 중…</div>;

  return (
    <div className="settings">
      <h1>설정</h1>
      {message && (
        <div className={message.ok ? "settings-ok" : "modal-error"} role="status">
          {message.ok ? "✓" : "⚠"} {message.text}
        </div>
      )}

      <section className="settings-card">
        <h2>계정</h2>
        <div className="account-row">
          {me.picture ? (
            <img className="account-avatar" src={me.picture} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="account-avatar placeholder-avatar">{(me.name || me.email).slice(0, 1)}</div>
          )}
          <div>
            <b>{me.name || me.email}</b>
            <div className="muted">{me.email} · Google 계정</div>
          </div>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onLogout}>로그아웃</button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Google 캘린더</h2>
        <div className="settings-row">
          <span className={`status-pill ${state}`}>
            {state === "connected" ? "연동됨" : state === "expired" ? "연동 만료" : "연동 안 됨"}
          </span>
          <span className="muted">
            {state === "connected"
              ? "미팅 노트를 저장하면 다음 미팅이 캘린더에 자동 등록됩니다(제목 앞 [AI CRM]). AI Assistant도 캘린더를 조회합니다."
              : state === "expired"
                ? "연동 토큰이 만료되었습니다. 다시 연동하세요."
                : "Google 연동을 누르고 동의 화면에서 캘린더 권한을 허용하세요."}
          </span>
        </div>

        {state === "connected" && (
          <div className="field settings-field">
            <label>일정을 등록·조회할 캘린더</label>
            {calendarError ? (
              <div className="modal-error">⚠ {calendarError}</div>
            ) : !calendars ? (
              <span className="muted">캘린더 목록을 불러오는 중…</span>
            ) : (
              <select value={me.calendar.calendarId} disabled={busy} onChange={(e) => changeCalendar(e.target.value)}>
                {/* 'primary'는 기본 캘린더의 별칭 */}
                {!calendars.some((c) => c.id === me.calendar.calendarId) && <option value={me.calendar.calendarId}>기본 캘린더</option>}
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.primary ? " (기본)" : ""}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="settings-actions">
          <a className={`btn${state === "connected" ? "" : " btn-primary"}`} href="/api/calendar/connect">
            <GoogleIcon /> {state === "none" ? "Google 연동" : "다시 연동"}
          </a>
          {state !== "none" && (
            <button type="button" className="btn btn-danger" onClick={disconnect} disabled={busy}>연동 해제</button>
          )}
        </div>
        <p className="muted settings-note">
          구글 앱이 테스트 상태라 연동은 7일 동안 유지됩니다. 만료되면 이 화면에서 다시 연동하세요.
          캘린더 정보는 AI Assistant 답변을 위해 제목·시간·장소만 OpenAI로 전송됩니다 (참석자·설명 제외).
        </p>
      </section>
    </div>
  );
}

export function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
