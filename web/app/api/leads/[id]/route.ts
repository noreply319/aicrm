import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { withTransaction } from "@/lib/events";
import { deleteLead, updateLead } from "@/lib/leadOps";
import { parseLeadInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const parsed = parseLeadInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const userId = await requestUserId();
  const result = await withTransaction((client) => updateLead(client, userId, id, parsed.data));
  return result.ok ? NextResponse.json(result.lead) : NextResponse.json({ error: result.error }, { status: result.status });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const result = await withTransaction((client) => deleteLead(client, id));
  return result.ok ? new NextResponse(null, { status: 204 }) : notFound();
}
