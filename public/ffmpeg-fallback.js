// A decoder for whatever the browser itself can't read (an m4a with an unusual codec, AMR, WMA, an old video format...):
// ffmpeg compiled to WebAssembly, loaded only when it is needed (about 30 MB, once; the browser keeps it afterwards).
// It runs here in the page, so the file still never leaves the user's computer. Returns mono samples at 16 kHz.

const SAMPLE_RATE = 16000;
const FFMPEG = '/vendor/ffmpeg/'; // the small JavaScript part, from this site (see the README there)
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';

let loading = null;

const script = src => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('לא הצלחנו לטעון את מפענח השמע'));
  document.head.append(s);
});
// The core is wrapped in a local blob address (the worker loads it with importScripts).
const blobUrl = async (url, type) => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));

async function load(onStatus) {
  if (!loading) {
    loading = (async () => {
      onStatus?.('הפורמט הזה לא נתמך בדפדפן, אז טוען מפענח כללי… (כ-30MB, רק בפעם הראשונה)');
      await script(FFMPEG + 'ffmpeg.js');
      const ffmpeg = new window.FFmpegWASM.FFmpeg();
      await ffmpeg.load({
        coreURL: await blobUrl(CORE + 'ffmpeg-core.js', 'text/javascript'),
        wasmURL: await blobUrl(CORE + 'ffmpeg-core.wasm', 'application/wasm'),
      });
      return ffmpeg;
    })().catch(e => { loading = null; throw e; });
  }
  return loading;
}

export async function decodeWithFfmpeg(file, onStatus) {
  const ffmpeg = await load(onStatus);
  const onProgress = ({ progress }) => { if (progress > 0 && progress <= 1) onStatus?.(`ממיר את הקובץ… ${Math.round(progress * 100)}%`); };
  ffmpeg.on('progress', onProgress);
  try {
    onStatus?.('ממיר את הקובץ…');
    await ffmpeg.writeFile('input', new Uint8Array(await file.arrayBuffer()));
    const code = await ffmpeg.exec(['-i', 'input', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'out.pcm']);
    if (code !== 0) throw new Error('ffmpeg exit ' + code);
    const raw = await ffmpeg.readFile('out.pcm');
    const pcm = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength & ~1)));
    if (!pcm.length) throw new Error('no audio in the file');
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
  } finally {
    ffmpeg.off('progress', onProgress);
    for (const f of ['input', 'out.pcm']) { try { await ffmpeg.deleteFile(f); } catch { /* not there */ } }
  }
}
