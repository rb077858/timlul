// Export of a transcript or a summary: Word (.docx), PDF and plain text, all in the browser (nothing is uploaded).
// Hebrew right-to-left throughout. The pages follow the site's look: paper, ink and a highlighter.
//
//   buildDoc(kind, text, info)   text -> { title, kind, meta, blocks }  (the model all three formats are made from)
//   buildDocx(doc)               -> Uint8Array of a .docx file
//   printHtml(doc)               -> a styled HTML page; printing it is how the PDF is made (real text, any browser)
//
// The transcript text has the shape the page shows. A conversation by speakers is blocks separated by a blank line:
//   דובר 1 · 00:12
//   what they said
// Anything else is plain paragraphs (one per line). A summary is the markdown the AI wrote: #, - and **bold**.

const SPEAKER_HEAD = /^(.{1,40}?) · (\d{1,2}:\d{2}(?::\d{2})?)$/;
export const SPEAKER_COLORS = ['1A1814', 'B8402B', '2C6A45', '2B5C8A', '7A4E9C', 'A06A12'];

export const fmtTime = sec => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

// ---------------------------------------------------------------- the model

/** The speakers (in order of appearance) of a transcript text, or [] when it isn't a conversation. */
export function speakersOf(text) {
  const seen = [];
  for (const b of String(text || '').split(/\n{2,}/)) {
    const m = b.split('\n')[0].trim().match(SPEAKER_HEAD);
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function transcriptBlocks(text) {
  const blocks = [];
  const speakers = speakersOf(text);
  if (speakers.length) {
    for (const raw of String(text).split(/\n{2,}/)) {
      const lines = raw.replace(/\s+$/, '').split('\n');
      const m = lines[0].trim().match(SPEAKER_HEAD);
      if (m) blocks.push({ t: 'turn', speaker: m[1], time: m[2], color: speakers.indexOf(m[1]), text: lines.slice(1).join(' ').trim() });
      else if (raw.trim()) blocks.push({ t: 'p', text: raw.trim().replace(/\n+/g, ' ') });
    }
    return blocks;
  }
  for (const line of String(text || '').split('\n')) if (line.trim()) blocks.push({ t: 'p', text: line.trim() });
  return blocks;
}

function summaryBlocks(md) {
  const blocks = [];
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) { blocks.push({ t: 'li', text: item[1] }); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    blocks.push(h ? { t: 'h', text: h[2] } : { t: 'p', text: line });
  }
  return blocks;
}

/** kind: 'transcript' | 'summary'. info: { title, seconds, date, note }. */
export function buildDoc(kind, text, info = {}) {
  const blocks = kind === 'summary' ? summaryBlocks(text) : transcriptBlocks(text);
  const speakers = kind === 'summary' ? [] : speakersOf(text);
  const date = new Date(info.date || Date.now());
  const meta = [];
  meta.push(['תאריך', date.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })]);
  if (info.seconds > 0) meta.push(['משך', info.seconds < 60 ? 'פחות מדקה' : fmtDuration(info.seconds)]);
  if (speakers.length) meta.push(['דוברים', speakers.join(', ')]);
  if (info.note) meta.push(['הערה', info.note]);
  return {
    kind,
    title: String(info.title || (kind === 'summary' ? 'סיכום' : 'תמלול')).slice(0, 200),
    label: kind === 'summary' ? 'סיכום' : 'תמלול',
    md: kind === 'summary', // **bold** is the AI's markup in a summary; in a transcript an asterisk is just an asterisk
    meta,
    blocks,
  };
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} שעות${m ? ' ו-' + m + ' דקות' : ''}` : `${m} דקות`;
}

/** The text of a document as a plain-text file. */
export function plainText(doc) {
  const stripMd = s => (doc.md ? s.replace(/\*\*([^*]+)\*\*/g, '$1') : s);
  return doc.blocks.map(b => (b.t === 'turn' ? `${b.speaker} · ${b.time}\n${b.text}` : b.t === 'li' ? '• ' + stripMd(b.text) : b.t === 'h' ? '\n' + stripMd(b.text) : stripMd(b.text))).join(doc.blocks.some(b => b.t === 'turn') ? '\n\n' : '\n');
}

// ---------------------------------------------------------------- Word

const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const HEB = /[֐-׿]/;

// Fonts every Word has with Hebrew; the site's own web fonts aren't on the reader's computer.
const BODY = 'Arial', HEAD = 'David';

function rPr({ bold, size, color, font, italic, mono } = {}) {
  const f = mono ? 'Consolas' : font || BODY;
  return `<w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}` +
    `${color ? `<w:color w:val="${color}"/>` : ''}${size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : ''}<w:rtl/><w:lang w:val="he-IL" w:bidi="he-IL"/></w:rPr>`;
}
const run = (text, o) => `<w:r>${rPr(o)}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;

