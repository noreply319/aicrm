import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

interface Props {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  small?: boolean;
}

/** 데이터가 없을 때 안내 + 다음 행동 버튼 */
export default function EmptyState({ icon, title, description, action, small }: Props) {
  return (
    <div className={cx("empty-state", small && "small")}>
      {icon && <div className="empty-icon" aria-hidden>{icon}</div>}
      <b className="empty-title">{title}</b>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
