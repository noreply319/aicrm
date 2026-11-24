"use client";

import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { IconButton } from "./Button";

interface ModalProps {
  /** 스크린리더용 이름 */
  label: string;
  /** 바깥 클릭·Esc·닫기 버튼 */
  onClose: () => void;
  size?: "md" | "lg" | "wide";
  /** 주면 `<form>`으로 렌더 (Enter 제출) */
  onSubmit?: () => void;
  className?: string;
  children: ReactNode;
}

/** 열려 있는 모달 순서 (마지막이 맨 위) */
const openStack: symbol[] = [];

/** 오버레이 + 대화 상자. 내용은 ModalHeader / 본문 / ModalFooter 순서로 넣는다 */
export default function Modal({ label, onClose, size = "md", onSubmit, className, children }: ModalProps) {
  // 렌더마다 바뀌는 콜백이어도 리스너는 한 번만 등록
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // 모달 위에 모달을 띄우면(리드 모달 → 연락처 수정) Esc는 맨 위 모달만 닫는다
  useEffect(() => {
    const me = Symbol(label);
    openStack.push(me);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openStack[openStack.length - 1] === me && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openStack.splice(openStack.indexOf(me), 1);
    };
  }, []);

  const cls = cx("modal", size === "wide" && "modal-wide", size === "lg" && "modal-lg", className);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {onSubmit ? (
        <form
          className={cls}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          autoComplete="off"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
        </form>
      ) : (
        <div className={cls} role="dialog" aria-modal="true" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/** 제목 줄: 오른쪽에 actions, onClose를 주면 닫기(×) 버튼 */
export function ModalHeader({ title, actions, onClose }: { title: ReactNode; actions?: ReactNode; onClose?: () => void }) {
  return (
    <div className="modal-head">
      <h2>{title}</h2>
      <span className="spacer" />
      {actions}
      {onClose && <IconButton icon="close" label="닫기" size="sm" onClick={onClose} />}
    </div>
  );
}

/** 하단 버튼 줄: start(왼쪽, 삭제 등) · children(오른쪽, 취소/저장) */
export function ModalFooter({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="modal-foot">
      {start}
      <div className="spacer" />
      {children}
    </div>
  );
}
