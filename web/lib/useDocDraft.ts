"use client";

import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DocAction, DocChatResult, DocTemplate, DocumentRecord } from "@/lib/types";

interface Options {
  /** 대화·직접 수정 결과가 올 때마다 (반영된 항목 강조 등) */
  onResult?: (r: DocChatResult) => void;
  /** 리드 단계가 바뀌었을 때 (발송 후 단계 이동) */
  onLeadsChanged?: () => void;
}

/**
 * 문서 작성 대화 상태: 템플릿 목록 · 작성 중인 문서 · 대화 전송 · 직접 수정.
 * 계약서 화면(ContractsView)과 AI Assistant의 견적서 탭(QuoteChat)이 함께 쓴다.
 */
export function useDocDraft({ onResult, onLeadsChanged }: Options = {}) {
  const [templates, setTemplates] = useState<DocTemplate[] | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 렌더마다 바뀌는 콜백이어도 최신 것을 부른다
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onLeadsRef = useRef(onLeadsChanged);
  onLeadsRef.current = onLeadsChanged;

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api<DocTemplate[]>("/api/templates"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const applyResult = useCallback((r: DocChatResult) => {
    setDoc(r.document);
    onResultRef.current?.(r);
    if (r.leadChanged) onLeadsRef.current?.();
  }, []);

  /** 저장된 문서 열기. 성공하면 true */
  const openDoc = useCallback(async (id: string) => {
    setError(null);
    try {
      setDoc(await api<DocumentRecord>(`/api/documents/${id}`));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  /** 템플릿으로 새 문서 만들기. 성공하면 true */
  const pickTemplate = useCallback(async (t: DocTemplate) => {
    setBusy(true);
    setError(null);
    try {
      setDoc(await api<DocumentRecord>("/api/documents", { method: "POST", body: JSON.stringify({ templateId: t.id }) }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const chat = async (payload: { message?: string; action?: DocAction; value?: string }) => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    // 보낸 말은 바로 보이게 (응답이 오면 서버 기록으로 바뀐다)
    const optimistic = payload.message ?? null;
    if (optimistic) setDoc({ ...doc, messages: [...doc.messages, { role: "user", text: optimistic, at: new Date().toISOString() }] });
    try {
      applyResult(await api<DocChatResult>(`/api/documents/${doc.id}/chat`, { method: "POST", body: JSON.stringify(payload) }));
    } catch (e) {
      setError((e as Error).message);
      setDoc(doc);
    } finally {
      setBusy(false);
    }
  };

  /** 문서에서 값 직접 수정 (실패하면 DocPaper가 에러를 표시하도록 던진다) */
  const editValue = async (key: string, value: string) => {
    if (!doc) return;
    const r = await api<DocChatResult>(`/api/documents/${doc.id}`, { method: "PATCH", body: JSON.stringify({ values: { [key]: value } }) });
    applyResult(r);
  };

  const download = () => {
    if (!doc) return;
    window.location.href = `/api/documents/${doc.id}/pdf`;
  };

  /** 기본 템플릿 추가 → 추가한 개수 (실패하면 null) */
  const loadDefaults = async () => {
    try {
      const added = await api<DocTemplate[]>("/api/templates/defaults", { method: "POST" });
      await loadTemplates();
      return added.length;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const reset = () => {
    setDoc(null);
    setError(null);
  };

  return {
    templates, loadTemplates, doc, busy, error, setError,
    openDoc, pickTemplate, chat, editValue, download, loadDefaults, applyResult, reset,
  };
}