// **bold** inside a line becomes bold runs
function runsOf(text, o = {}, md = true) {
  if (!md) return run(text, o);
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    return run(m ? m[1] : part, m ? { ...o, bold: true } : o);
  }).join('');
}

const para = (inner, { ppr = '', after = 120, line = 360, keep = false } = {}) =>
  `<w:p><w:pPr>${keep ? '<w:keepNext/>' : ''}<w:bidi/>${ppr}<w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>${inner}</w:p>`;
// jc "left" in a right-to-left paragraph is the start of the line, which is the right side of the page.

function docxBody(doc) {
  const out = [];
  const runs = (t, o) => runsOf(t, o, !!doc.md);
  // brand tag, with the highlighter behind it
  out.push(para(`<w:r>${rPr({ bold: true, size: 10, color: '1A1814' }).replace('<w:rtl/>', '<w:shd w:val="clear" w:color="auto" w:fill="F5D63F"/><w:rtl/>')}<w:t xml:space="preserve"> תמלולי · ${xml(doc.label)} </w:t></w:r>`, { after: 160 }));
  out.push(para(run(doc.title, { bold: true, size: 26, font: HEAD, color: '1A1814' }), { after: 100, line: 300 }));
  for (const [k, v] of doc.meta) out.push(para(run(k + ': ', { size: 10.5, color: '7A7466', bold: true }) + run(v, { size: 10.5, color: '5B5649' }), { after: 20, line: 276 }));
  // a rule under the heading block
  out.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="1A1814"/></w:pBdr><w:spacing w:after="240" w:line="120" w:lineRule="auto"/></w:pPr></w:p>`);

  for (const b of doc.blocks) {
    if (b.t === 'h') out.push(para(runs(b.text, { bold: true, size: 15, font: HEAD, color: '1A1814' }), { after: 80, keep: true, ppr: '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="D4CBB7"/></w:pBdr>' }).replace('<w:spacing w:after="80"', '<w:spacing w:before="280" w:after="80"'));
    else if (b.t === 'li') out.push(para(runs(b.text, { size: 12 }), { after: 60, ppr: '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' }));
    else if (b.t === 'turn') {
      const color = SPEAKER_COLORS[b.color % SPEAKER_COLORS.length];
      out.push(para(run(b.speaker, { bold: true, size: 11.5, color }) + run('   ' + b.time, { size: 9.5, color: '7A7466', mono: true }), { after: 30, keep: true, ppr: '<w:shd w:val="clear" w:color="auto" w:fill="F3EEE3"/>' }).replace('<w:spacing w:after="30"', '<w:spacing w:before="160" w:after="30"'));
      if (b.text) out.push(para(runs(b.text, { size: 12 }), { after: 80 }));
    } else out.push(para(runs(b.text, { size: 12 }), { after: 120 }));
  }
  return out.join('');
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function docxFiles(doc) {
  const footer = `<w:ftr ${NS}><w:p><w:pPr><w:bidi/><w:jc w:val="center"/></w:pPr>` +
    run(doc.title.slice(0, 60) + '  ·  עמוד ', { size: 9, color: '7A7466' }) +
    `<w:r>${rPr({ size: 9, color: '7A7466' })}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr({ size: 9, color: '7A7466' })}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r>${rPr({ size: 9, color: '7A7466' })}<w:fldChar w:fldCharType="separate"/></w:r>${run('1', { size: 9, color: '7A7466' })}<w:r>${rPr({ size: 9, color: '7A7466' })}<w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${docxBody(doc)}<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1247" w:bottom="1134" w:left="1247" w:header="567" w:footer="567" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${BODY}" w:hAnsi="${BODY}" w:cs="${BODY}"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="he-IL" w:bidi="he-IL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`,
    'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:themeFontLang w:val="en-US" w:bidi="he-IL"/></w:settings>`,
    'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="540" w:hanging="300"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="B8402B"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${footer}`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(doc.title)}</dc:title><dc:creator>תמלולי</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>תמלולי</Application></Properties>`,
  };
}

export async function buildDocx(doc) {
  return zip(docxFiles(doc));
}

// ---------------------------------------------------------------- a minimal zip (deflate when the browser can)

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >>> 8) & 255], u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const packed = await deflateRaw(raw);
    const data = packed && packed.length < raw.length ? packed : raw;
    const method = data === raw ? 0 : 8;
    const crc = crc32(raw);
    const head = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0)]);
    parts.push(head, nameBytes, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameBytes);
    offset += head.length + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(central.length / 2), ...u16(central.length / 2), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- PDF (the browser prints the page we make)

