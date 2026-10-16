// ===== MAHSULOT RASMINING FONINI OLIB TASHLASH ("3D" ko'rinish uchun) =====
// U2-Net (u2netp, 4.5 MB) modeli onnxruntime-web (WASM) orqali serverda ishlaydi.
// ffmpeg rasmni 320x320 ga keltiradi → model niqob (mask) beradi → niqob asl rasmga
// alfa-kanal sifatida qo'shiladi → mahsulot chegarasi bo'yicha qirqiladi → shaffof WebP.
'use strict';
const path = require('path');
const { spawn } = require('child_process');

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch (_) { FFMPEG = null; }

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let sessionPromise = null;
let queue = Promise.resolve();

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error("ffmpeg yo'q"));
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = [], err = [];
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => err.push(d));
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().slice(0, 200))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = require('onnxruntime-web');
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const session = await ort.InferenceSession.create(path.join(__dirname, 'models', 'u2netp.onnx'), { executionProviders: ['wasm'] });
      return { ort, session };
    })().catch(e => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
}

async function removeBackground(input, { maxSide = 1000 } = {}) {
  const run = async () => {
    const { ort, session } = await getSession();
    // 1) Model uchun 320x320 RGB
    const rgb = await ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${SIZE}:${SIZE},format=rgb24`, '-f', 'rawvideo', 'pipe:1'], input);
    if (rgb.length < SIZE * SIZE * 3) throw new Error("rasmni o'qib bo'lmadi");
    const data = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      for (let c = 0; c < 3; c++) data[c * SIZE * SIZE + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) };
    const out = await session.run(feeds);
    const pred = out[session.outputNames[0]].data;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < pred.length; i++) { if (pred[i] < mn) mn = pred[i]; if (pred[i] > mx) mx = pred[i]; }
    const range = mx - mn || 1;
    // 2) Niqob: kontrastni oshiramiz (chekkalar toza bo'lsin), mahsulot chegarasini topamiz
    const mask = Buffer.alloc(SIZE * SIZE);
    let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1, covered = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        let v = (pred[i] - mn) / range;
        v = Math.min(1, Math.max(0, (v - 0.2) / 0.6));         // chegara (kattalashtirgandan keyin yana aniqlanadi)
        const b = Math.round(v * 255);
        mask[i] = b;
        if (b > 96) { covered++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    // Faqat asosiy mahsulot (chetdagi begona narsalar — klaviatura, qo'l, stol bo'laklari — olib tashlanadi)
    {
      const tmp = Buffer.alloc(SIZE * SIZE * 4);
      for (let i = 0; i < SIZE * SIZE; i++) tmp[i * 4 + 3] = mask[i];
      keepMainObject(tmp, SIZE, SIZE);
      x0 = SIZE; y0 = SIZE; x1 = -1; y1 = -1; covered = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        mask[i] = tmp[i * 4 + 3];
        if (mask[i] > 96) { covered++; const x = i % SIZE, y = (i / SIZE) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    const ratio = covered / (SIZE * SIZE);
    if (x1 < 0 || ratio < 0.02) throw new Error('mahsulot aniqlanmadi');
    // 3) Asl rasm + niqob → alfa, mahsulot atrofida qirqish (nisbiy koordinatalar)
    const pad = 0.04;
    const fx0 = Math.max(0, x0 / SIZE - pad), fy0 = Math.max(0, y0 / SIZE - pad);
    const fx1 = Math.min(1, (x1 + 1) / SIZE + pad), fy1 = Math.min(1, (y1 + 1) / SIZE + pad);
    const maskPng = await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SIZE}x${SIZE}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], mask);
    const fs = require('fs'), os = require('os');
    const tmp = path.join(os.tmpdir(), `cut_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp + '_m.png', maskPng);
    try {
      const filter =
        `[0:v]format=rgba[img];[1:v]format=gray[m0];[m0][img]scale2ref=w=iw:h=ih:flags=bicubic[m1][img2];` +
        // Kattalashtirilgan niqob chetini aniqlaymiz (xira "tutun" chegara qolmasin)
        `[m1]lut=y='clip((val-56)*255/150\,0\,255)'[m];` +
        `[img2][m]alphamerge,crop=iw*${(fx1 - fx0).toFixed(4)}:ih*${(fy1 - fy0).toFixed(4)}:iw*${fx0.toFixed(4)}:ih*${fy0.toFixed(4)},` +
        `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
      const webp = await ffmpeg(['-i', 'pipe:0', '-i', tmp + '_m.png', '-filter_complex', filter, '-frames:v', '1',
        '-c:v', 'libwebp', '-lossless', '0', '-quality', '92', '-f', 'webp', 'pipe:1'], input);
      return { buffer: webp, coverage: ratio };
    } finally {
      try { fs.unlinkSync(tmp + '_m.png'); } catch (_) {}
    }
  };
  // Bir vaqtda bitta (xotira tejaladi)
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// AI "mahsulot ehtimoli" niqobi (320×320, 0–255) — oq fon usulini tekshirish uchun: rasm butunligicha cho'zilgan holda
async function saliency(input) {
  const run = async () => {
    const { ort, session } = await getSession();
    const rgb = await ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${SIZE}:${SIZE},format=rgb24`, '-f', 'rawvideo', 'pipe:1'], input);
    if (rgb.length < SIZE * SIZE * 3) throw new Error("rasmni o'qib bo'lmadi");
    const data = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) data[c * SIZE * SIZE + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
    const pred = out[session.outputNames[0]].data;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < pred.length; i++) { if (pred[i] < mn) mn = pred[i]; if (pred[i] > mx) mx = pred[i]; }
    const range = mx - mn || 1, mask = Buffer.alloc(SIZE * SIZE);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.round(Math.min(1, Math.max(0, (pred[i] - mn) / range)) * 255);
    return { buffer: mask, coverage: null };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// ===== HAJM XARITASI ("3D" model uchun) =====
