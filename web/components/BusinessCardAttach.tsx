"use client";

import { useRef, type DragEvent } from "react";
import { IconButton, type IconName } from "./ui";

/**
 * 입력창 옆 명함 첨부 버튼. 사진 여러 장 선택 가능.
 * capture 속성을 쓰지 않는다 → 모바일에서 "사진 찍기 / 사진 보관함" 중에서 고를 수 있다.
 */
export default function BusinessCardAttach({
  onFiles, disabled, icon = "camera", className,
}: { onFiles: (files: File[]) => void; disabled?: boolean; icon?: IconName; className?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        icon={icon}
        label="명함 사진 올리기"
        className={className ? `card-attach ${className}` : "card-attach"}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="명함 이미지 선택"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // 같은 사진을 다시 고를 수 있게
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** 대화 영역에 이미지를 끌어다 놓으면 명함으로 올린다 */
export function cardDropProps(onFiles: (files: File[]) => void) {
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return {
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files);
    },
  };
}
