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

module.exports = { removeBackground, available: () => !!FFMPEG };