// Depth Anything V2 Small (int8, 35 MB) fonsiz rasmdan chuqurlik xaritasini taxmin qiladi.
// Unga mahsulot siluetidan hisoblangan "yumaloqlash" qo'shiladi — chekkalar nolga tushadi,
// shunda WebGL'da yopiq, silliq hajmli shakl chiqadi. Natija: HM×HM kulrang PNG (rasmga cho'zilgan).
const DEPTH_N = 518, HM = 256;
let depthSessionPromise = null;
function getDepthSession() {
  if (!depthSessionPromise) {
    depthSessionPromise = (async () => {
      const ort = require('onnxruntime-web');
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const session = await ort.InferenceSession.create(path.join(__dirname, 'models', 'depth_anything_v2_small_q8.onnx'), { executionProviders: ['wasm'] });
      return { ort, session };
    })().catch(e => { depthSessionPromise = null; throw e; });
  }
  return depthSessionPromise;
}

function resampleBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function blur(h, n, mask) {
  const t = new Float32Array(h.length);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx >= 0 && xx < n) { s += h[y * n + xx]; c++; } }
    t[y * n + x] = s / c;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let dy = -2; dy <= 2; dy++) { const yy = y + dy; if (yy >= 0 && yy < n) { s += t[yy * n + x]; c++; } }
    h[y * n + x] = mask[y * n + x] ? s / c : 0;
  }
}

// Silhuetdan masofa (chamfer 3-4) → doiraviy profil: chekkada 0, ichkarida 1
function inflate(mask, n, radius) {
  const INF = 1e9, d = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3); else v = Math.min(v, 3);
    if (y > 0) { v = Math.min(v, d[i - n] + 3); if (x > 0) v = Math.min(v, d[i - n - 1] + 4); if (x < n - 1) v = Math.min(v, d[i - n + 1] + 4); } else v = Math.min(v, 3);
    d[i] = v;
  }
  for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) {
    const i = y * n + x; if (!d[i]) continue;
    let v = d[i];
    if (x < n - 1) v = Math.min(v, d[i + 1] + 3); else v = Math.min(v, 3);
    if (y < n - 1) { v = Math.min(v, d[i + n] + 3); if (x < n - 1) v = Math.min(v, d[i + n + 1] + 4); if (x > 0) v = Math.min(v, d[i + n - 1] + 4); } else v = Math.min(v, 3);
    d[i] = v;
  }
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (!mask[i]) continue;
    const t = Math.min(1, d[i] / 3 / radius);
    out[i] = Math.sqrt(1 - (1 - t) * (1 - t));
  }
  return out;
}

