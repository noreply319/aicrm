import { NextResponse } from "next/server";
import { AssistantError, askAssistant } from "@/lib/assistant";
import { parseChatInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** AI Assistant: { messages: ChatMessage[] } → { reply } */
export async function POST(req: Request) {
  const parsed = parseChatInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const reply = await askAssistant(parsed.data);
    return NextResponse.json({ reply });
  } catch (e) {
    if (e instanceof AssistantError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
