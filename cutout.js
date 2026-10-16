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

async function removeBackground(input, { maxSide = 900 } = {}) {
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
        v = Math.min(1, Math.max(0, (v - 0.12) / 0.76));       // yumshoq chegara
        const b = Math.round(v * 255);
        mask[i] = b;
        if (b > 96) { covered++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
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
        `[0:v]format=rgba[img];[1:v]format=gray[m0];[m0][img]scale2ref=w=iw:h=ih:flags=bicubic[m][img2];` +
        `[img2][m]alphamerge,crop=iw*${(fx1 - fx0).toFixed(4)}:ih*${(fy1 - fy0).toFixed(4)}:iw*${fx0.toFixed(4)}:ih*${fy0.toFixed(4)},` +
        `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
      const webp = await ffmpeg(['-i', 'pipe:0', '-i', tmp + '_m.png', '-filter_complex', filter, '-frames:v', '1',
        '-c:v', 'libwebp', '-lossless', '0', '-quality', '86', '-f', 'webp', 'pipe:1'], input);
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
    const h = new Float32Array(HM * HM);
    for (let i = 0; i < HM * HM; i++) h[i] = mask[i] ? inf[i] * (depth ? 0.3 + 0.7 * depth[i] : 1) : 0;
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

module.exports = { removeBackground, heightMap, available: () => !!FFMPEG };