// cutoutWebp — removeBackground natijasi (shaffof WebP). useModel=false bo'lsa faqat siluetdan.
async function heightMap(cutoutWebp, { useModel = true } = {}) {
  const run = async () => {
    const rgba = await ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${HM}:${HM}:flags=area,format=rgba`, '-f', 'rawvideo', 'pipe:1'], cutoutWebp);
    if (rgba.length < HM * HM * 4) throw new Error("rasmni o'qib bo'lmadi");
    const mask = new Uint8Array(HM * HM);
    let covered = 0;
    for (let i = 0; i < HM * HM; i++) if (rgba[i * 4 + 3] > 110) { mask[i] = 1; covered++; }
    if (covered < HM * HM * 0.01) throw new Error("mahsulot topilmadi");
    // Mahsulotning "qalinligi" — silhuetning eng tor o'lchamiga nisbatan
    let bx0 = HM, bx1 = 0, by0 = HM, by1 = 0;
    for (let y = 0; y < HM; y++) for (let x = 0; x < HM; x++) if (mask[y * HM + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const inf = inflate(mask, HM, Math.max(6, Math.min(bx1 - bx0, by1 - by0) * 0.16));
    let depth = null;
    if (useModel) {
      try {
        const { ort, session } = await getDepthSession();
        // Kulrang fon ustida (model butun sahnani emas, faqat mahsulotni ko'radi)
        const rgb = await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x808080:s=${DEPTH_N}x${DEPTH_N}`, '-i', 'pipe:0', '-filter_complex',
          `[1:v]scale=${DEPTH_N}:${DEPTH_N}:flags=bicubic,format=rgba[f];[0:v][f]overlay=0:0:format=auto,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], cutoutWebp);
        if (rgb.length < DEPTH_N * DEPTH_N * 3) throw new Error("rasmni o'qib bo'lmadi");
        const data = new Float32Array(3 * DEPTH_N * DEPTH_N);
        for (let i = 0; i < DEPTH_N * DEPTH_N; i++) for (let c = 0; c < 3; c++) data[c * DEPTH_N * DEPTH_N + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, DEPTH_N, DEPTH_N]) });
        const pred = out[session.outputNames[0]];
        const dims = pred.dims, ph = dims[dims.length - 2], pw = dims[dims.length - 1];
        depth = resampleBilinear(pred.data, pw, ph, HM, HM);
        // Faqat mahsulot ichida normallashtiramiz (2%–98% oralig'i — chetki shovqinlar kesiladi)
        const vals = [];
        for (let i = 0; i < HM * HM; i++) if (mask[i]) vals.push(depth[i]);
        vals.sort((a, b) => a - b);
        const lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.floor(vals.length * 0.98)], rg = (hi - lo) || 1;
        for (let i = 0; i < HM * HM; i++) depth[i] = mask[i] ? Math.min(1, Math.max(0, (depth[i] - lo) / rg)) : 0;
      } catch (e) {
        depth = null;
        process.stderr.write(JSON.stringify({ warn: 'depth: ' + e.message }) + '\n');
      }
    }
    // Chuqurlikdagi mayda shovqinni yo'qotamiz — faqat katta shakl qoladi (ekran/korpus tekis, "to'lqin"siz)
    if (depth) for (let pass = 0; pass < 4; pass++) blur(depth, HM, mask);
    const h = new Float32Array(HM * HM);
    for (let i = 0; i < HM * HM; i++) h[i] = mask[i] ? inf[i] * (depth ? 0.4 + 0.6 * depth[i] : 1) : 0;
    blur(h, HM, mask);
    let mx = 0; for (let i = 0; i < h.length; i++) if (h[i] > mx) mx = h[i];
    const g = Buffer.alloc(HM * HM);
    for (let i = 0; i < HM * HM; i++) g[i] = Math.round(h[i] / (mx || 1) * 255);
    const png = await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${HM}x${HM}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], g);
    return { buffer: png, model: !!depth };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// ===== FAQAT ASOSIY MAHSULOT QOLSIN =====
// Fon olib tashlangandan keyin qolgan alohida bo'laklar (chetdagi klaviatura, sichqoncha, dog'lar)
// o'chiriladi: eng katta bo'lak — mahsulot; boshqasi faqat yetarlicha katta va rasm chetiga tegmasa qoladi
// (masalan, quloqchinning ikki qulog'i yoki to'plamdagi ikkinchi buyum).
function keepMainObject(rgba, w, h) {
  const N = w * h, lab = new Int32Array(N), sizes = [0], touches = [false], boxes = [null];
  let cur = 0;
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (lab[s] || rgba[s * 4 + 3] < 128) continue;
    cur++; let size = 0, edge = false, x0 = w, y0 = h, x1 = 0, y1 = 0;
    lab[s] = cur; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i / w) | 0;
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) edge = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !lab[j] && rgba[j * 4 + 3] >= 128) { lab[j] = cur; stack.push(j); }
    }
    sizes.push(size); touches.push(edge); boxes.push([x0, y0, x1, y1]);
  }
  if (cur <= 1) return;
  let main = 1; for (let c = 2; c <= cur; c++) if (sizes[c] > sizes[main]) main = c;
  const keep = new Uint8Array(cur + 1); keep[main] = 1;
  for (let c = 1; c <= cur; c++) if (c !== main && sizes[c] >= sizes[main] * 0.18 && !touches[c]) keep[c] = 1;
  // Yarim shaffof chet piksellari (lab=0) — eng yaqin qolgan bo'lak bilan birga; uzoqdagilarini tozalaymiz
  for (let i = 0; i < N; i++) {
    const c = lab[i];
    if (c && !keep[c]) rgba[i * 4 + 3] = 0;
  }
  // Olib tashlangan bo'laklar atrofidagi xira chetlar ham ketsin
  const kb = boxes.filter((b, c) => b && keep[c]);
  const pad = 6;
  for (let i = 0; i < N; i++) {
    if (lab[i] || rgba[i * 4 + 3] === 0) continue;
    const x = i % w, y = (i / w) | 0;
    if (!kb.some(b => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad)) rgba[i * 4 + 3] = 0;
  }
}

// ===== KOLLAJNI KO'RINISHLARGA AJRATISH =====
// Bitta rasmda bir nechta ko'rinish (old, orqa, yonlar) oq fonda alohida turgan bo'lsa — har biri alohida
// shaffof PNG bo'lib qaytadi (o'qish tartibida: chapdan o'ngga, yuqoridan pastga). Aks holda null.
async function splitViews(rgba, w, h) {
  const N = w * h, lab = new Int32Array(N), comps = [];
  const stack = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (lab[s0] || rgba[s0 * 4 + 3] < 128) continue;
    const id = comps.length + 1; let size = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, edge = false;
    lab[s0] = id; stack.push(s0);
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i / w) | 0;
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) edge = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (j >= 0 && !lab[j] && rgba[j * 4 + 3] >= 128) { lab[j] = id; stack.push(j); }
    }
    comps.push({ id, size, edge, box: [x0, y0, x1, y1] });
  }
  const total = comps.reduce((a, c) => a + c.size, 0);
  // Ko'rinish: yetarlicha katta bo'lak (ingichka yon ko'rinish ham — bo'yi rasmning 15% idan uzun)
  const views = comps.filter(c => !c.edge && c.size >= total * 0.03 && Math.max(c.box[2] - c.box[0], c.box[3] - c.box[1]) >= Math.min(w, h) * 0.15);
  if (views.length < 2 || views.length > 6) return null;
  if (views.reduce((a, c) => a + c.size, 0) < total * 0.9) return null;    // ko'p mayda bo'laklar — kollaj emas
  // O'qish tartibi: avval qator (yuqoridan), keyin ustun
  const rowH = Math.max(...views.map(c => c.box[3] - c.box[1])) * 0.5;
  views.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) > rowH ? a.box[1] - b.box[1] : a.box[0] - b.box[0]));
  const out = [];
  for (const c of views) {
    const pad = 16;
    const [x0, y0, x1, y1] = [Math.max(0, c.box[0] - pad), Math.max(0, c.box[1] - pad), Math.min(w - 1, c.box[2] + pad), Math.min(h - 1, c.box[3] + pad)];
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, buf = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y + y0) * w + (x + x0), o = (y * cw + x) * 4;
      // Faqat shu bo'lak (va uning yarim shaffof cheti) — qo'shni ko'rinishlar kirmasin
      const keep = lab[i] === c.id || (!lab[i] && rgba[i * 4 + 3] > 0);
      if (!keep) continue;
      buf[o] = rgba[i * 4]; buf[o + 1] = rgba[i * 4 + 1]; buf[o + 2] = rgba[i * 4 + 2]; buf[o + 3] = rgba[i * 4 + 3];
    }
    // Kvadrat kanvasga markazlab (TRELLIS uchun qulay), PNG
    const side = Math.max(cw, ch) + 40;
    out.push(await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cw}x${ch}`, '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,scale='min(1024,iw)':-1`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], buf));
  }
  return out;
}

