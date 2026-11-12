// AI summary of a transcript ("סיכום AI"): the style, optional material from the lesson (slides,
// PDF, Word, images) and, on the business plan, other transcripts from the history. PowerPoint
// and Word are read here in the browser (their text only); PDFs and images go to OpenAI as files.
// The summary is paid from the minutes quota by what it cost (src/summary.js).

let d = null;           // helpers from app.js
let files = [];         // { name, kind: 'pdf' | 'image' | 'text', file, pages, text, size }
let lastText = '';      // the summary shown, for download / copy / email

const KINDS = { pdf: 'PDF', image: 'תמונה', text: 'טקסט' };
const CREDIT_USD = 0.003;
const PRICE = { input: 0.25, output: 2 };

export function initSummary(deps) {
  d = deps;
  const $ = d.$;
  $('summaryOpen').onclick = () => openSummary();
  $('summaryClose').onclick = () => { $('summaryCard').hidden = true; };
  $('sumFiles').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  const drop = $('sumDrop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  $('summaryBtn').onclick = () => generate();
  $('sumDownload').onclick = () => d.download(lastText, (currentName() || 'transcript') + ' - סיכום');
  $('sumCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(lastText); d.toast('הסיכום הועתק'); } catch { d.toast('לא הצלחנו להעתיק'); }
  };
  $('sumEmail').onclick = () => emailSummary();
}

const currentName = () => d.$('resultText').dataset.name || '';
const level = () => d.me()?.summary || { level: 0, styles: ['short', 'bullets'], files: 0, pages: 0, texts: 1, trialLeft: false };

// ---------- the card ----------

export function openSummary() {
  const $ = d.$;
  const s = level();
  const locked = s.level === 0 && !s.trialLeft;
  $('summaryCard').hidden = false;
  $('summaryFor').textContent = currentName();
  $('summaryLocked').hidden = !locked && !s.trialLeft;
  $('summaryLocked').innerHTML = '';
  if (locked) {
    $('summaryLocked').append(d.el('span', '', 'סיכומי AI זמינים בכל התוכניות בתשלום. '));
    const a = d.el('button', 'link-btn', 'לתוכניות');
    a.onclick = () => $('plans').scrollIntoView({ behavior: 'smooth' });
    $('summaryLocked').append(a);
  } else if (s.trialLeft) {
    $('summaryLocked').textContent = 'סיכום ניסיון אחד במתנה (סיכום קצר או נקודות). בתוכניות בתשלום אפשר לסכם כל תמלול.';
  }
  $('summaryForm').hidden = locked;
  renderStyles();
  renderFiles();
  renderMulti();
  updateCost();
  $('summaryCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStyles() {
  const $ = d.$;
  const s = level();
  const box = $('summaryStyles');
  const current = box.querySelector('input:checked')?.value || 'short';
  box.textContent = '';
  for (const [id, label] of Object.entries(d.config().summaryStyles || {})) {
    const ok = s.styles.includes(id);
    const lab = d.el('label', 'style-chip' + (ok ? '' : ' locked'), '');
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: 'sumStyle', value: id, disabled: !ok, checked: ok && id === (s.styles.includes(current) ? current : 'short') });
    lab.append(input, d.el('span', '', (ok ? '' : '🔒 ') + label));
    if (!ok) lab.title = 'בתוכנית מקצועי ומעלה';
    box.append(lab);
  }
}

function renderFiles() {
  const $ = d.$;
  const s = level();
  $('sumFilesBox').hidden = false;
  $('sumDrop').hidden = !s.files;
  $('sumFilesLocked').hidden = !!s.files;
  $('sumFilesLimit').textContent = s.files ? `עד ${s.files} קבצים ו-${s.pages} עמודים` : '';
  const ul = $('sumFileList');
  ul.textContent = '';
  files.forEach((f, i) => {
    const li = d.el('li', '', '');
    // The extension apart from the name: "שיעור 3.pdf" would come out scrambled in a right-to-left line.
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    li.append(d.el('span', 'name', f.name.replace(/\.[a-z0-9]+$/i, '')),
      d.el('span', 'muted small', [ext.toUpperCase(), f.kind === 'pdf' ? `${f.pages} עמ׳` : ''].filter(Boolean).join(' · ')));
    const x = d.el('button', 'link-btn', 'הסרה');
    x.onclick = () => { files.splice(i, 1); renderFiles(); updateCost(); };
    li.append(x);
    ul.append(li);
  });
}

