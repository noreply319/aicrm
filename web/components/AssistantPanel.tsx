"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { Alert, Badge, Button, IconButton, Textarea } from "./ui";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SUGGESTIONS = [
  "이번 주에 생성된 리드 알려줘",
  "최근 단계가 바뀐 리드는?",
  "오션핀테크 리드 변경 이력 보여줘",
  "현재 파이프라인 금액 합계는?",
];

export default function AssistantPanel({ open, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 새 메시지가 오면 맨 아래로 스크롤
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      const data = (body && typeof body === "object" ? body : {}) as { reply?: unknown; error?: unknown };
      if (!res.ok || typeof data.reply !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : `요청 실패 (${res.status})`);
      }
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (e) {
      // 실패한 질문은 입력창으로 되돌려 다시 보낼 수 있게 한다
      setMessages(messages);
      setInput(question);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="assistant" aria-label="AI Assistant" hidden={!open}>
      <div className="assistant-head">
        <div className="assistant-title">
          <Badge tone="brand">AI</Badge> Assistant
        </div>
        {messages.length > 0 && (
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => { setMessages([]); setError(null); }}>
            새 대화
          </Button>
        )}
        <IconButton icon="close" label="닫기" size="sm" onClick={onClose} />
      </div>

      <div className="assistant-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p>리드가 언제 생성되고 어떻게 바뀌었는지 물어보세요.</p>
            <div className="assistant-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="assistant-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="bubble bubble-assistant bubble-loading">답변 작성 중…</div>}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <Textarea
          value={input}
          placeholder="리드에 대해 질문하세요… (Enter 전송, Shift+Enter 줄바꿈)"
          rows={2}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter는 무시 (마지막 글자 중복 전송 방지)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <Button variant="primary" type="submit" disabled={loading || !input.trim()}>
          전송
        </Button>
      </form>
    </aside>
  );
}
