const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const CW = PAGE_W - M * 2;

class BoxDoc {
  constructor() {}

  async init() {
    this.pdf = await PDFDocument.create();
    this.font = await this.pdf.embedFont(StandardFonts.Helvetica);
    this.bold = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - M;
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - M;
  }

  text(str, x, y, { size = 9, bold = false, color = rgb(0, 0, 0), maxWidth = null } = {}) {
    const f = bold ? this.bold : this.font;
    let s = str == null ? '' : String(str);
    if (maxWidth) {
      while (s.length > 3 && f.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -1);
    }
    this.page.drawText(s, { x, y, size, font: f, color });
  }

  wrapText(str, x, y, width, { size = 8, bold = false, lineGap = 10 } = {}) {
    const f = bold ? this.bold : this.font;
    const words = String(str || '').split(' ');
    let line = '';
    let cy = y;
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > width && line) {
        this.page.drawText(line, { x, y: cy, size, font: f });
        cy -= lineGap;
        line = w;
      } else {
        line = test;
      }
    });
    if (line) { this.page.drawText(line, { x, y: cy, size, font: f }); cy -= lineGap; }
    return cy;
  }

  rect(x, y, w, h, { border = rgb(0, 0, 0), thickness = 0.8, fill = null } = {}) {
    this.page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: border, borderWidth: thickness, color: fill || undefined });
  }

  line(x1, y1, x2, y2, thickness = 0.8) {
    this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: rgb(0, 0, 0) });
  }

  // Caixa com rótulo pequeno em cima e valor em baixo
  field(x, y, w, h, label, value, opts = {}) {
    this.rect(x, y, w, h);
    this.text(label, x + 4, y - 10, { size: 7, bold: true, color: rgb(0.35, 0.35, 0.35) });
    this.text(value, x + 4, y - h + 8, { size: opts.size || 9, bold: opts.bold || false, maxWidth: w - 8 });
  }

  async embedImageAuto(bytes) {
    // tenta PNG, cai pra JPG
    try { return await this.pdf.embedPng(bytes); }
    catch (e) { return await this.pdf.embedJpg(bytes); }
  }

  save() { return this.pdf.save(); }
}

module.exports = { BoxDoc, PAGE_W, PAGE_H, M, CW };
