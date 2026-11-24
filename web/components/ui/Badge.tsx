import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "highlight";

interface Props {
  tone?: BadgeTone;
  /** 단계 색처럼 임의 색을 쓸 때 (tone 대신) — 배경은 같은 색 14% */
  color?: string;
  /** pill: 완전히 둥근 모양 (상태), 기본은 살짝 둥근 태그 */
  shape?: "tag" | "pill";
  title?: string;
  className?: string;
  children: ReactNode;
}

/** 상태·우선순위·개수 표시용 작은 라벨. 색은 tone 토큰만 사용한다 */
export default function Badge({ tone = "neutral", color, shape = "tag", title, className, children }: Props) {
  return (
    <span
      className={cx("badge", color ? "badge-color" : `badge-${tone}`, shape === "pill" && "badge-pill", className)}
      style={color ? ({ "--badge": color } as CSSProperties) : undefined}
      title={title}
    >
      {children}
    </span>
  );
}
