const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const compression = require('compression');
const { createAssistant, CATEGORY_ENUM } = require('./assistant');

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
const APP_URL   = process.env.APP_URL || `https://your-app.railway.app`;

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

// ===== BUYURTMA HOLATINI O'ZGARTIRISH (panel va yordamchi uchun umumiy) =====
async function setOrderStatus(orderId, status) {
  const orderPath = `orders/${orderId}`;
  const order = await firebaseGet(orderPath);
  if (!order) return { error: "Buyurtma topilmadi" };

  await firebasePatch(orderPath, { status });

  if (order.userId && BOT_TOKEN && global.telegramBotInstance) {
    const userMsg = status === 'confirmed'
      ? `✅ <b>Buyurtmangiz tasdiqlandi!</b>\n\n` +
        `📦 Buyurtma: <b>#${orderId}</b>\n` +
        `🚀 Admin siz bilan tez orada bog'lanadi va mahsulot yetkaziladi!\n\n` +
        `<i>TechStore — Ishonchli xarid</i>`
      : `❌ <b>Buyurtmangiz rad etildi!</b>\n\nSiz yuborgan to'lov tasdiqlanmadi. Muammo bo'lsa admin bilan bog'laning.`;
    global.telegramBotInstance.sendMessage(order.userId, userMsg, { parse_mode: 'HTML' })
      .catch(err => console.error("Foydalanuvchiga xabar yuborishda xato:", err.message));
  }

  const p = pendingPayments.find(x => x.orderNum === '#' + orderId);
  if (p) await deletePendingPaymentFromDb(p);
  return { success: true };
}

// ===== EXPRESS =====
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Server fayllari va maxfiy ma'lumotlar statik tarzda berilmasin
const PRIVATE_FILES = new Set(['/server.js', '/assistant.js', '/db.json', '/package.json', '/package-lock.json']);
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
    assistant: assistant.publicContact()
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
    res.json(await getProducts());
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
    dbProducts = await getProducts();
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
      desc: sanitizeInput(desc || 'Tavsif yo\'q.'),
      rating: Number(body.rating) || 5.0,
      reviews: Number(body.reviews) || 0,
      specs: Array.isArray(specs) ? specs.filter(pair => Array.isArray(pair)).map(pair => [sanitizeInput(pair[0]), sanitizeInput(pair[1])]) : [],
      emoji: body.emoji ? sanitizeInput(body.emoji) : null,
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

async function addProduct(data) {
  const { product, error } = buildProduct(data);
  if (error) return { error };
  await mutateProducts(list => ({ list: [product, ...list.filter(p => p.id !== product.id)] }));
  return { product };
}

async function updateProduct(id, data) {
  return mutateProducts(list => {
    const idx = list.findIndex(p => String(p.id) === String(id));
    if (idx === -1) return { list, result: { error: "Mahsulot topilmadi" } };
    const { product, error } = buildProduct({ ...list[idx], ...data, id: list[idx].id });
    if (error) return { list, result: { error } };
    list[idx] = { ...list[idx], ...product };
    return { list, result: { product: list[idx] } };
  });
}

async function deleteProduct(id) {
  return mutateProducts(list => ({ list: list.filter(p => String(p.id) !== String(id)), result: { success: true } }));
}

// Mahsulot qo'shish
app.post('/api/admin/products', apiRateLimiter, verifyAdmin, validateAndSanitizeProduct, async (req, res) => {
  const newProduct = req.sanitizedProduct;
  try {
    await mutateProducts(list => ({ list: [newProduct, ...list.filter(p => p.id !== newProduct.id)] }));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mahsulotni yangilash
app.put('/api/admin/products/:id', apiRateLimiter, verifyAdmin, validateAndSanitizeProduct, async (req, res) => {
  const { id } = req.params;
  const updatedProduct = { ...req.sanitizedProduct, id: Number(id) };
  try {
    const result = await mutateProducts(list => {
      const idx = list.findIndex(p => String(p.id) === String(id));
      if (idx === -1) return { list, result: false };
      list[idx] = { ...list[idx], ...updatedProduct };
      return { list, result: true };
    });
    if (result) res.json({ success: true });
    else res.status(404).json({ error: "Mahsulot topilmadi" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mahsulotni o'chirish
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
      lastSeen: Date.now()
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
async function getStoreStats() {
  const [orders, users, prods] = await Promise.all([
    firebaseGet('orders').then(o => o || {}),
    firebaseGet('users').then(u => u || {}),
    getProducts()
  ]);
  const list = Object.values(orders);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const confirmed = list.filter(o => o.status === 'confirmed');
  const today = list.filter(o => (o.createdAt || 0) >= startOfDay.getTime());
  return {
    products: prods.length,
    orders_total: list.length,
    orders_pending: list.filter(o => o.status === 'pending').length,
    orders_confirmed: confirmed.length,
    orders_rejected: list.filter(o => o.status === 'rejected').length,
    revenue_confirmed: confirmed.reduce((s, o) => s + (Number(o.total) || 0), 0),
    orders_today: today.length,
    revenue_today: today.filter(o => o.status === 'confirmed').reduce((s, o) => s + (Number(o.total) || 0), 0),
    customers: Object.keys(users).length
  };
}

let botUsername = '';

const assistant = createAssistant({
  loadConfig: () => firebaseGet('settings/assistant'),
  saveConfig: (cfg) => firebasePut('settings/assistant', cfg),
  getShopInfo: () => ({ botUsername, adminIds: ADMIN_IDS, adminContact: '@Jahongir_1220', appUrl: APP_URL }),
  getStorageInfo,
  dataDir: VOLUME_DIR ? path.join(VOLUME_DIR, '.data') : null,
  notifyAdminsViaBot: async (text) => {
    if (!botInstance) return;
    await Promise.all(ADMIN_IDS.map(id => botInstance.sendMessage(id, text).catch(() => {})));
  },
  store: {
    listProducts: () => getProducts(),
    getProduct: async (id) => (await getProducts()).find(p => String(p.id) === String(id)) || null,
    addProduct,
    updateProduct,
    deleteProduct,
    listOrders: () => firebaseGet('orders'),
    setOrderStatus,
    getStats: getStoreStats
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
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
      }
    });
    botInstance = bot;
    global.telegramBotInstance = bot;
    bot.getMe().then(me => { botUsername = me.username || ''; }).catch(() => {});
    
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
  await prepareStorage();
  await loadSettingsFromDb();
  await loadPendingPayments();
  initializeTelegramBot();
  await assistant.init();
  
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'belgilanmagan'}`);
});
