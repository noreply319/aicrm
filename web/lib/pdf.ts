import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  computeTotals, formatNumber, lineAmount, parseBody, resolveKey, type DocContext, type Seg,
} from "./docTemplate";

/**
 * 계약서·견적서 PDF (A4). 화면 미리보기와 같은 블록(parseBody)을 그린다.
 *  - 한글 폰트: 나눔고딕(OFL, assets/fonts). pdf-lib의 폰트 subset은 한글 글리프가 깨져서 폰트 전체를 넣는다(약 750KB).
 *  - 굵은 글씨는 같은 글자를 살짝 겹쳐 그려 표현한다 (Bold 폰트까지 넣으면 파일이 2배가 되므로).
 *  - PDF는 저장하지 않고 요청마다 값에서 다시 만든다.
 */

const FONT_PATH = path.join(process.cwd(), "assets/fonts/NanumGothic-Regular.ttf");

const globalForFont = globalThis as unknown as { crmPdfFont?: Promise<Buffer> };
const fontBytes = () => (globalForFont.crmPdfFont ??= readFile(FONT_PATH));

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 60;
const MARGIN_TOP = 70;
const MARGIN_BOTTOM = 64;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const INK = rgb(0.1, 0.11, 0.16);
const MUTED = rgb(0.45, 0.47, 0.53);
const LINE = rgb(0.55, 0.57, 0.62);
const HEAD_FILL = rgb(0.93, 0.94, 0.96);
const BLANK = "__________";

interface Style {
  size: number;
  bold?: boolean;
  color?: ReturnType<typeof rgb>;
}

class Writer {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;

  constructor(private doc: PDFDocument, readonly font: PDFFont, private chars: Set<number>, private header: string) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN_TOP;
    if (this.header) this.text(this.header, PAGE_W - MARGIN_X - this.width(this.header, 8), PAGE_H - 40, { size: 8, color: MUTED });
  }

  /** 남은 높이가 부족하면 다음 페이지로 */
  ensure(h: number) {
    if (this.y - h < MARGIN_BOTTOM) this.newPage();
  }

  /** 폰트에 없는 글자는 ?로 (그대로 두면 빈 칸으로 그려진다) */
  clean(t: string): string {
    return Array.from(t.replace(/\t/g, "    "))
      .map((c) => (c === " " || this.chars.has(c.codePointAt(0)!) ? c : "?"))
      .join("");
  }

  width(t: string, size: number) {
    return this.font.widthOfTextAtSize(this.clean(t), size);
  }

  text(t: string, x: number, y: number, s: Style) {
    const opts = { x, y, size: s.size, font: this.font, color: s.color ?? INK };
    const clean = this.clean(t);
    this.page.drawText(clean, opts);
    if (s.bold) this.page.drawText(clean, { ...opts, x: x + s.size * 0.035 });
  }

  /** 줄바꿈: 공백에서 끊고, 공백 없이 긴 단어는 글자 단위로 끊는다 */
  wrap(t: string, size: number, maxW: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of t.split(/(?<= )/)) {
      if (this.width(line + word, size) <= maxW) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      for (const ch of word) {
        if (this.width(line + ch, size) > maxW && line) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    if (line.trim() || lines.length === 0) lines.push(line.trimEnd());
    return lines;
  }

  paragraph(t: string, s: Style & { indent?: number; align?: "left" | "center"; lineH?: number; bullet?: string }) {
    const indent = s.indent ?? 0;
    const lineH = s.lineH ?? s.size * 1.65;
    this.wrap(t, s.size, CONTENT_W - indent).forEach((line, i) => {
      this.ensure(lineH);
      this.y -= lineH;
      const x = s.align === "center" ? (PAGE_W - this.width(line, s.size)) / 2 : MARGIN_X + indent;
      if (s.bullet && i === 0) this.text(s.bullet, MARGIN_X + indent - s.size * 1.1, this.y, s);
      this.text(line, x, this.y, s);
    });
  }

  rect(x: number, y: number, w: number, h: number, fill?: ReturnType<typeof rgb>) {
    this.page.drawRectangle({ x, y, width: w, height: h, borderColor: LINE, borderWidth: 0.6, color: fill });
  }
}

const segText = (segs: Seg[], ctx: DocContext) =>
  segs.map((s) => ("t" in s ? s.t : resolveKey(s.f, ctx).filled ? resolveKey(s.f, ctx).text : BLANK)).join("");

