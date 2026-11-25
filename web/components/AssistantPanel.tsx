"use client";

import { useEffect, useRef, useState } from "react";
import { MOBILE_QUERY } from "@/lib/constants";
import type { ChatMessage, Me } from "@/lib/types";
import { useMediaQuery } from "@/lib/useMediaQuery";
import QuoteChat from "./QuoteChat";
import { Alert, Badge, Button, Icon, IconButton, Tabs, Textarea } from "./ui";

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** 첫 화면(/): 메인 영역 전체를 쓰는 대화 화면 (숨기기 없음) */
  home: boolean;
  me: Me | null;
  /** 견적서 탭: 발송 후 단계 이동 등으로 리드가 바뀌었을 때 */
  onLeadsChanged: () => void;
  onNotice: (msg: string) => void;
}

type Mode = "chat" | "quote";

const SUGGESTIONS = [
  "이번 주에 생성된 리드 알려줘",
  "최근 단계가 바뀐 리드는?",
  "오션핀테크 리드 변경 이력 보여줘",
  "현재 파이프라인 금액 합계는?",
];

export default function AssistantPanel({ open: openProp, onOpen, onClose, home, me, onLeadsChanged, onNotice }: Props) {
  const open = home || openProp;
  const [mode, setMode] = useState<Mode>("chat");
  /** 견적서 탭은 처음 고를 때 만들고(템플릿 조회), 그 뒤에는 탭을 바꿔도 대화를 유지한다 */
  const [quoteSeen, setQuoteSeen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 모바일 키보드에는 Shift+Enter가 없어 단축키 안내를 빼고, 좁은 입력칸에 안내 문구가 다 보이게 한다
  const mobile = useMediaQuery(MOBILE_QUERY);

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

  // 닫아도 대화가 유지되도록 언마운트하지 않고 오른쪽으로 밀어 숨긴다 (inert: 숨긴 동안 포커스 불가)
  return (
    <>
    <aside className={`assistant${open ? "" : " closed"}${home ? " assistant-home" : ""}`} aria-label="AI Assistant" aria-hidden={!open} inert={!open}>
      <div className="assistant-head">
        {/* 모바일 전체 화면 채팅(첫 화면 외): 왼쪽 뒤로 가기로 원래 화면 복귀 */}
        {!home && <IconButton className="assistant-back" icon="chevronLeft" label="채팅 닫기" size="sm" onClick={onClose} />}
        <Badge tone="brand">AI</Badge>
        <Tabs
          className="assistant-tabs"
          label="대화 종류"
          items={[{ id: "chat", label: "일반 대화" }, { id: "quote", label: "견적서" }]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "quote") setQuoteSeen(true);
          }}
        />
        <span className="spacer" />
        {mode === "chat" && messages.length > 0 && (
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => { setMessages([]); setError(null); }}>
            새 대화
          </Button>
        )}
        {!home && <IconButton className="assistant-hide" icon="panelRight" label="Assistant 숨기기" size="sm" onClick={onClose} />}
      </div>

      {quoteSeen && (
        <div className="assistant-quote" hidden={mode !== "quote"}>
          <QuoteChat me={me} onLeadsChanged={onLeadsChanged} onNotice={onNotice} />
        </div>
      )}

      <div className="assistant-chat" hidden={mode !== "chat"}>
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
          placeholder={mobile ? "리드에 대해 질문하세요…" : "리드에 대해 질문하세요… (Enter 전송, Shift+Enter 줄바꿈)"}
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
      </div>
    </aside>
    {/* 숨긴 동안 오른쪽 가장자리 탭으로 다시 열기 (데스크톱) */}
    <button
      type="button"
      className={`assistant-handle${open ? "" : " show"}`}
      hidden={home}
      title="AI Assistant 보이기"
      aria-label="AI Assistant 보이기"
      tabIndex={open ? -1 : 0}
      onClick={onOpen}
    >
      <Icon name="chevronLeft" size={14} />
      <Badge tone="brand">AI</Badge>
    </button>
    </>
  );
}
