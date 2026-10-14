# TechStore — Telegram Mini App

## Ishga tushirish

```bash
npm install
npm start
```

## Muhit o'zgaruvchilari

| O'zgaruvchi | Tavsif |
|---|---|
| `BOT_TOKEN` | Telegram bot tokeni (admin panelda ham kiritish mumkin) |
| `ADMIN_IDS` | Admin Telegram ID'lari, vergul bilan |
| `APP_URL` | Mini App manzili |
| `SESSION_SECRET` | Ixtiyoriy. Yordamchi sessiyasi va AI kalitini shifrlash uchun maxfiy satr. Railway'da shart emas — berilmasa, Railway'ning o'zgarmas loyiha ID'laridan foydalaniladi va ma'lumotlar baribir shifrlanib bazada saqlanadi (redeploy'da o'chmaydi). |
| `GEMINI_API_KEY` | Ixtiyoriy. Bepul Google Gemini kaliti (admin panelda ham kiritish mumkin). |
| `ANTHROPIC_API_KEY` | Ixtiyoriy. Anthropic Claude kaliti (pullik). |

## Ma'lumotlarni saqlash (muhim)

Railway har deploy'da server diskini tozalaydi. Ma'lumotlar (mahsulotlar, buyurtmalar, yordamchi akkaunti, API kalitlar) o'chmasligi uchun:

- **Tavsiya:** Railway'da servisga **Volume** ulang (mount path: `/data`). Server `RAILWAY_VOLUME_MOUNT_PATH` ni avtomatik aniqlaydi va hamma narsani o'sha yerda saqlaydi.
- Volume bo'lmasa, Firebase ishlatiladi. Firebase'ga yozib bo'lmasa, admin panel → Yordamchi bo'limida qizil ogohlantirish chiqadi.

## Yordamchi admin

Admin panel → **Yordamchi** bo'limi:

1. [my.telegram.org/apps](https://my.telegram.org/apps) dan yordamchi akkaunt uchun `api_id` va `api_hash` oling.
2. API ID, API Hash va telefon raqamini kiritib **Kod yuborish** ni bosing, Telegramga kelgan kodni (va 2FA parolni, bo'lsa) kiriting.
3. **AI sozlamalari**da provayderni tanlang (standart — bepul **Google Gemini**; kalitni [aistudio.google.com/apikey](https://aistudio.google.com/apikey) dan oling, karta kerak emas) va kalitni kiriting. Shu yerda buyruq bera oladigan admin Telegram ID'larini tekshiring (panelga kirgan admin avtomatik qo'shiladi).

Shundan so'ng:

- **Admin** yordamchi akkauntga rasm yuborib "shu mahsulotni qo'sh, narxi 12 mln" deb yozsa — yordamchi mahsulotni aniqlaydi, tavsif va xususiyatlarini yozib katalogga qo'shadi. Mahsulotni tahrirlash/o'chirish, buyurtmalarni ko'rish/tasdiqlash, statistika va xaridorlarga xabar yuborish ham mumkin.
- **Xaridorlar** yozsa — yordamchi katalog asosida maslahat beradi, rasmlarini ko'rsatadi va xaridga undaydi. Xaridorlarda mahsulot yoki buyurtmalarni o'zgartiruvchi hech qanday imkoniyat yo'q (ruxsatlar server tomonida Telegram ID bo'yicha ajratiladi).
