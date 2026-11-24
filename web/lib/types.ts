export type StageId =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";

export type Priority = "high" | "mid" | "low";

export interface Lead {
  id: string;
  company: string;
  contact: string;
  title: string;
  email: string;
  phone: string;
  value: number;
  closeDate: string; // YYYY-MM-DD
  stage: StageId;
  priority: Priority;
  notes: string;
  createdAt: number;
}

export type LeadInput = Omit<Lead, "id" | "createdAt">;

/** AI Assistant 대화 메시지 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
