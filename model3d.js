// ===== HAQIQIY 3D MODEL (TRELLIS, Hugging Face) + GEMINI SIFAT NAZORATI =====
// 1) Gemini mahsulot surati 3D uchun yaroqliligini tekshiradi (bitta, aniq mahsulotmi).
// 2) Microsoft TRELLIS (MIT litsenziya) Hugging Face Space'da suratdan .glb model yasaydi.
// 3) TRELLIS bergan 360° videoni Gemini ko'rib, 1–10 baho beradi. Past bo'lsa — boshqa seed
//    bilan yana bir urinish, eng yaxshisi olinadi. 7 dan past bo'lsa mijozga ko'rsatilmaydi.
// Har bir mahsulot uchun bir marta, navbat bilan; natija diskda saqlanadi.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SPACES = ['trellis-community/TRELLIS', 'JeffreyXiang/TRELLIS'];
// TRELLIS ishlamasa (Space o'chgan / limit) — boshqa ochiq kodli modellar (GitHub: Tencent Hunyuan3D-2, Stability AI SF3D/TripoSR).
// Ularning API'si har xil, shuning uchun endpoint va parametrlar Space'ning o'zidan (view_api) avtomatik aniqlanadi.
const FALLBACK_SPACES = ['tencent/Hunyuan3D-2mv', 'tencent/Hunyuan3D-2', 'stabilityai/stable-fast-3d', 'stabilityai/TripoSR'];
const isQuota = m => /quota|zerogpu|exceeded|rate.?limit|too many|gpu.{0,20}(limit|time)/i.test(String(m));
const isDown = m => /\b50[234]\b|sleeping|paused|not running|runtime error|could not resolve app config|fetch failed|ECONN|ENOTFOUND|timeout/i.test(String(m));
const PASS_SCORE = 7;
const MAX_TRIES = 3;                 // bitta rasm uchun jami muvaffaqiyatsiz urinishlar
const RETRY_FAILED_MS = 24 * 3600e3; // xatodan keyin qayta urinish
const SWEEP_MS = 10 * 60e3;

