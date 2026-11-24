import { NextResponse } from "next/server";
import { documentPdf, fileNameOf, getDocument } from "@/lib/documents";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 문서 PDF. ?inline=1이면 브라우저에서 미리보기, 아니면 다운로드 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = UUID_RE.test(id) ? await getDocument(id) : null;
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다" }, { status: 404 });
  const { bytes } = await documentPdf(doc);
  const name = fileNameOf(doc);
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
