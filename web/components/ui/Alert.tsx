import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type AlertTone = "danger" | "warning" | "success" | "info" | "neutral";

const ICON: Record<AlertTone, string> = { danger: "⚠", warning: "⚠", success: "✓", info: "ℹ", neutral: "" };

interface Props {
  tone?: AlertTone;
  /** 오른쪽 버튼 영역 */
  action?: ReactNode;
  /** 앞 아이콘 숨김 */
  plain?: boolean;
  /** 화면 상단 전체 폭 배너 */
  banner?: boolean;
  role?: "alert" | "status";
  className?: string;
  children: ReactNode;
}

/** 안내·경고·오류 메시지 박스 */
export default function Alert({ tone = "info", action, plain, banner, role, className, children }: Props) {
  const icon = plain ? "" : ICON[tone];
  return (
    <div
      className={cx("alert", `alert-${tone}`, banner && "alert-banner", className)}
      role={role ?? (tone === "danger" ? "alert" : "status")}
    >
      <span className="alert-text">
        {icon && <span className="alert-icon" aria-hidden>{icon}</span>}
        {/* 글자·링크가 섞여도 한 덩어리로 줄바꿈되도록 감싼다 (flex 항목으로 쪼개지지 않게) */}
        <span className="alert-body">{children}</span>
      </span>
      {action && <span className="alert-action">{action}</span>}
    </div>
  );
}
