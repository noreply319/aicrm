import { KIND_LABEL } from "@/lib/docTemplate";
import type { DocKind, DocStatus } from "@/lib/types";
import { Badge, type BadgeTone } from "./ui";

const STATUS: Record<DocStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "작성 중", tone: "neutral" },
  completed: { label: "완성", tone: "brand" },
  sent: { label: "발송됨", tone: "success" },
};

/** 문서 종류(계약서·견적서) 또는 상태(작성 중·완성·발송됨) 배지 */
export default function DocBadge(p: { kind: DocKind } | { status: DocStatus; suffix?: string }) {
  if ("kind" in p) return <Badge tone={p.kind === "contract" ? "brand" : "warning"}>{KIND_LABEL[p.kind]}</Badge>;
  const s = STATUS[p.status];
  return (
    <Badge tone={s.tone} shape="pill" className={`doc-status-${p.status}`}>
      {s.label}{p.suffix ?? ""}
    </Badge>
  );
}
