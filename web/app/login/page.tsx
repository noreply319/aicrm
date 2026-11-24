import type { Metadata } from "next";
import { GoogleIcon } from "@/components/SettingsView";

export const metadata: Metadata = { title: "로그인 · Pipeline CRM" };

const ERRORS: Record<string, string> = {
  denied: "구글 로그인을 취소했습니다.",
  state: "로그인 요청이 만료되었습니다. 다시 시도하세요.",
  not_allowed: "접근 권한이 없는 계정입니다. 관리자에게 허용 이메일 등록을 요청하세요.",
  config: "서버의 구글 로그인 설정이 없습니다 (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  google: "구글 인증 중 문제가 발생했습니다. 잠시 후 다시 시도하세요.",
};

/** 로그인 화면: 구글 로그인만 제공 (허용 이메일만 통과) */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const href = `/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand login-brand">
          <div className="logo">◆</div> Pipeline CRM
        </div>
        <p className="muted">팀 계정으로 로그인하세요.</p>
        {error && <div className="modal-error" role="alert">⚠ {ERRORS[error] ?? "로그인에 실패했습니다."}</div>}
        <a className="btn login-btn" href={href}>
          <GoogleIcon /> Google로 로그인
        </a>
        <p className="muted login-note">허용된 이메일만 로그인할 수 있습니다.</p>
      </div>
    </main>
  );
}
