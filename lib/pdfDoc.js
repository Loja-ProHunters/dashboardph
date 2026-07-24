const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN_L = 56;
const MARGIN_R = 56;
const MARGIN_TOP = 90;   // espaço reservado pro cabeçalho/logo
const MARGIN_BOTTOM = 70; // espaço reservado pro rodapé
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

// Quebra um texto em linhas que cabem em maxWidth, respeitando negrito por segmento
function wrapText(font, boldFont, segments, size, maxWidth) {
  // segments: [{text, bold}]
  const words = [];
  segments.forEach(seg => {
    seg.text.split(/(\s+)/).forEach(tok => {
      if (tok.length) words.push({ text: tok, bold: seg.bold });
    });
  });
  const lines = [];
  let current = [];
  let currentWidth = 0;
  words.forEach(w => {
    const f = w.bold ? boldFont : font;
    const wWidth = f.widthOfTextAtSize(w.text, size);
    if (currentWidth + wWidth > maxWidth && current.length) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    if (!(current.length === 0 && /^\s+$/.test(w.text))) {
      current.push(w);
      currentWidth += wWidth;
    }
  });
  if (current.length) lines.push(current);
  return lines;
}

class LetterheadDoc {
  constructor({ logoBytes, footerLines }) {
    this.logoBytes = logoBytes;
    this.footerLines = footerLines; // array of strings, drawn small at bottom-left
    this.pages = [];
    this.cursorY = 0;
  }

  async init() {
    this.pdf = await PDFDocument.create();
    this.font = await this.pdf.embedFont(StandardFonts.Helvetica);
    this.bold = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    this.logoImg = this.logoBytes ? await this.pdf.embedPng(this.logoBytes) : null;
    this._newPage();
  }

  _newPage() {
    const page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(page);
    this.page = page;
    // Cabeçalho: logo + linha
    if (this.logoImg) {
      const scale = 34 / this.logoImg.height;
      const w = this.logoImg.width * scale;
      page.drawImage(this.logoImg, { x: MARGIN_L, y: PAGE_H - 60, width: w, height: 34 });
    }
    page.drawLine({
      start: { x: MARGIN_L, y: PAGE_H - 70 },
      end: { x: PAGE_W - MARGIN_R, y: PAGE_H - 70 },
      thickness: 1,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.cursorY = PAGE_H - MARGIN_TOP;
  }

  _ensureSpace(neededHeight) {
    if (this.cursorY - neededHeight < MARGIN_BOTTOM) {
      this._newPage();
    }
  }

  // segments: string OR [{text, bold}]
  addParagraph(segments, { size = 10.5, gapAfter = 10, align = 'left', center = false } = {}) {
    const segs = typeof segments === 'string' ? [{ text: segments, bold: false }] : segments;
    if (center) {
      const full = segs.map(s => s.text).join('');
      this._ensureSpace(size + 4);
      const w = this.bold.widthOfTextAtSize(full, size);
      this.page.drawText(full, {
        x: MARGIN_L + (CONTENT_W - w) / 2,
        y: this.cursorY,
        size,
        font: this.bold,
        color: rgb(0, 0, 0),
      });
      this.cursorY -= (size + 4) + gapAfter;
      return;
    }
    const lines = wrapText(this.font, this.bold, segs, size, CONTENT_W);
    const lineHeight = size * 1.35;
    lines.forEach(line => {
      this._ensureSpace(lineHeight);
      let x = MARGIN_L;
      line.forEach(w => {
        const f = w.bold ? this.bold : this.font;
        this.page.drawText(w.text, { x, y: this.cursorY, size, font: f, color: rgb(0, 0, 0) });
        x += f.widthOfTextAtSize(w.text, size);
      });
      this.cursorY -= lineHeight;
    });
    this.cursorY -= gapAfter;
  }

  addSpacer(h = 10) {
    this.cursorY -= h;
  }

  addSignatureBlock({ leftTitle, leftName, leftDoc, leftExtra, rightTitle, rightName, rightDoc }) {
    this._ensureSpace(120);
    const colW = CONTENT_W / 2 - 10;
    const y0 = this.cursorY;
    // linhas de assinatura
    this.page.drawLine({ start: { x: MARGIN_L, y: y0 - 40 }, end: { x: MARGIN_L + colW, y: y0 - 40 }, thickness: 1, color: rgb(0,0,0) });
    this.page.drawLine({ start: { x: MARGIN_L + colW + 20, y: y0 - 40 }, end: { x: MARGIN_L + colW + 20 + colW, y: y0 - 40 }, thickness: 1, color: rgb(0,0,0) });
    this.page.drawText(leftTitle, { x: MARGIN_L, y: y0, size: 10.5, font: this.bold });
    this.page.drawText(rightTitle, { x: MARGIN_L + colW + 20, y: y0, size: 10.5, font: this.bold });
    let ly = y0 - 55;
    this.page.drawText(leftName, { x: MARGIN_L, y: ly, size: 9.5, font: this.bold });
    this.page.drawText(leftDoc, { x: MARGIN_L, y: ly - 12, size: 9.5, font: this.font });
    if (leftExtra) this.page.drawText(leftExtra, { x: MARGIN_L, y: ly - 24, size: 9.5, font: this.bold });
    this.page.drawText(rightName, { x: MARGIN_L + colW + 20, y: ly, size: 9.5, font: this.bold });
    this.page.drawText(rightDoc, { x: MARGIN_L + colW + 20, y: ly - 12, size: 9.5, font: this.font });
    this.cursorY = ly - 60;
  }

  async finish() {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      let fy = 46;
      this.footerLines.forEach(line => {
        page.drawText(line, { x: MARGIN_L, y: fy, size: 7.5, font: this.font, color: rgb(0.35,0.35,0.35) });
        fy -= 9;
      });
      const label = `Página ${i + 1} de ${total}`;
      const w = this.font.widthOfTextAtSize(label, 8);
      page.drawText(label, { x: PAGE_W - MARGIN_R - w, y: 46, size: 8, font: this.font, color: rgb(0.35,0.35,0.35) });
    });
    return this.pdf.save();
  }
}

function loadAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'assets', name));
}

module.exports = { LetterheadDoc, loadAsset, PAGE_W, PAGE_H, CONTENT_W, MARGIN_L };
