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
- **Ovozli xabarlar** — xaridor ovozli xabar yuborsa, yordamchi uni tushunadi va (sozlamada yoqilgan bo'lsa) Microsoft neural ovozida (Madina yoki Sardor) ovozli xabar bilan javob qaytaradi. Ovoz yaratib bo'lmasa, javob matn sifatida yuboriladi.

## Buyurtmani yetkazish jarayoni

1. To'lov tasdiqlansa (panelda, yordamchi orqali yoki avtomatik), bot asosiy admin(lar)ga to'liq ma'lumot va **📦 Buyurtma yuborildi** tugmasini yuboradi; xaridorga (yordamchi akkaunt, bo'lmasa bot orqali) "ma'lumot adminga jo'natildi, BTS orqali yetib boradi" xabari boradi.
2. Admin tugmani bosib BTS chekini (rasm) botga yuboradi → xaridorga chek bilan "buyurtma jo'natildi" xabari boradi va yetib borgach rasm/fikr yuborish so'raladi. Buyurtma holati "Yuborildi" bo'ladi.
3. Server har daqiqada tasdiqlangan, lekin hali adminga yuborilmagan buyurtmalarni tekshiradi.

## Bot imkoniyatlari

- **/start** — rasmli kutib olish: do'kon, "Buyurtmalarim", yordamchi bilan suhbat va (sozlansa) kanal tugmalari.
- **/buyurtmalarim** — xaridor buyurtmalari va holati; yo'ldagi buyurtma uchun **"Yetib keldi"** tugmasi → 1–5 ⭐ baho → rasm va fikr. Fikrlar mahsulot sahifasida "Mijozlar fikri" bo'limida chiqadi, reyting yangilanadi.
- **Savat eslatmasi** — savatda 24 soatdan beri qolgan mahsulotlar haqida bitta eslatma (buyurtma bermagan bo'lsa).
- **Narx tushdi** — sevimlilarga qo'shilgan mahsulot arzonlashsa xabar.
- **Admin:** har kuni 21:00 da kunlik hisobot (`/hisobot` — istalgan payt), `/reklama` — hammaga xabar (oldindan ko'rish va tasdiqlash bilan), to'lovdan 24 soat o'tib ham jo'natilmagan buyurtma eslatmasi.
- Admin panel → Sozlamalar → **Telegram kanal** — /start dagi obuna tugmasi uchun.