function drawItems(w: Writer, ctx: DocContext) {
  const spec = ctx.lineItemsConfig?.spec ?? true;
  const cols = [
    { label: "No", w: 28, align: "center" as const },
    { label: "품목", w: 0, align: "left" as const },
    ...(spec ? [{ label: "규격", w: 70, align: "left" as const }] : []),
    { label: "수량", w: 48, align: "right" as const },
    { label: "단가", w: 78, align: "right" as const },
    { label: "금액", w: 88, align: "right" as const },
  ];
  cols[1].w = CONTENT_W - cols.reduce((a, c) => a + c.w, 0);
  const size = 9.5;
  const rowH = 20;

  const row = (cells: string[], opts: { fill?: ReturnType<typeof rgb>; bold?: boolean; span?: boolean } = {}) => {
    w.ensure(rowH);
    w.y -= rowH;
    let x = MARGIN_X;
    if (opts.span) {
      // 합계 행: 앞 칸을 합쳐 라벨, 마지막 칸에 금액
      const labelW = CONTENT_W - cols.at(-1)!.w;
      w.rect(x, w.y, labelW, rowH, opts.fill);
      w.text(cells[0], x + labelW - 6 - w.width(cells[0], size), w.y + 6.5, { size, bold: opts.bold });
      w.rect(x + labelW, w.y, cols.at(-1)!.w, rowH, opts.fill);
      w.text(cells[1], x + CONTENT_W - 6 - w.width(cells[1], size), w.y + 6.5, { size, bold: opts.bold });
      return;
    }
    cols.forEach((c, i) => {
      w.rect(x, w.y, c.w, rowH, opts.fill);
      let t = cells[i] ?? "";
      while (t && w.width(t, size) > c.w - 10) t = t.slice(0, -1);
      if (t !== (cells[i] ?? "")) t = t.slice(0, -1) + "…";
      const tx = c.align === "right" ? x + c.w - 6 - w.width(t, size) : c.align === "center" ? x + (c.w - w.width(t, size)) / 2 : x + 6;
      w.text(t, tx, w.y + 6.5, { size, bold: opts.bold });
      x += c.w;
    });
  };

  w.y -= 4;
  row(cols.map((c) => c.label), { fill: HEAD_FILL, bold: true });
  if (ctx.lineItems.length === 0) row(cols.map((_, i) => (i === 1 ? "(품목 없음)" : "")));
  ctx.lineItems.forEach((it, i) =>
    row([String(i + 1), it.name, ...(spec ? [it.spec] : []), formatNumber(it.qty), formatNumber(it.unitPrice), formatNumber(lineAmount(it))])
  );
  const t = computeTotals(ctx.lineItems, ctx.lineItemsConfig);
  const vat = ctx.lineItemsConfig?.vat ?? "excluded";
  row(["공급가액", formatNumber(t.supply)], { span: true });
  if (vat !== "none") row([vat === "included" ? "부가세 (포함)" : "부가세 (10%)", formatNumber(t.vat)], { span: true });
  row(["합계", formatNumber(t.total)], { span: true, bold: true, fill: HEAD_FILL });
  w.y -= 6;
}

/** 문서 → PDF 바이트 */
export async function renderPdf(body: string, ctx: DocContext): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(ctx.docName);
  doc.setCreator("Pipeline CRM");
  doc.setProducer("Pipeline CRM");
  const font = await doc.embedFont(await fontBytes(), { subset: false });
  const w = new Writer(doc, font, new Set(font.getCharacterSet()), ctx.docNumber);

  for (const b of parseBody(body)) {
    switch (b.type) {
      case "h1":
        w.y -= 6;
        w.paragraph(segText(b.segs, ctx), { size: 19, bold: true, align: "center", lineH: 30 });
        w.y -= 12;
        break;
      case "h2":
        w.ensure(40); // 조항 제목만 페이지 끝에 남지 않게
        w.y -= 6;
        w.paragraph(segText(b.segs, ctx), { size: 11.5, bold: true, lineH: 20 });
        break;
      case "li":
        w.paragraph(segText(b.segs, ctx), { size: 10.5, indent: 14, bullet: "•" });
        break;
      case "p":
        w.paragraph(segText(b.segs, ctx), { size: 10.5 });
        break;
      case "gap":
        w.y -= 8;
        break;
      case "items":
        drawItems(w, ctx);
        break;
    }
  }

  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const label = `${i + 1} / ${total}`;
    p.drawText(label, { x: (PAGE_W - font.widthOfTextAtSize(label, 8)) / 2, y: 32, size: 8, font, color: MUTED });
  });
  return { bytes: await doc.save(), pages: total };
}
