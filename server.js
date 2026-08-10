const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENVIRONMENT VARIABLES =====
const BOT_TOKEN   = process.env.BOT_TOKEN;
const ADMIN_IDS   = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const APP_URL     = process.env.APP_URL || `https://your-app.railway.app`;

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== TELEGRAM BOT =====
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // /start buyrug'i
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'Foydalanuvchi';

    bot.sendMessage(chatId,
      `👋 Salom, <b>${firstName}</b>!\n\n🛒 <b>TechStore</b>ga xush kelibsiz!\nYangi texnologiyalar va gadjetlar do'koni.\n\nQuyidagi tugma orqali do'konni oching:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🛍️ Do\'konni ochish', web_app: { url: APP_URL } }
          ]]
        }
      }
    );
  });

  // /admin buyrug'i — faqat adminlarga
  bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || '');
    const firstName = msg.from?.first_name || 'Admin';

    // Admin ID tekshirish
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(userId)) {
      bot.sendMessage(chatId, '🚫 Sizda admin huquqi yo\'q!');
      return;
    }

    // Admin URL — maxsus parametr bilan
    const adminUrl = `${APP_URL}?admin_access=true&uid=${userId}`;

    bot.sendMessage(chatId,
      `🔐 <b>Admin Panel</b>\n\nSalom, <b>${firstName}</b>!\nAdmin panelga kirish uchun quyidagi tugmani bosing.\n\n⚡ Parol so'ralmaydi — avtomatik kirish.`,
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

  // /help buyrug'i
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
      `📋 <b>Buyruqlar ro'yxati:</b>\n\n/start — Do'konni ochish\n/admin — Admin panel (faqat adminlar)\n/help — Yordam`,
      { parse_mode: 'HTML' }
    );
  });

  console.log('✅ Telegram bot ishga tushdi (polling mode)');
} else {
  console.warn('⚠️  BOT_TOKEN topilmadi. Bot ishlayapman emas.');
}

// ===== SERVER START =====
app.listen(PORT, () => {
  console.log(`🚀 Server ishga tushdi: http://localhost:${PORT}`);
  console.log(`📱 APP_URL: ${APP_URL}`);
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'belgilanmagan'}`);
});
