"use client";

import { useState } from "react";
import { STAGES } from "@/lib/constants";
import type { Lead, StageId } from "@/lib/types";
import Column from "./Column";

interface Props {
  leads: Lead[];
  noteCounts: Record<string, number>;
  onMove: (id: string, stage: StageId, beforeId: string | null) => void;
  onOpen: (id: string) => void;
  onAddInStage: (stage: StageId) => void;
}

export type DropTarget = { stage: StageId; index: number } | null;

export default function Board({ leads, noteCounts, onMove, onOpen, onAddInStage }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget>(null);

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
    <main className="board">
      {STAGES.map((stage) => (
        <Column
          key={stage.id}
          stage={stage}
          leads={leads.filter((l) => l.stage === stage.id)}
          noteCounts={noteCounts}
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
  );
}
