"use client";

import { useEffect, useState } from "react";

export default function Toast({ message }: { message: string | null }) {
  // 사라질 때 페이드 아웃 동안 마지막 메시지를 유지
  const [text, setText] = useState("");
  useEffect(() => {
    if (message) setText(message);
  }, [message]);

  return <div className={`toast${message ? " show" : ""}`}>{text}</div>;
}
