import type { CSSProperties } from "react";
import { AVATAR_COLORS } from "@/lib/constants";
import { cx } from "@/lib/cx";

interface Props {
  /** 이니셜과 색을 정하는 이름 */
  name: string;
  /** 색을 고정할 기준 문자열 (기본: name) */
  seed?: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** 이름 이니셜 또는 프로필 사진 원형 아바타 */
export default function Avatar({ name, seed, src, size = "md", className }: Props) {
  const key = seed ?? name;
  const color = AVATAR_COLORS[[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const cls = cx("avatar", `avatar-${size}`, className);
  if (src) return <img className={cls} src={src} alt="" referrerPolicy="no-referrer" />;
  return (
    <span className={cls} style={{ "--avatar": color } as CSSProperties} aria-hidden>
      {(name.trim() || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
