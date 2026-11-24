import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

interface Props<T extends string> {
  items: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  /** 탭이 많을 때: 글자 폭만큼, 넘치면 가로 스크롤 (모바일 단계 탭 등) */
  scrollable?: boolean;
  /** 스크린리더용 탭 목록 이름 */
  label?: string;
  className?: string;
}

/** 밑줄형 탭 (리드 상세, 노트 작성 방식 등) */
export default function Tabs<T extends string>({ items, value, onChange, scrollable, label, className }: Props<T>) {
  return (
    <div className={cx("seg-tabs", scrollable && "scroll", className)} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={value === t.id ? "on" : ""}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
