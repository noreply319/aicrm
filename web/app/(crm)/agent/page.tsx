import { redirect } from "next/navigation";

// Sales Agent는 AI Assistant(첫 화면)로 통합 — 예전 주소·북마크는 첫 화면으로 보낸다
export default function AgentPage() {
  redirect("/");
}
