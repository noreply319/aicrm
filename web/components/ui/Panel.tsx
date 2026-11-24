import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

interface Props {
  /** 제목 (h2) */
  title?: ReactNode;
  /** 제목 줄 오른쪽 */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** 흰 배경 + 테두리 카드 영역 (설정 카드, 요약 카드, 날짜 일정 목록 등) */
export default function Panel({ title, actions, className, children }: Props) {
  return (
    <section className={cx("panel", className)}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2 className="panel-title">{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
