"use client";

import { useState } from "react";
import { STAGES } from "@/lib/constants";
import type { Lead, StageId } from "@/lib/types";
import Column from "./Column";
import { Badge, Tabs } from "./ui";

interface Props {
  leads: Lead[];
  noteCounts: Record<string, number>;
  /** 리드별 가장 가까운 다음 미팅 시작 시각 (ISO) */
  nextMeetings: Record<string, string>;
  onMove: (id: string, stage: StageId, beforeId: string | null) => void;
  onOpen: (id: string) => void;
  onAddInStage: (stage: StageId) => void;
}

export type DropTarget = { stage: StageId; index: number } | null;

export default function Board({ leads, noteCounts, nextMeetings, onMove, onOpen, onAddInStage }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget>(null);
  /** 모바일(640px 이하): 탭으로 고른 단계 하나만 세로 목록으로 보여준다 (데스크톱은 모든 단계 칸반) */
  const [mobileStage, setMobileStage] = useState<StageId>("new");

  const endDrag = () => {
    setDraggingId(null);
    setTarget(null);
  };

  const handleDrop = (stage: StageId) => {
    if (!draggingId || !target || target.stage !== stage) return endDrag();
    const others = leads.filter((l) => l.stage === stage && l.id !== draggingId);
    const beforeId = others[target.index]?.id ?? null;
    onMove(draggingId, stage, beforeId);
    endDrag();
  };

  return (
    <>
    <Tabs
      className="stage-tabs"
      scrollable
      label="단계"
      value={mobileStage}
      onChange={setMobileStage}
      items={STAGES.map((s) => ({
        id: s.id,
        label: (
          <>
            {s.name} <Badge shape="pill" tone={s.id === mobileStage ? "brand" : "neutral"}>{leads.filter((l) => l.stage === s.id).length}</Badge>
          </>
        ),
      }))}
    />
    <main className="board">
      {STAGES.map((stage) => (
        <Column
          key={stage.id}
          mobileHidden={stage.id !== mobileStage}
          stage={stage}
          leads={leads.filter((l) => l.stage === stage.id)}
          noteCounts={noteCounts}
          nextMeetings={nextMeetings}
          draggingId={draggingId}
          dropIndex={target?.stage === stage.id ? target.index : null}
          onDragStart={setDraggingId}
          onDragEnd={endDrag}
          onHover={(index) => setTarget({ stage: stage.id, index })}
          onLeave={() => setTarget((t) => (t?.stage === stage.id ? null : t))}
          onDrop={() => handleDrop(stage.id)}
          onOpen={onOpen}
          onAdd={() => onAddInStage(stage.id)}
        />
      ))}
    </main>
    </>
  );
}
