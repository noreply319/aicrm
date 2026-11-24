"use client";

import Link from "next/link";
import type { Me, ScheduledMeeting } from "@/lib/types";
import { CandidateRow } from "./CalendarView";
import { Alert, Button, Modal, ModalFooter, ModalHeader } from "./ui";

interface Props {
  candidates: ScheduledMeeting[];
  /** 자동 등록하지 못한 이유 (없으면 시간 미정) */
  reason?: string;
  company: (leadId: string | null) => string;
  calendarState: Me["calendar"]["state"];
  onConfirm: (s: ScheduledMeeting) => void;
  onDismiss: (s: ScheduledMeeting) => void;
  /** 나중에: 후보로 남겨 두고 이 창에서만 뺀다 (캘린더·리드 상세에서 다시 등록 가능) */
  onLater: (s: ScheduledMeeting) => void;
  onClose: () => void;
}

/** 미팅 노트 저장 후 "다음 미팅 일정을 찾았어요" 확인 창 */
export default function ScheduleSuggestModal({ candidates, reason, company, calendarState, onConfirm, onDismiss, onLater, onClose }: Props) {
  return (
    <Modal label="다음 미팅 일정" size="lg" onClose={onClose}>
      <ModalHeader title="🗓 확인이 필요한 다음 미팅이 있어요" onClose={onClose} />
      <div className="suggest-body">
        <p className="muted">
          {reason
            ? `${reason}. 그래서 자동 등록하지 못한 일정입니다.`
            : "날짜나 시간이 정해지지 않아 자동 등록하지 못한 일정입니다. 시간을 정해 등록하세요."}
        </p>
        {calendarState !== "connected" && (
          <Alert tone="warning">
            캘린더가 {calendarState === "expired" ? "연동 만료 상태" : "연동되지 않은 상태"}입니다.{" "}
            <Link href="/settings" onClick={onClose}>설정 → Google 연동</Link> 후 캘린더 화면에서 등록할 수 있습니다.
            (&lsquo;나중에&rsquo;를 누르면 후보로 남겨 둡니다)
          </Alert>
        )}
        {candidates.map((c) => (
          <CandidateRow key={c.id} candidate={c} company={company(c.leadId)} onConfirm={onConfirm} onDismiss={onDismiss} onLater={onLater} />
        ))}
      </div>
      <ModalFooter>
        <Button onClick={onClose}>모두 나중에</Button>
      </ModalFooter>
    </Modal>
  );
}
