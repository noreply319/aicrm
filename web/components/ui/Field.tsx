import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

interface FieldProps {
  label: ReactNode;
  /** 라벨 옆 보조 설명 */
  hint?: ReactNode;
  /** 2열 폼에서 한 줄 전체 차지 */
  full?: boolean;
  className?: string;
  children: ReactNode;
}

/** 라벨 + 입력 요소 묶음. 입력 요소는 Input/Select/Textarea를 넣는다 */
export default function Field({ label, hint, full, className, children }: FieldProps) {
  return (
    <div className={cx("field", full && "full", className)}>
      <label className="field-label">
        {label}
        {hint && <span className="field-hint"> {hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function Input({ className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cx("control", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("control", className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cx("control", className)} {...rest} />;
}

/** 체크박스 + 라벨 */
export function Checkbox({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
