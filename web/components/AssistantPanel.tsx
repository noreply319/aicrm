"use client";

import { Fragment, useRef, useState } from "react";
import { MOBILE_QUERY } from "@/lib/constants";
import type { AgentTarget, Me } from "@/lib/types";
import type { AgentChat } from "@/lib/useAgentChat";
import { useAutoGrow } from "@/lib/useAutoGrow";
import { useBusinessCards } from "@/lib/useBusinessCards";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { useReviseInput } from "@/lib/useReviseInput";
import AgentTurn from "./AgentTurn";
import BusinessCardAttach, { cardDropProps } from "./BusinessCardAttach";
import BusinessCardConfirm, { type CardHost } from "./BusinessCardConfirm";
import ConversationList from "./ConversationList";
import QuoteChat from "./QuoteChat";
import { Badge, Button, Icon, IconButton, Tabs, Textarea } from "./ui";

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** 첫 화면(/): 메인 영역 전체를 쓰는 대화 화면 (숨기기 없음) */
  home: boolean;
  me: Me | null;
  /** 일반 대화 상태 (CrmApp이 가짐 — /api/assistant, 리드·회사·연락처 변경은 실행 계획 카드로 승인) */
  chat: AgentChat;
  /** 계획 카드의 리드 열기 등 */
  onOpenTarget: (target: AgentTarget) => void;
  /** 견적서 탭: 발송 후 단계 이동 등으로 리드가 바뀌었을 때 */
  onLeadsChanged: () => void;
  onNotice: (msg: string) => void;
  /** 명함 → 회사·연락처 등록 */
  cardHost: CardHost;
}

type Mode = "chat" | "quote";

