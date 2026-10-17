const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { createBotFeatures } = require('./bot-features');
const crypto = require('crypto');
const fs = require('fs');
const compression = require('compression');
const { createAssistant, CATEGORY_ENUM } = require('./assistant');
const PRODUCT_TYPES = require('./product-types');
const { createModel3D } = require('./model3d');

// ===== SAQLASH JOYI =====
// Railway'da Volume (doimiy disk) ulangan bo'lsa, barcha ma'lumotlar o'sha yerda saqlanadi va
// deploy'da o'chmaydi. Aks holda Firebase ishlatiladi; Firebase ham ishlamasa — vaqtinchalik fayl.
const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || '';
const REPO_DB_FILE = path.join(__dirname, 'db.json');
const DB_FILE = VOLUME_DIR ? path.join(VOLUME_DIR, 'db.json') : REPO_DB_FILE;
let storageMode = VOLUME_DIR ? 'volume' : 'firebase'; // 'volume' | 'firebase' | 'ephemeral'
let storageError = '';

function getStorageInfo() {
  return { mode: storageMode, persistent: storageMode !== 'ephemeral', error: storageError, volume: VOLUME_DIR || null };
}

function switchToLocalStorage(reason) {
  if (storageMode !== 'firebase') return;
  storageMode = 'ephemeral';
  storageError = reason;
  console.error(`❌ Firebase'ga yozib bo'lmadi (${reason}). Ma'lumotlar vaqtinchalik faylda saqlanadi va deploy'da O'CHADI! Railway'da Volume ulang yoki Firebase qoidalarini tuzating.`);
}

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
let SHOP_CHANNEL = (process.env.SHOP_CHANNEL || '').replace(/^@/, '');
let SHOP_AUTOPOST = true;   // yangi mahsulot qo'shilganda kanalga avtomatik e'lon
// To'lovlar kanali: bank xabarlari shu kanalga tushadi, bot va yordamchi faqat shu kanalni kuzatib to'lovni tasdiqlaydi
let PAYMENT_CHANNEL = { id: String(process.env.PAYMENT_CHANNEL_ID || '').trim(), title: '' };
const seenChannels = new Map();   // botga kelgan kanallar (admin panelda tanlash uchun taklif)
// -1001234567890, 1234567890 → "1234567890" (Bot API va GramJS bir xil ko'rinishda solishtiriladi)
function chanKey(id) { return String(id || '').trim().replace(/^-100/, '').replace(/^-/, ''); }
function isPaymentChannel(id) { return !!PAYMENT_CHANNEL.id && chanKey(id) === chanKey(PAYMENT_CHANNEL.id); }
const APP_URL   = process.env.APP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `https://your-app.railway.app`);

// Bot chatidagi pastki "Menu" tugmasini doim do'konning haqiqiy manziliga o'rnatamiz
// (BotFather'da eski/boshqa havola qolib ketgan bo'lsa ham ustidan yoziladi)
function setShopMenuButton(bot, chatId) {
  const form = {
    menu_button: JSON.stringify({ type: 'web_app', text: "🛍️ Do'kon", web_app: { url: APP_URL } })
  };
  if (chatId) form.chat_id = chatId;
  return bot.setChatMenuButton(form).catch(err => console.error('Menu tugmasini o\'rnatishda xato:', err.message));
}

const DEFAULT_PRODUCTS = [
  {id:1,  name:'iPhone 16 Pro Max',       brand:'Apple',   price:18500000, discount:15, emoji:'📱', image:'https://images.unsplash.com/photo-1695048133142-1a20484d2569?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1695048133142-1a20484d2569?q=80&w=600&auto=format&fit=crop'], cat:'Telefonlar',    rating:4.9, reviews:248, desc:'Professional darajadagi kamera tizimi, A18 Pro chip va titan rama bilan jihozlangan.',      specs:[['Ekran','6.9 OLED'],['Protsessor','A18 Pro'],['Kamera','48MP Triple'],['Batareya','4685 mAh'],['Rang','Titanium']]},
  {id:2,  name:'Samsung Galaxy S25 Ultra',brand:'Samsung', price:15000000, discount:10, emoji:'📱', image:'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?q=80&w=600&auto=format&fit=crop'], cat:'Telefonlar',    rating:4.8, reviews:312, desc:'Snapdragon 8 Elite, 200MP kamera va S Pen bilan jihozlangan flagman smartfon.',            specs:[['Ekran','6.9 AMOLED'],['Protsessor','Snapdragon 8 Elite'],['Kamera','200MP'],['Batareya','5000 mAh'],['RAM','12GB']]},
  {id:3,  name:'MacBook Air M3',          brand:'Apple',   price:24000000, discount:0,  emoji:'💻', image:'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?q=80&w=600&auto=format&fit=crop'], cat:'Kompyuterlar', rating:4.8, reviews:183, desc:'Ultra-yengil korpus, M3 chip va 18 soatlik batareya muddati.',                              specs:[['Ekran','13.6 Liquid Retina'],['Chip','Apple M3'],['RAM','8GB'],['Xotira','256GB SSD'],['Og\'irlik','1.24 kg']]},
  {id:4,  name:'MacBook Pro M3 Pro',      brand:'Apple',   price:35000000, discount:5,  emoji:'💻', image:'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?q=80&w=600&auto=format&fit=crop'], cat:'Kompyuterlar', rating:4.9, reviews:97,  desc:'M3 Pro chip bilan professional darajadagi unumdorlik va Liquid Retina XDR displey.',        specs:[['Ekran','16 Liquid Retina XDR'],['Chip','Apple M3 Pro'],['RAM','18GB'],['Xotira','512GB SSD'],['Og\'irlik','2.14 kg']]},
  {id:5,  name:'iPad Pro M4 13"',         brand:'Apple',   price:18000000, discount:0,  emoji:'📱', image:'https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?q=80&w=600&auto=format&fit=crop'], cat:'Kompyuterlar', rating:4.9, reviews:156, desc:'Eng nozik Apple qurilmasi, M4 chip va Ultra Retina XDR OLED displey.',                      specs:[['Ekran','13 Ultra Retina XDR'],['Chip','Apple M4'],['RAM','8GB'],['Xotira','256GB'],['Qalinlik','5.1mm']]},
  {id:6,  name:'Sony WH-1000XM5',         brand:'Sony',    price:3200000,  discount:20, emoji:'🎧', image:'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=600&auto=format&fit=crop'], cat:'Audio',        rating:4.7, reviews:412, desc:'Industry-leading shovqin o\'chirish texnologiyasi va 30 soatlik batareya.',                 specs:[['Tip','Over-ear'],['ANC','30dB'],['Batareya','30 soat'],['Ulanish','Bluetooth 5.2'],['Og\'irlik','250g']]},
  {id:7,  name:'AirPods Pro 2',           brand:'Apple',   price:2800000,  discount:0,  emoji:'🎧', image:'https://images.unsplash.com/photo-1588449668365-d15e397f6787?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1588449668365-d15e397f6787?q=80&w=600&auto=format&fit=crop'], cat:'Audio',        rating:4.8, reviews:534, desc:'H2 chip, adaptiv shovqin bekor qilish va Spatial Audio texnologiyasi.',                    specs:[['Tip','In-ear'],['ANC','2x kuchli'],['Batareya','30 soat (quticha)'],['Ulanish','Bluetooth 5.3'],['Suv','IPX4']]},
  {id:8,  name:'Apple Watch Ultra 2',     brand:'Apple',   price:9800000,  discount:0,  emoji:'⌚', image:'https://images.unsplash.com/photo-1434494878577-86c23bcb06b9?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1434494878577-86c23bcb06b9?q=80&w=600&auto=format&fit=crop'], cat:'Aksessuarlar', rating:4.9, reviews:96,  desc:'Ekstremal sharoitlar uchun mo\'ljallangan eng kuchli Apple Watch.',                         specs:[['Ekran','49mm OLED'],['Batareya','36 soat'],['Suv','100m'],['GPS','Dual frequency'],['Korpus','Titan']]},
  {id:9,  name:'Samsung Galaxy Watch 7',  brand:'Samsung', price:4200000,  discount:15, emoji:'⌚', image:'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=600&auto=format&fit=crop'], cat:'Aksessuarlar', rating:4.6, reviews:203, desc:'BioActive Sensor va AI salomatlik kuzatuvi bilan zamonaviy smartwatch.',                    specs:[['Ekran','1.3 AMOLED'],['Batareya','40 soat'],['Suv','5ATM'],['OS','Wear OS'],['Protsessor','Exynos W1000']]},
  {id:10, name:'PlayStation 5 Slim',      brand:'Sony',    price:8500000,  discount:0,  emoji:'🎮', image:'https://images.unsplash.com/photo-1606813907291-d86efa9b94db?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?q=80&w=600&auto=format&fit=crop'], cat:'O\'yinlar',    rating:4.8, reviews:678, desc:'8K grafik, ultra-tez SSD va immersiv DualSense controller bilan yangi avlod konsol.',      specs:[['CPU','8-core AMD Zen 2'],['GPU','10.28 TFLOPS'],['RAM','16GB GDDR6'],['Xotira','1TB SSD'],['Optik','4K Blu-ray']]},
  {id:11, name:'DJI Mini 4 Pro',          brand:'DJI',     price:9000000,  discount:10, emoji:'🚁', image:'https://images.unsplash.com/photo-1508614589041-895b88991e3e?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1508614589041-895b88991e3e?q=80&w=600&auto=format&fit=crop'], cat:'Dronlar',      rating:4.8, reviews:145, desc:'249g yengil, 4K/60fps video va omnidirectional obstacle sensing bilan professional dron.', specs:[['Video','4K/60fps HDR'],['Kamera','1/1.3" CMOS'],['Uchish','34 daqiqa'],['Masofa','20km'],['Og\'irlik','249g']]},
  {id:12, name:'GoPro Hero 13 Black',     brand:'GoPro',   price:4500000,  discount:0,  emoji:'📷', image:'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?q=80&w=600&auto=format&fit=crop'], cat:'Kameralar',    rating:4.7, reviews:289, desc:'5.3K video, HyperSmooth 6.0 va 13 metr chuqurlikda suv o\'tkazmasligi.',                  specs:[['Video','5.3K/60fps'],['Foto','24.7MP'],['Suv','13m'],['Batareya','Enduro'],['Og\'irlik','154g']]},
  {id:13, name:'Xiaomi 14 Ultra',         brand:'Xiaomi',  price:10500000, discount:12, emoji:'📱', image:'https://images.unsplash.com/photo-1598327105666-5b89351aff97?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1598327105666-5b89351aff97?q=80&w=600&auto=format&fit=crop'], cat:'Telefonlar',    rating:4.7, reviews:267, desc:'Leica optikasi, Snapdragon 8 Gen 3 va 90W simsiz quvvatlash.',                             specs:[['Ekran','6.73 AMOLED'],['Protsessor','Snapdragon 8 Gen 3'],['Kamera','50MP Leica'],['Batareya','5000 mAh'],['Quvvatlash','90W']]},
  {id:14, name:'Samsung Galaxy Z Fold 6', brand:'Samsung', price:22000000, discount:8,  emoji:'📱', image:'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?q=80&w=600&auto=format&fit=crop'], cat:'Telefonlar',    rating:4.7, reviews:134, desc:'7.6" katlanadigan displey, S Pen qo\'llab-quvvatlash va titan korpus.',                   specs:[['Asosiy','7.6 AMOLED'],['Tashqi','6.3 AMOLED'],['Protsessor','Snapdragon 8 Gen 3'],['RAM','12GB'],['Batareya','4400 mAh']]},
  {id:15, name:'Dell XPS 15 OLED',        brand:'Dell',    price:22000000, discount:5,  emoji:'💻', image:'https://images.unsplash.com/photo-1593642632823-8f785ba67e45?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1593642632823-8f785ba67e45?q=80&w=600&auto=format&fit=crop'], cat:'Kompyuterlar', rating:4.7, reviews:118, desc:'3.5K OLED touch displey, Intel Core i9 va RTX 4070 grafik karta bilan professional noutbuk.',specs:[['Ekran','15.6 3.5K OLED'],['Protsessor','Intel Core i9'],['RAM','32GB DDR5'],['Xotira','1TB SSD'],['GPU','RTX 4070']]},
  {id:16, name:'Bose QuietComfort 45',    brand:'Bose',    price:2500000,  discount:10, emoji:'🎧', image:'https://images.unsplash.com/photo-1546435770-a3e426bf472b?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1546435770-a3e426bf472b?q=80&w=600&auto=format&fit=crop'], cat:'Audio',        rating:4.6, reviews:356, desc:'Dunyoga mashhur shovqin bekor qilish va 24 soatlik batareya.',                             specs:[['Tip','Over-ear'],['ANC','WorldClass'],['Batareya','24 soat'],['Ulanish','Bluetooth 5.1'],['Og\'irlik','238g']]},
  {id:17, name:'Apple TV 4K (3-avlod)',   brand:'Apple',   price:2200000,  discount:0,  emoji:'📺', image:'https://images.unsplash.com/photo-1593305841991-05c297ba4575?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1593305841991-05c297ba4575?q=80&w=600&auto=format&fit=crop'], cat:'Smart TV',     rating:4.7, reviews:201, desc:'A15 Bionic chip, Dolby Vision va HDR10+ qo\'llab-quvvatlash.',                            specs:[['Chip','A15 Bionic'],['Video','4K Dolby Vision'],['Audio','Dolby Atmos'],['Xotira','64GB'],['Port','HDMI 2.1']]},
  {id:18, name:'Samsung 65" Neo QLED 8K', brand:'Samsung', price:45000000, discount:10, emoji:'📺', image:'https://images.unsplash.com/photo-1593789198777-f29bc259780e?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1593789198777-f29bc259780e?q=80&w=600&auto=format&fit=crop'], cat:'Smart TV',     rating:4.8, reviews:67,  desc:'8K Neo QLED texnologiyasi va Neural Quantum Processor bilan.',                             specs:[['Ekran','65" 8K QLED'],['Yorqinlik','4000 nit'],['OS','Tizen'],['Ulanish','Wi-Fi 6E'],['Dinamik','6.2.4 ch']]},
  {id:19, name:'Logitech MX Master 3S',   brand:'Logitech',price:1200000,  discount:0,  emoji:'🖱️', image:'https://images.unsplash.com/photo-1615663245857-ac93bb7c39e7?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1615663245857-ac93bb7c39e7?q=80&w=600&auto=format&fit=crop'], cat:'Aksessuarlar', rating:4.8, reviews:445, desc:'8000 DPI, magnit scroll va ergonomik dizayn bilan professional sichqoncha.',               specs:[['DPI','200-8000'],['Tugmalar','7'],['Batareya','70 kun'],['Ulanish','Bluetooth + USB'],['Og\'irlik','141g']]},
  {id:20, name:'OnePlus 12 5G',           brand:'OnePlus', price:8000000,  discount:18, emoji:'📱', image:'https://images.unsplash.com/photo-1565849906660-bf47eb869a73?q=80&w=600&auto=format&fit=crop', images:['https://images.unsplash.com/photo-1565849906660-bf47eb869a73?q=80&w=600&auto=format&fit=crop'], cat:'Telefonlar',    rating:4.7, reviews:198, desc:'Snapdragon 8 Gen 3, Hasselblad optikasi va 100W SUPERVOOC quvvatlash.',                    specs:[['Ekran','6.82 AMOLED 120Hz'],['Protsessor','Snapdragon 8 Gen 3'],['Kamera','50MP Hasselblad'],['Batareya','5400 mAh'],['Quvvatlash','100W SUPERVOOC']]}
];

function getNestedValue(obj, path) {
  const parts = path.split('/').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setNestedValue(obj, path, value) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    return value;
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return obj;
}

function patchNestedValue(obj, path, value) {
  const parts = path.split('/').filter(Boolean);
  
  if (parts.length === 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        obj = {};
      }
      for (const key of Object.keys(value)) {
        if (key.includes('/')) {
          obj = setNestedValue(obj, key, value[key]);
        } else {
          obj[key] = value[key];
        }
      }
      return obj;
    }
    return value;
  }
  
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  
  const lastPart = parts[parts.length - 1];
  if (current[lastPart] === undefined || current[lastPart] === null || typeof current[lastPart] !== 'object') {
    current[lastPart] = {};
  }
  
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key.includes('/')) {
        current[lastPart] = setNestedValue(current[lastPart], key, value[key]);
      } else {
        current[lastPart][key] = value[key];
      }
    }
  } else {
    current[lastPart] = value;
  }
  
  return obj;
}

function deleteNestedValue(obj, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    return {};
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
      return obj;
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1];
  if (current && typeof current === 'object') {
    delete current[lastPart];
  }
  return obj;
}

function readLocalDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {};
    }
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error('Error reading local db:', e.message);
    return {};
  }
}

function writeLocalDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing local db:', e.message);
  }
}

function initializeDbFile() {
  let data = {};
  if (fs.existsSync(DB_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.warn("db.json was invalid, reinitializing:", e.message);
      data = {};
    }
  }

  let modified = false;
  if (!data.products || !Array.isArray(data.products) || data.products.length === 0) {
    data.products = DEFAULT_PRODUCTS;
    modified = true;
  }
  if (!data.settings) {
    data.settings = {
      card: {
        number: "9860 3501 4074 7741",
        owner: "Tojiboyev Jahongir"
      },
      bot: {
        token: ""
      },
      admin: {
        telegramIds: ""
      }
    };
    modified = true;
  } else {
    if (!data.settings.card) {
      data.settings.card = { number: "9860 3501 4074 7741", owner: "Tojiboyev Jahongir" };
      modified = true;
    }
    if (!data.settings.bot) {
      data.settings.bot = { token: "" };
      modified = true;
    }
    if (!data.settings.admin) {
      data.settings.admin = { telegramIds: "" };
      modified = true;
    }
  }
  if (!data.users) {
    data.users = {};
    modified = true;
  }
  if (!data.orders) {
    data.orders = {};
    modified = true;
  }

  if (modified) {
    writeLocalDb(data);
    console.log("📂 Local db.json pre-populated with default products and settings.");
  }
}