function renderMulti() {
  const $ = d.$;
  const s = level();
  const box = $('sumMulti');
  box.textContent = '';
  const others = d.history().filter(h => h.text !== d.$('resultText').value);
  $('sumMultiBox').hidden = s.texts < 2 || !others.length;
  others.forEach((h, i) => {
    const lab = d.el('label', 'check-row', '');
    const input = document.createElement('input');
    Object.assign(input, { type: 'checkbox', value: String(i) });
    input.onchange = () => {
      if (box.querySelectorAll('input:checked').length > s.texts - 1) { input.checked = false; d.toast(`אפשר לסכם עד ${s.texts} תמלולים יחד`); }
      updateCost();
    };
    lab.append(input, d.el('span', '', h.name), d.el('span', 'muted small', d.fmtDate(h.date)));
    box.append(lab);
  });
  box.dataset.others = JSON.stringify(others.map(h => ({ title: h.name, text: h.text })));
}

function chosenTexts() {
  const box = d.$('sumMulti');
  const others = JSON.parse(box.dataset.others || '[]');
  return [
    { title: currentName(), text: d.$('resultText').value },
    ...[...box.querySelectorAll('input:checked')].map(i => others[Number(i.value)]),
  ];
}

// The most it can cost, in minutes from the quota (the same sum the server reserves).
function worstCredits() {
  const texts = chosenTexts();
  const chars = [...texts, ...files.filter(f => f.kind === 'text')].reduce((a, t) => a + (t.text || '').length, 0);
  const pages = files.filter(f => f.kind === 'pdf').reduce((a, f) => a + f.pages, 0);
  const images = files.filter(f => f.kind === 'image').length;
  const maxOut = level().trialLeft ? 3000 : 9000;
  const tokens = chars / 2 + (pages ? pages * 1500 : images * 1500) + 1500;
  return Math.max(1, Math.ceil(((tokens * PRICE.input + maxOut * PRICE.output) / 1e6) / CREDIT_USD));
}

function updateCost() {
  const n = worstCredits();
  d.$('summaryCost').textContent = d.me()?.unlimited ? '' : `יוריד מהמכסה עד ${n} דקות, בדרך כלל פחות`;
}

// ---------- files ----------

async function addFiles(list) {
  const s = level();
  for (const file of list) {
    if (files.length >= s.files) { d.toast(`אפשר לצרף עד ${s.files} קבצים`); break; }
    const ext = file.name.split('.').pop().toLowerCase();
    if (file.size > (d.config().maxSummaryFileBytes || 20e6)) { d.toast(`${file.name}: גדול מדי (עד 20MB)`); continue; }
    try {
      if (ext === 'pdf') {
        files.push({ name: file.name, kind: 'pdf', file, pages: await pdfPages(file) });
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        files.push({ name: file.name, kind: 'image', file, pages: 0 });
      } else if (ext === 'pptx') {
        files.push({ name: file.name, kind: 'text', text: await pptxText(file), pages: 0 });
        d.toast('מהמצגת נקרא רק הטקסט. לגרפים ותמונות: שמירה בשם PDF');
      } else if (ext === 'docx') {
        files.push({ name: file.name, kind: 'text', text: await docxText(file), pages: 0 });
      } else if (ext === 'txt' || ext === 'md') {
        files.push({ name: file.name, kind: 'text', text: await file.text(), pages: 0 });
      } else {
        d.toast(`${file.name}: אפשר PDF, PowerPoint, Word, טקסט או תמונה`);
        continue;
      }
    } catch {
      d.toast(`לא הצלחנו לקרוא את ${file.name}`);
      continue;
    }
    const pages = files.filter(f => f.kind === 'pdf').reduce((a, f) => a + f.pages, 0);
    if (pages > s.pages) { files.pop(); d.toast(`עד ${s.pages} עמודים בסך הכול`); }
  }
  renderFiles();
  updateCost();
}