export default function AssistantPanel({ open: openProp, onOpen, onClose, home, me, chat, onOpenTarget, onLeadsChanged, onNotice, cardHost }: Props) {
  const open = home || openProp;
  const [mode, setMode] = useState<Mode>("chat");
  /** 견적서 탭은 처음 고를 때 만들고(템플릿 조회), 그 뒤에는 탭을 바꿔도 대화를 유지한다 */
  const [quoteSeen, setQuoteSeen] = useState(false);
  const { messages, busy, send, stop, approve, approveAll, cancel, reset, conversationId, conversations, loaded, open: openConversation, remove } = chat;
  /** 저장된 대화 목록 보기 (대화 영역 자리에) */
  const [showList, setShowList] = useState(false);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // 입력칸: 기본 한 줄, 내용에 맞춰 최대 5줄까지 늘어남
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mobile = useMediaQuery(MOBILE_QUERY);
  // 좁은 입력칸(오른쪽 패널·모바일)에서는 안내 문구가 한 줄에 다 보이게 짧게
  const placeholder = home && !mobile ? "질문하거나 할 일을 요청하세요…" : "질문하거나 요청하세요…";
  // 빈 입력칸 높이는 안내 문구 줄 수를 따르므로 문구가 바뀌어도(첫 렌더 뒤 모바일 판정) 다시 맞춘다
  useAutoGrow(inputRef, input || placeholder);

  /** 명함 카드: 화면 전용 (OpenAI로 보내는 대화에는 넣지 않는다) */
  const cards = useBusinessCards();
  const addCards = (files: File[]) => {
    const warn = cards.addFiles(files, messages.length);
    if (warn) onNotice(warn);
  };
  const cardsAt = (index: number) =>
    cards.cards.filter((c) => Math.min(c.afterIndex, messages.length) === index).map((c) => <BusinessCardConfirm key={c.id} card={c} cards={cards} host={cardHost} />);

  // 새 메시지·명함 카드가 오면 맨 아래로 — 위로 올려 읽는 중이면 그대로 둔다
  const stickToBottom = useStickToBottom(listRef, messages, cards.cards.length);

  const submit = async (text: string) => {
    if (busy || !text.trim()) return;
    setInput("");
    stickToBottom(); // 보낸 질문과 답변은 맨 아래에서 보여준다
    await send(text);
  };

  const revise = useReviseInput(inputRef, setInput, cancel);

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
          items={[{ id: "chat", label: "일반 대화" }, { id: "quote", label: "문서" }]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "quote") setQuoteSeen(true);
          }}
        />
        <span className="spacer" />
        {mode === "chat" && (messages.length > 0 || cards.cards.length > 0) && !showList && (
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => { reset(); cards.clear(); }}>
            새 대화
          </Button>
        )}
        {mode === "chat" && (
          <IconButton icon="history" label="대화 목록" size="sm" aria-pressed={showList} className={showList ? "btn-active" : undefined} onClick={() => { if (!showList) chat.refreshList(); setShowList(!showList); }} />
        )}
        {!home && <IconButton className="assistant-hide" icon="panelRight" label="Assistant 숨기기" size="sm" onClick={onClose} />}
      </div>

      {quoteSeen && (
        <div className="assistant-quote" hidden={mode !== "quote"}>
          <QuoteChat me={me} onLeadsChanged={onLeadsChanged} onNotice={onNotice} />
        </div>
      )}

      <div className="assistant-chat" hidden={mode !== "chat"}>
      {showList && (
        <ConversationList
          conversations={conversations}
          currentId={conversationId}
          onOpen={(id) => { cards.clear(); setShowList(false); if (id !== conversationId) openConversation(id); }}
          onDelete={remove}
          onNew={() => { reset(); cards.clear(); setShowList(false); }}
          onClose={() => setShowList(false)}
        />
      )}
      <div className="assistant-messages" ref={listRef} hidden={showList} {...cardDropProps(addCards)}>
        {loaded && messages.length === 0 && cards.cards.length === 0 && (
          <div className="assistant-empty">
            <p>리드에 대해 물어보거나 리드·회사·연락처 추가·수정, 미팅 노트 작성, 일정 등록, 메일·견적서·계약서 발송을 요청하세요. 변경은 계획을 확인하고 승인하면 반영됩니다. 명함 사진을 올리면 회사·연락처로 등록해 드려요.</p>
          </div>
        )}
        {cardsAt(0)}
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.role === "user" ? (
              <div className="bubble bubble-user">{m.content}</div>
            ) : (
              <AgentTurn
                message={m}
                onApprove={(p) => approve(m.id, p)}
                onCancel={(p) => cancel(m.id, p)}
                onApproveAll={() => approveAll(m.id)}
                onRevise={(p) => revise(m.id, p)}
                onSendDraft={(p) => submit(`「${p.title}」 초안 그대로 메일을 보내줘`)}
                onOpenTarget={onOpenTarget}
              />
            )}
            {cardsAt(i + 1)}
          </Fragment>
        ))}
      </div>

      {/* 입력창: 둥근 알약 모양 안에 첨부(+) · 입력 · 보내기/멈추기 */}
      <form
        hidden={showList}
        className="assistant-input composer-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <div className="composer">
          <BusinessCardAttach onFiles={addCards} icon="plus" className="composer-btn" />
          <Textarea
            ref={inputRef}
            value={input}
            aria-label="AI Assistant에게 질문·요청"
            placeholder={placeholder}
            rows={1}
            maxLength={2000}
            onChange={(e) => setInput(e.target.value)}
            // 모바일: 입력칸을 누르면 키보드 위로 마지막 대화가 보이게 맨 아래로
            onFocus={() => mobile && stickToBottom()}
            onKeyDown={(e) => {
              // 한글 조합 중 Enter는 무시 (마지막 글자 중복 전송 방지)
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(input);
              }
            }}
          />
          {busy ? (
            <IconButton icon="stop" label="답변 멈추기" className="composer-btn composer-stop" onClick={stop} />
          ) : (
            <IconButton icon="arrowUp" label="전송" variant="primary" type="submit" className="composer-btn composer-send" disabled={!input.trim()} />
          )}
        </div>
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
