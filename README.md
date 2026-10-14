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
| `SESSION_SECRET` | **Tavsiya etiladi.** Yordamchi admin sessiyasi va AI kalitini shifrlab bazada saqlash uchun ixtiyoriy uzun maxfiy satr. Berilmasa, sessiya faqat serverdagi `.data/` papkasida saqlanadi va har deploy'da akkauntni qayta ulash kerak bo'ladi. |
| `GEMINI_API_KEY` | Ixtiyoriy. Bepul Google Gemini kaliti (admin panelda ham kiritish mumkin). |
| `ANTHROPIC_API_KEY` | Ixtiyoriy. Anthropic Claude kaliti (pullik). |

## Yordamchi admin

Admin panel → **Yordamchi** bo'limi:

1. [my.telegram.org/apps](https://my.telegram.org/apps) dan yordamchi akkaunt uchun `api_id` va `api_hash` oling.
2. API ID, API Hash va telefon raqamini kiritib **Kod yuborish** ni bosing, Telegramga kelgan kodni (va 2FA parolni, bo'lsa) kiriting.
3. **AI sozlamalari**da provayderni tanlang (standart — bepul **Google Gemini**; kalitni [aistudio.google.com/apikey](https://aistudio.google.com/apikey) dan oling, karta kerak emas) va kalitni kiriting. Shu yerda buyruq bera oladigan admin Telegram ID'larini tekshiring (panelga kirgan admin avtomatik qo'shiladi).

Shundan so'ng:

- **Admin** yordamchi akkauntga rasm yuborib "shu mahsulotni qo'sh, narxi 12 mln" deb yozsa — yordamchi mahsulotni aniqlaydi, tavsif va xususiyatlarini yozib katalogga qo'shadi. Mahsulotni tahrirlash/o'chirish, buyurtmalarni ko'rish/tasdiqlash, statistika va xaridorlarga xabar yuborish ham mumkin.
- **Xaridorlar** yozsa — yordamchi katalog asosida maslahat beradi, rasmlarini ko'rsatadi va xaridga undaydi. Xaridorlarda mahsulot yoki buyurtmalarni o'zgartiruvchi hech qanday imkoniyat yo'q (ruxsatlar server tomonida Telegram ID bo'yicha ajratiladi).