// Server ishga tushganda: saqlash joyini aniqlash
async function prepareStorage() {
  if (VOLUME_DIR) {
    fs.mkdirSync(VOLUME_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      // Volume birinchi marta ulanganda: mavjud ma'lumotlarni Firebase'dan (bo'lmasa repodagi fayldan) ko'chiramiz
      let seed = null;
      try {
        const res = await fetch(`${DB_URL}/.json`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) seed = await res.json();
      } catch (e) { /* Firebase ishlamasa repodagi fayldan */ }
      if (!seed || typeof seed !== 'object') {
        try { seed = JSON.parse(fs.readFileSync(REPO_DB_FILE, 'utf8')); } catch (e) { seed = {}; }
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf8');
      console.log(`💾 Volume'ga boshlang'ich ma'lumotlar ko'chirildi: ${DB_FILE}`);
    }
    console.log(`💾 Saqlash: Railway Volume (${VOLUME_DIR}) — deploy'da o'chmaydi`);
  } else {
    // Firebase'ga yozish ishlayaptimi — sinab ko'ramiz
    try {
      const res = await fetch(`${DB_URL}/_health.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: Date.now() }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 120);
        throw new Error(`HTTP ${res.status} ${body}`);
      }
      console.log('💾 Saqlash: Firebase (ishlayapti)');
    } catch (e) {
      switchToLocalStorage(e.message);
    }
  }
  initializeDbFile();
}

// ===== FIREBASE REST CLIENT =====
async function firebaseGet(path) {
  if (storageMode !== 'firebase') return getNestedValue(readLocalDb(), path) ?? null;
  try {
    const res = await fetch(`${DB_URL}/${path}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Firebase GET error at ${path}: ${e.message} - falling back to local db.json`);
    const dbData = readLocalDb();
    return getNestedValue(dbData, path) ?? null;
  }
}

async function firebasePut(path, data) {
  try {
    if (storageMode !== 'firebase') throw new Error('local');
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.message !== 'local') {
      console.error(`Firebase PUT error at ${path}: ${e.message} - falling back to local db.json`);
      switchToLocalStorage(e.message);
    }
    let dbData = readLocalDb();
    dbData = setNestedValue(dbData, path, data);
    writeLocalDb(dbData);
    return data;
  }
}

async function firebasePatch(path, data) {
  try {
    if (storageMode !== 'firebase') throw new Error('local');
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.message !== 'local') {
      console.error(`Firebase PATCH error at ${path}: ${e.message} - falling back to local db.json`);
      switchToLocalStorage(e.message);
    }
    let dbData = readLocalDb();
    dbData = patchNestedValue(dbData, path, data);
    writeLocalDb(dbData);
    return data;
  }
}

async function firebaseDelete(path) {
  try {
    if (storageMode !== 'firebase') throw new Error('local');
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.message !== 'local') {
      console.error(`Firebase DELETE error at ${path}: ${e.message} - falling back to local db.json`);
      switchToLocalStorage(e.message);
    }
    let dbData = readLocalDb();
    dbData = deleteNestedValue(dbData, path);
    writeLocalDb(dbData);
    return null;
  }
}


// ===== MAHSULOTLAR KESHI (har so'rovda Firebase'ga murojaat qilmaslik uchun) =====
const PRODUCTS_TTL_MS = 30 * 1000;
let productsCache = null;
let productsCacheAt = 0;
let productsWriteChain = Promise.resolve();

async function getProducts(force = false) {
  if (!force && productsCache && Date.now() - productsCacheAt < PRODUCTS_TTL_MS) return productsCache;
  const data = await firebaseGet('products');
  const list = Array.isArray(data) ? data.filter(Boolean) : (data && typeof data === 'object' ? Object.values(data).filter(Boolean) : []);
  productsCache = list;
  productsCacheAt = Date.now();
  return list;
}

// Mahsulotlar ro'yxatini ketma-ket o'zgartirish (admin panel va yordamchi bir vaqtda yozsa ham yo'qolmasin)
function mutateProducts(fn) {
  const run = productsWriteChain.then(async () => {
    const current = await getProducts(true);
    const { list, result } = await fn([...current]);
    await firebasePut('products', list);
    productsCache = list;
    productsCacheAt = Date.now();
    return result;
  });
  productsWriteChain = run.catch(() => {});
  return run;
}

// To'lov tasdiqlanganda: ombordagi soni kamayadi, sotilganlar soni oshadi ("Ko'p sotilganlar" uchun)
async function deductStockForOrder(order) {
  let items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) {
    const names = String(order.products || '').split(',').map(x => x.trim()).filter(Boolean);
    const list = await getProducts();
    items = names.map(n => { const p = list.find(x => x.name === n); return p ? { id: p.id, qty: 1 } : null; }).filter(Boolean);
  }
  if (!items.length) return;
  await mutateProducts(list => {
    for (const it of items) {
      const p = list.find(x => String(x.id) === String(it.id));
      if (!p) continue;
      const q = Math.max(1, Number(it.qty) || 1);
      p.sold = (Number(p.sold) || 0) + q;
      const v = it.variant && Array.isArray(p.variants) ? p.variants.find(x => String(x.id) === String(it.variant)) : null;
      if (v) { if (v.stock !== null && v.stock !== undefined && v.stock !== '') v.stock = Math.max(0, Number(v.stock) - q); }
      else if (p.stock !== null && p.stock !== undefined && p.stock !== '') p.stock = Math.max(0, Number(p.stock) - q);
    }
    return { list };
  });
}

// ===== BUYURTMA HOLATINI O'ZGARTIRISH (panel va yordamchi uchun umumiy) =====
async function setOrderStatus(orderId, status) {
  const orderPath = `orders/${orderId}`;
  const order = await firebaseGet(orderPath);
  if (!order) return { error: "Buyurtma topilmadi" };

  const patch = { status };
  if (status === 'confirmed' && !order.confirmedAt) patch.confirmedAt = Date.now();
  await firebasePatch(orderPath, patch);

  if (status === 'confirmed' && !order.stockDeducted) {
    await deductStockForOrder(order).catch(e => console.warn('Ombor sonini kamaytirib bo\'lmadi:', e.message));
    await firebasePatch(orderPath, { stockDeducted: true });
  }

  if (status === 'confirmed') {
    // Yordamchi admin: asosiy adminga to'liq ma'lumot + xaridorga xabar
    handleConfirmedOrder(orderId).catch(e => console.error('Buyurtmani qayta ishlashda xato:', e.message));
  } else if (status === 'rejected' && order.userId && global.telegramBotInstance) {
    global.telegramBotInstance.sendMessage(order.userId,
      `❌ <b>Buyurtmangiz rad etildi!</b>\n\nSiz yuborgan to'lov tasdiqlanmadi. Muammo bo'lsa admin bilan bog'laning.`,
      { parse_mode: 'HTML' })
      .catch(err => console.error("Foydalanuvchiga xabar yuborishda xato:", err.message));
  }

  const p = pendingPayments.find(x => x.orderNum === '#' + orderId);
  if (p) await deletePendingPaymentFromDb(p);
  return { success: true };
}

// ===== BUYURTMANI YETKAZISH JARAYONI (yordamchi admin kuzatadi) =====
// 1) To'lov tasdiqlanadi → asosiy adminga to'liq ma'lumot + "Buyurtma yuborildi" tugmasi, xaridorga xabar
// 2) Admin tugmani bosib BTS chekini yuboradi → xaridorga chek bilan "jo'natildi" xabari, fikr so'raladi
// Bazadagi matnlar "<" ">" ni &lt; &gt; qilib saqlaydi: oddiy matnga qaytaramiz, HTML uchun qayta kodlaymiz
const plain = (v) => String(v ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const escStored = (v) => escHtml(plain(v));
const awaitingShipProof = new Map();   // adminChatId -> orderId
const fulfillmentLocks = new Set();

function fmtOrderTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function orderLines(order, orderId) {
  return { num: plain(order.orderNum || ('#' + orderId)), products: plain(order.products || 'Mahsulot'), addr: plain(order.addr || ''), phone: plain(order.phone || '') };
}

// Xaridorga xabar: avval yordamchi akkaunt orqali, bo'lmasa bot orqali
async function messageCustomer(order, { text, html, photoBuffer, photoFileId, sticker }) {
  if (!order.userId) return false;
  const user = await firebaseGet(`users/${order.userId}`).catch(() => null);
  try {
    const ok = await assistant.sendToCustomer({ userId: order.userId, username: user?.username || '', text, photo: photoBuffer });
    if (ok) return 'assistant';
  } catch (e) {
    console.warn('Yordamchi orqali xaridorga yozib bo\'lmadi:', e.message);
  }
  if (!botInstance) return false;
  try {
    if (sticker) await sendStoreSticker(order.userId, sticker);
    if (photoFileId) await botInstance.sendPhoto(order.userId, photoFileId, { caption: html, parse_mode: 'HTML' });
    else if (photoBuffer) await botInstance.sendPhoto(order.userId, photoBuffer, { caption: html, parse_mode: 'HTML' }, { filename: 'chek.jpg', contentType: 'image/jpeg' });
    else await botInstance.sendMessage(order.userId, html, { parse_mode: 'HTML' });
    return 'bot';
  } catch (e) {
    console.warn('Bot orqali xaridorga yozib bo\'lmadi:', e.message);
    return false;
  }
}

async function handleConfirmedOrder(orderId) {
  if (fulfillmentLocks.has(orderId)) return;
  fulfillmentLocks.add(orderId);
  try {
    const order = await firebaseGet(`orders/${orderId}`);
    if (!order || order.fulfillment?.adminNotifiedAt) return;
    if (!botInstance || !ADMIN_IDS.length) return;   // keyinroq kuzatuvchi qayta urinadi
    const o = orderLines(order, orderId);
    const user = order.userId ? await firebaseGet(`users/${order.userId}`).catch(() => null) : null;
    const adminText =
      `🛒 <b>YANGI BUYURTMA — TO'LOV TASDIQLANDI</b>\n\n` +
      `📦 Buyurtma: <b>${escStored(o.num)}</b>\n` +
      `👤 Xaridor: <b>${escStored(order.userName || 'Foydalanuvchi')}</b>${user?.username ? ' (@' + escStored(user.username) + ')' : ''}\n` +
      `🆔 ID: <code>${escStored(order.userId || '—')}</code>\n` +
      `📞 Telefon: ${escStored(o.phone || '—')}\n` +
      `📍 Manzil: ${escStored(o.addr || '—')}\n` +
      `🛍 Mahsulot: <b>${escStored(o.products)}</b>\n` +
      `💰 Summa: <b>${fmtSom(order.total)}</b>\n` +
      `🕐 Vaqt: ${fmtOrderTime(order.createdAt)}\n` +
      `🚚 Yetkazish: BTS pochta\n\n` +
      `Mahsulotni BTS orqali jo'natgach, pastdagi tugmani bosing va chekni yuboring 👇`;
    const adminMessages = [];
    for (const id of ADMIN_IDS) {
      try {
        const m = await botInstance.sendMessage(id, adminText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '📦 Buyurtma yuborildi', callback_data: `ship:${orderId}` }]] },
        });
        adminMessages.push({ chatId: m.chat.id, messageId: m.message_id });
      } catch (e) {
        console.error(`Adminga (${id}) buyurtma xabarini yuborib bo'lmadi:`, e.message);
      }
    }
    if (!adminMessages.length) {
      await firebasePatch(`orders/${orderId}`, { fulfillment: { ...(order.fulfillment || {}), lastAttemptAt: Date.now() } });
      return;
    }

    const name = plain(order.userName || '').trim();
    const text =
      `Assalomu alaykum${name && name !== 'Foydalanuvchi' ? ', ' + name : ''}! ✅ To'lovingiz tasdiqlandi.\n\n` +
      `📦 ${o.num} buyurtmangiz haqidagi ma'lumot adminga jo'natildi. Tez orada buyurtmangiz BTS pochta orqali siz tanlagan manzilga yetib boradi` +
      (o.addr ? `:\n📍 ${o.addr}` : '.') +
      `\n\nSavollaringiz bo'lsa, shu yerga yozing 😊`;
    const html =
      `✅ <b>To'lovingiz tasdiqlandi!</b>\n\n` +
      `📦 <b>${escStored(o.num)}</b> buyurtmangiz haqidagi ma'lumot adminga jo'natildi. Tez orada buyurtmangiz <b>BTS pochta</b> orqali siz tanlagan manzilga yetib boradi.` +
      (o.addr ? `\n📍 ${escStored(o.addr)}` : '') +
      `\n\n<i>TechStore — ishonchli xarid</i> 💜`;
    const via = await messageCustomer(order, { text, html, sticker: 'accepted' });

    await firebasePatch(`orders/${orderId}`, {
      fulfillment: { ...(order.fulfillment || {}), adminNotifiedAt: Date.now(), adminMessages, customerNotifiedVia: via || null },
    });
    console.log(`📦 Buyurtma ${o.num}: adminga yuborildi, xaridorga ${via || 'yuborilmadi'}`);
  } finally {
    fulfillmentLocks.delete(orderId);
  }
}

// Kuzatuvchi: tasdiqlangan, lekin hali adminga yuborilmagan buyurtmalar (masalan bot vaqtincha ishlamagan bo'lsa)
async function sweepConfirmedOrders() {
  try {
    const orders = await firebaseGet('orders');
    if (!orders) return;
    for (const [id, o] of Object.entries(orders)) {
      if (o && o.status === 'confirmed' && o.confirmedAt && !o.fulfillment?.adminNotifiedAt && Date.now() - o.confirmedAt < 7 * 86400e3
        && Date.now() - (o.fulfillment?.lastAttemptAt || 0) > 10 * 60e3) {
        await handleConfirmedOrder(id);
      }
    }
  } catch (e) {
    console.warn('Buyurtmalarni kuzatishda xato:', e.message);
  }
}

