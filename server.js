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

// ===== ENVIRONMENT VARIABLES =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const APP_URL   = process.env.APP_URL || `https://your-app.railway.app`;

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== IN-MEMORY PENDING PAYMENTS =====
const pendingPayments = []; // array of { amount, userId, userName, orderNum, phone, addr, ts }

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

// To'lovni ro'yxatga olish API (Xavfsiz qilingan)
app.post('/api/register-payment', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const hostname = req.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  
  // Faqat Telegram Mini App yoki local dev orqali kirishga ruxsat
  if (!isLocal && !verifyTelegramAuth(initData)) {
    console.warn(`⚠️  Xavfsizlik: Noma'lum manbadan so'rov rad etildi! IP: ${req.ip}`);
    return res.status(401).json({ error: "Xavfsizlik xatosi: So'rov faqat Telegram orqali qabul qilinadi" });
  }

  const { amount, userId, userName, orderNum, phone, addr } = req.body;
  if (!amount || !userId) {
    return res.status(400).json({ error: "Noto'g'ri ma'lumotlar" });
  }

  // Eski bir xil summadagi to'lovlarni o'chirib tashlaymiz (faqat oxirgisi qolishi uchun)
  const cleanAmount = Number(amount);
  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    if (pendingPayments[i].amount === cleanAmount) {
      pendingPayments.splice(i, 1);
    }
  }

  pendingPayments.push({
    amount: cleanAmount,
    userId: String(userId),
    userName: userName || 'Foydalanuvchi',
    orderNum: orderNum || 'Nomalum',
    phone: phone || '',
    addr: addr || '',
    ts: Date.now()
  });

  console.log(`📝 Yangi to'lov kutilmoqda: Order ${orderNum}, Summa: ${cleanAmount} so'm, User: ${userName} (${userId})`);
  res.json({ success: true });
});

// ===== TELEGRAM BOT (POLLING) =====
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, {
    polling: {
      interval: 300,
      autoStart: true,
      params: { timeout: 10 }
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Polling xatosi:', err.code, err.message);
  });

  // /start
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

  // /admin
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

  // /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
      `📋 <b>Buyruqlar:</b>\n\n/start — Do'konni ochish\n/admin — Admin panel\n/help — Yordam`,
      { parse_mode: 'HTML' }
    );
  });

  // ===== TO'LOV XABARLARINI AVTOMATIK KUZATISH TIZIMI =====
  function handlePaymentMessage(msg) {
    const text = msg.text || msg.caption;
    if (!text) return;

    // Har qanday kiruvchi xabardagi raqamlarni tozalab olamiz
    // Masalan: "Humo Kirim: +30 000 010.00 UZS" -> "3000001000" (tiyinlar) yoki "30000010"
    const cleanText = text.replace(/[^0-9]/g, '');
    if (!cleanText) return;

    console.log(`📩 Kuzatilayotgan xabar: "${text.replace(/\n/g, ' ')}"`);

    // Pending to'lovlar bilan taqqoslaymiz
    for (let i = pendingPayments.length - 1; i >= 0; i--) {
      const p = pendingPayments[i];
      const amountStr = String(p.amount);

      // Agar xabardagi raqamlar ketma-ketligida kutilayotgan noyob summa mavjud bo'lsa
      if (cleanText.includes(amountStr)) {
        console.log(`🎯 TO'LOV MOS KELDI! Summa: ${p.amount} so'm, Buyurtma: ${p.orderNum}`);

        // Foydalanuvchiga tasdiqlash xabari (Chiroyli shaklda)
        const userMsg = `🎉 <b>To'lov qabul qilindi!</b>\n\n` +
          `Salom, <b>${p.userName}</b>!\n` +
          `Sizning <b>${p.amount.toLocaleString('uz')} so'm</b> to'lovingiz avtomatik ravishda tasdiqlandi. ✅\n\n` +
          `📦 Buyurtma raqami: <b>${p.orderNum}</b>\n\n` +
          `📞 Admin bilan bog'lanib buyurtmangizni olishingiz mumkin:\n` +
          `👉 <b>@Jahongir_1220</b>\n\n` +
          `Siz bilan hamkorlikdan mamnunmiz! ⚡`;

        bot.sendMessage(p.userId, userMsg, { parse_mode: 'HTML' })
          .then(() => console.log(`✉️ Foydalanuvchiga tasdiqlash xabari yuborildi: ${p.userId}`))
          .catch(err => console.error(`❌ Foydalanuvchiga xabar yuborishda xato:`, err.message));

        // Adminga xabar yuboramiz (barcha adminlarga)
        ADMIN_IDS.forEach(adminId => {
          const adminMsg = `✅ <b>AVTOMATIK TO'LOV TASDIQLANDI</b>\n\n` +
            `👤 Foydalanuvchi: <b>${p.userName}</b> (ID: ${p.userId})\n` +
            `📦 Buyurtma: <b>${p.orderNum}</b>\n` +
            `💰 Summa: <b>${p.amount.toLocaleString('uz')} so'm</b>\n` +
            `📞 Tel: ${p.phone}\n` +
            `📍 Manzil: ${p.addr}`;

          bot.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' })
            .catch(err => console.error(`❌ Adminga xabar yuborishda xato:`, err.message));
        });

        // Firebase da order statusini 'paid' ga o'zgartirishga harakat qilamiz (REST orqali)
        // Agar Firebase ruxsat bersa, status o'zgaradi, bo'lmasa xatolik tutib ketiladi (hech narsa bo'lmaydi)
        fetch(`https://techstore-7018f-default-rtdb.firebaseio.com/orders/${p.orderNum.replace('#','')}/status.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify('paid')
        }).catch(()=>{});

        // Ro'yxatdan o'chirib tashlaymiz
        pendingPayments.splice(i, 1);
      }
    }
  }

  // To'lov kanali yoki guruhdagi barcha xabarlarni tinglash
  bot.on('channel_post', (msg) => {
    handlePaymentMessage(msg);
  });

  bot.on('message', (msg) => {
    // Slash buyruqlarni tekshirmaymiz
    if (msg.text && msg.text.startsWith('/')) return;
    handlePaymentMessage(msg);
  });

  console.log('✅ Telegram bot ishga tushdi (polling mode & automatic payment verification active)');
} else {
  console.warn('⚠️  BOT_TOKEN topilmadi!');
}

// ===== SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📱 APP_URL: ${APP_URL}`);
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'belgilanmagan'}`);
});