function createModel3D({ dir, getProducts, imageKey, loadImageSource, loadImages, gemini, onChange, notify, loadGradio = () => import('@gradio/client') }) {
  const STATE_FILE = path.join(dir, 'models3d.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { state = {}; }
  let busy = false, pausedUntil = 0, timer = null, current = null;

  const token = () => (process.env.HF_TOKEN || '').trim();
  const spaces = () => (process.env.TRELLIS_SPACE ? [process.env.TRELLIS_SPACE] : DEFAULT_SPACES);
  const save = () => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { console.warn('🧊 3D holatini saqlab bo\'lmadi:', e.message); }
  };
  const set = (pid, patch) => { state[pid] = { ...(state[pid] || {}), ...patch, updatedAt: Date.now() }; save(); try { onChange && onChange(pid); } catch (_) {} };
  const glbPath = (pid, key) => path.join(dir, `${String(pid).replace(/[^\w-]/g, '_')}_${key}.glb`);

  // Mijozga ko'rsatish mumkinmi (rasm o'zgarmagan, sifat o'tgan yoki admin tasdiqlagan, yashirilmagan)
  function publicInfo(p) {
    const k = imageKey(p); const s = state[p.id];
    if (!k || !s || s.key !== k || !s.file || s.hidden) return null;
    const ok = s.status === 'ready' || s.approved === true;
    if (!ok) return null;
    return `/api/model3d/${encodeURIComponent(p.id)}.glb?v=${k.slice(-12)}`;
  }
  function fileFor(pid) {
    const s = state[pid];
    if (!s || !s.file) return null;
    const f = path.join(dir, s.file);
    return fs.existsSync(f) ? f : null;
  }

  // ---- Gemini ----
  async function askGemini(parts) {
    if (!gemini) return null;
    const r = await gemini(parts, { json: true }).catch(e => ({ error: e.message }));
    if (!r || r.error || !r.text) return null;
    try { return JSON.parse(String(r.text).replace(/^```(?:json)?|```$/gm, '').trim()); } catch (_) { return null; }
  }
  async function precheck(img, mime, p) {
    return askGemini([
      { inline_data: { mime_type: mime, data: img.toString('base64') } },
      { text: `Bu internet-do'kondagi "${p.name}" mahsulotining surati. Undan bitta rasmdan 3D model yasaymiz. ` +
        `Rasm yaroqlimi: mahsulot bitta, to'liq ko'rinadi, qirqilmagan, ustida katta yozuv/logotip/kollaj yo'q, qo'l yoki boshqa narsalar to'smagan? ` +
        `Faqat JSON qaytar: {"suitable": true|false, "reason": "qisqa sabab o'zbekcha"}` },
    ]);
  }
  async function judge(img, mime, video, p) {
    return askGemini([
      { text: 'Asl mahsulot surati:' },
      { inline_data: { mime_type: mime, data: img.toString('base64') } },
      { text: "Shu suratdan AI yasagan 3D modelning 360° aylanish videosi (chapda rangli, o'ngda geometriya):" },
      { inline_data: { mime_type: 'video/mp4', data: video.toString('base64') } },
      { text: `Mahsulot: "${p.name}". 3D modelni qat'iy baholang, xuddi xaridorga ko'rsatiladigandek: ` +
        `asl suratga o'xshashligi, shakl qiyshiq/egri/erigan emasligi, teshik yoki ortiqcha bo'laklar yo'qligi, ` +
        `rang va teksturalar tiniqligi (xira emasligi), yon va orqa tomoni tabiiyligi. ` +
        `Faqat JSON qaytar: {"score": 1-10 butun son, "issues": "asosiy kamchiliklar o'zbekcha, qisqa"}` },
    ]);
  }

  // ---- TRELLIS ----
  const findFile = (data, re) => {
    let found = null;
    const walk = v => {
      if (found || v == null) return;
      if (typeof v === 'string') { if (re.test(v.split('?')[0])) found = v; return; }
      if (Array.isArray(v)) return v.forEach(walk);
      if (typeof v === 'object') {
        const u = v.url || v.path;
        if (typeof u === 'string' && re.test(u.split('?')[0]) && v.url) { found = v.url; return; }
        Object.values(v).forEach(walk);
      }
    };
    walk(data);
    return found;
  };
  async function download(url) {
    const r = await fetch(url, { headers: token() ? { Authorization: `Bearer ${token()}` } : {}, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('yuklab bo\'lmadi: ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  // Endpoint parametrlarini nomi bo'yicha to'ldiramiz (Space versiyasi o'zgarsa ham ishlashi uchun)
  function argsFor(info, values) {
    const params = (info && info.parameters) || [];
    if (!params.length) return values;
    const out = {};
    for (const prm of params) {
      const n = prm.parameter_name || prm.label;
      if (n in values) out[n] = values[n];
      else if (prm.parameter_has_default) out[n] = prm.parameter_default;
    }
    return out;
  }
  // imgs — mahsulotning haqiqiy suratlari (old, orqa, yonlar). 2 va undan ko'p bo'lsa — TRELLIS "ko'p rasm" rejimi:
  // model barcha tomonlarni ko'radi va orqa/yon tomonlarni taxmin qilmaydi.
  async function trellis(imgs, seed) {
    const { Client, handle_file } = await loadGradio();
    imgs = (Array.isArray(imgs) ? imgs : [imgs]).filter(Boolean).slice(0, 4);
    const img = imgs[0];
    let lastErr = null;
    for (const space of spaces()) {
      try {
        const app = await Client.connect(space, { token: token(), events: ['data', 'status'] });
        const api = await app.view_api();
        const ep = api.named_endpoints || {};
        if (!ep['/image_to_3d'] || !ep['/extract_glb']) throw new Error(`${space}: kerakli API yo'q`);
        if (ep['/start_session']) await app.predict('/start_session', {}).catch(() => {});
        const prep = async b => {
          let im = handle_file(new Blob([b]));
          if (ep['/preprocess_image']) im = (await app.predict('/preprocess_image', argsFor(ep['/preprocess_image'], { image: im }))).data[0];
          return im;
        };
        const params = (ep['/image_to_3d'].parameters || []).map(x => x.parameter_name || x.label);
        const canMulti = imgs.length >= 2 && (!params.length || params.includes('multiimages'));
        let gen = null;
        if (canMulti) {
          try {
            const processed = [];
            for (const b of imgs) processed.push(await prep(b));
            gen = await app.predict('/image_to_3d', argsFor(ep['/image_to_3d'], {
              image: processed[0], multiimages: processed.map(im => ({ image: im, caption: null })), is_multiimage: true, seed,
              ss_guidance_strength: 7.5, ss_sampling_steps: 12, slat_guidance_strength: 3, slat_sampling_steps: 12,
              multiimage_algo: 'stochastic', randomize_seed: false,
            }));
            console.log(`🧊 TRELLIS: ${imgs.length} ta rasmdan (ko'p rasm rejimi)`);
          } catch (e) {
            if (isQuota(String(e && (e.message || e)))) throw e;
            console.warn("🧊 TRELLIS ko'p rasm rejimi ishlamadi, bitta rasm bilan:", String(e && (e.message || e)).slice(0, 200));
            gen = null;
          }
        }
        if (!gen) {
          gen = await app.predict('/image_to_3d', argsFor(ep['/image_to_3d'], {
            image: await prep(img), multiimages: [], is_multiimage: false, seed,
            ss_guidance_strength: 7.5, ss_sampling_steps: 12, slat_guidance_strength: 3, slat_sampling_steps: 12,
            multiimage_algo: 'stochastic', randomize_seed: false,
          }));
        }
        const videoUrl = findFile(gen.data, /\.mp4$/i);
        const glbOut = await app.predict('/extract_glb', argsFor(ep['/extract_glb'], { mesh_simplify: 0.95, texture_size: 1024 }));
        const glbUrl = findFile(glbOut.data, /\.glb$/i);
        if (!glbUrl) throw new Error(`${space}: .glb qaytmadi`);
        const glb = await download(glbUrl);
        if (glb.length < 1000 || glb.slice(0, 4).toString() !== 'glTF') throw new Error('GLB fayl buzuq');
        const video = videoUrl ? await download(videoUrl).catch(() => null) : null;
        return { glb, video, space, views: canMulti && gen ? imgs.length : 1 };
      } catch (e) {
        lastErr = e;
        const msg = String(e && (e.message || e));
        console.warn(`🧊 TRELLIS (${space}):`, msg.slice(0, 300));
        if (isQuota(msg)) { const err = new Error(msg); err.quota = true; throw err; }
      }
    }
    throw lastErr || new Error('TRELLIS ishlamadi');
  }

  // ---- Boshqa ochiq modellar (Hunyuan3D-2 / -2mv, Stable Fast 3D, TripoSR) ----
  const PREFERRED_EPS = ['/generation_all', '/shape_generation', '/run_button', '/generate', '/run', '/predict', '/image_to_3d'];
  const prmName = x => String(x.parameter_name || x.label || '').toLowerCase();
  const isImageParam = x => /image/i.test(String(x.component || '')) || /image/.test(prmName(x));
  async function otherSpace(space, imgs, seed) {
    const { Client, handle_file } = await loadGradio();
    const app = await Client.connect(space, { token: token(), events: ['data', 'status'] });
    const api = await app.view_api();
    const eps = api.named_endpoints || {};
    let name = PREFERRED_EPS.find(n => eps[n] && (eps[n].parameters || []).some(isImageParam));
    if (!name) name = Object.keys(eps).find(n => (eps[n].parameters || []).some(isImageParam));
    if (!name) throw new Error(`${space}: rasm qabul qiladigan API topilmadi`);
    const views = { front: imgs[0], back: imgs[1], left: imgs[2], right: imgs[3] };
    const file = b => (b ? handle_file(new Blob([b])) : null);
    let usedViews = 1;
    const args = (eps[name].parameters || []).map(x => {
      const n = prmName(x);
      if (isImageParam(x)) {
        const side = ['back', 'left', 'right', 'front'].find(k => n.includes(k));
        if (side && side !== 'front') { if (views[side]) usedViews++; return file(views[side]); }
        return file(views.front);
      }
      if (/seed/.test(n) && !/random/.test(n)) return seed;
      if (/random/.test(n)) return false;
      if (/rembg|remove|backgr|\bbg\b/.test(n)) return true;
      if (/caption|prompt|text/.test(n)) return x.parameter_has_default ? x.parameter_default : '';
      return x.parameter_has_default ? x.parameter_default : null;
    });
    const out = await app.predict(name, args);
    // Bir nechta .glb qaytsa (Hunyuan3D: oq shakl + teksturali) — teksturalisi olinadi
    const all = [];
    const walk = v => { if (v == null) return; if (typeof v === 'string') { if (/\.glb$/i.test(v.split('?')[0])) all.push(v); return; }
      if (Array.isArray(v)) return v.forEach(walk); if (typeof v === 'object') { if (typeof v.url === 'string' && /\.glb$/i.test(v.url.split('?')[0])) { all.push(v.url); return; } Object.values(v).forEach(walk); } };
    walk(out.data);
    const glbUrl = all.find(u => /textur|color|paint/i.test(u)) || all[all.length - 1];
    if (!glbUrl) throw new Error(`${space}: .glb qaytmadi`);
    const glb = await download(glbUrl);
    if (glb.length < 1000 || glb.slice(0, 4).toString() !== 'glTF') throw new Error(`${space}: GLB fayl buzuq`);
    console.log(`🧊 ${space} (${name}): model yasaldi, ${usedViews} ta rasmdan`);
    return { glb, video: null, space, views: usedViews };
  }

  // Navbat bilan: TRELLIS → Hunyuan3D-2mv (2+ rasm bo'lsa) → Hunyuan3D-2 → SF3D → TripoSR.
  // Hammasi limitga yetsa — kutish rejimi; boshqa xatolarda keyingisiga o'tiladi.
  async function generate(imgs, seed) {
    imgs = (Array.isArray(imgs) ? imgs : [imgs]).filter(Boolean).slice(0, 4);
    const errors = []; let quotaHits = 0, tried = 0;
    const custom = (process.env.MODEL3D_SPACES || '').split(',').map(x => x.trim()).filter(Boolean);
    try { tried++; return await trellis(imgs, seed); }
    catch (e) { if (e && e.quota) quotaHits++; errors.push('TRELLIS: ' + String(e && e.message || e).slice(0, 120)); }
    const others = (custom.length ? custom : FALLBACK_SPACES).filter(sp => !(/2mv/i.test(sp) && imgs.length < 2));
    for (const sp of others) {
      tried++;
      try { return await otherSpace(sp, imgs, seed); }
      catch (e) {
        const msg = String(e && (e.message || e));
        console.warn(`🧊 ${sp}:`, msg.slice(0, 300));
        if (isQuota(msg)) quotaHits++;
        errors.push(`${sp.split('/').pop()}: ${msg.slice(0, 100)}`);
      }
    }
    const err = new Error(errors.join(' | ').slice(0, 600));
    if (quotaHits && quotaHits >= Math.ceil(tried / 2)) err.quota = true;
    throw err;
  }

  // Adminga natija haqida xabar (bot orqali)
  // Faqat admin o'zi qo'shgan/rasmini o'zgartirgan yoki "Qayta yasash" bosgan mahsulotlar haqida yoziladi —
  // eski mahsulotlar fonda jim tekshiriladi (natijasi Admin → Mahsulotlar → 3D modellar'da ko'rinadi)
  function tell(text, pid) {
    if (pid != null) { if (!state[pid] || !state[pid].notify) return; set(pid, { notify: false }); }
    try { notify && Promise.resolve(notify(text)).catch(() => {}); } catch (_) {}
  }
  function watch(pid) { set(pid, { notify: true }); }
  let lastQuotaTell = 0;

  // ---- Bitta mahsulot ----
  async function build(p, { force = false } = {}) {
    const key = imageKey(p);
    if (!key) return;
    const prev = state[p.id] || {};
    const tries = prev.key === key ? (prev.tries || 0) : 0;
    current = p.id;
    set(p.id, { key, status: 'working', error: null, tries, hidden: prev.key === key ? prev.hidden : false, approved: prev.key === key ? prev.approved : null });
    try {
      // Barcha rasmlar (kollaj bo'lsa — ajratilgan ko'rinishlar); tekshiruv birinchi ko'rinish bo'yicha
      let all = null;
      if (loadImages) { try { const more = await loadImages(p); if (more && more.length) all = more; } catch (_) {} }
      const src = all ? all[0] : await loadImageSource(p);
      if (!all) all = [src];
      const mime = /^\x89PNG/.test(src.slice(0, 4).toString('latin1')) ? 'image/png' : /^RIFF/.test(src.slice(0, 4).toString()) ? 'image/webp' : 'image/jpeg';
      if (!force) {
        const pc = await precheck(src, mime, p);
        if (pc && pc.suitable === false) {
          set(p.id, { status: 'unsuitable', reason: String(pc.reason || '').slice(0, 300), tries: MAX_TRIES });
          tell(`🧊 "${p.name}" — rasm 3D model uchun yaroqsiz: ${pc.reason || ''}\nBoshqa rasm yuboring (oq fonda, mahsulot to'liq, 4 tomondan) yoki Admin → Mahsulotlar → 3D modellar'da "Qayta yasash".`, p.id);
          console.log(`🧊 3D (${p.id}) rasm yaroqsiz: ${pc.reason}`);
          return;
        }
      }
      let best = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const seed = attempt === 0 ? 0 : Math.floor(Math.random() * 2147483647);
        const r = await generate(all, seed);
        let verdict = r.video ? await judge(src, mime, r.video, p) : null;
        const score = verdict && Number.isFinite(Number(verdict.score)) ? Math.max(1, Math.min(10, Math.round(Number(verdict.score)))) : null;
        const cand = { ...r, score, issues: verdict ? String(verdict.issues || '').slice(0, 300) : null };
        if (!best || (cand.score || 0) > (best.score || 0)) best = cand;
        console.log(`🧊 3D (${p.id}) urinish ${attempt + 1}: baho ${score ?? '—'} ${cand.issues || ''}`);
        if (score === null || score >= PASS_SCORE + 1) break;  // juda yaxshi yoki baholab bo'lmadi (video faqat TRELLIS'da)
        if (score >= PASS_SCORE && attempt === 0) break;
      }
      const file = path.basename(glbPath(p.id, key.slice(-12)));
      fs.mkdirSync(dir, { recursive: true });
      // Eski fayllarni o'chiramiz
      if (prev.file && prev.file !== file) { try { fs.unlinkSync(path.join(dir, prev.file)); } catch (_) {} }
      fs.writeFileSync(path.join(dir, file), best.glb);
      const status = best.score === null ? 'unchecked' : best.score >= PASS_SCORE ? 'ready' : 'rejected';
      set(p.id, { status, score: best.score, reason: best.issues, file, space: best.space, size: best.glb.length, views: best.views || 1, tries: 0, force: false });
      console.log(`🧊 3D (${p.id}) tayyor: ${status}, baho ${best.score ?? '—'}`);
      const side = ((best.views || 1) > 1 ? `${best.views} tomondan` : 'bitta rasmdan') + `, ${String(best.space || '').split('/').pop()}`;
      tell(status === 'ready'
        ? `🧊 3D model tayyor: "${p.name}" — ${side}, baho ${best.score}/10 ✅\nMijozlar mahsulot sahifasida "3D ko'rinish" tugmasi orqali ko'radi.`
        : status === 'rejected'
          ? `🧊 "${p.name}" uchun 3D model yasaldi, lekin sifati past (${best.score}/10${best.issues ? ': ' + best.issues : ''}) — mijozlarga ko'rsatilmaydi.\nAdmin → Mahsulotlar → 3D modellar'da ko'rib "Ko'rsatish" yoki "Qayta yasash" mumkin.${(best.views || 1) < 4 ? " 4 tomondan rasm qo'shsangiz aniqroq chiqadi." : ''}`
          : `🧊 3D model tayyor: "${p.name}" — ${side}, lekin avtomatik baholanmadi${/trellis/i.test(best.space || '') ? " (Gemini kaliti yo'q)" : ' (bu model 360° video bermaydi)'}.\nAdmin → Mahsulotlar → 3D modellar'da ko'rib "Ko'rsatish" ni bosing.`, p.id);
    } catch (e) {
      if (e && e.quota) {
        if (Date.now() >= pausedUntil && Date.now() - lastQuotaTell > 24 * 3600e3 && state[p.id] && state[p.id].notify) lastQuotaTell = Date.now(), tell(`⏸ 3D model: barcha bepul 3D serverlarda (TRELLIS, Hunyuan3D, SF3D) GPU limiti tugadi yoki ular o'chgan — "${p.name}" navbatda, taxminan 1 soatdan keyin o'zi davom etadi.`);
        pausedUntil = Date.now() + 60 * 60e3;
        set(p.id, { status: 'queued', error: 'GPU limiti tugadi — keyinroq davom etadi' });
      } else {
        set(p.id, { status: 'failed', error: String(e && e.message || e).slice(0, 300), tries: tries + 1 });
        if (tries + 1 >= MAX_TRIES || tries === 0) tell(`⚠️ "${p.name}" uchun 3D model yasab bo'lmadi — barcha bepul 3D serverlar sinab ko'rildi:\n${String(e && e.message || e).slice(0, 400)}${tries + 1 < MAX_TRIES ? (isDown(e && e.message) ? "\nServerlar ishga tushishi bilan (30 daqiqadan keyin) o'zi qayta urinadi." : "\n24 soatdan keyin o'zi qayta urinadi.") : ''}`, p.id);
      }
    } finally {
      current = null;
    }
  }

  function needsWork(p) {
    const key = imageKey(p);
    if (!key) return false;
    const s = state[p.id];
    if (!s || s.key !== key) return true;
    if (s.status === 'queued' || s.status === 'rebuild') return true;
    if (s.status === 'failed' && (s.tries || 0) < MAX_TRIES && Date.now() - (s.updatedAt || 0) > (isDown(s.error) ? 30 * 60e3 : RETRY_FAILED_MS)) return true;
    return false;
  }

  async function sweep() {
    if (busy || !token() || Date.now() < pausedUntil) return;
    busy = true;
    try {
      const list = (await getProducts()).filter(Boolean);
      const next = list.find(p => state[p.id] && state[p.id].status === 'rebuild') || list.find(needsWork);
      if (next) await build(next, { force: state[next.id] && state[next.id].force });
    } catch (e) {
      console.warn('🧊 3D navbati:', e.message);
    } finally {
      busy = false;
    }
    // Navbatda yana ish bo'lsa — darhol keyingisi (limit tugamagan bo'lsa)
    if (Date.now() >= pausedUntil) {
      try { if ((await getProducts()).some(needsWork)) setTimeout(sweep, 5000); } catch (_) {}
    }
  }

  function start(delay = 3 * 60e3) {
    if (timer) return;
    setTimeout(sweep, delay);
    timer = setInterval(sweep, SWEEP_MS);
  }

  async function list() {
    const products = (await getProducts()).filter(Boolean);
    return {
      enabled: !!token(),
      pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
      working: current,
      items: products.map(p => {
        const s = state[p.id] || {};
        const fresh = s.key && s.key === imageKey(p);
        return {
          id: p.id, name: p.name,
          status: !imageKey(p) ? 'noimage' : fresh ? s.status : 'queued',
          score: fresh ? s.score ?? null : null, reason: fresh ? s.reason || null : null, error: fresh ? s.error || null : null,
          hidden: !!(fresh && s.hidden), approved: fresh ? s.approved ?? null : null,
          views: fresh ? s.views || null : null, photos: Array.isArray(p.images) ? p.images.length : (p.image ? 1 : 0),
          visible: !!publicInfo(p),
          preview: fresh && s.file ? `/api/model3d/${encodeURIComponent(p.id)}.glb?v=${String(s.key).slice(-12)}` : null,
        };
      }),
    };
  }

  function action(pid, act) {
    const s = state[pid];
    if (act === 'rebuild') { set(pid, { status: 'rebuild', tries: 0, error: null, force: true, notify: true }); setTimeout(sweep, 1000); return true; }
    if (!s) return false;
    if (act === 'hide') set(pid, { hidden: true });
    else if (act === 'show') set(pid, { hidden: false, approved: true });
    else return false;
    return true;
  }

  return { start, sweep, list, action, publicInfo, fileFor, watch };
}

module.exports = { createModel3D };