async function startShipFlow(bot, query) {
  const orderId = String(query.data).slice(5);
  const fromId = String(query.from.id);
  if (ADMIN_IDS.length && !ADMIN_IDS.includes(fromId)) {
    return bot.answerCallbackQuery(query.id, { text: "Bu amal faqat admin uchun", show_alert: true });
  }
  const order = await firebaseGet(`orders/${orderId}`);
  if (!order) return bot.answerCallbackQuery(query.id, { text: 'Buyurtma topilmadi', show_alert: true });
  if (order.status === 'shipped') return bot.answerCallbackQuery(query.id, { text: 'Bu buyurtma allaqachon yuborilgan ✅', show_alert: true });
  awaitingShipProof.set(String(query.message.chat.id), orderId);
  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(query.message.chat.id,
    `📸 <b>${escStored(order.orderNum || '#' + orderId)}</b> buyurtmasi uchun BTS pochta chekini (rasm) yuboring.\n\nBekor qilish uchun: /cancel`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Chek rasmini yuboring' } });
}

// Admin chek yuborsa: xaridorga chek bilan "jo'natildi" xabari. true — xabar shu jarayonga tegishli edi
async function handleShipProofMessage(bot, msg) {
  const chatId = String(msg.chat.id);
  const orderId = awaitingShipProof.get(chatId);
  if (!orderId) return false;
  if (msg.text && /^\/cancel/.test(msg.text)) {
    awaitingShipProof.delete(chatId);
    await bot.sendMessage(chatId, 'Bekor qilindi.');
    return true;
  }
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : (msg.document?.mime_type?.startsWith('image/') ? msg.document : null);
  if (!photo) {
    if (msg.text && msg.text.startsWith('/')) return false;
    await bot.sendMessage(chatId, '📸 Iltimos, chekni rasm ko\'rinishida yuboring (yoki /cancel).');
    return true;
  }
  awaitingShipProof.delete(chatId);
  let buffer = null;
  try {
    const link = await bot.getFileLink(photo.file_id);
    const r = await fetch(link, { signal: AbortSignal.timeout(30000) });
    if (r.ok) buffer = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn('Chek rasmini yuklab bo\'lmadi:', e.message);
  }
  const r = await shipOrder(orderId, { photoFileId: photo.file_id, buffer, note: (msg.caption || '').trim(), shippedBy: String(msg.from?.id || '') });
  if (r.error) { await bot.sendMessage(chatId, r.error); return true; }
  await bot.sendMessage(chatId, r.via
    ? `✅ ${r.num}: xaridorga chek bilan "buyurtma jo'natildi" xabari yuborildi${r.via === 'bot' ? ' (bot orqali)' : ''}.`
    : `⚠️ ${r.num} "yuborildi" deb belgilandi, lekin xaridorga xabar yetkazib bo'lmadi (u botni bloklagan yoki yozishmani boshlamagan bo'lishi mumkin). Telefon: ${r.phone || '—'}`);
  return true;
}

// Buyurtmani "jo'natildi" qilish (bot va admin panel uchun umumiy): xaridorga chek bilan xabar
async function shipOrder(orderId, { photoFileId = null, buffer = null, imgData = null, note = '', shippedBy = '' }) {
  const order = await firebaseGet(`orders/${orderId}`);
  if (!order) return { error: 'Buyurtma topilmadi.' };
  if (!['confirmed', 'paid', 'shipped'].includes(order.status)) return { error: "Faqat to'lovi tasdiqlangan buyurtmani jo'natish mumkin." };
  const o = orderLines(order, orderId);
  if (!buffer && imgData) {
    const m = String(imgData).match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    if (m) buffer = Buffer.from(m[1], 'base64');
  }
  note = String(note || '').trim().slice(0, 300);
  const text =
    `🚚 Buyurtmangiz yo'lga chiqdi!\n\n` +
    `📦 ${o.num} — ${o.products}\n` +
    `BTS pochta orqali muvaffaqiyatli jo'natildi${buffer || photoFileId ? ', chek rasmda 👆' : '.'}` +
    (o.addr ? `\n📍 ${o.addr}` : '') +
    (note ? `\n📝 ${note}` : '') +
    `\n\nBuyurtmangiz qo'lingizga yetib borgach, iltimos, mahsulot rasmini va qisqa fikringizni shu yerga yozib yuboring — biz uchun juda muhim 🙏\n\nTechStore'ni tanlaganingiz uchun rahmat! 💜`;
  const html =
    `🚚 <b>Buyurtmangiz yo'lga chiqdi!</b>\n\n` +
    `📦 <b>${escStored(o.num)}</b> — ${escStored(o.products)}\n` +
    `BTS pochta orqali muvaffaqiyatli jo'natildi${buffer || photoFileId ? ', chek rasmda 👆' : '.'}` +
    (o.addr ? `\n📍 ${escStored(o.addr)}` : '') +
    (note ? `\n📝 ${escStored(note)}` : '') +
    `\n\nBuyurtmangiz yetib borgach, iltimos, mahsulot rasmini va qisqa fikringizni yozib yuboring 🙏\n\n<i>TechStore'ni tanlaganingiz uchun rahmat!</i> 💜`;
  const via = await messageCustomer(order, { text, html, photoBuffer: buffer, photoFileId, sticker: 'shipping' });

  await firebasePatch(`orders/${orderId}`, {
    status: 'shipped',
    fulfillment: {
      ...(order.fulfillment || {}), shippedAt: Date.now(), shipProofFileId: photoFileId || null,
      shipProofImg: !photoFileId && imgData ? imgData : (order.fulfillment?.shipProofImg || null),
      shippedBy, shipNote: note || null, customerShipNotifiedVia: via || null,
    },
  });
  botFeatures.sendArrivedPrompt(order, orderId).catch(() => {});
  if (botInstance) {
    for (const m of order.fulfillment?.adminMessages || []) {
      botInstance.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Buyurtma yuborildi', callback_data: 'noop' }]] }, { chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
    }
  }
  console.log(`🚚 Buyurtma ${o.num} jo'natildi, xaridorga: ${via || 'yetkazilmadi'}`);
  return { via, num: o.num, phone: o.phone };
}

// ===== EXPRESS =====
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Server fayllari va maxfiy ma'lumotlar statik tarzda berilmasin
const PRIVATE_FILES = new Set(['/server.js', '/assistant.js', '/bot-features.js', '/cutout.js', '/cutout-worker.js', '/model3d.js', '/db.json', '/package.json', '/package-lock.json']);
app.use((req, res, next) => {
  if (PRIVATE_FILES.has(req.path) || req.path.startsWith('/.') || req.path.startsWith('/node_modules')) {
    return res.status(404).end();
  }
  next();
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rasmlar va ikonalar keshlanadi, index.html esa har doim yangilanadi
app.use(express.static(path.join(__dirname), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== RATE LIMITER MIDDLEWARE (DDoS & Spamdan himoya) =====
const requestTracker = new Map(); // IP -> Array of timestamps

// Eski IP yozuvlarini vaqti-vaqti bilan tozalash (xotira o'smasligi uchun)
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, timestamps] of requestTracker) {
    if (!timestamps.length || timestamps[timestamps.length - 1] < cutoff) requestTracker.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function apiRateLimiter(req, res, next) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
  const hostname = req.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || ip === '::1' || ip === '127.0.0.1' || ip.endsWith('127.0.0.1');

  if (isLocal) {
    return next();
  }

  const now = Date.now();
  const limit = 40; // 1 daqiqada maksimal 40 ta so'rov
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
    if (storageMode !== 'firebase') throw new Error('local');
    const res = await fetch(`${DB_URL}/pending_payments.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payment)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    payment.firebaseKey = result.name;
    pendingPayments.push(payment);
    console.log(`📝 Payment registered: ${payment.amount} UZS for order ${payment.orderNum}`);
  } catch (e) {
    console.warn("⚠️ Failed to register pending payment in Firebase, writing to local db.json:", e.message);
    const key = 'local_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    payment.firebaseKey = key;
    
    // Save to local db.json
    let dbData = readLocalDb();
    dbData = setNestedValue(dbData, `pending_payments/${key}`, payment);
    writeLocalDb(dbData);
    
    pendingPayments.push(payment);
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
      if (typeof settings.shop?.channel === 'string') SHOP_CHANNEL = settings.shop.channel;
      if (typeof settings.shop?.autoPost === 'boolean') SHOP_AUTOPOST = settings.shop.autoPost;
      if (settings.payment && typeof settings.payment.channelId === 'string') PAYMENT_CHANNEL = { id: settings.payment.channelId, title: settings.payment.channelTitle || '' };
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
  
  if (isLocal) {
    if (!initData) {
      req.adminUser = { id: 'mock-admin', first_name: 'Local', last_name: 'Admin', username: 'local_admin' };
      return next();
    }
    
    let isValid = verifyTelegramAuth(initData);
    if (!isValid) {
      isValid = true; // Local dev bypass for invalid signature
    }
    
    if (isValid) {
      try {
        const urlParams = new URLSearchParams(initData);
        const userStr = urlParams.get('user');
        if (userStr) {
          req.adminUser = JSON.parse(userStr);
        } else {
          req.adminUser = { id: 'mock-admin', first_name: 'Local', last_name: 'Admin', username: 'local_admin' };
        }
        return next();
      } catch (e) {
        req.adminUser = { id: 'mock-admin', first_name: 'Local', last_name: 'Admin', username: 'local_admin' };
        return next();
      }
    }
  }
  
  if (!initData || !verifyTelegramAuth(initData)) {
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
    },
    assistant: assistant.publicContact(),
    botUsername,
    channel: SHOP_CHANNEL,
    autoPost: SHOP_AUTOPOST
  });
});

// Suffix hisoblash API
app.get('/api/unique-suffix', apiRateLimiter, async (req, res) => {
  const price = parseInt(req.query.price) || 0;
  const suffix = await uniqueSuffixFor(price);
  res.json({ suffix, amount: price + suffix });
});

// Mahsulotlarni olish
// ===== RASMLAR: bazadagi base64 rasmlar o'rniga kichraytirilgan, keshlanadigan havolalar =====
const imgVersionCache = new Map();
function imgVersion(pid, i, src) {
  const key = `${pid}:${i}:${src.length}`;
  let v = imgVersionCache.get(key);
  if (!v) {
    v = crypto.createHash('sha1').update(src.slice(0, 4096)).update(String(src.length)).digest('hex').slice(0, 10);
    if (imgVersionCache.size > 2000) imgVersionCache.clear();
    imgVersionCache.set(key, v);
  }
  return v;
}
function imgUrl(pid, i, src, w) {
  return `/api/img/${encodeURIComponent(pid)}/${i}?w=${w}&v=${imgVersion(pid, i, src)}`;
}
const isDataImg = (src) => typeof src === 'string' && src.startsWith('data:image/');

// Reyting va sharhlar soni FAQAT haqiqiy xaridorlar fikrlaridan hisoblanadi (o'ylab topilgan raqamlar ko'rsatilmaydi)
let ratingsCache = null, ratingsCacheAt = 0;
async function getRealRatings(force = false) {
  if (!force && ratingsCache && Date.now() - ratingsCacheAt < 60000) return ratingsCache;
  const all = (await firebaseGet('reviews')) || {};
  const map = {};
  for (const [pid, revs] of Object.entries(all)) {
    const list = Object.values(revs || {}).filter(r => r && r.rating);
    if (list.length) map[pid] = { count: list.length, avg: Math.round(list.reduce((s, r) => s + Number(r.rating), 0) / list.length * 10) / 10 };
  }
  ratingsCache = map; ratingsCacheAt = Date.now();
  return map;
}
function invalidateRatings() { ratingsCacheAt = 0; }
function withRealRating(p, ratings) {
  if (!p) return p;
  const r = ratings && ratings[String(p.id)];
  return { ...p, rating: r ? r.avg : null, reviews: r ? r.count : 0 };
}

function publicProduct(p, now = Date.now(), ratings = null) {
  if (!p) return p;
  const out = ratings ? withRealRating(p, ratings) : { ...p };
  // Muddati o'tgan chegirma ko'rsatilmaydi (narx o'zgarmaydi, faqat eski narx/foiz yashiriladi)
  if (out.discountUntil && out.discountUntil <= now && out.discount > 0) { out.discount = 0; out.discountUntil = null; }
  const imgs = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : []);
  out.images = imgs.map((src, i) => isDataImg(src) ? imgUrl(p.id, i, src, 1080) : src);
  const ck = cutoutKey(p);
  out.cutout = ck ? `/api/cutout/${encodeURIComponent(p.id)}?v=${ck.key.split('_').pop()}` : null;
  out.depth = ck ? `/api/depth/${encodeURIComponent(p.id)}?v=${ck.key.split('_').pop()}` : null;
  const v3 = view3dSource(p);
  if (v3) {
    const vk = v3.key.split('_').pop();
    out.view3d = { img: v3.kind === 'b' ? `/api/banner-img/${encodeURIComponent(p.id)}?v=${bannerKey(p).key.split('_b').pop()}` : out.cutout,
      depth: `/api/depth/${encodeURIComponent(p.id)}?v=${vk}2${v3.kind}` };
    out.depth = out.view3d.depth;
  }
  out.model3d = model3d.publicInfo(p);
  const bk = bannerKey(p);
  out.banner = bk ? `/api/banner-img/${encodeURIComponent(p.id)}?v=${bk.key.split('_b').pop()}` : null;
  out.bannerReady = bannerReady(p);
  if (out.bannerImage && !/^https:/i.test(out.bannerImage)) delete out.bannerImage;
  delete out.bannerHidden;
  const first = imgs[0];
  out.image = first ? (isDataImg(first) ? imgUrl(p.id, 0, first, 480) : first) : (isDataImg(p.image) ? null : p.image || null);
  return out;
}

// Admin panel tahrirlashda qaytgan /api/img/... havolalarini asl rasmga almashtiradi
function resolveImgRefs(images, raw) {
  if (!Array.isArray(images)) return images;
  const rawImgs = raw ? (Array.isArray(raw.images) && raw.images.length ? raw.images : (raw.image ? [raw.image] : [])) : [];
  return images.map(src => {
    const m = typeof src === 'string' && src.match(/^\/api\/img\/([^/]+)\/(\d+)/);
    if (!m) return src;
    return (raw && String(raw.id) === decodeURIComponent(m[1]) && rawImgs[Number(m[2])]) || null;
  }).filter(Boolean);
}

const resizedCache = new Map();
function resizeImage(buf, w) {
  return new Promise((resolve, reject) => {
    const ffPath = (() => { try { return require('ffmpeg-static'); } catch (_) { return null; } })();
    if (!ffPath) return reject(new Error('ffmpeg yo\'q'));
    const ff = require('child_process').spawn(ffPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', `scale='min(${w},iw)':-2`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', 'pipe:1']);
    const out = [];
    ff.stdout.on('data', d => out.push(d));
    ff.on('error', reject);
    ff.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg ' + code)));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}

// Tashqi sayt rasmlari (banner uchun) server orqali: ba'zi saytlar boshqa domendan to'g'ridan-to'g'ri
// ochishni bloklaydi. Faqat ruxsat etilgan rasm saytlari, kichraytirib keshlanadi.
const PROXY_HOSTS = new Set(['store.storeimages.cdn-apple.com', 'upload.wikimedia.org', 'images.samsung.com', 'oasis.opstatics.com',
  'dji-official-fe.djicdn.com', 'assets.gopro.com', 'i02.appmifile.com', 'i.dell.com', 'assets.bose.com', 'resource.logitech.com',
  'www.pngmart.com', 'images.unsplash.com']);
const proxyCache = new Map();
app.get('/api/img-proxy', async (req, res) => {
  try {
    let u;
    try { u = new URL(String(req.query.u || '')); } catch (_) { return res.status(400).end(); }
    if (u.protocol !== 'https:' || !PROXY_HOSTS.has(u.hostname)) return res.status(403).end();
    const w = Math.max(120, Math.min(1200, parseInt(req.query.w) || 700));
    const key = `${u.href}|${w}`;
    let hit = proxyCache.get(key);
    if (!hit) {
      const r = await fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (TechStore image proxy)', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' }, signal: AbortSignal.timeout(15000) });
      const type = (r.headers.get('content-type') || '').split(';')[0];
      if (!r.ok || !type.startsWith('image/')) {
        proxyCache.set(key, { fail: true, at: Date.now() });
        return res.status(404).end();
      }
      const orig = Buffer.from(await r.arrayBuffer());
      let out = { type, buf: orig };
      try { const webp = await resizeImage(orig, w); if (webp.length < orig.length) out = { type: 'image/webp', buf: webp }; } catch (_) {}
      hit = out;
      if (proxyCache.size > 120) proxyCache.delete(proxyCache.keys().next().value);
      proxyCache.set(key, hit);
    } else if (hit.fail) {
      if (Date.now() - hit.at < 30 * 60e3) return res.status(404).end();
      proxyCache.delete(key);
      return res.redirect(302, req.originalUrl);
    }
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.end(hit.buf);
  } catch (e) {
    res.status(502).end();
  }
});

// ===== BANNER UCHUN "3D" KO'RINISH: mahsulot suratining foni AI bilan olib tashlanadi =====
// Natija diskda keshlanadi (bir mahsulot rasmi uchun bir marta hisoblanadi).
const CUTOUT_DIR = path.join(VOLUME_DIR || path.join(__dirname, 'data'), 'cutouts');
const cutoutJobs = new Map();
function cutoutKey(p) {
  const imgs = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : []);
  const src = imgs[0];
  if (!src) return null;
  return { src, key: `${p.id}_${crypto.createHash('sha1').update(String(src).slice(0, 4096)).update(String(src.length)).digest('hex').slice(0, 12)}` };
}
async function loadImageSource(src) {
  const m = String(src).match(/^data:image\/[a-z+]+;base64,(.+)$/i);
  if (m) return Buffer.from(m[1], 'base64');
  const loc = String(src).match(/^local:([A-Za-z0-9_.-]+)$/);
  if (loc) return fs.readFileSync(path.join(CUTOUT_DIR, 'banner-src', loc[1]));
  if (!/^https:\/\//i.test(src)) throw new Error('rasm manzili yaroqsiz');
  // Ba'zi saytlar (CDN) bitta turdagi so'rovni bloklaydi — bir nechta variant bilan urinib ko'ramiz
  const variants = [
    { 'User-Agent': 'Mozilla/5.0 (TechStore image proxy)', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' },
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Referer: new URL(src).origin + '/' },
    { 'User-Agent': 'curl/8.5.0', Accept: '*/*' },
  ];
  let r = null, lastErr = '';
  for (const headers of variants) {
    try {
      r = await fetch(src, { headers, signal: AbortSignal.timeout(20000) });
      if (r.ok && String(r.headers.get('content-type') || '').startsWith('image/')) break;
      lastErr = 'status ' + r.status; r = null;
    } catch (e) { lastErr = e.message; r = null; }
  }
  if (!r) throw new Error('rasm yuklanmadi: ' + lastErr);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12e6) throw new Error('rasm juda katta');
  return buf;
}
function runCutoutWorker(buf, mode = 'cutout') {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'cutout-worker.js'), mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('vaqt tugadi')); }, 90000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let info = {};
      try { info = JSON.parse(Buffer.concat(err).toString().trim().split('\n').pop() || '{}'); } catch (_) {}
      if (code === 0 && out.length) resolve({ buffer: Buffer.concat(out), coverage: info.coverage, model: info.model });
      else reject(new Error(info.error || 'ishlov berib bo\'lmadi'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}
async function getCutout(p) {
  const k = cutoutKey(p);
  if (!k) return null;
  // .v2 — kattaroq manbadan, aniqroq chetlar bilan (eski xira kesh qayta tayyorlanadi)
  const file = path.join(CUTOUT_DIR, k.key + '.v2.webp');
  const failFile = path.join(CUTOUT_DIR, k.key + '.v2.fail');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(failFile) && Date.now() - fs.statSync(failFile).mtimeMs < 6 * 3600e3) return null;
  if (!cutoutJobs.has(k.key)) {
    // Bir vaqtda bitta ish (CPU va xotira tejaladi)
    const prev = [...cutoutJobs.values()].pop() || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      try {
        const r = await runCutoutWorker(await loadHiRes(k.src));
        // Mahsulot deyarli butun rasmni egallasa yoki juda kichik bo'lsa — fonsiz ko'rinish chiqmaydi
        if (r.coverage && (r.coverage > 0.82 || r.coverage < 0.03)) throw new Error('mahsulot aniq ajralmadi');
        fs.mkdirSync(CUTOUT_DIR, { recursive: true });
        fs.writeFileSync(file, r.buffer);
        return r.buffer;
      } catch (e) {
        console.warn(`🖼 Fonsiz rasm (${p.id}) tayyorlanmadi:`, e.message);
        try { fs.mkdirSync(CUTOUT_DIR, { recursive: true }); fs.writeFileSync(failFile, e.message); } catch (_) {}
        return null;
      } finally {
        cutoutJobs.delete(k.key);
      }
    });
    cutoutJobs.set(k.key, job);
  }
  return cutoutJobs.get(k.key);
}

// "3D" model uchun hajm xaritasi (AI chuqurlik + silhuet). Fonsiz rasm tayyor bo'lgach hisoblanadi.
// 3D ko'rinish uchun rasm: banner uchun tayyorlangan (toza, tekshirilgan, katta) bo'lsa o'sha, aks holda fonsiz surat
function view3dSource(p) {
  if (bannerReady(p)) { const bk = bannerKey(p); return { kind: 'b', key: bk.key, file: path.join(CUTOUT_DIR, bk.key + '.webp') }; }
  const ck = cutoutKey(p);
  return ck ? { kind: 'c', key: ck.key, file: null } : null;
}
async function getDepthMap(p) {
  const k = view3dSource(p);
  if (!k) return null;
  const file = path.join(CUTOUT_DIR, k.key + '.v2.depth.png');
  const failFile = path.join(CUTOUT_DIR, k.key + '.v2.depth.fail');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(failFile) && Date.now() - fs.statSync(failFile).mtimeMs < 6 * 3600e3) return null;
  const jk = k.key + ':depth';
  if (!cutoutJobs.has(jk)) {
    const cut = k.file ? Promise.resolve(fs.readFileSync(k.file)) : getCutout(p);
    const prev = [...cutoutJobs.values()].pop() || Promise.resolve();
    const job = Promise.all([cut, prev.catch(() => {})]).then(async ([cutBuf]) => {
      try {
        if (!cutBuf) throw new Error("fonsiz rasm yo'q");
        const r = await runCutoutWorker(cutBuf, 'depth');
        fs.mkdirSync(CUTOUT_DIR, { recursive: true });
        fs.writeFileSync(file, r.buffer);
        if (!r.model) console.warn(`🧊 Hajm xaritasi (${p.id}) AI modelisiz (faqat silhuet) tayyorlandi`);
        return r.buffer;
      } catch (e) {
        console.warn(`🧊 Hajm xaritasi (${p.id}) tayyorlanmadi:`, e.message);
        try { fs.mkdirSync(CUTOUT_DIR, { recursive: true }); fs.writeFileSync(failFile, e.message); } catch (_) {}
        return null;
      } finally {
        cutoutJobs.delete(jk);
      }
    });
    cutoutJobs.set(jk, job);
  }
  return cutoutJobs.get(jk);
}

// Haqiqiy 3D model (TRELLIS + Gemini nazorati) — HF_TOKEN o'rnatilgan bo'lsa ishlaydi
const model3d = createModel3D({
  dir: path.join(CUTOUT_DIR, 'models3d'),
  getProducts,
  // Kalit barcha rasmlardan: 4 tomondan rasmlar qo'shilsa model qaytadan (aniqroq) yasaladi
  imageKey: p => {
    const imgs = (Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : [])).slice(0, 4);
    if (!imgs.length) return null;
    const h = crypto.createHash('sha1'); imgs.forEach(src => h.update(String(src).slice(0, 4096)).update(String(String(src).length)));
    return `${p.id}_${h.digest('hex').slice(0, 12)}`;
  },
  loadImageSource: p => loadImageSource(cutoutKey(p).src),
  // Kollaj (bitta rasmda 4 tomon) bo'lsa — alohida ko'rinishlarga ajratiladi; jami 4 tagacha
  loadImages: async p => {
    const imgs = (Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : [])).slice(0, 5);
    const out = [];
    for (const src of imgs) {
      if (out.length >= 4) break;
      let buf; try { buf = await loadImageSource(src); } catch (_) { continue; }
      const views = await splitCollage(buf).catch(() => null);
      if (views && views.length >= 2) { console.log(`🧊 3D (${p.id}): kollaj ${views.length} ta ko'rinishga ajratildi`); out.push(...views); }
      else out.push(buf);
    }
    return out.slice(0, 4);
  },
  gemini: (parts, opts) => assistant.geminiGenerate(parts, opts),
  notify: async text => { if (botInstance) await Promise.all(ADMIN_IDS.map(id => botInstance.sendMessage(id, text).catch(() => {}))); },
});
app.get('/api/model3d/:file', async (req, res) => {
  const pid = String(req.params.file).replace(/\.glb$/i, '');
  const f = model3d.fileFor(pid);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  fs.createReadStream(f).pipe(res);
});
app.get('/api/admin/models3d', apiRateLimiter, verifyAdmin, async (req, res) => {
  try { res.json(await model3d.list()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/models3d/:pid/:action(hide|show|rebuild)', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    if (req.params.action === 'rebuild' && !process.env.HF_TOKEN) return res.status(400).json({ error: "Railway'da HF_TOKEN o'rnatilmagan" });
    const ok = model3d.action(req.params.pid, req.params.action);
    if (!ok) return res.status(404).json({ error: '3D model topilmadi' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/depth/:pid', async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).end();
    const buf = await getDepthMap(p);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// ===== BANNER RASMI: har doim fonsiz (shaffof) mahsulot =====
// 1) Admin bergan banner rasmi haqiqatan shaffof bo'lsa — o'zi (chetlari qirqiladi).
// 2) Banner rasmida fon bo'lsa (oq/rangli) — AI bilan foni olib tashlanadi.
// 3) Banner rasmi yo'q yoki ishlamasa — asosiy mahsulot suratining fonsiz varianti.
// Standart mahsulotlar uchun ishlab chiqaruvchi saytlaridagi tayyor shaffof rasmlar (Mini App'dagi bilan bir xil).
// Faqat id VA nom mos kelsa ishlatiladi (admin shu id bilan boshqa mahsulot qo'shgan bo'lsa — yo'q).
const DEFAULT_BANNERS = {
  1: ["iPhone 16 Pro Max", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/iphone-16-pro-finish-select-202409-6-9inch-deserttitanium?wid=2560&hei=1440&fmt=png-alpha"],
  2: ["Samsung Galaxy S25 Ultra", "https://upload.wikimedia.org/wikipedia/commons/e/e5/S24_Onyx_Black.png"],
  3: ["MacBook Air M3", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/mba13-midnight-select-202402?wid=2000&hei=2000&fmt=png-alpha"],
  4: ["MacBook Pro M3 Pro", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/mbp14-spaceblack-select-202310?wid=2000&hei=2000&fmt=png-alpha"],
  5: ["iPad Pro M4 13\"", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/ipad-pro-finish-select-202405-13inch-spaceblack?wid=2000&hei=2000&fmt=png-alpha"],
  6: ["Sony WH-1000XM5", "https://www.pngmart.com/files/6/Sony-Headphone-PNG-File.png"],
  7: ["AirPods Pro 2", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/MTJV3?wid=2000&hei=2000&fmt=png-alpha"],
  8: ["Apple Watch Ultra 2", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/ultra-case-unselect-gallery-1-202409?wid=2000&hei=2000&fmt=png-alpha"],
  9: ["Samsung Galaxy Watch 7", "https://images.samsung.com/is/image/samsung/p6pim/in/sm-l310nzsains/sm-l310nzsains-front-silver?$ORIGIN_PNG$&fmt=png-alpha"],
  10: ["PlayStation 5 Slim", "https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/Black_and_white_Playstation_5_base_edition_with_controller.png/960px-Black_and_white_Playstation_5_base_edition_with_controller.png"],
  11: ["DJI Mini 4 Pro", "https://dji-official-fe.djicdn.com/dps/4e5a0e08f51a704e6c38ce713a0c0a96.png"],
  12: ["GoPro Hero 13 Black", "https://assets.gopro.com/is/image/gopro/hero13-black-camera-hero?wid=1200&fmt=png-alpha"],
  13: ["Xiaomi 14 Ultra", "https://i02.appmifile.com/mi-com-product/fly-birds/xiaomi-14-ultra/pc/6c5ee2c0702d847120a1ebf2d4bf6b22.png"],
  14: ["Samsung Galaxy Z Fold 6", "https://images.samsung.com/is/image/samsung/p6pim/in/sm-f956bdbgins/sm-f956bdbgins-front-silver?$ORIGIN_PNG$&fmt=png-alpha"],
  15: ["Dell XPS 15 OLED", "https://i.dell.com/is/image/DellContent/content/dam/ss2/product-images/dell-client-products/notebooks/xps-notebooks/xps-15-9530/media-gallery/touch-black/notebook-xps-15-9530-t-black-gallery-1.psd?fmt=png-alpha&wid=1400"],
  16: ["Bose QuietComfort 45", "https://assets.bose.com/content/dam/Bose_DAM/Web/consumer_electronics/global/products/headphones/qc45/product_silo_images/qc45_triple_black_EC_hero.png"],
  17: ["Apple TV 4K (3-avlod)", "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/apple-tv-4k-hero-select-202210?wid=2000&hei=2000&fmt=png-alpha"],
  18: ["Samsung 65\" Neo QLED 8K", "https://images.samsung.com/is/image/samsung/p6pim/in/qa65qn900dkxxl/qa65qn900dkxxl-front-black?$ORIGIN_PNG$&fmt=png-alpha"],
  19: ["Logitech MX Master 3S", "https://resource.logitech.com/content/dam/logitech/en/products/mice/mx-master-3s/gallery/mx-master-3s-mouse-top-view-graphite.png"],
  20: ["OnePlus 12 5G", "https://oasis.opstatics.com/content/dam/oasis/page/2024/global/product/12/specs/black-phone.png"]
};
function defaultBanner(p) {
  const d = DEFAULT_BANNERS[p.id];
  return d && String(p.name || '').trim().toLowerCase() === d[0].toLowerCase() ? d[1] : '';
}
const { removeUniformBackground: _rub, splitCollage } = require('./cutout');
// Oq fon usuli + AI niqobi (alohida jarayonda) bilan tekshiriladi
const aiMask = async png => (await runCutoutWorker(png, 'mask')).buffer;
const removeUniformBackground = input => _rub(input, { aiMask });
function bannerKey(p) {
  const ck = cutoutKey(p);
  const src = p.bannerImage || defaultBanner(p);
  if (!src && !ck) return null;
  return { src, key: `${p.id}_b${crypto.createHash('sha1').update('v6').update(String(src).slice(0, 4096)).update(String(src.length)).update(ck ? ck.key : '').digest('hex').slice(0, 12)}` };
}
function ffRaw(args, input) {
  return new Promise((resolve, reject) => {
    const ffPath = (() => { try { return require('ffmpeg-static'); } catch (_) { return null; } })();
    if (!ffPath) return reject(new Error("ffmpeg yo'q"));
    const ff = require('child_process').spawn(ffPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = [];
    ff.stdout.on('data', d => out.push(d));
    ff.on('error', reject);
    ff.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg ' + code)));
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}
// Rasm shaffofmi: 64×64 alfa-kanal bo'yicha — burchaklar shaffof va mahsulot chegarasi
async function alphaInfo(buf) {
  const N = 64;
  const px = await ffRaw(['-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${N}:${N},format=rgba`, '-f', 'rawvideo', 'pipe:1'], buf);
  if (px.length < N * N * 4) return null;
  let clear = 0, x0 = N, y0 = N, x1 = -1, y1 = -1, vis = 0, solid = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const a = px[(y * N + x) * 4 + 3];
    if (a >= 16) vis++; if (a >= 150) solid++;
    if (a < 16) clear++;
    else if (a > 190) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const corner = (x, y) => px[(y * N + x) * 4 + 3] < 16;
  const corners = [corner(0, 0), corner(N - 1, 0), corner(0, N - 1), corner(N - 1, N - 1)].filter(Boolean).length;
  return { transparent: clear / (N * N) > 0.08 && corners >= 3 && x1 > x0, box: [x0 / N, y0 / N, (x1 + 1) / N, (y1 + 1) / N], solid: vis ? solid / vis : 1 };
}
async function transparentToWebp(buf, box, solid = 1) {
  const pad = 0.03;
  // Mahsulotning o'zi ko'p yarim shaffof bo'lsa (kumush/shisha) — faqat juda xira qoldiqlar olinadi, aks holda "arvoh"lar ham
  const lut = solid < 0.85 ? `clip((val-24)*255/60\\,0\\,255)` : `clip((val-120)*255/90\\,0\\,255)`;
  const [bx0, by0, bx1, by1] = [Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(1, box[2] + pad), Math.min(1, box[3] + pad)];
  return ffRaw(['-i', 'pipe:0', '-frames:v', '1', '-vf',
    // Yarim shaffof "arvoh" qismlar (aks, xira soya, ikkinchi xira ko'rinish) olib tashlanadi, chetlar silliq qoladi
    `format=rgba,lutrgb=a='${lut}',crop=iw*${(bx1 - bx0).toFixed(4)}:ih*${(by1 - by0).toFixed(4)}:iw*${bx0.toFixed(4)}:ih*${by0.toFixed(4)},scale='min(1000,iw)':'min(1000,ih)':force_original_aspect_ratio=decrease`,
    '-c:v', 'libwebp', '-lossless', '0', '-quality', '92', '-f', 'webp', 'pipe:1'], buf);
}
const BANNER_PASS = 7;
const bannerMetaPath = k => path.join(CUTOUT_DIR, k.key + '.json');
function readBannerMeta(k) { try { return JSON.parse(fs.readFileSync(bannerMetaPath(k), 'utf8')); } catch (_) { return null; } }
async function getBannerImage(p) {
  const k = bannerKey(p);
  if (!k) return null;
  const file = path.join(CUTOUT_DIR, k.key + '.webp');
  const meta = readBannerMeta(k);
  if (fs.existsSync(file) && meta) {
    // Banner rasmining o'zi yuklanmagan va mahsulot suratidan kesilgan bo'lsa — 1 soatdan keyin asl rasmni qayta sinaymiz
    const retrySource = meta.from === 'photo' && k.src && Date.now() - (meta.at || 0) > 3600e3;
    if (!retrySource) return meta.ok ? fs.readFileSync(file) : null;
  } else if (meta && !meta.ok && Date.now() - (meta.at || 0) < 6 * 3600e3) return null;
  const jk = k.key + ':banner';
  if (!cutoutJobs.has(jk)) {
    const prev = [...cutoutJobs.values()].pop() || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      const save = (buf, m) => {
        fs.mkdirSync(CUTOUT_DIR, { recursive: true });
        if (buf) fs.writeFileSync(file, buf);
        fs.writeFileSync(bannerMetaPath(k), JSON.stringify({ ...m, at: Date.now() }));
        if (!m.ok) console.warn(`🖼 Banner rasmi (${p.id}) bannerga qo'yilmaydi: ${m.why || ''} ${m.score != null ? '(baho ' + m.score + ')' : ''}`);
        return m.ok ? buf : null;
      };
      try {
        let why = '';
        // 1) Admin bergan (yoki standart) banner rasmi
        if (k.src) {
          try {
            const src = await loadImageSource(k.src);
            // Oq/kulrang bir xil fon (yoki shaffof chet ichidagi oq karta) — chetdan to'ldirib aniq olib tashlaymiz
            const ub = await removeUniformBackground(src).catch(() => null);
            if (ub) {
              const { buffer, v } = await pickUniform(ub, p);
              if (!v || v.score >= BANNER_PASS) return save(buffer, { ok: true, from: 'banner-white', score: v?.score ?? null, issues: v?.issues });
            }
            const info = await alphaInfo(src).catch(() => null);
            if (info && info.transparent) return save(await transparentToWebp(src, info.box, info.solid), { ok: true, from: 'banner' });
            const r = await runCutoutWorker(src);
            if (r.coverage && (r.coverage > 0.82 || r.coverage < 0.03)) throw new Error('banner rasmida mahsulot aniq ajralmadi');
            const v = await judgeCutout(r.buffer, p);
            if (!v || v.score >= BANNER_PASS) return save(r.buffer, { ok: true, from: 'banner-ai', score: v?.score ?? null, issues: v?.issues });
            why = `banner rasmidan kesilgani sifatsiz: ${v.issues}`;
          } catch (e) { why = e.message; }
        }
        // 2) Asosiy mahsulot surati (kattaroq o'lchamda) — fonini kesamiz va Gemini tekshiradi
        const ck = cutoutKey(p);
        if (!ck) return save(null, { ok: false, why: why || "rasm yo'q" });
        const photo = await loadHiRes(ck.src);
        const ub = await removeUniformBackground(photo).catch(() => null);
        if (ub) {
          const { buffer, v } = await pickUniform(ub, p);
          if (!v || v.score >= BANNER_PASS) return save(buffer, { ok: true, from: 'photo-white', score: v?.score ?? null, issues: v?.issues });
        }
        const r = await runCutoutWorker(photo);
        if (r.coverage && (r.coverage > 0.82 || r.coverage < 0.03)) return save(null, { ok: false, from: 'photo', why: (why ? why + '; ' : '') + 'mahsulot suratida aniq ajralmadi' });
        const v = await judgeCutout(r.buffer, p);
        const ok = !v || v.score >= BANNER_PASS;
        return save(ok ? r.buffer : null, { ok, from: 'photo', score: v?.score ?? null, issues: v?.issues, why: ok ? why : `sifat past: ${v.issues}` });
      } catch (e) {
        try { return save(null, { ok: false, why: e.message }); } catch (_) { return null; }
      } finally {
        cutoutJobs.delete(jk);
      }
    });
    cutoutJobs.set(jk, job);
  }
  return cutoutJobs.get(jk);
}

// ===== ADMIN: BANNER RASMLARI (ko'rish, yashirish, qayta yasash, o'z PNG rasmini yuklash) =====
async function setProductFields(id, fields) {
  return mutateProducts(list => {
    const p = list.find(x => String(x.id) === String(id));
    if (!p) return { list, result: { error: 'Mahsulot topilmadi' } };
    for (const [k, v] of Object.entries(fields)) { if (v === null || v === undefined) delete p[k]; else p[k] = v; }
    return { list, result: { product: p } };
  });
}
function dropBannerCache(p) {
  const k = bannerKey(p);
  if (!k) return;
  for (const f of [k.key + '.webp', k.key + '.json']) { try { fs.unlinkSync(path.join(CUTOUT_DIR, f)); } catch (_) {} }
}
app.get('/api/admin/banners', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const list = await getProducts();
    res.json(list.map(p => {
      const k = bannerKey(p);
      const meta = k ? readBannerMeta(k) : null;
      const src = p.bannerImage || defaultBanner(p);
      return {
        id: p.id, name: p.name, hidden: !!p.bannerHidden,
        source: !src ? 'photo' : String(src).startsWith('local:') ? 'upload' : p.bannerImage ? 'link' : 'default',
        status: p.bannerHidden ? 'hidden' : !meta ? 'pending' : meta.ok ? 'ok' : 'fail',
        from: meta?.from || null, score: meta?.score ?? null, why: meta && !meta.ok ? (meta.why || meta.issues || '') : '',
        img: k && meta?.ok ? `/api/banner-img/${encodeURIComponent(p.id)}?v=${k.key.split('_b').pop()}` : null,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/banners/:pid/:action(hide|show|rebuild|reset)', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi' });
    const act = req.params.action;
    if (act === 'hide' || act === 'show') await setProductFields(p.id, { bannerHidden: act === 'hide' ? true : null });
    if (act === 'rebuild') dropBannerCache(p);
    if (act === 'reset') {
      dropBannerCache(p);
      const m = String(p.bannerImage || '').match(/^local:([A-Za-z0-9_.-]+)$/);
      if (m) { try { fs.unlinkSync(path.join(CUTOUT_DIR, 'banner-src', m[1])); } catch (_) {} }
      await setProductFields(p.id, { bannerImage: null, bannerHidden: null });
    }
    if (act === 'rebuild' || act === 'reset') {
      const fresh = (await getProducts()).find(x => String(x.id) === String(p.id));
      getBannerImage(fresh).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin o'zi tayyorlagan rasmni yuklaydi (shaffof PNG eng yaxshisi — fon kesilmaydi)
app.post('/api/admin/banners/:pid/image', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi' });
    const m = String(req.body?.image || '').match(/^data:image\/(png|webp|jpeg);base64,(.+)$/i);
    if (!m) return res.status(400).json({ error: 'PNG, WEBP yoki JPG rasm yuboring' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8e6) return res.status(400).json({ error: 'Rasm 8 MB dan katta' });
    const dir = path.join(CUTOUT_DIR, 'banner-src');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(p.id).replace(/[^0-9A-Za-z_-]/g, '')}-${Date.now()}.${m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()}`;
    fs.writeFileSync(path.join(dir, name), buf);
    // eski yuklanganlarini tozalaymiz
    try { for (const f of fs.readdirSync(dir)) if (f.startsWith(String(p.id) + '-') && f !== name) fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    const r = await setProductFields(p.id, { bannerImage: 'local:' + name, bannerHidden: null });
    const buf2 = await getBannerImage(r.product).catch(() => null);
    const k = bannerKey(r.product), meta = k ? readBannerMeta(k) : null;
    res.json({ ok: !!buf2, why: meta && !meta.ok ? (meta.why || meta.issues || '') : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== TOPILMAGAN QIDIRUVLAR (do'konda yo'q, lekin mijozlar izlagan mahsulotlar) =====
const searchMissBuf = new Map();   // kalit → { q, n, sources }
let searchMisses = null;           // firebase'dagi to'liq ro'yxat (xotirada)
const normQuery = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s+.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const queryKey = q => crypto.createHash('sha1').update(q).digest('hex').slice(0, 12);
function productMatchesText(p, q) {
  const hay = `${p.name} ${p.brand} ${p.cat} ${(p.variants || []).map(v => v.name).join(' ')}`.toLowerCase();
  return q.split(' ').filter(w => w.length > 1).every(w => hay.includes(w));
}
async function recordSearchMiss(raw, source) {
  const q = normQuery(raw);
  if (q.length < 2 || !/\p{L}{2}/u.test(q)) return false;
  if ((await getProducts()).some(p => productMatchesText(p, q))) return false;   // aslida bor — hisoblanmaydi
  const key = queryKey(q);
  const e = searchMissBuf.get(key) || { q, n: 0, sources: {} };
  e.n++; e.sources[source] = (e.sources[source] || 0) + 1;
  searchMissBuf.set(key, e);
  return true;
}
async function flushSearchMisses() {
  if (!searchMissBuf.size) return;
  if (!searchMisses) searchMisses = (await firebaseGet('searchMisses')) || {};
  const batch = [...searchMissBuf.entries()]; searchMissBuf.clear();
  for (const [key, e] of batch) {
    const cur = searchMisses[key] || { q: e.q, count: 0, firstAt: Date.now(), sources: {} };
    cur.q = e.q; cur.count = (cur.count || 0) + e.n; cur.lastAt = Date.now();
    for (const [s, n] of Object.entries(e.sources)) cur.sources[s] = (cur.sources?.[s] || 0) + n;
    searchMisses[key] = cur;
    await firebasePatch(`searchMisses/${key}`, cur).catch(() => {});
  }
}
app.post('/api/track/search', apiRateLimiter, async (req, res) => {
  try { await recordSearchMiss(req.body?.q, 'miniapp'); } catch (_) {}
  res.json({ ok: true });
});
app.get('/api/admin/search-misses', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    await flushSearchMisses();
    if (!searchMisses) searchMisses = (await firebaseGet('searchMisses')) || {};
    const products = await getProducts();
    const items = Object.entries(searchMisses).filter(([, v]) => v && v.q).map(([key, v]) => ({
      key, q: v.q, count: v.count || 0, lastAt: v.lastAt || 0, sources: v.sources || {},
      nowAvailable: products.some(p => productMatchesText(p, v.q)),
    })).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, 60);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/search-misses/:key', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const key = String(req.params.key).replace(/[^0-9a-f]/g, '');
    if (searchMisses) delete searchMisses[key];
    await firebaseDelete(`searchMisses/${key}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SOTUV VORONKASI: ko'rildi → savatga qo'shildi → buyurtma =====
// Har kun uchun mahsulot bo'yicha noyob (bir xaridor kuniga bir marta) ko'rishlar va savatga qo'shishlar
const funnelBuf = new Map();      // `${day}|${pid}` → { v, c }
const funnelSeen = new Set();     // `${day}|${pid}|${type}|${who}` — takrorlarni sanamaslik uchun
let funnelSeenDay = '';
const tashkentDay = (t = Date.now()) => new Date(t + 5 * 3600e3).toISOString().slice(0, 10);
app.post('/api/track/event', apiRateLimiter, async (req, res) => {
  try {
    const type = req.body?.type === 'cart' ? 'c' : req.body?.type === 'view' ? 'v' : null;
    const pid = String(req.body?.pid || '').slice(0, 30);
    if (!type || !pid) return res.json({ ok: false });
    if (!(await getProducts()).some(p => String(p.id) === pid)) return res.json({ ok: false });
    const user = userFromInitData(req);
    const who = user ? 'u' + user.id : 'ip' + (req.ip || '');
    if (user && ADMIN_IDS.map(String).includes(String(user.id))) return res.json({ ok: true });   // adminning o'zi hisoblanmaydi
    const day = tashkentDay();
    if (day !== funnelSeenDay) { funnelSeen.clear(); funnelSeenDay = day; }
    const sk = `${day}|${pid}|${type}|${who}`;
    if (funnelSeen.has(sk)) return res.json({ ok: true });
    funnelSeen.add(sk);
    const k = `${day}|${pid}`;
    const e = funnelBuf.get(k) || { v: 0, c: 0 };
    e[type]++;
    funnelBuf.set(k, e);
    res.json({ ok: true });
  } catch (_) { res.json({ ok: false }); }
});
async function flushFunnel() {
  if (!funnelBuf.size) return;
  const batch = [...funnelBuf.entries()]; funnelBuf.clear();
  const byDay = {};
  for (const [k, e] of batch) { const [day, pid] = k.split('|'); (byDay[day] = byDay[day] || {})[pid] = e; }
  for (const [day, items] of Object.entries(byDay)) {
    const cur = (await firebaseGet(`funnel/${day}`)) || {};
    const patch = {};
    for (const [pid, e] of Object.entries(items)) {
      const c = cur[pid] || { v: 0, c: 0 };
      patch[pid] = { v: (c.v || 0) + e.v, c: (c.c || 0) + e.c };
    }
    await firebasePatch(`funnel/${day}`, patch).catch(() => {});
  }
}
app.get('/api/admin/funnel', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    await flushFunnel();
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
    const all = (await firebaseGet('funnel')) || {};
    const from = tashkentDay(Date.now() - (days - 1) * 86400e3);
    const agg = {};
    for (const [day, items] of Object.entries(all)) {
      if (day < from) continue;
      for (const [pid, e] of Object.entries(items || {})) {
        const a = agg[pid] = agg[pid] || { views: 0, carts: 0, orders: 0, sold: 0 };
        a.views += e.v || 0; a.carts += e.c || 0;
      }
    }
    // Buyurtmalar faqat ko'rishlar hisoblana boshlagan kundan sanaladi (aks holda foizlar ma'nosiz bo'ladi)
    const firstDay = Object.keys(all).sort()[0];
    const trackStart = firstDay ? Date.parse(firstDay + 'T00:00:00+05:00') : Date.now();
    const since = Math.max(Date.now() - days * 86400e3, trackStart);
    const orders = (await firebaseGet('orders')) || {};
    const products = await getProducts();
    for (const o of Object.values(orders)) {
      if (!o || (o.createdAt || 0) < since || /cancel|reject/i.test(o.status || '')) continue;
      let items = Array.isArray(o.items) ? o.items : [];
      if (!items.length) items = String(o.products || '').split(',').map(n => { const p = products.find(x => x.name === n.trim()); return p ? { id: p.id, qty: 1 } : null; }).filter(Boolean);
      const seen = new Set();
      for (const it of items) {
        const pid = String(it.id);
        const a = agg[pid] = agg[pid] || { views: 0, carts: 0, orders: 0, sold: 0 };
        if (!seen.has(pid)) { a.orders++; seen.add(pid); }
        if (['confirmed', 'shipped', 'delivered'].includes(o.status)) a.sold += Math.max(1, Number(it.qty) || 1);
      }
    }
    const rows = products.map(p => ({ id: p.id, name: p.name, ...(agg[String(p.id)] || { views: 0, carts: 0, orders: 0, sold: 0 }) }))
      .sort((a, b) => b.views - a.views || b.orders - a.orders);
    const tot = rows.reduce((t, r) => ({ views: t.views + r.views, carts: t.carts + r.carts, orders: t.orders + r.orders }), { views: 0, carts: 0, orders: 0 });
    const since0 = Object.keys(all).sort()[0] || null;
    res.json({ days, since: since0, totals: tot, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
setInterval(() => { flushSearchMisses().catch(() => {}); flushFunnel().catch(() => {}); }, 60000);

// Fonni kesish uchun kattaroq manba: Unsplash kabi saytlar o'lchamni URL'da beradi (w=600 → 1600)
function hiResSrc(src) {
  try {
    const u = new URL(src);
    if (u.hostname === 'images.unsplash.com') { u.searchParams.set('w', '1600'); u.searchParams.set('q', '90'); return u.href; }
  } catch (_) {}
  return src;
}
async function loadHiRes(src) {
  if (/^https:/i.test(src)) { const hi = hiResSrc(src); if (hi !== src) { try { return await loadImageSource(hi); } catch (_) {} } }
  return loadImageSource(src);
}
// Gemini fonsiz rasmni ko'rib baholaydi: qoldiq fon (tutun, soya, bo'laklar), xiralik, kesilgan joylar
async function judgeCutout(buf, p) {
  try {
    if (typeof assistant === 'undefined' || !assistant.geminiGenerate) return null;
    const jpg = await ffRaw(['-f', 'lavfi', '-i', 'color=c=0x8a8f98:s=16x16', '-i', 'pipe:0', '-filter_complex',
      `[1]scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease[c];[0][c]scale2ref[bg][c2];[bg][c2]overlay`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'], buf);
    const r = await assistant.geminiGenerate([
      { inline_data: { mime_type: 'image/jpeg', data: jpg.toString('base64') } },
      { text: `Bu "${p.name}" mahsulotining fonini AI olib tashlagan rasmi (kulrang fon — shaffof joy). U do'kon bannerida ko'rsatiladi. ` +
        `Qat'iy baholang: mahsulot to'liq va aniq ajratilganmi; atrofida eski fondan qoldiq (oq yoki rangli to'rtburchak fon/quti, oq dog', tutun, rangli dog'lar, soya, stol, qo'l) va BEGONA buyumlar (klaviatura, sichqoncha, kabel, quti, boshqa mahsulot bo'laklari) yo'qmi — faqat shu mahsulotning o'zi ko'rinishi kerak; chetlari toza va tiniqmi (xira emasmi); mahsulotning biror qismi kesilib ketmaganmi. ` +
        `Faqat JSON: {"score": 1-10, "issues": "qisqa, o'zbekcha"}` },
    ], { json: true });
    if (!r || r.error || !r.text) return null;
    const j = JSON.parse(String(r.text).replace(/^```(?:json)?|```$/gm, '').trim());
    const score = Math.round(Number(j.score));
    return Number.isFinite(score) ? { score, issues: String(j.issues || '').slice(0, 200) } : null;
  } catch (_) { return null; }
}

// Oq fon usuli ikki variant beradi (ichki "teshik"lar bilan/siz) — Gemini yaxshisini tanlaydi
async function pickUniform(ub, p) {
  if (ub.ai) console.log(`🖼 Banner (${p.id}) oq fon + AI: tiklandi ${ub.ai.restored}, olindi ${ub.ai.removed}, teshik ${ub.ai.autoHoles}, orol ${ub.ai.islands || 0}, moslik ${ub.ai.agree}`);
  let a = await judgeCutout(ub.buffer, p);
  // Gemini yo'q bo'lsa — AI niqobi bilan moslik juda past natija sifatsiz deb hisoblanadi (bannerga chiqmaydi)
  if (!a && ub.ai && ub.ai.agree != null && ub.ai.agree < 0.55) a = { score: 4, issues: `AI niqobi bilan mos emas (${ub.ai.agree})` };
  if (!ub.holesBuffer || !a) return { buffer: ub.buffer, v: a };
  const b = await judgeCutout(ub.holesBuffer, p);
  return b && b.score > a.score ? { buffer: ub.holesBuffer, v: b } : { buffer: ub.buffer, v: a };
}

function bannerReady(p) {
  if (p && p.bannerHidden) return false;
  const k = bannerKey(p);
  if (!k) return false;
  const m = readBannerMeta(k);
  return !!(m && m.ok && fs.existsSync(path.join(CUTOUT_DIR, k.key + '.webp')));
}
app.get('/api/banner-img/:pid', async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).end();
    const buf = await getBannerImage(p);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

app.get('/api/cutout/:pid', async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).end();
    const buf = await getCutout(p);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// Server ishga tushganda banner mahsulotlari uchun oldindan tayyorlab qo'yamiz
async function prewarmCutouts() {
  try {
    const list = (await getProducts()).filter(Boolean);
    for (const p of list) { await getBannerImage(p).catch(() => {}); }   // banner rasmi (ichida fonsiz surat ham tayyorlanadi)
    for (const p of list) { await getCutout(p).catch(() => {}); }
    // Keyin "3D" hajm xaritalari (mijoz kutib qolmasin)
    for (const p of list) { await getDepthMap(p).catch(() => {}); }
  } catch (_) {}
}

app.get('/api/img/:pid/:idx', async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    const imgs = p ? (Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : [])) : [];
    const src = imgs[Number(req.params.idx)];
    if (!isDataImg(src)) return res.status(404).end();
    const m = src.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!m) return res.status(404).end();
    const w = Math.max(120, Math.min(1600, parseInt(req.query.w) || 0));
    const key = `${req.params.pid}:${req.params.idx}:${w}:${imgVersion(p.id, Number(req.params.idx), src)}`;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    let hit = resizedCache.get(key);
    if (!hit) {
      const orig = Buffer.from(m[2], 'base64');
      try {
        const webp = req.query.w ? await resizeImage(orig, w) : null;
        hit = webp && webp.length < orig.length ? { type: 'image/webp', buf: webp } : { type: m[1], buf: orig };
      } catch (e) {
        hit = { type: m[1], buf: orig };
      }
      if (resizedCache.size > 300) resizedCache.delete(resizedCache.keys().next().value);
      resizedCache.set(key, hit);
    }
    res.setHeader('Content-Type', hit.type);
    res.end(hit.buf);
  } catch (e) {
    res.status(500).end();
  }
});

app.get('/api/products', apiRateLimiter, async (req, res) => {
  try {
    const now = Date.now();
    const ratings = await getRealRatings();
    res.json((await getProducts()).map(p => publicProduct(p, now, ratings)));
  } catch (e) {
    res.status(500).json({ error: "Mahsulotlarni yuklashda xatolik yuz berdi" });
  }
});

// ===== MAHSULOTNI ULASHISH =====
function escHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSom(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + " so'm";
}

// Mahsulot rasmi ochiq URL orqali (Telegram ulashilgan xabarga rasmni shu yerdan oladi)
app.get('/api/products/:id/image', async (req, res) => {
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.id));
    const src = p && ((p.images && p.images[0]) || p.image);
    if (!src) return res.status(404).end();
    const m = String(src).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    let buf, type;
    if (m) {
      buf = Buffer.from(m[2], 'base64');
      type = m[1];
    } else if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src, { headers: { Accept: 'image/jpeg,image/*' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return res.status(502).end();
      buf = Buffer.from(await r.arrayBuffer());
      type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    } else {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// Ulashish uchun bot tomonidan tayyorlangan xabar (rasm + matn + botga olib boruvchi tugma)
app.post('/api/share/:id', apiRateLimiter, async (req, res) => {
  try {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData || !verifyTelegramAuth(initData)) return res.status(401).json({ error: 'Telegram orqali oching' });
    const user = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
    if (!user.id) return res.status(400).json({ error: 'Foydalanuvchi topilmadi' });
    if (!botInstance || !botUsername) return res.status(503).json({ error: 'Bot ishlamayapti' });

    const p = (await getProducts()).find(x => String(x.id) === String(req.params.id));
    if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi' });

    const d = Number(p.discount) || 0;
    const oldPrice = d > 0 && d < 100 ? Math.round(p.price / (1 - d / 100)) : null;
    const desc = String(p.desc || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const shortDesc = desc.length > 160 ? desc.slice(0, 157).trim() + '…' : desc;
    const specs = (p.specs || []).slice(0, 3).map(([k, v]) => `▫️ ${escHtml(k)}: <b>${escHtml(v)}</b>`).join('\n');
    const caption = [
      `${d > 0 ? '🔥' : '✨'} <b>${escHtml(p.name)}</b>`,
      '',
      oldPrice
        ? `💰 <b>${fmtSom(p.price)}</b>  <s>${fmtSom(oldPrice)}</s>  (−${d}%)`
        : `💰 <b>${fmtSom(p.price)}</b>`,
      shortDesc ? `\n${escHtml(shortDesc)}` : '',
      specs ? `\n${specs}` : '',
      '',
      "🚚 BTS orqali tekin yetkazib berish",
      "🛡 Xavfsiz to'lov · avtomatik tasdiqlash",
      '',
      `🛍 <b>TechStore</b> — @${botUsername}`
    ].filter(x => x !== null).join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 1000);

    const productLink = `https://t.me/${botUsername}?start=p_${p.id}`;
    const reply_markup = { inline_keyboard: [[{ text: "🛍 Do'konda ko'rish", url: productLink }]] };
    const imageUrl = `${APP_URL}/api/products/${p.id}/image`;
    const hasImage = !!((p.images && p.images[0]) || p.image);

    const result = hasImage
      ? { type: 'photo', id: `p${p.id}`, photo_url: imageUrl, thumbnail_url: imageUrl, caption, parse_mode: 'HTML', reply_markup }
      : { type: 'article', id: `p${p.id}`, title: p.name, input_message_content: { message_text: caption, parse_mode: 'HTML' }, reply_markup };

    const prepared = await botInstance._request('savePreparedInlineMessage', {
      form: {
        user_id: user.id,
        result: JSON.stringify(result),
        allow_user_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
        allow_bot_chats: false
      }
    });
    res.json({ id: prepared.id, link: productLink });
  } catch (e) {
    console.error('Share xato:', e.message);
    res.status(500).json({ error: 'Ulashishni tayyorlab bo\'lmadi' });
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
// ===== BUYURTMA YARATISH (Mini App va yordamchi admin uchun umumiy) =====
// Buyurtma raqami serverda beriladi (ikki xaridorga bir xil raqam tushmasin), narx va ombor bazadan tekshiriladi,
// to'lovni avtomatik aniqlash uchun summaga unikal qo'shimcha (suffix) qo'shiladi.
let orderNumChain = Promise.resolve();
function nextOrderNumber() {
  const run = orderNumChain.then(async () => {
    const orders = (await firebaseGet('orders')) || {};
    const meta = (await firebaseGet('meta/orderCounter')) || 0;
    const maxExisting = Object.keys(orders).map(k => parseInt(k)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 1042);
    const next = Math.max(maxExisting, Number(meta) || 0) + 1;
    await firebasePatch('meta', { orderCounter: next });
    return next;
  });
  orderNumChain = run.catch(() => {});
  return run;
}

async function uniqueSuffixFor(base) {
  const orders = (await firebaseGet('orders')) || {};
  const used = new Set(Object.values(orders).filter(o => o && o.status === 'pending').map(o => Number(o.total)));
  pendingPayments.forEach(p => used.add(Number(p.amount)));
  for (let tries = 0; tries < 400; tries++) {
    const suffix = Math.floor(Math.random() * (tries < 200 ? 99 : 999)) + 1;
    if (!used.has(base + suffix)) return suffix;
  }
  return Math.floor(Math.random() * 999) + 1;
}

// Mahsulot (va variant) narxi hamda ombordagi soni
function itemPriceAndStock(prod, variantId) {
  if (variantId && Array.isArray(prod.variants)) {
    const v = prod.variants.find(x => String(x.id) === String(variantId));
    if (!v) return { error: `"${plainText(prod.name)}" uchun tanlangan variant topilmadi` };
    return { price: Number(v.price) || prod.price, stock: (v.stock === null || v.stock === undefined || v.stock === '') ? null : Number(v.stock), label: `${plainText(prod.name)} (${plainText(v.name)})`, variant: v };
  }
  return { price: prod.price, stock: (prod.stock === null || prod.stock === undefined || prod.stock === '') ? null : Number(prod.stock), label: plainText(prod.name) };
}

async function createOrder({ items, userId, userName, phone, addr, chekImg = null, suffix, amount, source = 'miniapp' }) {
  if (!userId || !Array.isArray(items) || !items.length) return { error: "Noto'g'ri buyurtma ma'lumotlari" };
  const dbProducts = await getProducts();
  let base = 0;
  const clean = [];
  for (const item of items) {
    const dbProd = dbProducts.find(p => p && String(p.id) === String(item.id));
    if (!dbProd) return { error: `Mahsulot topilmadi: ${plainText(item.name || item.id)}` };
    const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
    const ps = itemPriceAndStock(dbProd, item.variant);
    if (ps.error) return { error: ps.error };
    if (ps.stock !== null && ps.stock < qty) {
      return { error: ps.stock <= 0 ? `"${ps.label}" hozircha tugagan.` : `"${ps.label}" dan faqat ${ps.stock} ta qoldi.` };
    }
    base += ps.price * qty;
    clean.push({ id: String(dbProd.id), name: sanitizeInput(ps.label), qty, price: ps.price, ...(item.variant ? { variant: String(item.variant) } : {}) });
  }
  let sfx = Number(suffix);
  if (!sfx || sfx < 0 || sfx > 1000) sfx = await uniqueSuffixFor(base);
  const total = base + sfx;
  if (amount !== undefined && Math.abs(Number(amount) - total) > 100) {
    return { error: "Buyurtma summasi mos kelmadi. Narxlar o'zgargan bo'lishi mumkin. Iltimos, sahifani yangilang.", tampered: true };
  }
  const num = await nextOrderNumber();
  const orderNum = '#' + num;
  const order = {
    orderNum, products: clean.map(i => i.name).join(', '), total, basePrice: base, suffix: sfx,
    addr: sanitizeInput(addr || ''), phone: sanitizeInput(phone || ''), status: 'pending',
    userId: String(userId), userName: sanitizeInput(userName || 'Foydalanuvchi'),
    chekImg: chekImg && typeof chekImg === 'string' ? chekImg : null,
    items: clean, source, createdAt: Date.now(),
  };
  await firebasePut(`orders/${num}`, order);
  firebaseDelete(`carts/${String(userId)}`).catch(() => {});
  await registerPendingPaymentInDb({ amount: total, userId: String(userId), userName: order.userName, orderNum, phone: order.phone, addr: order.addr, ts: Date.now() });
  return { orderNum, id: String(num), amount: total, base, suffix: sfx, order };
}

app.post('/api/orders', apiRateLimiter, async (req, res) => {
  const { amount, userName, phone, addr, items, suffix, chekImg } = req.body || {};
  // Telegram ichida foydalanuvchi ID'si imzolangan initData'dan olinadi
  const tgUser = userFromInitData(req);
  const userId = tgUser ? String(tgUser.id) : String(req.body?.userId || '');
  try {
    const r = await createOrder({ items, userId, userName, phone, addr, chekImg, suffix, amount });
    if (r.error) {
      if (r.tampered) console.warn(`⚠️ Security: summa mos kelmadi (user ${userId})`);
      return res.status(400).json({ error: r.error });
    }
    res.json({ success: true, orderNum: r.orderNum, amount: r.amount });
  } catch (e) {
    console.error("Order processing error:", e);
    res.status(500).json({ error: "Buyurtmani qayta ishlashda xatolik yuz berdi: " + e.message });
  }
});

// ===== ADMIN PROTECTED REST API =====

// Barcha buyurtmalarni olish
app.get('/api/admin/orders', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const ordersData = (await firebaseGet('orders')) || {};
    // Og'ir rasm o'rniga havola: jo'natish cheki
    const out = {};
    for (const [id, o] of Object.entries(ordersData)) {
      if (!o) continue;
      const f = o.fulfillment ? { ...o.fulfillment } : null;
      if (f) { delete f.shipProofImg; delete f.adminMessages; }
      out[id] = { ...o, fulfillment: f, shipProof: proofUrl(id, o) };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "Buyurtmalarni yuklashda xatolik: " + e.message });
  }
});

// Admin panel: buyurtmani jo'natildi qilish (BTS cheki rasmi bilan)
app.post('/api/admin/orders/:orderId/ship', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const img = typeof req.body?.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(req.body.image) && req.body.image.length < 3e6 ? req.body.image : null;
    const r = await shipOrder(req.params.orderId, { imgData: img, note: req.body?.note || '', shippedBy: String(req.adminUser?.id || 'panel') });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, via: r.via || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SMS / tashqi xizmatdan to'lov xabari (webhook) =====
function paymentHookKey() {
  return crypto.createHash('sha256').update(`payhook:${BOT_TOKEN || ''}:${process.env.SESSION_SECRET || process.env.RAILWAY_PROJECT_ID || 'ts'}`).digest('hex').slice(0, 32);
}
app.all('/api/payment-hook/:key', express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
  if (req.params.key !== paymentHookKey()) return res.status(403).json({ error: 'kalit noto\'g\'ri' });
  let text = '';
  const b = req.body;
  if (typeof b === 'string') {
    try { const j = JSON.parse(b); text = [j.text, j.message, j.body, j.sms, j.msg, j.content].filter(Boolean).join('\n') || b; } catch (_) { text = b; }
  } else if (b && typeof b === 'object') {
    text = [b.text, b.message, b.body, b.sms, b.msg, b.content].filter(Boolean).join('\n');
  }
  if (!text && req.query.text) text = String(req.query.text);
  try {
    const matched = await matchPaymentText(text, 'SMS');
    res.json({ ok: true, matched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/payment-hook', apiRateLimiter, verifyAdmin, (req, res) => {
  res.json({ url: `${APP_URL.replace(/\/$/, '')}/api/payment-hook/${paymentHookKey()}`, log: paymentLog.slice(0, 10) });
});

// Admin: to'lovlar kanali (bank xabarlari tushadigan kanal)
async function paymentChannelStatus() {
  const out = { id: PAYMENT_CHANNEL.id, title: PAYMENT_CHANNEL.title, bot: null, assistant: null,
    suggestions: [...seenChannels.values()].filter(c => !isPaymentChannel(c.id)).sort((a, b) => b.at - a.at).slice(0, 5),
    log: paymentLog.filter(l => /kanal/.test(l.source)).slice(0, 8) };
  if (PAYMENT_CHANNEL.id && botInstance) {
    try {
      const me = await botInstance.getMe();
      const m = await botInstance.getChatMember(PAYMENT_CHANNEL.id, me.id);
      out.bot = ['administrator', 'creator'].includes(m.status) ? 'admin' : m.status;
    } catch (e) { out.bot = 'not_member'; }
  }
  if (PAYMENT_CHANNEL.id && assistant.channelMembership) out.assistant = await assistant.channelMembership(chanKey(PAYMENT_CHANNEL.id)).catch(() => null);
  return out;
}
app.get('/api/admin/payment-channel', apiRateLimiter, verifyAdmin, async (req, res) => {
  try { res.json(await paymentChannelStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/payment-channel', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    let ref = String(req.body?.channel || '').trim().replace(/^https?:\/\/t\.me\//i, '');
    if (!ref) {
      PAYMENT_CHANNEL = { id: '', title: '' };
      await firebasePatch('', { 'settings/payment': { channelId: '', channelTitle: '' } });
      return res.json(await paymentChannelStatus());
    }
    if (/^\d{5,}$/.test(ref)) ref = '-100' + ref;                     // 1234567890 → -1001234567890
    else if (!/^-\d{5,}$/.test(ref)) ref = '@' + ref.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    let id = /^-\d+$/.test(ref) ? ref : '', title = '';
    if (botInstance) {
      try {
        const chat = await botInstance.getChat(ref);
        if (!chat || !chat.id) throw new Error('kanal topilmadi');
        if (chat.type && chat.type !== 'channel' && chat.type !== 'supergroup') return res.status(400).json({ error: "Bu kanal emas — to'lovlar kanali ID sini kiriting" });
        id = String(chat.id); title = chat.title || '';
      }
      catch (e) { if (!id) return res.status(400).json({ error: "Kanal topilmadi. Botni kanalga admin qiling yoki kanal ID sini (-100...) kiriting." }); }
    } else if (!id) return res.status(400).json({ error: "Bot ishlamayapti — kanal ID sini (-100...) kiriting" });
    PAYMENT_CHANNEL = { id, title };
    await firebasePatch('', { 'settings/payment': { channelId: id, channelTitle: title } });
    console.log(`💳 To'lovlar kanali: ${title || id}`);
    res.json(await paymentChannelStatus());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: mijozlar fikrlari
app.get('/api/admin/reviews', apiRateLimiter, verifyAdmin, async (req, res) => {
  try { res.json(await botFeatures.listAllReviews()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/reviews/:pid/:rid', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const r = await botFeatures.deleteReview(req.params.pid, req.params.rid);
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Buyurtmani tasdiqlash / rad etish
app.post('/api/admin/orders/:orderId/:action(approve|reject)', apiRateLimiter, verifyAdmin, async (req, res) => {
  const { orderId, action } = req.params;
  try {
    const result = await setOrderStatus(orderId, action === 'approve' ? 'confirmed' : 'rejected');
    if (result.error) return res.status(404).json(result);
    res.json(result);
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
  const { card, bot, admin, shop } = req.body;
  
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
    if (shop && typeof shop.channel === 'string') {
      // https://t.me/kanal, @kanal yoki kanal — hammasi "kanal" ko'rinishiga keltiriladi
      SHOP_CHANNEL = shop.channel.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
      if (typeof shop.autoPost === 'boolean') SHOP_AUTOPOST = shop.autoPost;
      updates['settings/shop'] = { channel: SHOP_CHANNEL, autoPost: SHOP_AUTOPOST };
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
    if (Array.isArray(defaultProducts)) {
      await mutateProducts(() => ({ list: defaultProducts }));
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

// Mahsulotni tekshirish va tozalash (panel ham, yordamchi admin ham shu funksiyadan o'tadi)
function buildProduct(body) {
  const { name, brand, price, discount, cat, desc, specs, images } = body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return { error: "Mahsulot nomi kiritilishi shart!" };
  }
  if (!brand || typeof brand !== 'string' || brand.trim() === '') {
    return { error: "Brand nomi kiritilishi shart!" };
  }

  const parsedPrice = parseInt(price);
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    return { error: "Mahsulot narxi musbat son bo'lishi shart!" };
  }

  const parsedDiscount = parseInt(discount) || 0;
  if (parsedDiscount < 0 || parsedDiscount > 100) {
    return { error: "Chegirma 0 va 100 oralig'ida bo'lishi shart!" };
  }

  if (!cat || !CATEGORY_ENUM.includes(cat)) {
    return { error: "Noto'g'ri mahsulot kategoriyasi!" };
  }
  // Mahsulot turi (ixtiyoriy): kategoriyaga mos bo'lmasa saqlanmaydi
  const pType = body.type && PRODUCT_TYPES.typeOf(String(body.type));
  const type = pType && pType.cat === cat ? pType.key : null;

  // Ombordagi soni: bo'sh — cheklanmagan (hisob yuritilmaydi)
  let stock = null;
  if (body.stock !== undefined && body.stock !== null && String(body.stock).trim() !== '') {
    stock = parseInt(body.stock);
    if (isNaN(stock) || stock < 0) return { error: "Ombordagi soni 0 yoki musbat son bo'lishi shart!" };
  }
  // Chegirma tugash vaqti (ixtiyoriy) — ilovada ortga sanoq ko'rsatiladi
  let discountUntil = null;
  if (body.discountUntil) {
    const t = typeof body.discountUntil === 'number' ? body.discountUntil : Date.parse(body.discountUntil);
    if (!isNaN(t) && t > 0) discountUntil = t;
  }

  // Variantlar (rang/xotira): har birining o'z narxi va ombor soni
  let variants = null;
  if (Array.isArray(body.variants)) {
    variants = [];
    for (const v of body.variants.slice(0, 12)) {
      if (!v || !String(v.name || '').trim()) continue;
      const vp = parseInt(v.price);
      if (isNaN(vp) || vp <= 0) return { error: `"${String(v.name).slice(0, 40)}" varianti narxi noto'g'ri` };
      let vs = null;
      if (v.stock !== undefined && v.stock !== null && String(v.stock).trim() !== '') {
        vs = parseInt(v.stock);
        if (isNaN(vs) || vs < 0) return { error: `"${String(v.name).slice(0, 40)}" varianti soni noto'g'ri` };
      }
      variants.push({ id: String(v.id || ('v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))).slice(0, 40), name: sanitizeInput(String(v.name).slice(0, 60)), price: vp, stock: vs });
    }
    if (!variants.length) variants = null;
  }

  const cleanImages = Array.isArray(images) ? images.filter(img => typeof img === 'string').slice(0, 5) : [];
  const mainImage = body.image && typeof body.image === 'string' ? body.image : (cleanImages[0] || null);

  return {
    product: {
      id: body.id ? Number(body.id) : (Date.now() + Math.floor(Math.random() * 1000)),
      name: sanitizeInput(name),
      brand: sanitizeInput(brand),
      price: parsedPrice,
      discount: parsedDiscount,
      cat: cat,
      type,
      desc: sanitizeInput(desc || 'Tavsif yo\'q.'),
      rating: Number(body.rating) || 5.0,
      reviews: Number(body.reviews) || 0,
      specs: Array.isArray(specs) ? specs.filter(pair => Array.isArray(pair)).map(pair => [sanitizeInput(pair[0]), sanitizeInput(pair[1])]) : [],
      emoji: body.emoji ? sanitizeInput(body.emoji) : null,
      stock,
      variants,
      discountUntil: parsedDiscount > 0 ? discountUntil : null,
      // Vaqtinchalik chegirmada asl narx — muddat tugaganda narx shunga qaytadi
      regularPrice: parsedDiscount > 0 && Number(body.regularPrice) > parsedPrice ? Math.round(Number(body.regularPrice)) : null,
      sold: Number(body.sold) || 0,
      image: mainImage,
      images: cleanImages.length ? cleanImages : (mainImage ? [mainImage] : [])
    }
  };
}

function validateAndSanitizeProduct(req, res, next) {
  const { product, error } = buildProduct(req.body);
  if (error) return res.status(400).json({ error });
  req.sanitizedProduct = product;
  next();
}

// Yangi mahsulot (admin panel yoki yordamchi orqali): 3D model navbati + kanalga avtomatik e'lon
function onProductCreated(pid) {
  model3d.watch(pid);   // admin o'zi qo'shgan — 3D natijasi haqida xabar beriladi
  setTimeout(() => { try { model3d.sweep(); } catch (_) {} }, 5000);
  setTimeout(() => autoPostNewProduct(pid).catch(e => console.warn('📢 Avto e\'lon xatosi:', e.message)), 45000);   // rasmlar qo'shilishiga ulgursin
}
async function addProduct(data) {
  const { product, error } = buildProduct(data);
  if (error) return { error };
  await mutateProducts(list => ({ list: [product, ...list.filter(p => p.id !== product.id)] }));
  onProductCreated(product.id);
  return { product };
}

async function updateProduct(id, data) {
  let before = null;
  const result = await mutateProducts(list => {
    const idx = list.findIndex(p => String(p.id) === String(id));
    if (idx === -1) return { list, result: { error: "Mahsulot topilmadi" } };
    const { product, error } = buildProduct({ ...list[idx], ...data, id: list[idx].id });
    if (error) return { list, result: { error } };
    before = { ...list[idx] };
    list[idx] = { ...list[idx], ...product };
    return { list, result: { product: list[idx] } };
  });
  if (result?.product && before) {
    // Narx tushsa — sevimlilariga qo'shganlarga xabar
    botFeatures.onProductUpdated(before, result.product).catch(e => console.warn('Narx xabari xatosi:', e.message));
    // Omborga qayta kelsa — kutayotganlarga xabar
    if (!hasStock(before) && hasStock(result.product)) notifyWaitlist(result.product).catch(e => console.warn('Kutish ro\'yxati xatosi:', e.message));
    // Rasmlar o'zgarsa (masalan, 4 tomondan rasmlar qo'shildi) — 3D model darhol qayta yasaladi
    if (JSON.stringify(before.images || before.image || null) !== JSON.stringify(result.product.images || result.product.image || null)) { model3d.watch(result.product.id); setTimeout(() => { try { model3d.sweep(); } catch (_) {} }, 5000); }
  }
  return result;
}

async function deleteProduct(id) {
  return mutateProducts(list => ({ list: list.filter(p => String(p.id) !== String(id)), result: { success: true } }));
}

// Mahsulot qo'shish
app.post('/api/admin/products', apiRateLimiter, verifyAdmin, validateAndSanitizeProduct, async (req, res) => {
  const newProduct = req.sanitizedProduct;
  try {
    await mutateProducts(list => ({ list: [newProduct, ...list.filter(p => p.id !== newProduct.id)] }));
    onProductCreated(newProduct.id);
    res.json({ success: true, product: publicProduct(newProduct, Date.now(), await getRealRatings()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mahsulotni yangilash — faqat yuborilgan maydonlar o'zgaradi (kategoriya, xususiyatlar va h.k. saqlanib qoladi)
app.put('/api/admin/products/:id', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const data = { ...(req.body || {}) };
    delete data.id;
    if (Array.isArray(data.images) || typeof data.image === 'string') {
      const raw = (await getProducts()).find(x => String(x.id) === String(req.params.id));
      if (Array.isArray(data.images)) data.images = resolveImgRefs(data.images, raw);
      if (typeof data.image === 'string') data.image = resolveImgRefs([data.image], raw)[0] || (data.images && data.images[0]) || null;
    }
    const result = await updateProduct(req.params.id, data);
    if (result.error) return res.status(result.error === "Mahsulot topilmadi" ? 404 : 400).json(result);
    res.json({ success: true, product: publicProduct(result.product, Date.now(), await getRealRatings()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/products/:id', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    await deleteProduct(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Foydalanuvchini ro'yxatdan o'tkazish/yangilash (WebApp ochilganda)
app.post('/api/users/register', apiRateLimiter, async (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(400).json({ error: "Init data missing" });
  
  const hostname = req.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  
  let isValid = verifyTelegramAuth(initData);
  
  // Agarda local bo'lsa va bot token hali sozlanmagan bo'lsa (initData bor, lekin token yo'q)
  if (!isValid && isLocal && !BOT_TOKEN) {
    isValid = true;
  }
  
  if (!isValid) {
    return res.status(401).json({ error: "Verifikatsiya muvaffaqiyatsiz tugadi" });
  }
  
  let tgUser = null;
  try {
    const urlParams = new URLSearchParams(initData);
    tgUser = JSON.parse(urlParams.get('user') || '{}');
  } catch(e) {
    return res.status(400).json({ error: "Noto'g'ri user formati" });
  }
  
  if (!tgUser || !tgUser.id) return res.status(400).json({ error: "User info missing" });
  
  try {
    const userPath = `users/${tgUser.id}`;
    const existing = await firebaseGet(userPath);
    
    const userData = {
      id: tgUser.id,
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
      photo_url: tgUser.photo_url || '',
      joinedAt: existing?.joinedAt || Date.now(),
      lastSeen: Date.now(),
      sources: { ...(existing?.sources || {}), app: true }
    };
    
    await firebasePatch(userPath, userData);
    res.json({ success: true, user: userData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Foydalanuvchilar (Mijozlar) ro'yxatini olish
app.get('/api/admin/users', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const usersData = await firebaseGet('users') || {};
    const ordersData = await firebaseGet('orders') || {};
    
    let userList = Object.values(usersData);
    
    // Fallback: Agar users bo'limi bo'sh bo'lsa, buyurtmalardan foydalanuvchilarni yig'ish (backward compatibility)
    if (userList.length === 0) {
      const fallbackMap = new Map();
      Object.values(ordersData).forEach(o => {
        if (o.userId) {
          const uidStr = String(o.userId);
          fallbackMap.set(uidStr, {
            id: o.userId,
            first_name: o.userName || 'Foydalanuvchi',
            last_name: '',
            username: o.userUsername || '',
            photo_url: o.userPhotoUrl || '',
            joinedAt: o.createdAt || Date.now()
          });
        }
      });
      userList = Array.from(fallbackMap.values());
    }
    
    // Har bir foydalanuvchining buyurtmalar soni va oxirgi telefon raqamini hisoblab chiqish
    const userOrderCounts = {};
    const userPhones = {};
    
    Object.values(ordersData).forEach(o => {
      if (o.userId) {
        const uidStr = String(o.userId);
        userOrderCounts[uidStr] = (userOrderCounts[uidStr] || 0) + 1;
        if (o.phone) {
          userPhones[uidStr] = o.phone;
        }
      }
    });
    
    const result = userList.map(u => {
      const uidStr = String(u.id);
      return {
        id: u.id,
        first_name: u.first_name || 'Foydalanuvchi',
        last_name: u.last_name || '',
        username: u.username || '',
        photo_url: u.photo_url || '',
        phone: userPhones[uidStr] || '',
        orderCount: userOrderCounts[uidStr] || 0,
        joinedAt: u.joinedAt || Date.now(),
        lastSeen: u.lastSeen || Date.now()
      };
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== YORDAMCHI ADMIN (Telegram akkaunt + AI) =====
// ===== FOYDALANUVCHILARNI HISOBGA OLISH =====
// Telegram bot obunachilari sonini API orqali bermaydi — shuning uchun botga /start bosgan,
// Mini App'ni ochgan va yordamchiga yozgan har bir foydalanuvchini o'zimiz yozib boramiz.
const recentlyTracked = new Map(); // userId -> oxirgi yozilgan vaqt (bazaga ortiqcha yozmaslik uchun)

async function trackUser(from, source) {
  if (!from || !from.id || from.is_bot) return;
  const id = String(from.id);
  const key = id + ':' + source;
  if (Date.now() - (recentlyTracked.get(key) || 0) < 10 * 60 * 1000) return;
  recentlyTracked.set(key, Date.now());
  if (recentlyTracked.size > 5000) recentlyTracked.clear();
  try {
    const existing = await firebaseGet(`users/${id}`);
    await firebasePatch(`users/${id}`, {
      id: from.id,
      first_name: from.first_name || existing?.first_name || '',
      last_name: from.last_name || existing?.last_name || '',
      username: from.username || existing?.username || '',
      joinedAt: existing?.joinedAt || Date.now(),
      lastSeen: Date.now(),
      sources: { ...(existing?.sources || {}), [source]: true }
    });
  } catch (e) {
    console.warn('trackUser xato:', e.message);
  }
}

async function getStoreStats() {
  const [orders, users, prods] = await Promise.all([
    firebaseGet('orders').then(o => o || {}),
    firebaseGet('users').then(u => u || {}),
    getProducts()
  ]);
  const list = Object.values(orders);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const confirmed = list.filter(o => ['confirmed', 'shipped', 'delivered', 'paid'].includes(o.status));
  const today = list.filter(o => (o.createdAt || 0) >= startOfDay.getTime());
  return {
    products: prods.length,
    orders_total: list.length,
    orders_pending: list.filter(o => o.status === 'pending').length,
    orders_confirmed: confirmed.length,
    orders_rejected: list.filter(o => o.status === 'rejected').length,
    revenue_confirmed: confirmed.reduce((s, o) => s + (Number(o.total) || 0), 0),
    orders_today: today.length,
    revenue_today: today.filter(o => ['confirmed', 'shipped', 'delivered', 'paid'].includes(o.status)).reduce((s, o) => s + (Number(o.total) || 0), 0),
    ...userStats(users, orders),
    note: "users_total — botga /start bosgan, Mini App'ni ochgan yoki yordamchiga yozgan barcha noyob Telegram foydalanuvchilar (hisob yuritish boshlangandan beri). Telegram bot obunachilarining to'liq sonini API orqali bermaydi, shuning uchun hisob shu tizim ishga tushgan paytdan boshlanadi. users_with_orders — kamida bitta buyurtma berganlar."
  };
}

function userStats(users, orders) {
  const list = Object.values(users || {}).filter(u => u && u.id);
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const buyers = new Set(Object.values(orders || {}).map(o => String(o.userId)).filter(Boolean));
  const src = (k) => list.filter(u => u.sources && u.sources[k]).length;
  const firstJoin = list.reduce((m, u) => Math.min(m, u.joinedAt || now), now);
  return {
    users_total: list.length,
    users_new_today: list.filter(u => (u.joinedAt || 0) >= startOfDay.getTime()).length,
    users_new_7d: list.filter(u => (u.joinedAt || 0) >= now - 7 * 86400000).length,
    users_active_24h: list.filter(u => (u.lastSeen || 0) >= now - 86400000).length,
    users_via_bot: src('bot'),
    users_via_mini_app: src('app'),
    users_via_assistant_chat: src('assistant'),
    users_with_orders: buyers.size,
    counting_since: list.length ? new Date(firstJoin).toISOString().slice(0, 10) : null
  };
}

async function listUsers({ query = '', limit = 20 } = {}) {
  const users = Object.values((await firebaseGet('users')) || {}).filter(u => u && u.id);
  const q = String(query).toLowerCase().replace('@', '').trim();
  const filtered = q ? users.filter(u => `${u.first_name} ${u.last_name} ${u.username} ${u.id}`.toLowerCase().includes(q)) : users;
  filtered.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return {
    total: filtered.length,
    users: filtered.slice(0, Math.min(Math.max(parseInt(limit) || 20, 1), 100)).map(u => ({
      user_id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' '),
      username: u.username ? '@' + u.username : '',
      joined: u.joinedAt ? new Date(u.joinedAt).toISOString().slice(0, 16).replace('T', ' ') : null,
      last_seen: u.lastSeen ? new Date(u.lastSeen).toISOString().slice(0, 16).replace('T', ' ') : null,
      via: Object.keys(u.sources || {}).join(', ')
    }))
  };
}

let botUsername = '';

const assistant = createAssistant({
  loadConfig: () => firebaseGet('settings/assistant'),
  saveConfig: (cfg) => firebasePut('settings/assistant', cfg),
  getShopInfo: () => ({ botUsername, adminIds: ADMIN_IDS, adminContact: '@Jahongir_1220', appUrl: APP_URL }),
  getStorageInfo,
  dataDir: VOLUME_DIR ? path.join(VOLUME_DIR, '.data') : null,
  onPaymentText: (text, source, key) => matchPaymentText(text, source, key),
  onSearchMiss: (q, source) => { recordSearchMiss(q, source).catch(() => {}); },
  getPaymentChannel: () => PAYMENT_CHANNEL.id ? chanKey(PAYMENT_CHANNEL.id) : '',
  notifyAdminsViaBot: async (text) => {
    if (!botInstance) return;
    await Promise.all(ADMIN_IDS.map(id => botInstance.sendMessage(id, text).catch(() => {})));
  },
  store: {
    listProducts: async () => { const r = await getRealRatings(); return (await getProducts()).map(p => withRealRating(p, r)); },
    getProduct: async (id) => { const p = (await getProducts()).find(x => String(x.id) === String(id)); return p ? withRealRating(p, await getRealRatings()) : null; },
    addProduct,
    updateProduct,
    deleteProduct,
    listOrders: () => firebaseGet('orders'),
    setOrderStatus,
    getStats: getStoreStats,
    listUsers,
    trackUser,
    getOrder: (id) => firebaseGet(`orders/${id}`),
    shipOrder: (id, opts) => shipOrder(id, opts),
    listReviews: () => botFeatures.listAllReviews(),
    deleteReview: (pid, rid) => botFeatures.deleteReview(pid, rid),
    broadcast: (opts) => botFeatures.broadcastText(opts),
    remindPending: (hours) => remindPendingPayments(hours),
    postToChannel: (pid, text) => postProductToChannel(pid, text),
    createOrder: async (opts) => { const r = await createOrder(opts); return r.error ? r : { ...r, card: { number: CARD_NUMBER, owner: CARD_OWNER } }; },
    addToWaitlist: (pid, uid, via) => addToWaitlist(pid, uid, via),
    saveChatMemory: (uid, data) => firebasePut(`chatMemory/${uid}`, data),
    loadChatMemory: (uid) => firebaseGet(`chatMemory/${uid}`),
    countNewUsers: async (from, to) => Object.values((await firebaseGet('users')) || {}).filter(u => u && (u.joinedAt || 0) >= from && (u.joinedAt || 0) <= to).length,
  }
});

// ===== DO'KON STIKERLARI =====
// stickers/*.png (512×512) bot orqali Telegram stiker to'plamiga aylantiriladi; egasi — birinchi admin.
// Bot xaridorga muhim paytlarda (salom, buyurtma qabul qilindi, yo'lda, yetkazildi) shu stikerlarni yuboradi.
const STORE_STICKERS = [
  { key: 'hello', file: '01-salom.png', emoji: ['👋', '😊'] },
  { key: 'new', file: '02-yangi.png', emoji: ['🆕', '📱'] },
  { key: 'sale', file: '03-chegirma.png', emoji: ['🔥', '💸'] },
  { key: 'accepted', file: '04-qabul.png', emoji: ['📦', '✅'] },
  { key: 'shipping', file: '05-yolda.png', emoji: ['🚚', '📦'] },
  { key: 'congrats', file: '06-muborak.png', emoji: ['🎉', '🥳'] },
  { key: 'thanks', file: '07-rahmat.png', emoji: ['🙏', '💜'] },
  { key: 'good', file: '08-zor.png', emoji: ['👍', '🔥'] },
  { key: 'soon', file: '09-tezorada.png', emoji: ['⏳', '⌚'] },
  { key: 'logo', file: '10-logo.png', emoji: ['🛍', '💜'] },
];
let stickerCache = null;   // { name, ids: { key: file_id } }
const stickerSetName = () => `techstore_by_${String(botUsername || '').toLowerCase()}`;
async function loadStickerIds() {
  if (stickerCache) return stickerCache;
  const saved = await firebaseGet('meta/stickers').catch(() => null);
  stickerCache = saved && saved.ids ? saved : { name: '', ids: {} };
  return stickerCache;
}
async function buildStickerSet() {
  if (!botInstance || !botUsername) return { error: 'Bot ishlamayapti' };
  const owner = Number(ADMIN_IDS[0]);
  if (!owner) return { error: 'ADMIN_IDS sozlanmagan' };
  const name = stickerSetName();
  let set = await botInstance._request('getStickerSet', { qs: { name } }).catch(() => null);
  const have = new Set(((set && set.stickers) || []).map(s => s.emoji));
  const ids = {};
  for (const st of STORE_STICKERS) {
    const p = path.join(__dirname, 'stickers', st.file);
    if (!fs.existsSync(p)) continue;
    const input = { emoji_list: st.emoji, keywords: [st.key, 'techstore'] };
    if (!set) {
      const up = await botInstance.uploadStickerFile(owner, fs.createReadStream(p), 'static', {}, { filename: st.file, contentType: 'image/png' });
      await botInstance._request('createNewStickerSet', { qs: { user_id: owner, name, title: 'TechStore', sticker_type: 'regular', stickers: JSON.stringify([{ ...input, sticker: up.file_id, format: 'static' }]) } });
      set = await botInstance._request('getStickerSet', { qs: { name } });
      have.add(st.emoji[0]);
      continue;
    }
    if (have.has(st.emoji[0])) continue;
    const up = await botInstance.uploadStickerFile(owner, fs.createReadStream(p), 'static', {}, { filename: st.file, contentType: 'image/png' });
    await botInstance._request('addStickerToSet', { qs: { user_id: owner, name, sticker: JSON.stringify({ ...input, sticker: up.file_id, format: 'static' }) } });
    have.add(st.emoji[0]);
  }
  set = await botInstance._request('getStickerSet', { qs: { name } });
  for (const st of STORE_STICKERS) { const s = set.stickers.find(x => x.emoji === st.emoji[0]); if (s) ids[st.key] = s.file_id; }
  stickerCache = { name, ids, builtAt: Date.now() };
  await firebasePut('meta/stickers', stickerCache);
  return { ok: true, count: set.stickers.length, link: `https://t.me/addstickers/${name}` };
}
async function sendStoreSticker(chatId, key) {
  try {
    if (!botInstance || !chatId) return;
    const c = await loadStickerIds();
    if (c.ids[key]) await botInstance.sendSticker(chatId, c.ids[key]);
  } catch (_) {}
}
app.post('/api/admin/stickers/build', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const r = await buildStickerSet();
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/stickers', apiRateLimiter, verifyAdmin, async (req, res) => {
  const c = await loadStickerIds();
  res.json({ ready: Object.keys(c.ids).length > 0, count: Object.keys(c.ids).length, link: c.name ? `https://t.me/addstickers/${c.name}` : null });
});

// ===== KANALGA MAHSULOT POSTI =====
// Tuzilma kod bilan quriladi (faqat haqiqiy ma'lumot): sarlavha, qisqa matn, xususiyatlar, variantlar, narx, heshteglar
const CHANNEL_CAT_EMOJI = { 'Telefonlar': '📱', 'Kompyuterlar': '💻', 'PC qismlari': '🖥', 'Periferiya': '⌨️', 'Audio': '🎧', 'Aksessuarlar': '🔌', 'Kameralar': '📷', "O'yinlar": '🎮', 'Dronlar': '🚁', 'Smart TV': '📺', 'Mebel': '🪑' };
const CHANNEL_SPEC_EMOJI = [
  [/videokarta|grafik|gpu/, '🎮'], [/ekran|diagonal|displey|monitor|tashqi/, '🖥'], [/protsessor|chip|cpu|soket|yadro|chipset/, '⚙️'],
  [/ram|xotira|hajm|ssd|hdd|kesh/, '💾'], [/kamera|megapiksel|foto|obyektiv|optik|linza|matritsa|sensor/, '📸'],
  [/batareya|sig'im|akkumulyator|parvoz vaqti/, '🔋'], [/quvvat|watt|sertifikat|zaryad|tdp|blok pitaniya/, '⚡'],
  [/rang|podsvetka/, '🎨'], [/og'irlik|yuk|vazn/, '⚖️'], [/ulanish|bluetooth|wi-?fi|interfeys|port|ulagich|shina/, '🔗'],
  [/video|kadr/, '🎬'], [/audio|dinamik|drayver|ovoz|mikrofon|anc|shovqin/, '🔊'], [/\bos\b|platforma|smart|tizim/, '📲'],
  [/suv/, '💧'], [/kafolat|himoya/, '🛡'], [/chastota|tezlik|aylanish|hz/, '🚀'], [/kuler|ventilyator|radiator/, '❄️'],
  [/masofa/, '📡'], [/material|korpus|o'lcham|uzunl|baland|qalinlik|format/, '📐'],
];
const specEmoji = label => { const k = String(label || '').toLowerCase().replace(/[‘’`]/g, "'"); const r = CHANNEL_SPEC_EMOJI.find(([re]) => re.test(k)); return r ? r[1] : '▫️'; };
const hashTag = s => '#' + String(s || '').replace(/[^\p{L}\p{N}]+/gu, '');

function buildChannelCaption(p, hook) {
  const name = plainText(p.name);
  const lines = [];
  lines.push(`${p.discount > 0 ? '🔥 <b>CHEGIRMA</b>' : '🆕 <b>YANGI MAHSULOT</b>'}`, '');
  lines.push(`${CHANNEL_CAT_EMOJI[p.cat] || '✨'} <b>${escHtml(name)}</b>`);
  if (hook) lines.push(`<i>${escHtml(plainText(hook)).slice(0, 350)}</i>`);
  const specs = (Array.isArray(p.specs) ? p.specs : []).filter(x => Array.isArray(x) && x[0] && x[1]).slice(0, 7);
  if (specs.length) {
    lines.push('', '<b>📋 Xususiyatlari:</b>');
    lines.push('<blockquote>' + specs.map(([k, v]) => `${specEmoji(k)} ${escHtml(plainText(k))}: <b>${escHtml(plainText(v))}</b>`).join('\n') + '</blockquote>');
  }
  const variants = (Array.isArray(p.variants) ? p.variants : []).filter(v => v && v.name && Number(v.price) > 0).slice(0, 6);
  if (variants.length) {
    lines.push('<b>🎨 Variantlar:</b>');
    variants.forEach(v => lines.push(`• ${escHtml(plainText(v.name))} — <b>${fmtSom(v.price)}</b>`));
  }
  lines.push('');
  const old = p.discount > 0 ? Math.round(Number(p.regularPrice) > p.price ? Number(p.regularPrice) : p.price / (1 - p.discount / 100)) : 0;
  lines.push(`💰 Narxi: <b>${variants.length ? fmtSom(Math.min(...variants.map(v => Number(v.price)))) + ' dan' : fmtSom(p.price)}</b>${old && !variants.length ? `  <s>${fmtSom(old)}</s>  (−${p.discount}%)` : ''}`);
  if (p.discount > 0 && p.discountUntil && p.discountUntil > Date.now()) {
    const d = new Date(p.discountUntil + 5 * 3600e3);
    lines.push(`⏳ Chegirma ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')} gacha amal qiladi`);
  }
  const st = p.stock === null || p.stock === undefined || p.stock === '' ? null : Number(p.stock);
  if (st !== null && st > 0 && st <= 5) lines.push(`📦 Omborda atigi <b>${st} ta</b> qoldi`);
  lines.push("🚚 BTS orqali butun O'zbekiston bo'ylab yetkazib berish");
  lines.push('', '👇 Buyurtma berish uchun tugmani bosing');
  const tags = [p.cat ? hashTag(p.cat) : '', p.brand ? hashTag(p.brand) : '', '#TechStore'].filter(t => t.length > 1);
  lines.push('', tags.join(' '));
  let cap = lines.join('\n');
  // Telegram rasm izohi chegarasi — 1024 belgi (teglardan tashqari matn bo'yicha)
  if (cap.replace(/<[^>]+>/g, '').length > 1000 && hook) return buildChannelCaption(p, '');
  return cap;
}

async function postProductToChannel(pid, text) {
  if (!botInstance) return { error: 'Bot ishlamayapti' };
  if (!SHOP_CHANNEL) return { error: "Kanal sozlanmagan: admin panel → Sozlamalar → Telegram kanal'ga kanal username'ini kiriting va botni kanalga admin qiling" };
  const p = (await getProducts()).find(x => String(x.id) === String(pid));
  if (!p) return { error: 'Mahsulot topilmadi' };
  const name = plainText(p.name);
  let caption = buildChannelCaption(p, text || '');
  if (caption.replace(/<[^>]+>/g, '').length > 1020) caption = buildChannelCaption({ ...p, specs: (p.specs || []).slice(0, 4), variants: (p.variants || []).slice(0, 3) }, '');
  const markup = { inline_keyboard: [
    [{ text: '🛍 Sotib olish', url: `https://t.me/${botUsername}?start=p_${p.id}` }],
    [{ text: "🏪 Barcha mahsulotlar", url: `https://t.me/${botUsername}?start=shop` }],
  ] };
  const src = (Array.isArray(p.images) && p.images[0]) || p.image;
  const chat = '@' + SHOP_CHANNEL;
  try {
    let msg;
    const buf = src ? await loadImageSource(src).catch(() => null) : null;
    msg = buf ? await botInstance.sendPhoto(chat, buf, { caption, parse_mode: 'HTML', reply_markup: markup }, { filename: 'mahsulot.jpg', contentType: 'image/jpeg' })
      : await botInstance.sendMessage(chat, caption, { parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
    return { posted: true, product: name, link: `https://t.me/${SHOP_CHANNEL}/${msg.message_id}` };
  } catch (e) {
    return { error: `Kanalga yuborib bo'lmadi: ${e.message}. Bot kanalda admin ekanini tekshiring.` };
  }
}

// ===== YANGI MAHSULOT — KANALGA AVTOMATIK E'LON =====
// Matnni Gemini faqat mahsulotning haqiqiy ma'lumotlaridan yozadi (o'ylab topilgan xususiyat yo'q); kalit bo'lmasa — shablon.
async function channelCaption(p) {
  // Faqat 1–2 jumlali qisqa jozibali matn; xususiyat/narx ro'yxatini kod o'zi chiqaradi
  const specs = (Array.isArray(p.specs) ? p.specs : []).filter(x => Array.isArray(x) && x[0] && x[1]).slice(0, 6);
  const facts = [`Nomi: ${plainText(p.name)}`, p.brand ? `Brend: ${plainText(p.brand)}` : '', p.cat ? `Kategoriya: ${p.cat}` : '',
    p.desc && !/tavsif yo'q/i.test(p.desc) ? `Tavsif: ${plainText(p.desc).slice(0, 500)}` : '',
    specs.length ? 'Xususiyatlar: ' + specs.map(([a, b]) => `${plainText(a)} — ${plainText(b)}`).join('; ') : ''].filter(Boolean).join('\n');
  try {
    if (typeof assistant !== 'undefined' && assistant.geminiGenerate) {
      const r = await assistant.geminiGenerate([{ text:
        `Telegram do'kon kanalidagi mahsulot e'loni uchun 1–2 jumlali qisqa jozibali kirish matni yoz (o'zbek tilida, lotin alifbosida).\n${facts}\n\n` +
        `Qoidalar: FAQAT yuqoridagi ma'lumotlardan foydalan — xususiyat, narx, kafolat, sovg'a yoki aksiya o'ylab topma. ` +
        `Mahsulot nomini, narxni, yetkazib berishni va xususiyatlar ro'yxatini yozma (ular alohida chiqadi). Emoji ishlatma. 160 belgidan oshmasin. Faqat matnni qaytar.` }]);
      const t = r && !r.error && String(r.text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
      if (t && t.length > 15) return t.slice(0, 220);
    }
  } catch (_) {}
  return p.desc && !/tavsif yo'q/i.test(p.desc) ? plainText(p.desc).slice(0, 200) : '';
}
async function autoPostNewProduct(pid, { manual = false } = {}) {
  if (!manual && !SHOP_AUTOPOST) return { skipped: "o'chirilgan" };
  if (!SHOP_CHANNEL || !botInstance) return { error: 'Kanal sozlanmagan' };
  const p = (await getProducts()).find(x => String(x.id) === String(pid));
  if (!p) return { error: 'Mahsulot topilmadi' };
  if (!manual && p.channelPostedAt) return { skipped: 'allaqachon joylangan' };
  if (!manual && !hasStock(p)) return { skipped: 'omborda yo\'q' };
  const r = await postProductToChannel(p.id, await channelCaption(p));
  const tellAdmins = text => { for (const id of ADMIN_IDS) botInstance.sendMessage(id, text, { disable_web_page_preview: true }).catch(() => {}); };
  if (r.posted) {
    await setProductFields(p.id, { channelPostedAt: Date.now(), channelPostLink: r.link });
    if (!manual) tellAdmins(`📢 Yangi mahsulot kanalga joylandi: ${plainText(p.name)}\n${r.link}`);
    console.log(`📢 Kanalga e'lon: ${plainText(p.name)} → ${r.link}`);
  } else if (!manual) tellAdmins(`📢 "${plainText(p.name)}" kanalga avtomatik joylanmadi: ${r.error}`);
  return r;
}
app.post('/api/admin/products/:pid/post-channel', apiRateLimiter, verifyAdmin, async (req, res) => {
  try {
    const r = await autoPostNewProduct(req.params.pid, { manual: true });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vaqtinchalik chegirma muddati tugasa — narx asl holiga qaytadi
async function restoreExpiredDiscounts() {
  const now = Date.now();
  const list = await getProducts();
  const expired = list.filter(p => p && p.regularPrice && p.discountUntil && p.discountUntil <= now);
  for (const p of expired) {
    await updateProduct(p.id, { price: p.regularPrice, discount: 0, discountUntil: null, regularPrice: null }).catch(() => {});
    console.log(`⏰ Chegirma tugadi: ${plainText(p.name)} — narx ${fmtSom(p.regularPrice)} ga qaytdi`);
  }
}

// ===== "KELGANDA XABAR BERING" =====
async function addToWaitlist(pid, uid, via = 'miniapp') {
  await firebasePatch(`waitlist/${pid}`, { [String(uid)]: { via, at: Date.now() } });
}
function hasStock(p) {
  if (!p) return false;
  if (Array.isArray(p.variants) && p.variants.length) return p.variants.some(v => v.stock === null || v.stock === undefined || v.stock === '' || Number(v.stock) > 0);
  return p.stock === null || p.stock === undefined || p.stock === '' || Number(p.stock) > 0;
}
async function notifyWaitlist(product) {
  const list = (await firebaseGet(`waitlist/${product.id}`)) || {};
  const ids = Object.keys(list);
  if (!ids.length) return 0;
  await firebaseDelete(`waitlist/${product.id}`);
  const name = plainText(product.name);
  let sent = 0;
  for (const uid of ids) {
    const text = `🎉 Xushxabar! Siz kutgan ${name} yana sotuvda — ${fmtSom(product.price)}.\n\nOmborda soni cheklangan, xohlasangiz shu yerning o'zida buyurtma rasmiylashtirib beraman 😊`;
    const html = `🎉 <b>Xushxabar!</b> Siz kutgan <b>${escHtml(name)}</b> yana sotuvda — <b>${fmtSom(product.price)}</b>.\n\nSoni cheklangan, shoshiling 👇`;
    let ok = false;
    if (list[uid]?.via === 'assistant') ok = await assistant.sendToCustomer({ userId: uid, text }).catch(() => false);
    if (!ok && botInstance) {
      ok = await botInstance.sendMessage(uid, html, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "🛍 Ko'rish", web_app: { url: `${APP_URL}?product=${product.id}` } }]] } }).then(() => true).catch(() => false);
    }
    if (ok) sent++;
    await new Promise(r => setTimeout(r, 80));
  }
  console.log(`🔔 ${name} omborga keldi — ${sent}/${ids.length} kishiga xabar berildi`);
  return sent;
}

// To'lovi kutilayotgan buyurtmalarga muloyim eslatma (bir buyurtmaga bir marta)
async function remindPendingPayments(hours = 1) {
  const orders = (await firebaseGet('orders')) || {};
  const now = Date.now();
  let sent = 0, failed = 0;
  const list = [];
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.status !== 'pending' || o.paymentReminderAt || !o.createdAt) continue;
    if (now - o.createdAt < hours * 3600e3 || now - o.createdAt > 3 * 86400e3) continue;
    const num = plainText(o.orderNum || '#' + id);
    const sum = fmtSom(o.total);
    const text = `Assalomu alaykum! 😊 ${num} buyurtmangiz bo'yicha to'lovni hali ko'rmadik.\n\n💳 Karta: ${CARD_NUMBER} (${CARD_OWNER})\n💰 Aynan ${sum} o'tkazing — shunda to'lov avtomatik tasdiqlanadi.\n\nTo'lagan bo'lsangiz yoki savolingiz bo'lsa, shu yerga yozing.`;
    const html = `⏳ <b>${escHtml(num)}</b> buyurtmangiz bo'yicha to'lovni hali ko'rmadik.\n\n💳 Karta: <code>${escHtml(CARD_NUMBER)}</code> (${escHtml(CARD_OWNER)})\n💰 Aynan <b>${sum}</b> o'tkazing — to'lov avtomatik tasdiqlanadi.\n\nSavolingiz bo'lsa, yozing 😊`;
    const via = await messageCustomer(o, { text, html }).catch(() => false);
    await firebasePatch(`orders/${id}`, { paymentReminderAt: now });
    if (via) { sent++; list.push(num); } else failed++;
    if (sent + failed >= 30) break;
  }
  return { sent, failed, orders: list };
}

const botFeatures = createBotFeatures({
  firebaseGet, firebasePatch, firebaseDelete, getProducts, updateProduct,
  escHtml, fmtSom,
  getBot: () => botInstance,
  getAdminIds: () => ADMIN_IDS,
  getAppUrl: () => APP_URL,
  getChannel: () => SHOP_CHANNEL,
  getAssistantContact: () => assistant.publicContact(),
  welcomeImagePath: path.join(__dirname, 'welcome.jpg'),
  getBackupData: () => firebaseGet(''),
});

for (const fn of ['addReview', 'deleteReview']) {
  const orig = botFeatures[fn];
  botFeatures[fn] = async (...args) => { try { return await orig(...args); } finally { invalidateRatings(); } };
}

// Mini App foydalanuvchisini initData orqali aniqlash (imzo tekshiriladi)
function userFromInitData(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return null;
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (!verifyTelegramAuth(initData) && !(isLocal && !BOT_TOKEN)) return null;
  try {
    const u = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
    return u && u.id ? u : null;
  } catch (_) { return null; }
}

// Savat va sevimlilar (eslatmalar uchun)
app.post('/api/me/sync', apiRateLimiter, async (req, res) => {
  const user = userFromInitData(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  try {
    await botFeatures.syncUserData(user.id, { cart: req.body?.cart, favorites: req.body?.favorites });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== XARIDOR BUYURTMALARI (Mini App) =====
function proofToken(orderId) {
  return crypto.createHash('sha256').update(`proof:${orderId}:${BOT_TOKEN || process.env.SESSION_SECRET || 'ts'}`).digest('hex').slice(0, 24);
}
function proofUrl(orderId, order) {
  const f = order?.fulfillment || {};
  return (f.shipProofFileId || f.shipProofImg) ? `/api/orders/${encodeURIComponent(orderId)}/ship-proof?t=${proofToken(orderId)}` : null;
}
const plainText = (v) => String(v ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

app.get('/api/me/orders', apiRateLimiter, async (req, res) => {
  const user = userFromInitData(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  try {
    const all = (await firebaseGet('orders')) || {};
    const list = Object.entries(all)
      .filter(([, o]) => o && String(o.userId) === String(user.id))
      .map(([id, o]) => ({
        id, orderNum: plainText(o.orderNum || '#' + id), products: plainText(o.products || ''), items: o.items || null,
        total: o.total || 0, status: o.status || 'pending', addr: plainText(o.addr || ''), phone: plainText(o.phone || ''),
        createdAt: o.createdAt || 0, confirmedAt: o.confirmedAt || 0,
        shippedAt: o.fulfillment?.shippedAt || 0, deliveredAt: o.fulfillment?.deliveredAt || 0,
        shipNote: plainText(o.fulfillment?.shipNote || ''), shipProof: proofUrl(id, o), review: o.review || null,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Taklif qilingan do'stlar soni (bonus berilmaydi)
app.get('/api/me/referrals', apiRateLimiter, async (req, res) => {
  const user = userFromInitData(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  try {
    const users = (await firebaseGet('users')) || {};
    const invited = Object.entries(users).filter(([, u]) => u && String(u.referredBy || '') === String(user.id)).map(([id]) => String(id));
    const orders = (await firebaseGet('orders')) || {};
    const buyers = new Set(Object.values(orders).filter(o => o && invited.includes(String(o.userId))).map(o => String(o.userId)));
    res.json({ count: invited.length, buyers: buyers.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Taklif havolasi uchun QR-kod (do'stga telefondan ko'rsatish uchun)
app.get('/api/me/ref-qr', apiRateLimiter, async (req, res) => {
  try {
    const uid = String(req.query.u || '').replace(/\D/g, '').slice(0, 20);
    const link = `https://t.me/${botUsername || 'Tech_uzbot'}${uid ? `?start=ref_${uid}` : ''}`;
    const png = await require('qrcode').toBuffer(link, { width: 480, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0d2b', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(png);
  } catch (e) { res.status(500).end(); }
});
let refShareFid = null;
async function refShareFileId(uid) {
  if (refShareFid) return refShareFid;
  const saved = await firebaseGet('meta/refShareFileId').catch(() => null);
  if (typeof saved === 'string' && saved) return (refShareFid = saved);
  // Bir marta yuklaymiz: foydalanuvchining o'ziga jim yuborib, file_id ni olamiz va xabarni darhol o'chiramiz
  const m = await botInstance.sendPhoto(uid, fs.createReadStream(path.join(__dirname, 'welcome.jpg')), { disable_notification: true });
  botInstance.deleteMessage(uid, m.message_id).catch(() => {});
  const fid = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : null;
  if (fid) { refShareFid = fid; firebasePatch('meta', { refShareFileId: fid }).catch(() => {}); }
  return fid;
}
// Do'stga yuboriladigan tayyor xabar: banner rasm + matn + "Do'konni ochish" tugmasi (shaxsiy havola bilan)
app.post('/api/me/ref-share', apiRateLimiter, async (req, res) => {
  const user = userFromInitData(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  if (!botInstance || !botUsername) return res.status(503).json({ error: 'Bot ishlamayapti' });
  try {
    const link = `https://t.me/${botUsername}?start=ref_${user.id}`;
    const caption = `🛍 <b>TechStore</b> — original texnika onlayn do'koni\n\n📱 Smartfon, 💻 noutbuk, 🎧 quloqchin va boshqa gadjetlar\n🚚 O'zbekiston bo'ylab BTS orqali tekin yetkazib berish\n🛡 Xavfsiz to'lov · avtomatik tasdiqlash\n💬 24/7 yordamchi\n\n${escHtml(user.first_name || "Do'stingiz")} sizga tavsiya qildi 👇`;
    // Rasm URL orqali emas, Telegram'ga bir marta yuklangan file_id orqali — har doim ko'rinadi
    const fileId = await refShareFileId(user.id).catch(e => { console.warn('Ulashish rasmi:', e.message); return null; });
    const img = `${APP_URL}/welcome.jpg`;
    const result = { type: 'photo', id: `ref${user.id}`, ...(fileId ? { photo_file_id: fileId } : { photo_url: img, thumbnail_url: img }), caption, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: "🛍 Do'konni ochish", url: link }]] } };
    const prepared = await botInstance._request('savePreparedInlineMessage', { form: {
      user_id: user.id, result: JSON.stringify(result), allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false } });
    res.json({ id: prepared.id, link });
  } catch (e) { res.status(500).json({ error: "Ulashishni tayyorlab bo'lmadi" }); }
});

app.post('/api/me/waitlist/:pid', apiRateLimiter, async (req, res) => {
  const user = userFromInitData(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  try {
    const p = (await getProducts()).find(x => String(x.id) === String(req.params.pid));
    if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi' });
    await addToWaitlist(p.id, user.id, 'miniapp');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function ownOrder(req, res) {
  const user = userFromInitData(req);
  if (!user) { res.status(401).json({ error: 'auth' }); return null; }
  const order = await firebaseGet(`orders/${req.params.id}`);
  if (!order || String(order.userId) !== String(user.id)) { res.status(404).json({ error: 'Buyurtma topilmadi' }); return null; }
  return { user, order };
}

app.post('/api/me/orders/:id/delivered', apiRateLimiter, async (req, res) => {
  try {
    const r = await ownOrder(req, res); if (!r) return;
    if (!['shipped', 'delivered'].includes(r.order.status)) return res.status(400).json({ error: "Buyurtma hali jo'natilmagan" });
    const was = r.order.status;
    await botFeatures.markDelivered(r.order, req.params.id);
    if (was !== 'delivered') sendStoreSticker(r.order.userId, 'congrats');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/me/orders/:id/review', apiRateLimiter, async (req, res) => {
  try {
    const r = await ownOrder(req, res); if (!r) return;
    if (r.order.review) return res.status(400).json({ error: 'Siz allaqachon fikr qoldirgansiz' });
    if (!['shipped', 'delivered'].includes(r.order.status)) return res.status(400).json({ error: "Fikrni buyurtma yetib kelgach qoldirish mumkin" });
    if (r.order.status === 'shipped') await botFeatures.markDelivered(r.order, req.params.id);
    const photo = typeof req.body?.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(req.body.photo) && req.body.photo.length < 1.5e6 ? req.body.photo : null;
    const name = [r.user.first_name, r.user.last_name].filter(Boolean).join(' ').trim() || plainText(r.order.userName) || 'Xaridor';
    await botFeatures.addReview({ order: r.order, orderId: req.params.id, userId: r.user.id, name, rating: req.body?.rating, text: req.body?.text, photoData: photo });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Jo'natish cheki rasmi (havolada imzo bor — <img> uchun)
app.get('/api/orders/:id/ship-proof', async (req, res) => {
  try {
    if (req.query.t !== proofToken(req.params.id)) return res.status(403).end();
    const order = await firebaseGet(`orders/${req.params.id}`);
    const f = order?.fulfillment || {};
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const m = f.shipProofImg && String(f.shipProofImg).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (m) { res.setHeader('Content-Type', m[1]); return res.end(Buffer.from(m[2], 'base64')); }
    if (!f.shipProofFileId || !botInstance) return res.status(404).end();
    const r = await fetch(await botInstance.getFileLink(f.shipProofFileId), { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).end(); }
});

// Mijozlar fikri
app.get('/api/products/:id/reviews', apiRateLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(await botFeatures.listReviews(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reviews/:pid/:rid/photo', apiRateLimiter, async (req, res) => {
  try {
    const ph = await botFeatures.reviewPhoto(req.params.pid, req.params.rid);
    if (!ph) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (ph.data) { res.setHeader('Content-Type', ph.type); return res.end(ph.data); }
    const r = await fetch(ph.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).end();
  }
});

function assistantRoute(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      res.json({ success: true, ...(data || {}), status: assistant.status() });
    } catch (e) {
      console.error('Assistant API error:', e.message);
      res.status(400).json({ error: e.errorMessage ? `Telegram: ${e.errorMessage}` : e.message, status: assistant.status() });
    }
  };
}

app.get('/api/admin/assistant', apiRateLimiter, verifyAdmin, (req, res) => {
  res.json(assistant.status());
});

app.post('/api/admin/assistant/settings', apiRateLimiter, verifyAdmin, assistantRoute(req => assistant.updateSettings(req.body || {})));

app.post('/api/admin/assistant/send-code', apiRateLimiter, verifyAdmin, assistantRoute(req => assistant.sendCode({
  apiId: req.body.apiId,
  apiHash: req.body.apiHash,
  phone: req.body.phone,
  ownerId: req.adminUser?.id
})));

app.post('/api/admin/assistant/verify-code', apiRateLimiter, verifyAdmin, assistantRoute(req => assistant.verifyCode(req.body.code)));

app.post('/api/admin/assistant/verify-password', apiRateLimiter, verifyAdmin, assistantRoute(req => assistant.verifyPassword(req.body.password)));

app.post('/api/admin/assistant/test-ai', apiRateLimiter, verifyAdmin, assistantRoute(() => assistant.testAI()));
app.get('/api/admin/assistant/models', apiRateLimiter, verifyAdmin, assistantRoute(() => assistant.listModels()));

app.post('/api/admin/assistant/disconnect', apiRateLimiter, verifyAdmin, assistantRoute(() => assistant.disconnect()));

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
      ...(process.env.TELEGRAM_API_URL ? { baseApiUrl: process.env.TELEGRAM_API_URL } : {}),
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
      }
    });
    botInstance = bot;
    global.telegramBotInstance = bot;
    bot.getMe().then(me => { botUsername = me.username || ''; }).catch(() => {});
    botFeatures.setCommands().catch(() => {});
    setShopMenuButton(bot).then(() => console.log(`🔘 Menu tugmasi o'rnatildi: ${APP_URL}`));
    
    bot.on('polling_error', (err) => {
      console.error('Polling xatosi:', err.code, err.message);
    });

    bot.onText(/\/start/, (msg) => {
      const chatId    = msg.chat.id;
      const firstName = msg.from?.first_name || 'Foydalanuvchi';
      console.log(`/start - ${firstName} (${chatId})`);
      // Shu chat uchun alohida eski tugma qolgan bo'lsa ham almashtiriladi
      setShopMenuButton(bot, chatId);

      // Ulashilgan havola orqali kelgan: /start p_<mahsulotID> — shu mahsulotni darhol ochamiz
      const payload = (msg.text || '').split(' ')[1] || '';
      // Do'st taklifi: /start ref_<taklif qilgan ID> — faqat yangi foydalanuvchi uchun yoziladi (bonussiz)
      const rm = payload.match(/^ref_(\d+)$/);
      if (rm && rm[1] !== String(msg.from?.id)) {
        (async () => {
          const uid = String(msg.from.id);
          const existing = await firebaseGet(`users/${uid}`);
          const isNew = !existing || !existing.joinedAt || Date.now() - existing.joinedAt < 10 * 60 * 1000;
          if (!isNew || existing?.referredBy) return;
          await firebasePatch(`users/${uid}`, { referredBy: rm[1], referredAt: Date.now() });
          const who = escHtml([msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Do\'stingiz');
          bot.sendMessage(rm[1], `🎉 <b>${who}</b> sizning taklifingiz bilan TechStore'ga qo'shildi! Do'konimizni tavsiya qilganingiz uchun rahmat 💜`, { parse_mode: 'HTML' }).catch(() => {});
        })().catch(e => console.warn('Taklifni yozib bo\'lmadi:', e.message));
      }
      const pm = payload.match(/^p_(\d+)$/);
      if (pm) {
        getProducts().then(list => {
          const p = list.find(x => String(x.id) === pm[1]);
          if (!p) throw new Error('not found');
          bot.sendMessage(chatId,
            `👋 Salom, <b>${escHtml(firstName)}</b>!\n\n${p.discount > 0 ? '🔥' : '✨'} <b>${escHtml(p.name)}</b>\n💰 <b>${fmtSom(p.price)}</b>\n\nMahsulotni ko'rish uchun tugmani bosing 👇`,
            {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: "🛍 Mahsulotni ochish", web_app: { url: `${APP_URL}?product=${p.id}` } }]] }
            }
          );
        }).catch(() => bot.sendMessage(chatId, "Bu mahsulot endi mavjud emas. Do'kondagi boshqa mahsulotlarni ko'ring 👇", {
          reply_markup: { inline_keyboard: [[{ text: "🛍️ Do'konni ochish", web_app: { url: APP_URL } }]] }
        }));
        return;
      }

      sendStoreSticker(chatId, 'hello').finally(() => botFeatures.sendWelcome(chatId, firstName).catch(e => console.warn('/start xatosi:', e.message)));
    });

    bot.onText(/^\/(stikerlar|stickers)\b/, async (msg) => {
      if (!ADMIN_IDS.includes(String(msg.from?.id || ''))) return;
      bot.sendMessage(msg.chat.id, '🎨 Stiker to\'plami tayyorlanmoqda…').catch(() => {});
      const r = await buildStickerSet().catch(e => ({ error: e.message }));
      if (r.error) return bot.sendMessage(msg.chat.id, `❌ ${r.error}`).catch(() => {});
      bot.sendMessage(msg.chat.id, `✅ TechStore stikerlari tayyor (${r.count} ta):\n${r.link}`).catch(() => {});
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
        `📋 <b>Buyruqlar:</b>\n\n/start — Do'konni ochish\n/buyurtmalarim — Buyurtmalarim va ularning holati\n/help — Yordam` +
        (ADMIN_IDS.includes(String(msg.from?.id)) ? `\n\n👑 <b>Admin:</b>\n/admin — Admin panel\n/hisobot — Bugungi hisobot\n/reklama — Hammaga xabar yuborish\n/backup — Zaxira nusxa` : '') +
        `\n\nSavollar bo'lsa, do'kon yordamchisiga yozing — u 24/7 javob beradi 💬`,
        { parse_mode: 'HTML' }
      );
    });

    bot.on('channel_post', (msg) => {
      const cid = String(msg.chat?.id || '');
      if (isPaymentChannel(cid)) return handlePaymentMessage(msg, { trusted: true });
      // Boshqa kanal — to'lov sifatida qabul qilinmaydi, faqat eslab qolamiz (admin panelda tanlash uchun)
      seenChannels.set(cid, { id: cid, title: msg.chat?.title || '', username: msg.chat?.username || '', at: Date.now(), looksPayment: looksLikeCredit(msg.text || msg.caption || '') });
      if (seenChannels.size > 10) seenChannels.delete(seenChannels.keys().next().value);
    });

    bot.on('callback_query', (query) => {
      const data = String(query.data || '');
      if (data.startsWith('ship:')) {
        startShipFlow(bot, query).catch(e => {
          console.error('ship tugmasi xatosi:', e.message);
          bot.answerCallbackQuery(query.id, { text: 'Xatolik, qayta urinib ko\'ring' }).catch(() => {});
        });
      } else {
        botFeatures.handleCallback(query).then(handled => {
          if (!handled) bot.answerCallbackQuery(query.id).catch(() => {});
        }).catch(e => {
          console.error('Tugma xatosi:', e.message);
          bot.answerCallbackQuery(query.id, { text: 'Xatolik, qayta urinib ko\'ring' }).catch(() => {});
        });
      }
    });

    bot.on('message', async (msg) => {
      if (msg.chat && msg.chat.type === 'private') trackUser(msg.from, 'bot');
      if (msg.chat?.type === 'private' && awaitingShipProof.has(String(msg.chat.id))) {
        try {
          if (await handleShipProofMessage(bot, msg)) return;
        } catch (e) {
          console.error('Chekni qayta ishlashda xato:', e.message);
          bot.sendMessage(msg.chat.id, '⚠️ Xatolik yuz berdi: ' + e.message).catch(() => {});
          return;
        }
      }
      try {
        if (await botFeatures.handleMessage(msg)) return;
      } catch (e) {
        console.error('Bot xabarini qayta ishlashda xato:', e.message);
      }
      if (msg.text && msg.text.startsWith('/')) return;
      handlePaymentMessage(msg);
    });

    console.log('✅ Telegram bot ishga tushdi (polling mode & automatic payment verification active)');
  } catch (e) {
    console.error("❌ Failed to initialize Telegram Bot:", e.message);
  }
}

// ===== TO'LOV XABARLARINI AVTOMATIK KUZATISH TIZIMI =====
// Har bir buyurtmaga unikal summa beriladi (masalan 18 500 003). Bank/karta xabarida aynan shu summa
// uchrasa, buyurtma avtomatik tasdiqlanadi. Xabar manbalari:
//   • admin @bot ga yoki yordamchi akkauntga bank xabarini forward qiladi;
//   • yordamchi akkauntdagi bank/karta botlari xabarlari (masalan HUMO, CardXabar);
//   • telefondagi SMS'ni yuboruvchi ilova (webhook: /api/payment-hook/<kalit>);
//   • bot admin bo'lgan kanal postlari.
// Oddiy xaridor botga summa yozsa — hisobga olinmaydi (aks holda o'zini "to'ladim" deb tasdiqlab olardi).
function amountsInText(text) {
  const found = new Set();
  const lines = String(text || '').split(/\n/);
  for (const line of lines) {
    // "18 500 003.00", "18,500,003", "18500003" kabi raqamlar guruhlari
    const tokens = line.match(/\d[\d\s.,  ']*\d|\d/g) || [];
    for (const tok of tokens) {
      const clean = tok.replace(/[.,]\d{1,2}$/, '');              // tiyinlar (.00)
      const groups = clean.split(/[\s.,  ']+/).filter(Boolean);
      for (let i = 0; i < groups.length; i++) {
        let acc = '';
        for (let j = i; j < groups.length; j++) {
          if (j > i && groups[j].length !== 3) break;
          acc += groups[j];
          found.add(acc.replace(/^0+/, ''));
        }
      }
    }
  }
  return found;
}

// Bank xabaridan faqat TUSHGAN pul summasini olamiz: qoldiq (💰, "balans"), sana/vaqt,
// karta raqami va yechilgan pul (➖) qatorlari hisobga olinmaydi.
const BALANCE_LINE_RE = /💰|balans|qoldiq|остаток|баланс|balance|dostupno|доступно/i;
const DEBIT_LINE_RE = /➖|списан|spisan|pokupka|покупка|oplata|оплата|yechib|chiqim/i;
const CREDIT_LINE_RE = /➕|^\s*\+\s*\d|пополн|popoln|зачисл|zachisl|to'ldirish|tushdi|kirim|приход/im;
function looksLikeCredit(text) { return CREDIT_LINE_RE.test(String(text || '')); }
function paymentAmounts(text) {
  // Qatordagi shovqinni kesamiz: qoldiq so'zidan keyingi qism, karta raqami, sana va vaqt
  const clean = l => l
    .replace(new RegExp('(' + BALANCE_LINE_RE.source + ').*$', 'i'), '')
    .replace(/\*+\s?\d{4}|\d{4,6}\s?\*{2,}\s?\d{0,4}|\b\d{16}\b/g, ' ')
    .replace(/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
  const lines = String(text || '').split(/\n/);
  const plusLines = lines.filter(l => /➕|^\s*\+\s*\d/.test(l));
  if (plusLines.length) return amountsInText(plusLines.map(clean).join('\n'));
  // ➕ belgisi yo'q (masalan, SMS): pul yechilgani haqidagi xabar bo'lsa — hech narsa
  if (DEBIT_LINE_RE.test(text) && !CREDIT_LINE_RE.test(text)) return new Set();
  return amountsInText(lines.filter(l => !DEBIT_LINE_RE.test(l) || CREDIT_LINE_RE.test(l)).map(clean).join('\n'));
}

const paymentLog = [];   // admin panel uchun oxirgi to'lov xabarlari
const seenPaymentKeys = new Set();   // bitta kanal xabarini bot ham, yordamchi ham ko'radi — bir marta ishlaymiz
let paymentQueue = Promise.resolve();
function matchPaymentText(text, source = 'unknown', dedupeKey = '') {
  if (dedupeKey) {
    if (seenPaymentKeys.has(dedupeKey)) return Promise.resolve([]);
    seenPaymentKeys.add(dedupeKey);
    if (seenPaymentKeys.size > 500) seenPaymentKeys.delete(seenPaymentKeys.values().next().value);
  }
  // Ketma-ket: ikki manba bir vaqtda bir buyurtmani ikki marta tasdiqlamasin
  const run = () => matchPaymentTextNow(text, source);
  const p = paymentQueue.then(run, run);
  paymentQueue = p.catch(() => {});
  return p;
}
async function matchPaymentTextNow(text, source) {
  if (!text || !/\d{4,}/.test(String(text).replace(/[\s., ]/g, ''))) return [];
  const amounts = paymentAmounts(text);
  const orders = (await firebaseGet('orders')) || {};
  const now = Date.now();
  const matched = [];
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.status !== 'pending' || !o.total) continue;
    if (o.createdAt && now - o.createdAt > 7 * 86400e3) continue;
    if (amounts.has(String(Math.round(Number(o.total))))) matched.push({ id, order: o });
  }
  // pendingPayments ro'yxatidagilar ham (bazada holati yo'qolgan bo'lsa)
  for (const p of pendingPayments.slice()) {
    const id = String(p.orderNum || '').replace('#', '');
    if (!matched.some(m => m.id === id) && amounts.has(String(p.amount)) && orders[id]?.status === 'pending') {
      matched.push({ id, order: orders[id] });
    }
  }
  paymentLog.unshift({ at: now, source, text: String(text).slice(0, 200), matched: matched.map(m => m.order.orderNum || '#' + m.id) });
  if (paymentLog.length > 20) paymentLog.pop();
  for (const m of matched) {
    console.log(`🎯 TO'LOV MOS KELDI (${source}): ${m.order.total} so'm → ${m.order.orderNum}`);
    await setOrderStatus(m.id, 'confirmed').catch(e => console.error("Buyurtma holatini yangilab bo'lmadi:", e.message));
    await firebasePatch(`orders/${m.id}`, { paidVia: source, paidAt: now }).catch(() => {});
  }
  return matched.map(m => ({ id: m.id, orderNum: m.order.orderNum, total: m.order.total, userName: m.order.userName }));
}

function handlePaymentMessage(msg, { trusted = false } = {}) {
  const text = msg.text || msg.caption;
  if (!text) return;
  const fromId = String(msg.from?.id || '');
  // Faqat ishonchli manbalar: admin (forward qilingan bank xabari) yoki kanal posti
  if (!trusted && !ADMIN_IDS.includes(fromId)) return;
  const isChan = msg.chat?.type === 'channel';
  const source = isChan ? "to'lov kanali (bot)" : (msg.forward_from || msg.forward_sender_name || msg.forward_origin ? 'admin forward' : 'admin');
  matchPaymentText(text, source, isChan ? `ch:${chanKey(msg.chat.id)}:${msg.message_id}` : '').then(list => {
    if (msg.chat?.type === 'private' && botInstance && (list.length || source === 'admin forward')) {
      botInstance.sendMessage(msg.chat.id, list.length
        ? `✅ To'lov topildi va tasdiqlandi: ${list.map(m => m.orderNum).join(', ')}`
        : `🔍 Bu xabarda kutilayotgan buyurtma summasi topilmadi.`).catch(() => {});
    }
  }).catch(e => console.error("To'lovni tekshirishda xato:", e.message));
}

// ===== SERVER =====
app.listen(PORT, async () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📱 APP_URL: ${APP_URL}`);
  
  // Database sync on startup
  await prepareStorage();
  await loadSettingsFromDb();
  await loadPendingPayments();
  initializeTelegramBot();
  await assistant.init();
  setTimeout(sweepConfirmedOrders, 20000);
  setInterval(sweepConfirmedOrders, 60000);
  setTimeout(prewarmCutouts, 30000);
  model3d.start();
  setInterval(() => restoreExpiredDiscounts().catch(() => {}), 60000);
  botFeatures.startSchedulers();
  
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'belgilanmagan'}`);
});