// ===== BIR XIL RANGLI FONNI OLIB TASHLASH (oq/kulrang fondagi mahsulot surati) =====
// Chetdan boshlab fon rangiga yaqin piksellar "bo'yoq quyish" (flood fill) bilan o'chiriladi —
// mahsulot ichidagi oq qismlar (ekran, korpus) saqlanadi, chunki ular chetga ulanmagan.
// Fon bir xil bo'lmasa (xona, tutun, rang-barang) — null (unda AI ishlatiladi).
const UB = 1000;
async function removeUniformBackground(input, { split = false, aiMask = null } = {}) {
  const rgba = await ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-vf',
    `format=rgba,scale=${UB}:${UB}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${UB}:${UB}:-1:-1:color=0x00000000,format=rgba`,
    '-f', 'rawvideo', 'pipe:1'], input);
  if (rgba.length < UB * UB * 4) return null;
  const N = UB * UB;
  const A = i => rgba[i * 4 + 3];
  // Fon bilan chegaradosh ko'rinadigan piksellar: rasm cheti yoki shaffof qo'shnisi bor
  const seeds = [];
  for (let y = 0; y < UB; y += 2) for (let x = 0; x < UB; x += 2) {
    const i = y * UB + x;
    if (A(i) < 200) continue;
    const edge = x < 2 || y < 2 || x >= UB - 2 || y >= UB - 2 || A(i - 2) < 40 || A(i + 2) < 40 || A(i - 2 * UB) < 40 || A(i + 2 * UB) < 40;
    if (edge) seeds.push(i);
  }
  if (seeds.length < 50) return null;                       // ko'rinadigan chegarasi yo'q — allaqachon toza
  // Ko'rinadigan qismning chegara to'rtburchagi: burchaklari ham ko'rinsa — bu to'rtburchak FON (oq karta yoki
  // JPEG foni), mahsulot emas (mahsulotning burchaklari odatda yumaloq yoki shaffof bo'ladi)
  let bx0 = UB, by0 = UB, bx1 = -1, by1 = -1;
  for (let y = 0; y < UB; y += 2) for (let x = 0; x < UB; x += 2) if (A(y * UB + x) >= 200) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) return null;
  const corners = [[bx0 + 2, by0 + 2], [bx1 - 2, by0 + 2], [bx0 + 2, by1 - 2], [bx1 - 2, by1 - 2]].map(([x, y]) => y * UB + x);
  // Kamida 3 ta burchak ko'rinadigan, och (oq/kulrang) va o'zaro o'xshash bo'lsin — bittasida begona narsa
  // (klaviatura, sichqoncha) bo'lishi mumkin. Qora/rangli to'rtburchak — mahsulotning o'zi (televizor ekrani).
  const light = corners.filter(i => {
    if (A(i) < 200) return false;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    return 0.299 * r + 0.587 * g + 0.114 * b > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
  });
  if (light.length < 3) return null;
  const bg = [0, 1, 2].map(c => Math.round(light.reduce((sum, i) => sum + rgba[i * 4 + c], 0) / light.length));
  if (light.some(i => Math.hypot(rgba[i * 4] - bg[0], rgba[i * 4 + 1] - bg[1], rgba[i * 4 + 2] - bg[2]) > 45)) return null;
  const dist = i => Math.hypot(rgba[i * 4] - bg[0], rgba[i * 4 + 1] - bg[1], rgba[i * 4 + 2] - bg[2]);
  const TOL = 34;
  // Fonga o'xshash: fon rangiga yaqin YOKI och rangsiz (yorug'lik farqi bilan o'sha fon)
  const bgLike = i => { if (dist(i) < TOL) return true; const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]; return Math.max(r, g, b) > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 28 && dist(i) < 90; };
  const near = seeds.filter(bgLike).length / seeds.length;
  if (near < 0.8) return null;                               // chegarasi bir xil emas — oddiy fon emas
  // Flood fill: shaffof joylar va chegaradagi fonga yaqin piksellardan boshlab
  const isBg = new Uint8Array(N);
  const stack = [];
  for (let i = 0; i < N; i++) {
    const x = i % UB, y = (i / UB) | 0;
    if (A(i) < 40 || ((x === 0 || y === 0 || x === UB - 1 || y === UB - 1) && bgLike(i))) { isBg[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop(); const x = i % UB;
    const nb = [x > 0 ? i - 1 : -1, x < UB - 1 ? i + 1 : -1, i - UB, i + UB];
    for (const j of nb) {
      if (j < 0 || j >= N || isBg[j]) continue;
      if (A(j) < 40 || dist(j) < TOL) { isBg[j] = 1; stack.push(j); continue; }
      // Fon yorug'ligi asta o'zgaradi (chetda kulrangroq, o'rtada oqroq): qo'shni piksel bilan deyarli bir xil,
      // och va rangsiz bo'lsa — u ham fon. Mahsulot chegarasida keskin farq bo'lgani uchun ichiga o'tmaydi.
      const dn = Math.hypot(rgba[j * 4] - rgba[i * 4], rgba[j * 4 + 1] - rgba[i * 4 + 1], rgba[j * 4 + 2] - rgba[i * 4 + 2]);
      const mx = Math.max(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]), mn = Math.min(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]);
      if (dn < 7 && mx > 160 && mx - mn < 30) { isBg[j] = 1; stack.push(j); }
    }
  }
  let visible0 = 0; for (let i = 0; i < N; i++) if (A(i) >= 40) visible0++;
  // AI niqobi bilan tekshirish: (1) mahsulotning och/kumush qismi fon deb o'chib ketgan bo'lsa — AI aniq "mahsulot"
  // degan joylar tiklanadi (soat korpusi "titilib" qolmaydi); (2) qolgan och tekis joyni AI aniq "fon" desa —
  // u ham olib tashlanadi (quloqchin halqasi ichidagi oq dog'). Niqob bo'lmasa — avvalgidek.
  let ai = null, fix = { restored: 0, removed: 0, agree: null };
  if (aiMask && !split) {
    try {
      const flat = await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${UB}x${UB}`, '-i', 'pipe:0', '-f', 'lavfi', '-i', `color=c=white:s=${UB}x${UB}`,
        '-filter_complex', '[1][0]overlay=format=auto,format=rgb24', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], rgba);
      const m = await aiMask(flat);
      if (m && m.length >= 320 * 320) ai = m;
    } catch (_) { ai = null; }
  }
  if (ai) {
    const S = 320, R = 2;
    const lo = Buffer.alloc(S * S), hi = Buffer.alloc(S * S);   // eroziya (aniq mahsulot) va kengaytirish (aniq fon)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let a = 255, b = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const v = ai[Math.min(S - 1, Math.max(0, y + dy)) * S + Math.min(S - 1, Math.max(0, x + dx))];
        if (v < a) a = v; if (v > b) b = v;
      }
      lo[y * S + x] = a; hi[y * S + x] = b;
    }
    const at = (buf, i) => { const x = i % UB, y = (i / UB) | 0; return buf[Math.min(S - 1, (y * S / UB) | 0) * S + Math.min(S - 1, (x * S / UB) | 0)]; };
    for (let i = 0; i < N; i++) {
      if (A(i) < 200) continue;
      if (isBg[i]) { if (at(lo, i) > 200) { isBg[i] = 0; fix.restored++; } }
      else if (bgLike(i) && at(hi, i) < 30) { isBg[i] = 1; fix.removed++; }
    }
  }
  // Mahsulot ichida qolgan fon "orol"lari (quloqchin halqasi ichi): rangi fon rangiga yaqin, soya bilan bir oz
  // o'zgaradi, lekin chetdagi fonga tutashmagan. AI ham "mahsulot" demasa va mahsulotning katta qismi bo'lmasa — olinadi.
  if (!split) {
    let prod = 0; for (let i = 0; i < N; i++) if (!isBg[i] && A(i) >= 40) prod++;
    const seen = new Uint8Array(N);
    const light = j => { const r = rgba[j * 4], g = rgba[j * 4 + 1], b = rgba[j * 4 + 2]; const mx = Math.max(r, g, b); return mx > 150 && mx - Math.min(r, g, b) < 30; };
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || isBg[s0] || A(s0) < 200 || dist(s0) > TOL * 0.7) continue;
      const comp = [s0]; seen[s0] = 1; let dsum = 0, asum = 0, big = false;
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k], x = i % UB; dsum += dist(i);
        if (ai) { const y = (i / UB) | 0; asum += ai[Math.min(319, (y * 320 / UB) | 0) * 320 + Math.min(319, (x * 320 / UB) | 0)]; }
        if (comp.length > prod * 0.4) { big = true; break; }
        for (const j of [x > 0 ? i - 1 : -1, x < UB - 1 ? i + 1 : -1, i - UB, i + UB]) {
          if (j < 0 || j >= N || seen[j] || isBg[j] || A(j) < 200) continue;
          const dn = Math.hypot(rgba[j * 4] - rgba[i * 4], rgba[j * 4 + 1] - rgba[i * 4 + 1], rgba[j * 4 + 2] - rgba[i * 4 + 2]);
          if (dist(j) < TOL || (dn < 7 && light(j))) { seen[j] = 1; comp.push(j); }
        }
      }
      if (big) { for (let k = 0; k < comp.length; k++) seen[comp[k]] = 1; continue; }
      const n = comp.length;
      if (n < N * 0.002 || dsum / n > 24 || (ai && asum / n > 160)) continue;
      for (const i of comp) isBg[i] = 1;
      fix.islands = (fix.islands || 0) + 1;
    }
  }
  for (let i = 0; i < N; i++) if (isBg[i]) rgba[i * 4 + 3] = 0;
  if (split) return splitViews(rgba, UB, UB);
  keepMainObject(rgba, UB, UB);
  for (let i = 0; i < N; i++) if (rgba[i * 4 + 3] === 0) isBg[i] = 1;
  // Natija: fon shaffof, chegarada silliq o'tish; mahsulot chegarasi (bbox)
  let x0 = UB, y0 = UB, x1 = -1, y1 = -1, solid = 0;
  for (let i = 0; i < N; i++) {
    if (isBg[i]) { rgba[i * 4 + 3] = 0; continue; }
    const x = i % UB, y = (i / UB) | 0;
    const touches = (x > 0 && isBg[i - 1]) || (x < UB - 1 && isBg[i + 1]) || (y > 0 && isBg[i - UB]) || (y < UB - 1 && isBg[i + UB]);
    if (touches) rgba[i * 4 + 3] = Math.round(A(i) * Math.min(1, Math.max(0.25, (dist(i) - TOL * 0.5) / TOL)));
    if (rgba[i * 4 + 3] > 190) { solid++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const removed = 1 - solid / Math.max(1, visible0);
  if (x1 < 0 || solid < N * 0.01 || removed < 0.08) return null;   // fon deyarli yo'q yoki mahsulot topilmadi
  const pad = 12;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(UB - 1, x1 + pad); y1 = Math.min(UB - 1, y1 + pad);
  const encode = buf => ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${UB}x${UB}`, '-i', 'pipe:0', '-frames:v', '1',
    '-vf', `crop=${x1 - x0 + 1}:${y1 - y0 + 1}:${x0}:${y0}`, '-c:v', 'libwebp', '-lossless', '0', '-quality', '92', '-f', 'webp', 'pipe:1'], buf);
  const webp = await encode(rgba);
  // Mahsulot bilan o'ralgan ichki "teshik"lar (quloqchin halqasi, ruchka orasi) — fonga o'xshash tekis och joylar.
  // Bu mahsulotning oq qismi ham bo'lishi mumkin, shuning uchun alohida variant: qaysi biri yaxshi — tekshiruvchi tanlaydi.
  let holesBuffer = null, autoHoles = 0;
  {
    const lum = i => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const cand = i => rgba[i * 4 + 3] > 200 && Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 160 && Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) - Math.min(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) < 28;
    const seen = new Uint8Array(N), copy = Buffer.from(rgba);
    let found = 0;
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || !cand(s0)) continue;
      const comp = [s0]; seen[s0] = 1; let sum = 0, sum2 = 0, ok = true;
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k], x = i % UB; const L = lum(i); sum += L; sum2 += L * L;
        for (const j of [x > 0 ? i - 1 : -1, x < UB - 1 ? i + 1 : -1, i - UB, i + UB]) {
          if (j < 0 || j >= N || seen[j]) continue;
          if (cand(j) && Math.abs(lum(j) - L) < 7) { seen[j] = 1; comp.push(j); }
        }
        if (comp.length > N * 0.25) { ok = false; break; }
      }
      const n = comp.length, mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      if (!ok || n < N * 0.0015 || sd > 8) continue;
      for (const i of comp) copy[i * 4 + 3] = 0;
      found++;
      // AI ham "fon" desa (o'rtacha ehtimol past) — bu aniq teshik, asosiy natijada ham olib tashlanadi
      if (ai) {
        let t = 0; for (const i of comp) { const x = i % UB, y = (i / UB) | 0; t += ai[Math.min(319, (y * 320 / UB) | 0) * 320 + Math.min(319, (x * 320 / UB) | 0)]; }
        if (t / n < 110) {
          for (const i of comp) rgba[i * 4 + 3] = 0;
          // Teshik chetidagi och "hoshiya" (silliqlangan o'tish piksellari) ham olinadi
          for (const i of comp) {
            const x = i % UB, y = (i / UB) | 0;
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
              const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= UB || yy >= UB) continue;
              const j = yy * UB + xx; if (!rgba[j * 4 + 3]) continue;
              const mx = Math.max(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]), mn = Math.min(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]);
              if (mx > 120 && mx - mn < 30) rgba[j * 4 + 3] = 0;
            }
          }
          autoHoles++;
        }
      }
    }
    if (found) holesBuffer = await encode(copy);
  }
  const buffer = autoHoles ? await encode(rgba) : webp;
  // AI bilan qanchalik mos (IoU): juda past bo'lsa — natija shubhali
  if (ai) {
    let inter = 0, uni = 0;
    for (let i = 0; i < N; i++) {
      const x = i % UB, y = (i / UB) | 0;
      const a = rgba[i * 4 + 3] > 128, b = ai[Math.min(319, (y * 320 / UB) | 0) * 320 + Math.min(319, (x * 320 / UB) | 0)] > 128;
      if (a && b) inter++; if (a || b) uni++;
    }
    fix.agree = uni ? +(inter / uni).toFixed(3) : null;
  }
  return { buffer, holesBuffer: autoHoles ? null : holesBuffer, coverage: solid / N, bg, ai: ai ? { ...fix, autoHoles } : null };
}

// Kollaj bo'lsa — ko'rinishlar ro'yxati (≥2), aks holda null
async function splitCollage(input) { return removeUniformBackground(input, { split: true }); }

module.exports = { removeBackground, removeUniformBackground, saliency, splitCollage, heightMap, available: () => !!FFMPEG };
