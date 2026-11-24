import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

interface Props<T extends string> {
  items: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/** 밑줄형 탭 (리드 상세, 노트 작성 방식 등) */
export default function Tabs<T extends string>({ items, value, onChange, className }: Props<T>) {
  return (
    <div className={cx("seg-tabs", className)} role="tablist">
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