const html = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inlineHtml = (s, md) => (md ? html(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') : html(s));

export function printHtml(doc) {
  const inline = s => inlineHtml(s, !!doc.md);
  const colors = SPEAKER_COLORS.map(c => '#' + c);
  let body = '';
  let list = false;
  for (const b of doc.blocks) {
    if (b.t !== 'li' && list) { body += '</ul>'; list = false; }
    if (b.t === 'li') { if (!list) { body += '<ul>'; list = true; } body += `<li>${inline(b.text)}</li>`; }
    else if (b.t === 'h') body += `<h2>${inline(b.text)}</h2>`;
    else if (b.t === 'turn') body += `<section class="turn"><div class="who" style="--c:${colors[b.color % colors.length]}"><b>${html(b.speaker)}</b><time>${html(b.time)}</time></div><p>${inline(b.text)}</p></section>`;
    else body += `<p>${inline(b.text)}</p>`;
  }
  if (list) body += '</ul>';
  const meta = doc.meta.map(([k, v]) => `<div><dt>${html(k)}</dt><dd>${html(v)}</dd></div>`).join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${html(doc.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Frank+Ruhl+Libre:wght@500;700;900&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
@page { size: A4; margin: 20mm 18mm 22mm; @bottom-center { content: "${html(doc.title.slice(0, 50)).replace(/"/g, '')}  ·  " counter(page); font: 9pt Assistant, Arial, sans-serif; color: #7a7466; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 12pt/1.75 'Assistant', 'Arial Hebrew', Arial, sans-serif; color: #1a1814; }
.tag { display: inline-block; background: #f5d63f; padding: 1px 10px; font: 700 9.5pt 'Assistant', Arial, sans-serif; letter-spacing: .02em; }
h1 { font: 900 27pt/1.15 'Frank Ruhl Libre', 'David', 'Times New Roman', serif; margin: 12px 0 10px; overflow-wrap: anywhere; }
dl { display: flex; flex-wrap: wrap; gap: 4px 26px; margin: 0 0 12px; font-size: 10.5pt; color: #5b5649; }
dl div { display: flex; gap: 6px; } dt { font-weight: 700; color: #7a7466; } dt::after { content: ':'; } dd { margin: 0; }
.rule { height: 0; border-top: 2.5px solid #1a1814; margin: 0 0 20px; }
p { margin: 0 0 11px; orphans: 3; widows: 3; text-align: start; }
h2 { font: 700 15pt/1.3 'Frank Ruhl Libre', 'David', serif; margin: 22px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #d4cbb7; break-after: avoid; }
ul { margin: 0 0 12px; padding: 0 20px 0 0; } li { margin-bottom: 5px; } li::marker { color: #b8402b; }
.turn { margin: 0 0 13px; break-inside: avoid-page; }
.who { display: flex; align-items: baseline; gap: 12px; background: #f3eee3; border-right: 3px solid var(--c); padding: 2px 11px; margin-bottom: 4px; break-after: avoid; }
.who b { color: var(--c); font-size: 11.5pt; } .who time { font: 400 9pt 'IBM Plex Mono', Consolas, monospace; color: #7a7466; direction: ltr; }
.turn p { margin: 0 14px 0 0; }
strong { font-weight: 700; }
</style></head><body>
<span class="tag">תמלולי · ${html(doc.label)}</span>
<h1>${html(doc.title)}</h1>
<dl>${meta}</dl><div class="rule"></div>
${body}
</body></html>`;
}

// ---------------------------------------------------------------- in the page

function save(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const safeName = s => String(s || 'תמלול').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 100) || 'תמלול';

/** format: 'docx' | 'pdf' | 'txt'. PDF opens the browser's print dialog on the styled page: "Save as PDF". */
export async function exportDoc(doc, format) {
  const name = safeName(doc.title) + (doc.kind === 'summary' ? '' : '');
  if (format === 'txt') return save(new Blob(['﻿' + plainText(doc)], { type: 'text/plain;charset=utf-8' }), name + '.txt');
  if (format === 'docx') {
    return save(new Blob([await buildDocx(doc)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), name + '.docx');
  }
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;inset-inline-start:-9999px;width:800px;height:600px;border:0';
  document.body.append(frame);
  const d = frame.contentDocument;
  d.open();
  d.write(printHtml(doc));
  d.close();
  // wait for the web fonts, but not for long
  await Promise.race([d.fonts ? d.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 2500))]);
  const win = frame.contentWindow;
  win.onafterprint = () => setTimeout(() => frame.remove(), 500);
  win.focus();
  win.print();
  setTimeout(() => frame.remove(), 120000);
}
