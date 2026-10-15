// ===== TELEGRAM BOT: QO'SHIMCHA IMKONIYATLAR =====
// /start (rasmli), /buyurtmalarim, "Yetib keldi" + baho va fikr, mijozlar fikri,
// tashlab ketilgan savat va narx tushishi eslatmalari, kunlik hisobot, /reklama,
// jo'natilmay qolgan buyurtma eslatmasi, bot menyusi.
'use strict';
const fs = require('fs');

const TZ_OFFSET = 5 * 3600e3; // Toshkent (UTC+5)
const DAY = 86400e3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STATUS_LABELS = {
  pending: "⏳ To'lov tekshirilmoqda",
  confirmed: "✅ Tasdiqlandi — jo'natishga tayyorlanmoqda",
  paid: "✅ Tasdiqlandi — jo'natishga tayyorlanmoqda",
  shipped: "🚚 Yo'lda (BTS pochta)",
  delivered: '📬 Yetib keldi',
  rejected: '❌ Rad etildi',
};

function tashkentDate(ts = Date.now()) {
  const d = new Date(ts + TZ_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), key: d.toISOString().slice(0, 10) };
}
function dayStart(ts = Date.now()) {
  return Math.floor((ts + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
}
function fmtDate(ts) {
  if (!ts) return '';
  const t = tashkentDate(ts);
  return `${String(t.d).padStart(2, '0')}.${String(t.m).padStart(2, '0')}.${t.y}`;
}

function createBotFeatures(deps) {
  const {
    firebaseGet, firebasePatch, firebaseDelete, getProducts, updateProduct,
    escHtml, fmtSom, getBot, getAdminIds, getAppUrl, getChannel, getAssistantContact,
    welcomeImagePath,
  } = deps;

  const states = new Map();          // chatId -> { type, ... }
  const priceAlertAt = new Map();    // productId -> ts (spam bo'lmasin)
  const counters = { day: '', cartReminders: 0, priceAlerts: 0, reviews: 0 };
  let welcomeFileId = null;
  let lastReportKey = null;

  // Bazadagi matnlar "<" va ">" ni &lt; &gt; ko'rinishida saqlaydi — ikki marta kodlanmasin
  const esc = (v) => escHtml(String(v ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  const bot = () => getBot();
  const isAdmin = (id) => getAdminIds().includes(String(id));
  const shopButton = (text = "🛍 Do'konni ochish", query = '') => ({ text, web_app: { url: getAppUrl() + query } });
  function resetCountersIfNewDay() {
    const k = tashkentDate().key;
    if (counters.day !== k) { counters.day = k; counters.cartReminders = 0; counters.priceAlerts = 0; counters.reviews = 0; }
  }
  function bump(key) {
    resetCountersIfNewDay();
    counters[key]++;
  }

  // Telegram 429 (juda tez) bo'lsa kutib qayta urinadi
  async function safeSend(fn) {
    for (let i = 0; i < 3; i++) {
      try { return await fn(); } catch (e) {
        const retry = e.response?.body?.parameters?.retry_after;
        if (retry && i < 2) { await sleep((retry + 1) * 1000); continue; }
        throw e;
      }
    }
  }

  // ---------- /start ----------
  async function sendWelcome(chatId, firstName) {
    const b = bot();
    if (!b) return;
    const contact = getAssistantContact();
    const channel = getChannel();
    const keyboard = [
      [shopButton()],
      [{ text: '📦 Buyurtmalarim', callback_data: 'myorders' }],
    ];
    if (contact?.link) keyboard.push([{ text: "💬 Yordamchi bilan gaplashish", url: contact.link }]);
    if (channel) keyboard.push([{ text: '📢 Kanalimizga obuna bo\'ling', url: `https://t.me/${channel}` }]);
    const caption =
      `👋 Salom, <b>${esc(firstName || 'do\'stim')}</b>!\n\n` +
      `🛒 <b>TechStore</b> — original texnika onlayn do'koni.\n\n` +
      `📱 Smartfonlar, 💻 noutbuklar, 🎧 quloqchinlar va boshqalar\n` +
      `🚚 O'zbekiston bo'ylab BTS pochta orqali yetkazib berish\n` +
      `🔒 Xavfsiz to'lov va har bir buyurtma kuzatuvi\n\n` +
      `Do'konni ochish uchun pastdagi tugmani bosing 👇`;
    const opts = { caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    try {
      const photo = welcomeFileId || (welcomeImagePath && fs.existsSync(welcomeImagePath) ? fs.createReadStream(welcomeImagePath) : null);
      if (!photo) throw new Error('rasm yo\'q');
      const m = await b.sendPhoto(chatId, photo, opts, { filename: 'welcome.jpg', contentType: 'image/jpeg' });
      if (!welcomeFileId && m?.photo?.length) welcomeFileId = m.photo[m.photo.length - 1].file_id;
    } catch (e) {
      await b.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
    }
  }

  // ---------- /buyurtmalarim ----------
  async function userOrders(userId) {
    const all = (await firebaseGet('orders')) || {};
    return Object.entries(all)
      .filter(([, o]) => o && String(o.userId) === String(userId))
      .map(([id, o]) => ({ id, ...o }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function sendMyOrders(chatId, userId) {
    const b = bot();
    if (!b) return;
    const list = await userOrders(userId);
    if (!list.length) {
      return b.sendMessage(chatId, "📦 Sizda hali buyurtmalar yo'q.\n\nDo'konimizdan o'zingizga yoqqan texnikani tanlang 👇", {
        reply_markup: { inline_keyboard: [[shopButton()]] },
      });
    }
    const shown = list.slice(0, 5);
    const lines = shown.map(o =>
      `<b>${esc(o.orderNum || '#' + o.id)}</b> · ${fmtDate(o.createdAt)}\n` +
      `🛍 ${esc(o.products || 'Mahsulot')}\n` +
      `💰 ${fmtSom(o.total)}\n` +
      `${STATUS_LABELS[o.status] || STATUS_LABELS.pending}`);
    const keyboard = shown
      .filter(o => o.status === 'shipped')
      .map(o => [{ text: `✅ ${o.orderNum || '#' + o.id} yetib keldi`, callback_data: `arrived:${o.id}` }]);
    keyboard.push([shopButton()]);
    await b.sendMessage(chatId,
      `📦 <b>Buyurtmalaringiz</b>${list.length > 5 ? ` (oxirgi 5 tasi, jami ${list.length})` : ''}\n\n${lines.join('\n\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }

  // Jo'natilgandan keyin xaridorga "Yetib keldi" tugmasi (bot orqali)
  async function sendArrivedPrompt(order, orderId) {
    const b = bot();
    if (!b || !order?.userId) return false;
    try {
      await b.sendMessage(order.userId,
        `📬 Buyurtmangiz <b>${esc(order.orderNum || '#' + orderId)}</b> qo'lingizga yetib kelgach, pastdagi tugmani bosing — mahsulotni baholab, fikringizni qoldirasiz 🙏`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Buyurtma yetib keldi', callback_data: `arrived:${orderId}` }]] } });
      return true;
    } catch (_) { return false; }
  }

  // ---------- Yetib keldi → baho → fikr ----------
  async function markDelivered(order, orderId) {
    if (order.status === 'delivered') return false;
    await firebasePatch(`orders/${orderId}`, { status: 'delivered', fulfillment: { ...(order.fulfillment || {}), deliveredAt: Date.now() } });
    const b = bot();
    if (b) {
      for (const id of getAdminIds()) {
        b.sendMessage(id, `📬 <b>${esc(order.orderNum || '#' + orderId)}</b> xaridorga yetib keldi (${esc(order.userName || '')}).`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
    return true;
  }

  async function onArrived(query, orderId) {
    const b = bot();
    const order = await firebaseGet(`orders/${orderId}`);
    if (!order || String(order.userId) !== String(query.from.id)) {
      return b.answerCallbackQuery(query.id, { text: 'Buyurtma topilmadi', show_alert: true });
    }
    if (order.status === 'delivered' && order.review) {
      return b.answerCallbackQuery(query.id, { text: 'Rahmat! Siz allaqachon fikr qoldirgansiz 💜', show_alert: true });
    }
    await markDelivered(order, orderId);
    await b.answerCallbackQuery(query.id, { text: 'Ajoyib! 🎉' });
    b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    await b.sendMessage(query.message.chat.id,
      `🎉 Xaridingiz muborak bo'lsin!\n\n<b>${esc(order.products || 'Mahsulot')}</b> sizga qanchalik yoqdi? Baholang 👇`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: `${n}⭐`, callback_data: `rate:${orderId}:${n}` }))] } });
  }

  async function onRate(query, orderId, rating) {
    const b = bot();
    const order = await firebaseGet(`orders/${orderId}`);
    if (!order || String(order.userId) !== String(query.from.id)) {
      return b.answerCallbackQuery(query.id, { text: 'Buyurtma topilmadi', show_alert: true });
    }
    if (order.review) return b.answerCallbackQuery(query.id, { text: 'Siz allaqachon baho bergansiz 💜', show_alert: true });
    states.set(String(query.message.chat.id), { type: 'review', orderId, rating, at: Date.now() });
    await b.answerCallbackQuery(query.id, { text: '⭐'.repeat(rating) });
    b.editMessageText(`Bahoingiz: ${'⭐'.repeat(rating)}`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    await b.sendMessage(query.message.chat.id,
      `📸 Endi mahsulot rasmini va qisqa fikringizni yuboring (rasm + izoh bitta xabarda bo'lsa yaxshi).\n\nFikrsiz yakunlash: /skip`);
  }

  async function productIdsOfOrder(order) {
    if (Array.isArray(order.items) && order.items.length) return [...new Set(order.items.map(i => String(i.id)))];
    const names = String(order.products || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const list = await getProducts();
    return list.filter(p => names.includes(String(p.name).trim().toLowerCase())).map(p => String(p.id));
  }

  // Fikrni saqlash (bot va Mini App uchun umumiy). photoFileId — Telegram fayli, photoData — data:image/... (Mini App)
  async function addReview({ order, orderId, userId, name, rating, text, photoFileId = null, photoData = null }) {
    const b = bot();
    rating = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
    text = String(text || '').trim().slice(0, 1000);
    const review = {
      userId: String(userId || ''), name: String(name || 'Xaridor').slice(0, 60), rating, text,
      photoFileId, photoData, orderId, createdAt: Date.now(),
    };
    const pids = await productIdsOfOrder(order);
    const rid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    for (const pid of pids) {
      await firebasePatch(`reviews/${pid}`, { [rid]: review });
      // Mahsulot reytingi va sharhlar soni yangilanadi
      try {
        const p = (await getProducts()).find(x => String(x.id) === pid);
        if (p) {
          const cnt = Number(p.reviews) || 0;
          const avg = Number(p.rating) || 0;
          const nextCnt = cnt + 1;
          const nextAvg = Math.round(((avg * cnt + rating) / nextCnt) * 10) / 10;
          await updateProduct(pid, { rating: nextAvg, reviews: nextCnt });
        }
      } catch (e) { console.warn('Reytingni yangilab bo\'lmadi:', e.message); }
    }
    await firebasePatch(`orders/${orderId}`, { review: { rating, text, hasPhoto: !!(photoFileId || photoData), at: Date.now() } });
    bump('reviews');
    if (b) {
      const adminText = `⭐ <b>Yangi fikr</b> — ${esc(order.orderNum || '#' + orderId)}\n👤 ${esc(review.name)}\n${'⭐'.repeat(rating)}\n🛍 ${esc(order.products || '')}${text ? `\n\n💬 ${esc(text)}` : ''}`;
      const m = photoData && String(photoData).match(/^data:image\/[a-z+]+;base64,(.+)$/i);
      for (const id of getAdminIds()) {
        if (photoFileId) b.sendPhoto(id, photoFileId, { caption: adminText.slice(0, 1000), parse_mode: 'HTML' }).catch(() => {});
        else if (m) b.sendPhoto(id, Buffer.from(m[1], 'base64'), { caption: adminText.slice(0, 1000), parse_mode: 'HTML' }, { filename: 'fikr.jpg', contentType: 'image/jpeg' }).catch(() => {});
        else b.sendMessage(id, adminText, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
    return { saved: true, products: pids.length };
  }

  async function saveReview(msg, st) {
    const b = bot();
    const chatId = String(msg.chat.id);
    states.delete(chatId);
    const order = await firebaseGet(`orders/${st.orderId}`);
    if (!order) return b.sendMessage(chatId, 'Buyurtma topilmadi.');
    if (order.review) return b.sendMessage(chatId, 'Rahmat! Siz bu buyurtma uchun allaqachon fikr qoldirgansiz 💜');
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    const text = String((msg.text && !msg.text.startsWith('/')) ? msg.text : (msg.caption || '')).trim().slice(0, 1000);
    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || order.userName || 'Xaridor';
    const { products: pidsCount } = await addReview({ order, orderId: st.orderId, userId: msg.from?.id, name, rating: st.rating, text, photoFileId: photo?.file_id || null });
    await b.sendMessage(chatId,
      `💜 Rahmat, ${esc(name.split(' ')[0])}! Fikringiz biz uchun juda qadrli${pidsCount ? " va u mahsulot sahifasida boshqa xaridorlarga ko'rinadi" : ''}.\n\nYana xarid qilishni istasangiz — doim xizmatingizdamiz 👇`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[shopButton()]] } });
  }

  // ---------- /reklama ----------
  async function allUserIds() {
    const users = (await firebaseGet('users')) || {};
    return Object.keys(users).filter(id => /^\d+$/.test(id));
  }

  async function startBroadcast(chatId) {
    states.set(String(chatId), { type: 'bc_wait', at: Date.now() });
    await bot().sendMessage(chatId,
      `📣 <b>Reklama xabari</b>\n\nHammaga yuboriladigan xabarni yuboring: matn, rasm (izohi bilan) yoki video.\nXabar tagiga avtomatik "🛍 Do'konni ochish" tugmasi qo'shiladi.\n\nBekor qilish: /cancel`,
      { parse_mode: 'HTML' });
  }

  async function prepareBroadcast(msg) {
    const b = bot();
    const chatId = String(msg.chat.id);
    const count = (await allUserIds()).length;
    states.set(chatId, { type: 'bc_ready', fromChat: msg.chat.id, msgId: msg.message_id, at: Date.now() });
    await b.sendMessage(chatId, '👀 Xaridorlar xabarni shunday ko\'radi:');
    await b.copyMessage(chatId, msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [[shopButton()]] } }).catch(() => {});
    await b.sendMessage(chatId, `Jami <b>${count}</b> ta foydalanuvchiga yuborilsinmi?`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: `✅ Yuborish (${count})`, callback_data: 'bc:send' }, { text: '❌ Bekor', callback_data: 'bc:cancel' }]] },
    });
  }

  async function runBroadcast(query) {
    const b = bot();
    const chatId = String(query.message.chat.id);
    const st = states.get(chatId);
    if (!st || st.type !== 'bc_ready') return b.answerCallbackQuery(query.id, { text: 'Xabar topilmadi, /reklama ni qayta boshlang', show_alert: true });
    states.delete(chatId);
    await b.answerCallbackQuery(query.id, { text: 'Yuborish boshlandi' });
    await b.editMessageText('⏳ Yuborilmoqda...', { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    const ids = await allUserIds();
    let ok = 0, fail = 0;
    for (const uid of ids) {
      try {
        await safeSend(() => b.copyMessage(uid, st.fromChat, st.msgId, { reply_markup: { inline_keyboard: [[shopButton()]] } }));
        ok++;
      } catch (_) { fail++; }
      await sleep(60); // Telegram limiti: sekundiga ~30 ta xabar
    }
    await b.editMessageText(`📣 Reklama yuborildi.\n\n✅ Yetkazildi: ${ok}\n❌ Yetmadi: ${fail} (botni bloklagan yoki /start bosmagan)`,
      { chat_id: chatId, message_id: query.message.message_id }).catch(() => b.sendMessage(chatId, `📣 Yuborildi: ${ok}, yetmadi: ${fail}`));
  }

  // Yordamchi admin uchun: hammaga matn (va rasm) yuborish
  async function broadcastText({ text = '', photoData = null, countOnly = false } = {}) {
    const ids = await allUserIds();
    if (countOnly) return ids.length;
    const b = bot();
    if (!b) return { ok: 0, fail: ids.length };
    const m = photoData && String(photoData).match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    const photo = m ? Buffer.from(m[1], 'base64') : null;
    let ok = 0, fail = 0, fileId = null;
    const markup = { inline_keyboard: [[shopButton()]] };
    for (const uid of ids) {
      try {
        if (photo) {
          const r = await safeSend(() => b.sendPhoto(uid, fileId || photo, { caption: text.slice(0, 1000), reply_markup: markup }, fileId ? {} : { filename: 'reklama.jpg', contentType: 'image/jpeg' }));
          if (!fileId && r?.photo?.length) fileId = r.photo[r.photo.length - 1].file_id;
        } else {
          await safeSend(() => b.sendMessage(uid, text, { reply_markup: markup }));
        }
        ok++;
      } catch (_) { fail++; }
      await sleep(60);
    }
    return { ok, fail };
  }

  // ---------- Kunlik hisobot ----------
  async function buildReport() {
    const [orders, users] = await Promise.all([firebaseGet('orders').then(o => o || {}), firebaseGet('users').then(u => u || {})]);
    const from = dayStart();
    const all = Object.entries(orders).filter(([, o]) => o).map(([id, o]) => ({ id, ...o }));
    const today = all.filter(o => (o.createdAt || 0) >= from);
    const paid = (o) => ['confirmed', 'paid', 'shipped', 'delivered'].includes(o.status);
    const revenue = today.filter(paid).reduce((s, o) => s + (Number(o.total) || 0), 0);
    const toShip = all.filter(o => o.status === 'confirmed' || o.status === 'paid');
    const userList = Object.values(users);
    const newUsers = userList.filter(u => (u.joinedAt || 0) >= from).length;
    const active = userList.filter(u => (u.lastSeen || 0) >= from).length;
    resetCountersIfNewDay();
    return `📊 <b>Kunlik hisobot — ${fmtDate(Date.now())}</b>\n\n` +
      `🛒 Bugungi buyurtmalar: <b>${today.length}</b>\n` +
      `   ✅ to'langan: ${today.filter(paid).length} · ⏳ kutilmoqda: ${today.filter(o => o.status === 'pending').length} · ❌ rad: ${today.filter(o => o.status === 'rejected').length}\n` +
      `💰 Bugungi daromad: <b>${fmtSom(revenue)}</b>\n\n` +
      `👥 Yangi foydalanuvchilar: <b>${newUsers}</b> (bugun faol: ${active}, jami: ${userList.length})\n` +
      `⭐ Yangi fikrlar: ${counters.reviews}\n` +
      `🛒 Savat eslatmalari: ${counters.cartReminders} · 📉 Narx xabarlari: ${counters.priceAlerts}\n\n` +
      (toShip.length
        ? `🚚 <b>Jo'natilishi kerak: ${toShip.length} ta</b>\n${toShip.slice(0, 10).map(o => `• ${esc(o.orderNum || '#' + o.id)} — ${esc(o.userName || '')}`).join('\n')}`
        : `🚚 Jo'natilmay qolgan buyurtma yo'q 👍`);
  }

  async function sendReport(chatIds) {
    const b = bot();
    if (!b) return;
    const text = await buildReport();
    for (const id of chatIds) await b.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  async function maybeDailyReport() {
    const t = tashkentDate();
    if (t.h !== 21 || !bot() || !getAdminIds().length) return;
    if (!lastReportKey) lastReportKey = (await firebaseGet('meta/dailyReport')) || '';
    if (lastReportKey === t.key) return;
    lastReportKey = t.key;
    await firebasePatch('meta', { dailyReport: t.key });
    await sendReport(getAdminIds());
  }

  // ---------- Savat / sevimlilar sinxronizatsiyasi ----------
  async function syncUserData(userId, { cart, favorites }) {
    const uid = String(userId);
    if (Array.isArray(cart)) {
      const items = cart.filter(i => i && i.id != null).slice(0, 50).map(i => ({ id: String(i.id), qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) }));
      const prev = await firebaseGet(`carts/${uid}`);
      if (!items.length) { if (prev) await firebaseDelete(`carts/${uid}`); }
      else if (JSON.stringify(prev?.items || []) !== JSON.stringify(items)) {
        await firebasePatch(`carts/${uid}`, { items, updatedAt: Date.now(), remindedAt: prev?.remindedAt || 0 });
      }
    }
    if (Array.isArray(favorites)) {
      const ids = [...new Set(favorites.map(String))].slice(0, 200);
      const prev = await firebaseGet(`favorites/${uid}`);
      if (JSON.stringify(prev?.ids || []) !== JSON.stringify(ids)) {
        if (ids.length) await firebasePatch(`favorites/${uid}`, { ids, updatedAt: Date.now() });
        else if (prev) await firebaseDelete(`favorites/${uid}`);
      }
    }
  }

  async function sweepCarts() {
    const b = bot();
    if (!b) return;
    const carts = (await firebaseGet('carts')) || {};
    const now = Date.now();
    let orders = null;
    const products = await getProducts();
    for (const [uid, c] of Object.entries(carts)) {
      if (!c?.items?.length || !c.updatedAt) continue;
      if (now - c.updatedAt < DAY || now - c.updatedAt > 3 * DAY) continue;
      if ((c.remindedAt || 0) >= c.updatedAt) continue;
      orders = orders || (await firebaseGet('orders')) || {};
      const orderedSince = Object.values(orders).some(o => o && String(o.userId) === uid && (o.createdAt || 0) >= c.updatedAt);
      await firebasePatch(`carts/${uid}`, { remindedAt: now });
      if (orderedSince) continue;
      const items = c.items.map(i => ({ ...i, p: products.find(p => String(p.id) === String(i.id)) })).filter(i => i.p);
      if (!items.length) continue;
      const lines = items.slice(0, 5).map(i => `• ${esc(i.p.name)}${i.qty > 1 ? ` × ${i.qty}` : ''} — ${fmtSom(i.p.price)}`).join('\n');
      try {
        await b.sendMessage(uid,
          `🛒 <b>Savatingizda mahsulotlar qoldi!</b>\n\n${lines}\n\nUlar hali ham mavjud — buyurtmani bir necha soniyada yakunlashingiz mumkin 👇`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[shopButton('🛒 Savatni ochish', '?tab=cart')]] } });
        bump('cartReminders');
      } catch (_) { /* botni bloklagan */ }
    }
  }

  // ---------- Narx tushdi ----------
  async function onProductUpdated(before, after) {
    const b = bot();
    if (!b || !before || !after) return;
    const oldPrice = Number(before.price) || 0;
    const newPrice = Number(after.price) || 0;
    if (!(newPrice > 0 && oldPrice > 0 && newPrice < oldPrice)) return;
    const pid = String(after.id);
    if (Date.now() - (priceAlertAt.get(pid) || 0) < 6 * 3600e3) return;
    priceAlertAt.set(pid, Date.now());
    const favs = (await firebaseGet('favorites')) || {};
    const userIds = Object.entries(favs).filter(([, f]) => (f?.ids || []).map(String).includes(pid)).map(([uid]) => uid);
    if (!userIds.length) return;
    const pct = Math.round((1 - newPrice / oldPrice) * 100);
    const text = `📉 <b>Narx tushdi!</b>\n\n❤️ Sevimlilaringizdagi <b>${esc(after.name)}</b>\n<s>${fmtSom(oldPrice)}</s> → <b>${fmtSom(newPrice)}</b>${pct > 0 ? ` (−${pct}%)` : ''}\n\nShoshiling, chegirmali narx cheklangan bo'lishi mumkin 👇`;
    for (const uid of userIds) {
      try {
        await safeSend(() => b.sendMessage(uid, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[shopButton("👀 Ko'rish", `?product=${pid}`)]] } }));
        bump('priceAlerts');
      } catch (_) {}
      await sleep(60);
    }
  }

  // ---------- Jo'natilmay qolgan buyurtma eslatmasi ----------
  async function sweepUnshipped() {
    const b = bot();
    if (!b || !getAdminIds().length) return;
    const orders = (await firebaseGet('orders')) || {};
    const now = Date.now();
    for (const [id, o] of Object.entries(orders)) {
      const sent = o?.fulfillment?.adminNotifiedAt;
      if (!o || o.status !== 'confirmed' || !sent || now - sent < DAY || o.fulfillment.shipReminderAt) continue;
      await firebasePatch(`orders/${id}`, { fulfillment: { ...o.fulfillment, shipReminderAt: now } });
      const text = `⏰ <b>Eslatma:</b> ${esc(o.orderNum || '#' + id)} buyurtmasi to'lov tasdiqlanganiga 1 kundan oshdi, lekin hali jo'natilmadi.\n\n👤 ${esc(o.userName || '')} · 📞 ${esc(o.phone || '—')}\n📍 ${esc(o.addr || '—')}\n🛍 ${esc(o.products || '')}`;
      for (const aid of getAdminIds()) {
        b.sendMessage(aid, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📦 Buyurtma yuborildi', callback_data: `ship:${id}` }]] } }).catch(() => {});
      }
    }
  }

  // ---------- Mijozlar fikri (Mini App uchun) ----------
  async function listReviews(productId) {
    const raw = (await firebaseGet(`reviews/${String(productId)}`)) || {};
    const items = Object.entries(raw).map(([rid, r]) => ({
      id: rid, name: r.name || 'Xaridor', rating: r.rating || 5, text: r.text || '', createdAt: r.createdAt || 0,
      photo: (r.photoFileId || r.photoData) ? `/api/reviews/${encodeURIComponent(productId)}/${encodeURIComponent(rid)}/photo` : null,
    })).sort((a, b) => b.createdAt - a.createdAt);
    const avg = items.length ? Math.round(items.reduce((s, r) => s + r.rating, 0) / items.length * 10) / 10 : 0;
    return { count: items.length, avg, items: items.slice(0, 30) };
  }

  // { url } — Telegram fayli, { data, type } — Mini App orqali yuklangan rasm
  async function reviewPhoto(productId, reviewId) {
    const r = await firebaseGet(`reviews/${String(productId)}/${String(reviewId)}`);
    const m = r?.photoData && String(r.photoData).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (m) return { data: Buffer.from(m[2], 'base64'), type: m[1] };
    if (!r?.photoFileId || !bot()) return null;
    return { url: await bot().getFileLink(r.photoFileId) };
  }

  // Admin: barcha fikrlar va o'chirish
  async function listAllReviews() {
    const all = (await firebaseGet('reviews')) || {};
    const products = await getProducts();
    const seen = new Set();
    const out = [];
    for (const [pid, revs] of Object.entries(all)) {
      for (const [rid, r] of Object.entries(revs || {})) {
        if (!r) continue;
        const key = rid; // bitta fikr bir nechta mahsulotga yozilgan bo'lishi mumkin
        const prod = products.find(p => String(p.id) === pid);
        out.push({ pid, rid, name: r.name, rating: r.rating, text: r.text || '', createdAt: r.createdAt || 0, product: prod ? prod.name : '—', orderId: r.orderId,
          photo: (r.photoFileId || r.photoData) ? `/api/reviews/${encodeURIComponent(pid)}/${encodeURIComponent(rid)}/photo` : null, dup: seen.has(key) });
        seen.add(key);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }

  async function deleteReview(pid, rid) {
    const r = await firebaseGet(`reviews/${pid}/${rid}`);
    if (!r) return { error: 'Fikr topilmadi' };
    await firebaseDelete(`reviews/${pid}/${rid}`);
    try {
      const p = (await getProducts()).find(x => String(x.id) === String(pid));
      if (p && Number(p.reviews) > 1) {
        const cnt = Number(p.reviews), avg = Number(p.rating) || 0;
        const nextAvg = Math.max(1, Math.min(5, Math.round(((avg * cnt - (r.rating || 5)) / (cnt - 1)) * 10) / 10));
        await updateProduct(pid, { rating: nextAvg, reviews: cnt - 1 });
      }
    } catch (_) {}
    return { deleted: true };
  }

  // ---------- Bot menyusi ----------
  async function setCommands() {
    const b = bot();
    if (!b) return;
    const base = [
      { command: 'start', description: "Do'konni ochish" },
      { command: 'buyurtmalarim', description: 'Buyurtmalarim va holati' },
      { command: 'help', description: 'Yordam' },
    ];
    await b.setMyCommands(base).catch(e => console.warn('setMyCommands:', e.message));
    for (const id of getAdminIds()) {
      await b.setMyCommands([
        ...base,
        { command: 'admin', description: 'Admin panel' },
        { command: 'hisobot', description: 'Bugungi hisobot' },
        { command: 'reklama', description: 'Hammaga xabar yuborish' },
      ], { scope: JSON.stringify({ type: 'chat', chat_id: Number(id) }) }).catch(() => {});
    }
  }

  // ---------- Router ----------
  // Buyruqlar va holatga bog'liq xabarlar. true — xabar shu yerda qayta ishlandi
  async function handleMessage(msg) {
    if (msg.chat?.type !== 'private') return false;
    const b = bot();
    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : '';
    const st = states.get(chatId);
    if (st && Date.now() - st.at > 2 * 3600e3) states.delete(chatId);

    if (cmd === '/buyurtmalarim' || cmd === '/orders') { await sendMyOrders(msg.chat.id, msg.from.id); return true; }
    if (cmd === '/hisobot' && isAdmin(msg.from.id)) { await sendReport([msg.chat.id]); return true; }
    if (cmd === '/reklama' && isAdmin(msg.from.id)) { await startBroadcast(msg.chat.id); return true; }

    const cur = states.get(chatId);
    if (!cur) return false;
    if (cmd === '/cancel') { states.delete(chatId); await b.sendMessage(chatId, 'Bekor qilindi.'); return true; }
    if (cur.type === 'review') {
      if (cmd === '/skip' || msg.photo || (text && !cmd)) { await saveReview(msg, cur); return true; }
      return false;
    }
    if (cur.type === 'bc_wait' && isAdmin(msg.from.id)) {
      if (cmd) return false;
      await prepareBroadcast(msg);
      return true;
    }
    return false;
  }

  // true — callback shu yerda qayta ishlandi
  async function handleCallback(query) {
    const b = bot();
    const data = String(query.data || '');
    if (data === 'myorders') {
      await b.answerCallbackQuery(query.id);
      await sendMyOrders(query.message.chat.id, query.from.id);
      return true;
    }
    let m;
    if ((m = data.match(/^arrived:(.+)$/))) { await onArrived(query, m[1]); return true; }
    if ((m = data.match(/^rate:(.+):([1-5])$/))) { await onRate(query, m[1], Number(m[2])); return true; }
    if (data === 'bc:send' && isAdmin(query.from.id)) { await runBroadcast(query); return true; }
    if (data === 'bc:cancel' && isAdmin(query.from.id)) {
      states.delete(String(query.message.chat.id));
      await b.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
      b.editMessageText('❌ Reklama bekor qilindi.', { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
      return true;
    }
    return false;
  }

  // Har daqiqada: kunlik hisobot vaqti; har soatda: savat va jo'natilmagan buyurtmalar
  let minuteTick = 0;
  function startSchedulers() {
    setInterval(async () => {
      minuteTick++;
      try { await maybeDailyReport(); } catch (e) { console.warn('Kunlik hisobot xatosi:', e.message); }
      if (minuteTick % 60 === 5) {
        try { await sweepCarts(); } catch (e) { console.warn('Savat eslatmasi xatosi:', e.message); }
        try { await sweepUnshipped(); } catch (e) { console.warn('Jo\'natish eslatmasi xatosi:', e.message); }
      }
    }, 60000);
  }

  return {
    sendWelcome, sendMyOrders, sendArrivedPrompt, handleMessage, handleCallback, setCommands,
    syncUserData, onProductUpdated, listReviews, reviewPhoto, startSchedulers,
    addReview, markDelivered, listAllReviews, deleteReview, broadcastText, STATUS_LABELS,
    _internals: { buildReport, sweepCarts, sweepUnshipped, maybeDailyReport, states },
  };
}

module.exports = { createBotFeatures, STATUS_LABELS };
