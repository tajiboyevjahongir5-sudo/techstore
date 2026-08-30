const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

// ===== SERVER CRASH BO'LMASIN =====
process.on('uncaughtException', (err) => {
  console.error('⚠️ uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ unhandledRejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE CONFIGURATION =====
const DB_URL = "https://techstore-7018f-default-rtdb.firebaseio.com";

// ===== MUTABLE SYSTEM SETTINGS =====
let BOT_TOKEN = process.env.BOT_TOKEN || "";
let ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
let CARD_NUMBER = process.env.CARD_NUMBER || "9860 3501 4074 7741";
let CARD_OWNER = process.env.CARD_OWNER || "Tojiboyev Jahongir";
const APP_URL   = process.env.APP_URL || `https://your-app.railway.app`;

// ===== FIREBASE REST CLIENT =====
async function firebaseGet(path) {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Firebase GET error at ${path}:`, e.message);
    return null;
  }
}

async function firebasePut(path, data) {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Firebase PUT error at ${path}:`, e.message);
    throw e;
  }
}

async function firebasePatch(path, data) {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Firebase PATCH error at ${path}:`, e.message);
    throw e;
  }
}

async function firebaseDelete(path) {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Firebase DELETE error at ${path}:`, e.message);
    throw e;
  }
}

// ===== EXPRESS =====
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== RATE LIMITER MIDDLEWARE (DDoS & Spamdan himoya) =====
const requestTracker = new Map(); // IP -> Array of timestamps

function apiRateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const limit = 20; // 1 daqiqada maksimal 20 ta so'rov
  const windowMs = 60 * 1000; // 1 daqiqa (60000 ms)

  if (!requestTracker.has(ip)) {
    requestTracker.set(ip, []);
  }

  const timestamps = requestTracker.get(ip);
  // 1 daqiqadan eski vaqtlarni tozalash
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    console.warn(`🚫 Spam aniqlandi! IP blocked: ${ip}`);
    return res.status(429).json({ error: "Ko'p so'rov yuborildi. Iltimos 1 daqiqa kuting." });
  }

  timestamps.push(now);
  next();
}

// ===== IN-MEMORY PENDING PAYMENTS SYSTEM =====
const pendingPayments = []; // array of { amount, userId, userName, orderNum, phone, addr, ts, firebaseKey }

// Sync pending payments with Firebase DB (Resilient to server restarts)
async function loadPendingPayments() {
  try {
    const data = await firebaseGet('pending_payments');
    if (data) {
      pendingPayments.length = 0; // Clear local array
      Object.keys(data).forEach(key => {
        pendingPayments.push({ ...data[key], firebaseKey: key });
      });
      console.log(`📝 Loaded ${pendingPayments.length} pending payments from Firebase`);
    }
  } catch (e) {
    console.warn("⚠️ Failed to load pending payments from Firebase:", e.message);
  }
}

