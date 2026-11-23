import type { Priority, StageId } from "./types";

export const STAGES: { id: StageId; name: string; color: string }[] = [
  { id: "new", name: "신규 리드", color: "#8a90a2" },
  { id: "contacted", name: "첫 컨택", color: "#3b9eff" },
  { id: "qualified", name: "니즈 확인", color: "#00b8a9" },
  { id: "proposal", name: "제안/견적", color: "#a46bff" },
  { id: "negotiation", name: "협상", color: "#f5a524" },
  { id: "won", name: "수주", color: "#2fb164" },
  { id: "lost", name: "실주", color: "#e5484d" },
];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "높음",
  mid: "보통",
  low: "낮음",
};

export const AVATAR_COLORS = [
  "#5b5bf7",
  "#00b8a9",
  "#f5a524",
  "#e5484d",
  "#a46bff",
  "#3b9eff",
  "#2fb164",
];

export const THEME_KEY = "crm.theme";
