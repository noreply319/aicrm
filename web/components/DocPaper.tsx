"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeTotals, displayValue, formatNumber, lineAmount, parseBody, resolveKey, type DocContext, type Seg,
} from "@/lib/docTemplate";
import type { TemplateField } from "@/lib/types";

interface Props {
  body: string;
  ctx: DocContext;
  /** 지금 Assistant가 묻는 항목 (굵은 테두리) */
  currentKey?: string | null;
  /** 방금 바뀐 항목 (깜빡임) */
  flash?: string[];
  /** 항목 클릭 → 직접 수정. 없으면 읽기 전용 */
  onEdit?: (key: string, value: string) => Promise<void>;
  /** 완성 후: 칩 강조 없이 PDF와 같은 모양 */
  plain?: boolean;
}

/**
 * 문서 미리보기 (PDF와 같은 블록 구조). 바뀌는 부분은 칩으로 표시:
 * 회색 점선 = 미입력, 강조색 = 입력됨, 굵은 테두리 = 지금 묻는 항목, 점선(흰 배경) = 자동 계산
 */
export default function DocPaper({ body, ctx, currentKey, flash = [], onEdit, plain }: Props) {
  const blocks = useMemo(() => parseBody(body), [body]);
  const paperRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ key: string; top: number; left: number } | null>(null);

  // 바뀐 항목(없으면 지금 묻는 항목)이 보이게 스크롤
  useEffect(() => {
    const key = flash[0] ?? currentKey;
    if (!key) return;
    const el = paperRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash, currentKey]);

  const openEditor = (key: string, el: HTMLElement) => {
    if (!onEdit || !paperRef.current) return;
    const p = paperRef.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setEditing({ key, top: r.bottom - p.top + 6, left: Math.max(0, Math.min(r.left - p.left, p.width - 260)) });
  };

  const chip = (seg: Seg, i: number) => {
    if ("t" in seg) return <span key={i}>{seg.t}</span>;
    const r = resolveKey(seg.f, ctx);
    if (plain) return <span key={i}>{r.filled ? r.text : "＿＿＿＿"}</span>;
    const editable = Boolean(onEdit) && r.kind === "field";
    const cls = [
      "fchip",
      r.kind === "calc" || r.kind === "system" ? "calc" : r.filled ? "ok" : "",
      seg.f === currentKey ? "now" : "",
      flash.includes(seg.f) ? "flash" : "",
      editable ? "editable" : "",
    ].filter(Boolean).join(" ");
    return (
      <span
        key={i}
        className={cls}
        data-key={seg.f}
        role={editable ? "button" : undefined}
        tabIndex={editable ? 0 : undefined}
        title={editable ? `${seg.f} 수정` : r.kind === "calc" ? "자동 계산" : r.kind === "system" ? "자동 입력" : undefined}
        onClick={(e) => editable && openEditor(seg.f, e.currentTarget)}
        onKeyDown={(e) => editable && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openEditor(seg.f, e.currentTarget))}
      >
        {r.filled ? r.text : `[${seg.f}]`}
      </span>
    );
  };

  const field = editing ? ctx.fields.find((f) => f.key === editing.key) : undefined;

  return (
    <div className="paper" ref={paperRef}>
      <div className="paper-number">{ctx.docNumber}</div>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h1": return <h2 key={i} className="paper-h1">{b.segs.map(chip)}</h2>;
          case "h2": return <h3 key={i} className="paper-h2">{b.segs.map(chip)}</h3>;
          case "li": return <div key={i} className="paper-li">• {b.segs.map(chip)}</div>;
          case "p": return <p key={i} className="paper-p">{b.segs.map(chip)}</p>;
          case "gap": return <div key={i} className="paper-gap" />;
          case "items": return <ItemsTable key={i} ctx={ctx} flash={!plain && flash.includes("품목표")} />;
        }
      })}
      {editing && field && onEdit && (
        <ValueEditor
          field={field}
          value={ctx.values[field.key] ?? ""}
          style={{ top: editing.top, left: editing.left }}
          onSave={async (v) => {
            await onEdit(field.key, v);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ItemsTable({ ctx, flash }: { ctx: DocContext; flash: boolean }) {
  const spec = ctx.lineItemsConfig?.spec ?? true;
  const vat = ctx.lineItemsConfig?.vat ?? "excluded";
  const t = computeTotals(ctx.lineItems, ctx.lineItemsConfig);
  const span = spec ? 5 : 4;
  return (
    <table className={`paper-items${flash ? " flash" : ""}`} data-key="품목표">
      <thead>
        <tr><th>No</th><th>품목</th>{spec && <th>규격</th>}<th>수량</th><th>단가</th><th>금액</th></tr>
      </thead>
      <tbody>
        {ctx.lineItems.length === 0 && (
          <tr><td colSpan={span + 1} className="paper-items-empty">품목을 Assistant에게 알려주세요</td></tr>
        )}
        {ctx.lineItems.map((it, i) => (
          <tr key={i} className={flash && i === ctx.lineItems.length - 1 ? "new" : ""}>
            <td className="c">{i + 1}</td><td>{it.name}</td>{spec && <td>{it.spec}</td>}
            <td className="n">{formatNumber(it.qty)}</td><td className="n">{formatNumber(it.unitPrice)}</td>
            <td className="n">{formatNumber(lineAmount(it))}</td>
          </tr>
        ))}
        <tr><td colSpan={span} className="n">공급가액</td><td className="n">{formatNumber(t.supply)}</td></tr>
        {vat !== "none" && (
          <tr><td colSpan={span} className="n">{vat === "included" ? "부가세 (포함)" : "부가세 (10%)"}</td><td className="n">{formatNumber(t.vat)}</td></tr>
        )}
        <tr className="total"><td colSpan={span} className="n">합계</td><td className="n">{formatNumber(t.total)}</td></tr>
      </tbody>
    </table>
  );
}

/** 항목 직접 수정 팝오버 */
function ValueEditor({ field, value, style, onSave, onClose }: {
  field: TemplateField; value: string; style: React.CSSProperties;
  onSave: (v: string) => Promise<void>; onClose: () => void;
}) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(v);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && field.type !== "multiline") {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="value-pop" ref={ref} style={style} role="dialog" aria-label={`${field.key} 수정`} onKeyDown={onKey}>
      <b>{field.key}</b>
      {field.type === "choice" ? (
        <select value={v} onChange={(e) => setV(e.target.value)}>
          <option value="">(빈칸)</option>
          {field.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      ) : field.type === "date" ? (
        <input type="date" value={v} onChange={(e) => setV(e.target.value)} />
      ) : field.type === "multiline" ? (
        <textarea rows={4} value={v} onChange={(e) => setV(e.target.value)} />
      ) : (
        <input
          value={field.type === "money" || field.type === "number" ? displayValue(field, v) : v}
          inputMode={field.type === "money" || field.type === "number" ? "numeric" : undefined}
          onChange={(e) => setV(field.type === "money" || field.type === "number" ? e.target.value.replace(/[^\d]/g, "") : e.target.value)}
        />
      )}
      {error && <div className="value-pop-error">⚠ {error}</div>}
      <div className="value-pop-foot">
        <span className="muted">Enter 저장 · Esc 취소</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>취소</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>저장</button>
      </div>
    </div>
  );
}