async function registerPendingPaymentInDb(payment) {
  try {
    const res = await fetch(`${DB_URL}/pending_payments.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payment)
    });
    const result = await res.json();
    payment.firebaseKey = result.name;
    pendingPayments.push(payment);
    console.log(`📝 Payment registered: ${payment.amount} UZS for order ${payment.orderNum}`);
  } catch (e) {
    console.warn("⚠️ Failed to register pending payment in Firebase:", e.message);
    pendingPayments.push(payment); // Fallback to memory-only
  }
}

async function deletePendingPaymentFromDb(payment) {
  try {
    if (payment.firebaseKey) {
      await firebaseDelete(`pending_payments/${payment.firebaseKey}`);
    }
    const idx = pendingPayments.indexOf(payment);
    if (idx !== -1) pendingPayments.splice(idx, 1);
  } catch (e) {
    console.warn("⚠️ Failed to delete pending payment from Firebase:", e.message);
    const idx = pendingPayments.indexOf(payment);
    if (idx !== -1) pendingPayments.splice(idx, 1);
  }
}

// ===== MUTABLE SETTINGS SYNC =====
async function loadSettingsFromDb() {
  try {
    const settings = await firebaseGet('settings');
    if (settings) {
      if (settings.bot?.token) {
        BOT_TOKEN = settings.bot.token;
        initializeTelegramBot();
      }
      if (settings.admin?.telegramIds) {
        ADMIN_IDS = settings.admin.telegramIds.split(',').map(id => id.trim()).filter(Boolean);
      }
      if (settings.card?.number) CARD_NUMBER = settings.card.number;
      if (settings.card?.owner) CARD_OWNER = settings.card.owner;
      console.log("⚙️ Settings loaded from Firebase");
    }
  } catch (e) {
    console.warn("⚠️ Failed to load settings from Firebase:", e.message);
  }
}

// Telegram WebApp initData verifikatsiyasi (HMAC-SHA256)
function verifyTelegramAuth(initData) {
  if (!initData || !BOT_TOKEN) return false;
  
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    // Kalitlarni alifbo tartibida saralash
    const keys = Array.from(urlParams.keys()).sort();
    const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
    
    // Bot tokenidan maxfiy kalit yaratish
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const generatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return generatedHash === hash;
  } catch(e) {
    return false;
  }
}

// Admin Authorization Middleware (InitData bo'yicha)
function verifyAdmin(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const hostname = req.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  
  // Local development fallback
  if (isLocal && !initData) {
    return next();
  }
  
  if (!verifyTelegramAuth(initData)) {
    console.warn(`⚠️ Security: Unauthorized admin attempt from IP: ${req.ip}`);
    return res.status(401).json({ error: "Xavfsizlik xatosi: Siz admin emassiz yoki sessiya muddati tugagan" });
  }
  
  try {
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');
    if (!userStr) return res.status(401).json({ error: "Foydalanuvchi ma'lumotlari topilmadi" });
    
    const user = JSON.parse(userStr);
    const userId = String(user.id);
    
    if (ADMIN_IDS.length === 0 || ADMIN_IDS.includes(userId)) {
      req.adminUser = user;
      return next();
    }
  } catch(e) {
    return res.status(400).json({ error: "Noto'g'ri initData formati" });
  }
  
  return res.status(403).json({ error: "Sizda admin huquqi yo'q!" });
}

// ===== PUBLIC REST API =====

// Karta ma'lumotlarini olish
app.get('/api/public-settings', apiRateLimiter, (req, res) => {
  res.json({
    card: {
      number: CARD_NUMBER,
      owner: CARD_OWNER
    }
  });
});

// Suffix hisoblash API
app.get('/api/unique-suffix', apiRateLimiter, (req, res) => {
  const price = parseInt(req.query.price) || 0;
  
  const usedSuffixes = new Set(
    pendingPayments
      .filter(p => p.amount >= price && p.amount <= price + 100)
      .map(p => p.amount - price)
  );
  
  let suffix = Math.floor(Math.random() * 100) + 1;
  let tries = 0;
  while (usedSuffixes.has(suffix) && tries < 100) {
    suffix = (suffix % 100) + 1;
    tries++;
  }
  
  res.json({ suffix, amount: price + suffix });
});

// Mahsulotlarni olish
app.get('/api/products', apiRateLimiter, async (req, res) => {
  try {
    const products = await firebaseGet('products');
    res.json(products || []);
  } catch (e) {
    res.status(500).json({ error: "Mahsulotlarni yuklashda xatolik yuz berdi" });
  }
});

// Buyurtma holatini olish (Foydalanuvchi tekshirishi uchun polling)
app.get('/api/orders/:orderId', apiRateLimiter, async (req, res) => {
  const { orderId } = req.params;
  try {
    const order = await firebaseGet(`orders/${orderId}`);
    if (!order) return res.status(404).json({ error: "Buyurtma topilmadi" });
    res.json({ status: order.status });
  } catch (e) {
    res.status(500).json({ error: "Xatolik yuz berdi" });
  }
});

// Yangi buyurtma yaratish va to'lovni ro'yxatga olish
app.post('/api/orders', apiRateLimiter, async (req, res) => {
  const { amount, userId, userName, orderNum, phone, addr, items, basePrice, suffix, chekImg } = req.body;
  if (!amount || !userId || !orderNum || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Noto'g'ri buyurtma ma'lumotlari" });
  }

  // 1) Narxni bazadan qayta tekshirish (Price tampering mudofaasi)
  let dbProducts = [];
  try {
    dbProducts = await firebaseGet('products') || [];
  } catch(e) {
    console.error("Failed to fetch products for verification:", e);
    return res.status(500).json({ error: "Mahsulotlar narxini tekshirishda xatolik yuz berdi" });
  }

  let calculatedBaseTotal = 0;
  for (const item of items) {
    const dbProd = dbProducts.find(p => p && String(p.id) === String(item.id));
    if (!dbProd) {
      return res.status(400).json({ error: `Mahsulot topilmadi: ${item.name}` });
    }
    const realPrice = dbProd.price;
    const discount = dbProd.discount || 0;
    const finalPrice = discount > 0 ? Math.round(realPrice * (1 - discount / 100)) : realPrice;
    calculatedBaseTotal += finalPrice * (item.qty || 1);
  }

  const cleanSuffix = Number(suffix || 0);
  const expectedAmount = calculatedBaseTotal + cleanSuffix;
  const cleanAmount = Number(amount);

  if (Math.abs(expectedAmount - cleanAmount) > 100) {
    console.warn(`⚠️ Security: Price tampering attempt! Expected: ${expectedAmount}, Got: ${cleanAmount}`);
    return res.status(400).json({ error: "Buyurtma summasi mos kelmadi. Narxlar o'zgargan bo'lishi mumkin. Iltimos, sahifani yangilang." });
  }

  // Sanitise fields
  const cleanUserName = sanitizeInput(userName || 'Foydalanuvchi');
  const cleanOrderNum = sanitizeInput(orderNum);
  const cleanPhone = sanitizeInput(phone || '');
  const cleanAddr = sanitizeInput(addr || '');

  // Eski kutilayotgan to'lovlarni o'chirish (tozalash)
  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    if (pendingPayments[i].amount === cleanAmount) {
      await deletePendingPaymentFromDb(pendingPayments[i]);
    }
  }

  const newPayment = {
    amount: cleanAmount,
    userId: String(userId),
    userName: cleanUserName,
    orderNum: cleanOrderNum,
    phone: cleanPhone,
    addr: cleanAddr,
    ts: Date.now()
  };

  try {
    // 1) Firebase-da buyurtmani saqlash
    await firebasePut(`orders/${cleanOrderNum.replace('#','')}`, {
      orderNum: cleanOrderNum,
      products: items.map(i => sanitizeInput(i.name)).join(', '),
      total: cleanAmount,
      basePrice: calculatedBaseTotal,
      suffix: cleanSuffix,
      addr: cleanAddr,
      phone: cleanPhone,
      status: 'pending',
      userId: String(userId),
      userName: cleanUserName,
      chekImg: chekImg && typeof chekImg === 'string' ? chekImg : null,
      createdAt: Date.now()
    });

    // 2) Kutilayotgan to'lovni Firebase va local xotirada saqlash
    await registerPendingPaymentInDb(newPayment);

    res.json({ success: true, orderNum: cleanOrderNum, amount: cleanAmount });
  } catch (e) {
    console.error("Order processing error:", e);
    res.status(500).json({ error: "Buyurtmani qayta ishlashda xatolik yuz berdi: " + e.message });
  }
});

// ===== ADMIN PROTECTED REST API =====

// Barcha buyurtmalarni olish
app.get('/api/admin/orders', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const ordersData = await firebaseGet('orders');
    res.json(ordersData || {});
  } catch (e) {
    res.status(500).json({ error: "Buyurtmalarni yuklashda xatolik: " + e.message });
  }
});

// Buyurtmani tasdiqlash
app.post('/api/admin/orders/:orderId/approve', apiRateLimiter, verifyAdmin, async (req, res) => {
  const { orderId } = req.params;
  const orderPath = `orders/${orderId}`;
  
  try {
    const order = await firebaseGet(orderPath);
    if (!order) return res.status(404).json({ error: "Buyurtma topilmadi" });
    
    // Statusni yangilash
    await firebasePatch(orderPath, { status: 'confirmed' });
    
    // Foydalanuvchiga Telegram xabar yuborish
    if (order.userId && BOT_TOKEN && global.telegramBotInstance) {
      const userMsg = `✅ <b>Buyurtmangiz tasdiqlandi!</b>\n\n` +
        `📦 Buyurtma: <b>#${orderId}</b>\n` +
        `🚀 Admin siz bilan tez orada bog'lanadi va mahsulot yetkaziladi!\n\n` +
        `<i>TechStore — Ishonchli xarid</i>`;
      
      global.telegramBotInstance.sendMessage(order.userId, userMsg, { parse_mode: 'HTML' })
        .catch(err => console.error("Foydalanuvchiga tasdiqlash yuborishda xato:", err.message));
    }
    
    // Kutilayotgan to'lovlardan o'chirish
    const p = pendingPayments.find(x => x.orderNum === '#' + orderId);
    if (p) await deletePendingPaymentFromDb(p);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buyurtmani rad etish
app.post('/api/admin/orders/:orderId/reject', apiRateLimiter, verifyAdmin, async (req, res) => {
  const { orderId } = req.params;
  const orderPath = `orders/${orderId}`;
  
  try {
    const order = await firebaseGet(orderPath);
    if (!order) return res.status(404).json({ error: "Buyurtma topilmadi" });
    
    await firebasePatch(orderPath, { status: 'rejected' });
    
    if (order.userId && BOT_TOKEN && global.telegramBotInstance) {
      const userMsg = `❌ <b>Buyurtmangiz rad etildi!</b>\n\nSiz yuborgan to'lov tasdiqlanmadi. Muammo bo'lsa admin bilan bog'laning.`;
      global.telegramBotInstance.sendMessage(order.userId, userMsg, { parse_mode: 'HTML' })
        .catch(err => console.error("Foydalanuvchiga rad etish yuborishda xato:", err.message));
    }
    
    const p = pendingPayments.find(x => x.orderNum === '#' + orderId);
    if (p) await deletePendingPaymentFromDb(p);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin sozlamalarini olish
app.get('/api/admin/settings', apiRateLimiter, verifyAdmin, (req, res) => {
  res.json({
    card: { number: CARD_NUMBER, owner: CARD_OWNER },
    bot: { token: BOT_TOKEN },
    admin: { telegramIds: ADMIN_IDS.join(',') }
  });
});

// Admin sozlamalarini yangilash
app.post('/api/admin/settings', apiRateLimiter, verifyAdmin, async (req, res) => {
  const { card, bot, admin } = req.body;
  
  try {
    const updates = {};
    if (card) {
      CARD_NUMBER = card.number;
      CARD_OWNER = card.owner;
      updates['settings/card'] = { number: CARD_NUMBER, owner: CARD_OWNER };
    }
    if (bot) {
      BOT_TOKEN = bot.token;
      updates['settings/bot'] = { token: BOT_TOKEN };
    }
    if (admin) {
      ADMIN_IDS = admin.telegramIds.split(',').map(id => id.trim()).filter(Boolean);
      updates['settings/admin'] = { telegramIds: admin.telegramIds };
    }
    
    await firebasePatch('', updates);
    
    if (bot && bot.token) {
      initializeTelegramBot();
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Sozlamalarni yangilashda xato: " + e.message });
  }
});

// Mahsulotlarni default holatga reset qilish
app.post('/api/admin/products/reset', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const { products: defaultProducts } = req.body;
    if (defaultProducts) {
      await firebasePut('products', defaultProducts);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Standart mahsulotlar ro'yxati yuborilmadi" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sanitization helper
function sanitizeInput(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

// Product validator and sanitizer
function validateAndSanitizeProduct(req, res, next) {
  const { name, brand, price, discount, cat, desc, specs, images } = req.body;
  
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: "Mahsulot nomi kiritilishi shart!" });
  }
  if (!brand || typeof brand !== 'string' || brand.trim() === '') {
    return res.status(400).json({ error: "Brand nomi kiritilishi shart!" });
  }
  
  const parsedPrice = parseInt(price);
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    return res.status(400).json({ error: "Mahsulot narxi musbat son bo'lishi shart!" });
  }
  
  const parsedDiscount = parseInt(discount) || 0;
  if (parsedDiscount < 0 || parsedDiscount > 100) {
    return res.status(400).json({ error: "Chegirma 0 va 100 oralig'ida bo'lishi shart!" });
  }
  
  const allowedCats = ['Telefonlar', 'Kompyuterlar', 'Audio', 'Aksessuarlar', 'Kameralar'];
  if (!cat || !allowedCats.includes(cat)) {
    return res.status(400).json({ error: "Noto'g'ri mahsulot kategoriyasi!" });
  }
  
  req.sanitizedProduct = {
    id: req.body.id ? Number(req.body.id) : (Date.now() + Math.floor(Math.random() * 1000)),
    name: sanitizeInput(name),
    brand: sanitizeInput(brand),
    price: parsedPrice,
    discount: parsedDiscount,
    cat: cat,
    desc: sanitizeInput(desc || 'Tavsif yo\'q.'),
    rating: Number(req.body.rating) || 5.0,
    reviews: Number(req.body.reviews) || 0,
    specs: Array.isArray(specs) ? specs.map(pair => [sanitizeInput(pair[0]), sanitizeInput(pair[1])]) : [],
    emoji: req.body.emoji ? sanitizeInput(req.body.emoji) : null,
    image: req.body.image && typeof req.body.image === 'string' ? req.body.image : null,
    images: Array.isArray(images) ? images.filter(img => typeof img === 'string') : []
  };
  
  next();
}

// Mahsulot qo'shish
app.post('/api/admin/products', apiRateLimiter, verifyAdmin, validateAndSanitizeProduct, async (req, res) => {
  const newProduct = req.sanitizedProduct;
  try {
    let prods = await firebaseGet('products') || [];
    prods = prods.filter(p => p && p.id !== newProduct.id);
    prods.unshift(newProduct);
    await firebasePut('products', prods);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mahsulotni yangilash
app.put('/api/admin/products/:id', apiRateLimiter, verifyAdmin, validateAndSanitizeProduct, async (req, res) => {
  const { id } = req.params;
  const updatedProduct = req.sanitizedProduct;
  updatedProduct.id = Number(id);
  try {
    let prods = await firebaseGet('products') || [];
    const idx = prods.findIndex(p => p && String(p.id) === String(id));
    if (idx !== -1) {
      prods[idx] = { ...prods[idx], ...updatedProduct };
      await firebasePut('products', prods);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Mahsulot topilmadi" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mahsulotni o'chirish
app.delete('/api/admin/products/:id', apiRateLimiter, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    let prods = await firebaseGet('products') || [];
    prods = prods.filter(p => p && String(p.id) !== String(id));
    await firebasePut('products', prods);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Foydalanuvchilar ro'yxatini olish
app.get('/api/admin/users', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const ordersData = await firebaseGet('orders') || {};
    const usersMap = new Map();
    
    Object.values(ordersData).forEach(o => {
      if (o.userId) {
        usersMap.set(String(o.userId), {
          id: o.userId,
          first_name: o.userName || 'Foydalanuvchi',
          last_name: '',
          username: o.userUsername || '',
          phone: o.phone || '',
          orderCount: (usersMap.get(String(o.userId))?.orderCount || 0) + 1,
          joinedAt: o.createdAt || Date.now()
        });
      }
    });
    
    res.json(Array.from(usersMap.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== TELEGRAM BOT (POLLING) =====
let botInstance = null;

function initializeTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn("⚠️ Cannot initialize Telegram Bot: BOT_TOKEN is empty");
    return;
  }
  
  if (botInstance && botInstance.token === BOT_TOKEN) {
    return;
  }
  
  if (botInstance) {
    try {
      console.log("🔄 Stopping existing Telegram bot instance...");
      botInstance.stopPolling();
    } catch(e) {
      console.error("Error stopping bot polling:", e.message);
    }
  }
  
  try {
    const bot = new TelegramBot(BOT_TOKEN, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
      }
    });
    botInstance = bot;
    global.telegramBotInstance = bot;
    
    bot.on('polling_error', (err) => {
      console.error('Polling xatosi:', err.code, err.message);
    });

    bot.onText(/\/start/, (msg) => {
      const chatId    = msg.chat.id;
      const firstName = msg.from?.first_name || 'Foydalanuvchi';
      console.log(`/start - ${firstName} (${chatId})`);

      bot.sendMessage(chatId,
        `👋 Salom, <b>${firstName}</b>!\n\n🛒 <b>TechStore</b>ga xush kelibsiz!\n\nQuyidagi tugma orqali do'konni oching:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: "🛍️ Do'konni ochish", web_app: { url: APP_URL } }
            ]]
          }
        }
      );
    });

    bot.onText(/\/admin/, (msg) => {
      const chatId    = msg.chat.id;
      const userId    = String(msg.from?.id || '');
      const firstName = msg.from?.first_name || 'Admin';
      console.log(`/admin - ${firstName} (${userId})`);

      if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, "🚫 Sizda admin huquqi yo'q!");
        return;
      }

      const adminUrl = `${APP_URL}?admin_access=true&uid=${userId}`;

      bot.sendMessage(chatId,
        `🔐 <b>Admin Panel</b>\n\nSalom, <b>${firstName}</b>!\n⚡ Parol so'ralmaydi — avtomatik kirish.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '⚙️ Admin Panelni ochish', web_app: { url: adminUrl } }
            ]]
          }
        }
      );
    });

    bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      bot.sendMessage(chatId,
        `📋 <b>Buyruqlar:</b>\n\n/start — Do'konni ochish\n/admin — Admin panel\n/help — Yordam`,
        { parse_mode: 'HTML' }
      );
    });

    bot.on('channel_post', (msg) => {
      handlePaymentMessage(msg);
    });

    bot.on('message', (msg) => {
      if (msg.text && msg.text.startsWith('/')) return;
      handlePaymentMessage(msg);
    });

    console.log('✅ Telegram bot ishga tushdi (polling mode & automatic payment verification active)');
  } catch (e) {
    console.error("❌ Failed to initialize Telegram Bot:", e.message);
  }
}

// ===== TO'LOV XABARLARINI AVTOMATIK KUZATISH TIZIMI =====
function handlePaymentMessage(msg) {
  const text = msg.text || msg.caption;
  if (!text) return;

  const cleanText = text.replace(/[^0-9]/g, '');
  if (!cleanText) return;

  console.log(`📩 Kuzatilayotgan xabar: "${text.replace(/\n/g, ' ')}"`);

  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    const p = pendingPayments[i];
    const amountStr = String(p.amount);

    if (cleanText.includes(amountStr)) {
      console.log(`🎯 TO'LOV MOS KELDI! Summa: ${p.amount} so'm, Buyurtma: ${p.orderNum}`);

      const userMsg = `🎉 <b>To'lov qabul qilindi!</b>\n\n` +
        `Salom, <b>${p.userName}</b>!\n` +
        `Sizning <b>${p.amount.toLocaleString('uz')} so'm</b> to'lovingiz avtomatik ravishda tasdiqlandi. ✅\n\n` +
        `📦 Buyurtma raqami: <b>${p.orderNum}</b>\n\n` +
        `📞 Admin bilan bog'lanib buyurtmangizni olishingiz mumkin:\n` +
        `👉 <b>@Jahongir_1220</b>\n\n` +
        `Siz bilan hamkorlikdan mamnunmiz! ⚡`;

      if (botInstance) {
        botInstance.sendMessage(p.userId, userMsg, { parse_mode: 'HTML' })
          .then(() => console.log(`✉️ Foydalanuvchiga tasdiqlash xabari yuborildi: ${p.userId}`))
          .catch(err => console.error(`❌ Foydalanuvchiga xabar yuborishda xato:`, err.message));

        ADMIN_IDS.forEach(adminId => {
          const adminMsg = `✅ <b>AVTOMATIK TO'LOV TASDIQLANDI</b>\n\n` +
            `👤 Foydalanuvchi: <b>${p.userName}</b> (ID: ${p.userId})\n` +
            `📦 Buyurtma: <b>${p.orderNum}</b>\n` +
            `💰 Summa: <b>${p.amount.toLocaleString('uz')} so'm</b>\n` +
            `📞 Tel: ${p.phone}\n` +
            `📍 Manzil: ${p.addr}`;

          botInstance.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' })
            .catch(err => console.error(`❌ Adminga xabar yuborishda xato:`, err.message));
        });
      }

      firebasePatch(`orders/${p.orderNum.replace('#','')}`, { status: 'confirmed' })
        .catch(e => console.error("Failed to update status in Firebase:", e));

      deletePendingPaymentFromDb(p);
    }
  }
}

// ===== SERVER =====
app.listen(PORT, async () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📱 APP_URL: ${APP_URL}`);
  
  // Database sync on startup
  await loadSettingsFromDb();
  await loadPendingPayments();
  initializeTelegramBot();
  
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'belgilanmagan'}`);
});