async function pdfPages(file) {
  const s = new TextDecoder('latin1').decode(await file.arrayBuffer());
  const direct = (s.match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map(m => Number(m[1]));
  return Math.max(direct, ...counts, 1);
}

// A .pptx/.docx is a zip of XML files: read the ones we need with the browser's own inflate.
async function unzip(file, wanted) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  let p = dv.getUint32(end + 16, true);
  const out = [];
  for (let n = dv.getUint16(end + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const at = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.test(name)) continue;
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
    const data = buf.subarray(start, start + size);
    const xml = method === 0 ? new TextDecoder().decode(data)
      : method === 8 ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text() : null;
    if (xml !== null) out.push({ name, xml });
  }
  return out;
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function paragraphs(xml, tag) {
  return xml.split(new RegExp(`</${tag}:p>`)).map(p => unxml([...p.matchAll(new RegExp(`<${tag}:t[^>]*>([^<]*)</${tag}:t>`, 'g'))].map(m => m[1]).join(''))).filter(t => t.trim());
}

async function pptxText(file) {
  const slides = (await unzip(file, /^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  const text = slides.map((s, i) => `שקף ${i + 1}:\n` + paragraphs(s.xml, 'a').join('\n')).join('\n\n');
  if (!text.trim()) throw new Error('empty');
  return text;
}

async function docxText(file) {
  const [doc] = await unzip(file, /^word\/document\.xml$/);
  const text = doc ? paragraphs(doc.xml, 'w').join('\n') : '';
  if (!text.trim()) throw new Error('empty');
  return text;
}

// ---------- making it ----------

async function generate() {
  const $ = d.$;
  const style = $('summaryStyles').querySelector('input:checked')?.value || 'short';
  const btn = $('summaryBtn');
  btn.disabled = true;
  $('summaryError').hidden = true;
  $('summaryOut').hidden = true;
  $('summaryProgress').hidden = false;
  const step = t => { $('summaryProgressText').textContent = t; };
  try {
    const ids = [];
    const uploads = files.filter(f => f.kind === 'pdf' || f.kind === 'image');
    for (const [i, f] of uploads.entries()) {
      step(`מעלה חומרים (${i + 1}/${uploads.length})…`);
      const r = await d.api('/api/summary/file', {
        method: 'POST',
        headers: { 'Content-Type': f.file.type || (f.kind === 'pdf' ? 'application/pdf' : 'image/png'), 'X-Filename': encodeURIComponent(f.name) },
        body: f.file,
      });
      ids.push(r.id);
    }
    step('כותב את הסיכום… זה לוקח בדרך כלל חצי דקה עד דקה');
    const r = await d.api('/api/summarize', {
      method: 'POST',
      json: {
        style, texts: chosenTexts(), files: ids,
        extra: files.filter(f => f.kind === 'text').map(f => ({ name: f.name, text: f.text })),
        pages: files.filter(f => f.kind === 'pdf').reduce((a, f) => a + f.pages, 0),
      },
    });
    lastText = r.text;
    $('summaryText').innerHTML = renderMarkdown(r.text);
    $('summaryOut').hidden = false;
    $('summaryMeta').textContent = (r.partial ? 'הסיכום ארוך ונקטע בסופו. ' : '') + (d.me()?.unlimited ? '' : `ירדו ${r.credits} דקות מהמכסה`);
    files = [];
    renderFiles();
    await d.refreshMe(true);
    d.renderQuota();
    renderStyles();
    $('summaryOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('summaryError').textContent = e.message;
    $('summaryError').hidden = false;
  } finally {
    btn.disabled = false;
    $('summaryProgress').hidden = true;
    updateCost();
  }
}

async function emailSummary() {
  if (!d.me()?.features?.email) { d.toast('שליחה במייל זמינה בתוכניות בתשלום'); return; }
  try {
    const r = await d.api('/api/email', { method: 'POST', json: { text: lastText, filename: (currentName() || 'transcript') + ' - סיכום' } });
    d.toast('נשלח ל-' + r.to);
  } catch (e) {
    d.toast(e.message);
  }
}

// The model answers in simple Markdown (##, -, **); everything else is plain text.
function renderMarkdown(md) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let html = '', list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(item[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (!line) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    html += h ? `<h3>${inline(h[2])}</h3>` : `<p>${inline(line)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

// For checks in a browser (no effect on the page).
export const _internal = { pptxText, docxText, pdfPages, renderMarkdown, openSummary };
