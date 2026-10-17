// ===== MAHSULOT TURLARI va har bir tur uchun so'raladigan xususiyatlar =====
// Admin panel (mahsulot qo'shish oynasi) va yordamchi admin (AI) shu ro'yxatdan foydalanadi:
// tur tanlanganda faqat shu turga tegishli maydonlar so'raladi.
(function (root) {
  const CATEGORIES = ['Telefonlar', 'Kompyuterlar', 'PC qismlari', 'Periferiya', 'Audio', 'Aksessuarlar', 'Kameralar', "O'yinlar", 'Dronlar', 'Smart TV', 'Mebel'];
  // specs: [nomi, misol]
  const TYPES = [
    // --- Telefonlar
    { key: 'smartfon', name: 'Smartfon', cat: 'Telefonlar', specs: [['Ekran', '6.7" AMOLED 120Hz'], ['Protsessor', 'Snapdragon 8 Gen 3'], ['RAM', '12GB'], ['Xotira', '256GB'], ['Kamera', '200MP + 12MP + 10MP'], ['Batareya', '5000 mAh'], ['Rang', 'Titanium Black']] },
    { key: 'oddiy-telefon', name: 'Tugmali telefon', cat: 'Telefonlar', specs: [['Ekran', '2.4"'], ['SIM', '2 ta SIM'], ['Batareya', '1500 mAh'], ['Rang', 'Qora']] },
    // --- Kompyuterlar
    { key: 'noutbuk', name: 'Noutbuk', cat: 'Kompyuterlar', specs: [['Ekran', '15.6" IPS FHD 144Hz'], ['Protsessor', 'Intel Core i7-13700H'], ['RAM', '16GB DDR5'], ['Xotira', '512GB NVMe SSD'], ['Videokarta', 'RTX 4060 8GB'], ['Batareya', '10 soatgacha'], ["Og'irlik", '1.8 kg']] },
    { key: 'kompyuter', name: "Kompyuter (yig'ilgan PC)", cat: 'Kompyuterlar', specs: [['Protsessor', 'Ryzen 7 7800X3D'], ['Videokarta', 'RTX 4070 Super 12GB'], ['RAM', '32GB DDR5 6000MHz'], ['Xotira', '1TB NVMe SSD'], ['Ona plata', 'B650'], ['Blok pitaniya', '750W 80+ Gold'], ['Korpus', 'ATX, oynali']] },
    { key: 'monoblok', name: 'Monoblok', cat: 'Kompyuterlar', specs: [['Ekran', '24" 4.5K'], ['Protsessor', 'Apple M3'], ['RAM', '8GB'], ['Xotira', '256GB SSD']] },
    { key: 'planshet', name: 'Planshet', cat: 'Kompyuterlar', specs: [['Ekran', '11" Liquid Retina'], ['Protsessor', 'Apple M2'], ['Xotira', '128GB'], ['Ulanish', 'Wi-Fi / 5G'], ['Batareya', '10 soat']] },
    // --- PC qismlari
    { key: 'videokarta', name: 'Videokarta', cat: 'PC qismlari', specs: [['Model', 'RTX 4070 Super'], ['Videoxotira', '12GB GDDR6X'], ['Shina', '192-bit'], ['Quvvat talabi', '220W (650W BP tavsiya)'], ['Ulagichlar', '1× 16-pin'], ['Uzunligi', '267 mm'], ['Chiqishlar', '3× DP, 1× HDMI']] },
    { key: 'protsessor', name: 'Protsessor (CPU)', cat: 'PC qismlari', specs: [['Soket', 'AM5 / LGA1700'], ['Yadro / oqim', '8 / 16'], ['Chastota', '4.2–5.0 GHz'], ['Kesh', '96MB L3'], ['TDP', '120W'], ['Integratsiyalangan grafika', 'Bor / Yo\'q'], ['Kuler bilan', 'Ha / Yo\'q (Box/Tray)']] },
    { key: 'ona-plata', name: 'Ona plata', cat: 'PC qismlari', specs: [['Soket', 'AM5'], ['Chipset', 'B650'], ['Format', 'ATX / mATX'], ['RAM turi', 'DDR5, 4 slot, 128GB gacha'], ['M.2 slotlar', '2 ta'], ['Wi-Fi / Bluetooth', 'Wi-Fi 6E, BT 5.3']] },
    { key: 'ram', name: 'Operativ xotira (RAM)', cat: 'PC qismlari', specs: [['Hajm', '32GB (2×16GB)'], ['Turi', 'DDR5'], ['Chastota', '6000 MHz'], ['Taymingi', 'CL30'], ['Format', 'DIMM / SO-DIMM (noutbuk)'], ['Podsvetka', 'RGB / yo\'q']] },
    { key: 'ssd', name: 'SSD', cat: 'PC qismlari', specs: [['Hajm', '1TB'], ['Interfeys', 'NVMe PCIe 4.0 / SATA'], ['Form-faktor', 'M.2 2280 / 2.5"'], ["O'qish tezligi", '7000 MB/s'], ['Yozish tezligi', '6000 MB/s'], ['Resurs (TBW)', '600 TBW']] },
    { key: 'hdd', name: 'HDD (qattiq disk)', cat: 'PC qismlari', specs: [['Hajm', '2TB'], ['Aylanish tezligi', '7200 rpm'], ['Interfeys', 'SATA III'], ['Kesh', '256MB'], ['Form-faktor', '3.5" / 2.5"']] },
    { key: 'blok-pitaniya', name: 'Blok pitaniya (PSU)', cat: 'PC qismlari', specs: [['Quvvat', '750W'], ['Sertifikat', '80+ Gold'], ['Modullilik', "To'liq modulli / modulsiz"], ['Format', 'ATX'], ['Videokarta ulagichi', '12VHPWR / 2× 8-pin'], ['Kafolat', '5 yil']] },
    { key: 'korpus', name: 'Korpus (keys)', cat: 'PC qismlari', specs: [['Format', 'Mid-Tower, ATX'], ['Material', 'Po\'lat + temperlangan oyna'], ['Ventilyatorlar', '3 ta ARGB (o\'rnatilgan)'], ['Videokarta uzunligi', '400 mm gacha'], ['Kuler balandligi', '165 mm gacha'], ['Rang', 'Qora / Oq']] },
    { key: 'kuler', name: 'Protsessor kuleri', cat: 'PC qismlari', specs: [['Turi', 'Havo (bashnya)'], ['Soket mosligi', 'AM5, AM4, LGA1700'], ['TDP', '220W gacha'], ['Balandligi', '155 mm'], ['Ventilyator', '120mm, 1800 rpm'], ['Podsvetka', 'ARGB / yo\'q']] },
    { key: 'suv-sovutish', name: 'Suv sovutish (AIO)', cat: 'PC qismlari', specs: [['Radiator', '360 mm'], ['Soket mosligi', 'AM5, AM4, LGA1700'], ['Ventilyatorlar', '3× 120mm'], ['Nasos', 'Ekranli / oddiy'], ['Podsvetka', 'ARGB']] },
    { key: 'ventilyator', name: 'Korpus ventilyatori', cat: 'PC qismlari', specs: [["O'lcham", '120 mm'], ['Tezlik', '500–1800 rpm'], ['Shovqin', '25 dB'], ['Ulanish', '4-pin PWM'], ['Podsvetka', 'ARGB'], ['Komplektda', '3 ta']] },
    { key: 'termopasta', name: 'Termopasta', cat: 'PC qismlari', specs: [['Issiqlik o\'tkazuvchanligi', '12.5 W/mK'], ['Hajm', '4 g']] },
    // --- Periferiya
    { key: 'monitor', name: 'Monitor', cat: 'Periferiya', specs: [['Diagonal', '27"'], ['Aniqlik', '2560×1440 (2K)'], ['Matritsa', 'IPS / VA / OLED'], ['Chastota', '165 Hz'], ['Javob vaqti', '1 ms'], ['Ulagichlar', 'HDMI, DisplayPort']] },
    { key: 'klaviatura', name: 'Klaviatura', cat: 'Periferiya', specs: [['Turi', 'Mexanik / membrana'], ['Switch', 'Red (linear)'], ['Format', 'TKL / 100% / 75%'], ['Ulanish', 'Simli USB / Bluetooth / 2.4GHz'], ['Podsvetka', 'RGB'], ['Til', 'Lotin + kirill']] },
    { key: 'sichqoncha', name: 'Sichqoncha', cat: 'Periferiya', specs: [['Sensor', 'PAW3395'], ['DPI', '26 000 gacha'], ['Ulanish', 'Simsiz 2.4GHz / Bluetooth / simli'], ['Tugmalar', '6 ta'], ["Og'irlik", '63 g'], ['Batareya', '70 soat']] },
    { key: 'gilamcha', name: 'Sichqoncha gilamchasi', cat: 'Periferiya', specs: [["O'lcham", '900×400 mm'], ['Qalinlik', '4 mm'], ['Material', 'Mato, rezina asos'], ['Podsvetka', 'RGB / yo\'q']] },
    { key: 'veb-kamera', name: 'Veb-kamera', cat: 'Periferiya', specs: [['Aniqlik', '1080p (Full HD)'], ['Kadr tezligi', '30 / 60 fps'], ['Mikrofon', "O'rnatilgan, stereo"], ['Fokus', 'Avtofokus'], ['Ulanish', 'USB']] },
    { key: 'mikrofon', name: 'Mikrofon', cat: 'Periferiya', specs: [['Turi', 'Kondensator / dinamik'], ["Yo'nalganlik", 'Kardioid'], ['Ulanish', 'USB-C / XLR'], ['Chastota', '20 Hz – 20 kHz'], ['Komplektda', 'Shtativ, pop-filtr']] },
    { key: 'printer', name: 'Printer / MFU', cat: 'Periferiya', specs: [['Turi', 'Lazer / siyohli'], ['Rangli', 'Ha / Yo\'q'], ['Funksiyalar', 'Chop etish, skaner, nusxa'], ['Ulanish', 'USB, Wi-Fi'], ['Tezlik', '20 bet/daq']] },
    { key: 'router', name: 'Wi-Fi router', cat: 'Periferiya', specs: [['Standart', 'Wi-Fi 6 (AX3000)'], ['Diapazon', '2.4 + 5 GHz'], ['Portlar', '4× LAN, 1× WAN'], ['Qamrov', '120 m² gacha']] },
    { key: 'fleshka', name: 'Fleshka / xotira kartasi', cat: 'Periferiya', specs: [['Hajm', '128GB'], ['Turi', 'USB 3.2 / microSD'], ['Tezlik', '150 MB/s']] },
    // --- Audio
    { key: 'quloqchin', name: 'Quloqchin', cat: 'Audio', specs: [['Turi', 'Over-ear / In-ear (TWS)'], ['Ulanish', 'Bluetooth 5.3 / simli'], ['Shovqin bekor qilish', 'ANC bor / yo\'q'], ['Batareya', '30 soat'], ['Mikrofon', 'Bor'], ["Og'irlik", '250 g']] },
    { key: 'kolonka', name: 'Kolonka', cat: 'Audio', specs: [['Quvvat', '20W'], ['Ulanish', 'Bluetooth 5.3, AUX'], ['Batareya', '12 soat'], ['Suv himoyasi', 'IP67']] },
    { key: 'saundbar', name: 'Saundbar', cat: 'Audio', specs: [['Quvvat', '300W'], ['Kanallar', '3.1'], ['Ulanish', 'HDMI eARC, Bluetooth, Optik'], ['Sabvufer', 'Simsiz, bor']] },
    // --- Aksessuarlar (telefon va boshqa)
    { key: 'chexol', name: "Chexol (g'ilof)", cat: 'Aksessuarlar', specs: [['Mos model', 'iPhone 16 Pro Max'], ['Material', 'Silikon / teri / plastik'], ['Rang', 'Qora'], ['MagSafe', 'Bor / yo\'q'], ['Himoya', 'Burchaklari kuchaytirilgan']] },
    { key: 'himoya-oynasi', name: 'Himoya oynasi / laminat', cat: 'Aksessuarlar', specs: [['Mos model', 'Samsung S24 Ultra'], ['Turi', '9H temperlangan oyna / plyonka'], ['Qoplama', "To'liq ekran, anti-blik / mat"], ['Komplektda', "2 ta, o'rnatish ramkasi"]] },
    { key: 'powerbank', name: 'Powerbank', cat: 'Aksessuarlar', specs: [["Sig'im", '20 000 mAh'], ['Chiqish quvvati', '65W'], ['Portlar', '2× USB-C, 1× USB-A'], ['Tez quvvatlash', 'PD 3.0 / QC 4.0'], ["Og'irlik", '350 g']] },
    { key: 'zaryadlovchi', name: 'Zaryadlovchi (adapter)', cat: 'Aksessuarlar', specs: [['Quvvat', '30W'], ['Portlar', '1× USB-C'], ['Standart', 'PD / QC / PPS'], ['Mos qurilmalar', 'iPhone, Samsung, noutbuk']] },
    { key: 'kabel', name: 'Kabel', cat: 'Aksessuarlar', specs: [['Ulanish', 'USB-C → Lightning'], ['Uzunlik', '1 m'], ['Quvvat', '60W'], ['Material', "To'qima o'ralgan"]] },
    { key: 'simsiz-zaryadlovchi', name: 'Simsiz zaryadlovchi', cat: 'Aksessuarlar', specs: [['Quvvat', '15W'], ['Standart', 'Qi2 / MagSafe'], ['Qurilmalar soni', '3 ta (telefon, soat, quloqchin)']] },
    { key: 'batareya', name: 'Telefon batareyasi', cat: 'Aksessuarlar', specs: [['Mos model', 'iPhone 13'], ["Sig'im", '3227 mAh'], ['Turi', 'Original / analog']] },
    { key: 'aqlli-soat', name: 'Aqlli soat', cat: 'Aksessuarlar', specs: [['Ekran', '1.9" AMOLED'], ['Korpus', '45 mm, alyuminiy'], ['Batareya', '2 kun'], ['Suv himoyasi', '5ATM'], ['Moslik', 'iPhone / Android']] },
    { key: 'fitnes-bilaguzuk', name: 'Fitnes bilaguzuk', cat: 'Aksessuarlar', specs: [['Ekran', '1.6" AMOLED'], ['Batareya', '14 kun'], ['Suv himoyasi', '5ATM'], ['Sensorlar', 'Puls, SpO2, uyqu']] },
    { key: 'shtativ', name: 'Shtativ / selfi-tayoq', cat: 'Aksessuarlar', specs: [['Maks. balandlik', '1.5 m'], ['Pult', 'Bluetooth'], ['Mos qurilmalar', 'Telefon, kamera']] },
    // --- Kameralar
    { key: 'fotoapparat', name: 'Fotoapparat', cat: 'Kameralar', specs: [['Matritsa', '24MP Full-frame'], ['Video', '4K 60fps'], ['Obyektiv', '24–70mm (kit)'], ['Stabilizatsiya', 'IBIS 5-o\'q'], ['Batareya', '500 kadr']] },
    { key: 'ekshn-kamera', name: 'Ekshn-kamera', cat: 'Kameralar', specs: [['Video', '5.3K 60fps'], ['Foto', '27MP'], ['Stabilizatsiya', 'HyperSmooth'], ['Suv himoyasi', '10 m gacha'], ['Batareya', '1720 mAh']] },
    { key: 'kuzatuv-kamerasi', name: 'Kuzatuv kamerasi', cat: 'Kameralar', specs: [['Aniqlik', '2K / 4MP'], ['Tungi rejim', '10 m gacha'], ['Ulanish', 'Wi-Fi'], ['Xotira', 'microSD / bulut'], ['Joylashuv', 'Ichki / tashqi']] },
    // --- O'yinlar
    { key: 'konsol', name: "O'yin konsoli", cat: "O'yinlar", specs: [['Xotira', '1TB SSD'], ['Aniqlik', '4K 120fps'], ['Versiya', 'Disk / Digital'], ['Komplektda', '1 ta geympad']] },
    { key: 'geympad', name: 'Geympad (joystik)', cat: "O'yinlar", specs: [['Moslik', 'PS5 / Xbox / PC'], ['Ulanish', 'Bluetooth / simli'], ['Batareya', '12 soat'], ['Vibratsiya', 'Bor']] },
    { key: 'oyin-diski', name: "O'yin diski", cat: "O'yinlar", specs: [['Platforma', 'PS5'], ['Til', 'Rus / ingliz'], ['Janr', 'Sport / ekshn']] },
    // --- Dronlar
    { key: 'dron', name: 'Dron', cat: 'Dronlar', specs: [['Kamera', '4K 60fps HDR'], ['Parvoz vaqti', '34 daqiqa'], ['Masofa', '20 km'], ["Og'irlik", '249 g'], ["To'siqni sezish", 'Har tomonlama']] },
    // --- Smart TV
    { key: 'televizor', name: 'Televizor', cat: 'Smart TV', specs: [['Diagonal', '55"'], ['Aniqlik', '4K UHD'], ['Matritsa', 'QLED / OLED / LED'], ['Chastota', '120 Hz'], ['Smart platforma', 'Google TV / Tizen / webOS'], ['HDR', 'Dolby Vision, HDR10+']] },
    { key: 'tv-pristavka', name: 'TV-pristavka', cat: 'Smart TV', specs: [['Aniqlik', '4K HDR'], ['Platforma', 'Android TV / tvOS'], ['Xotira', '32GB'], ['Pult', 'Ovozli']] },
    { key: 'proyektor', name: 'Proyektor', cat: 'Smart TV', specs: [['Aniqlik', '1080p'], ['Yorqinlik', '500 ANSI lm'], ['Ekran o\'lchami', '200" gacha'], ['Smart', 'Android TV']] },
    // --- Mebel
    { key: 'kreslo', name: 'Kompyuter / geymer kreslo', cat: 'Mebel', specs: [['Material', 'Eko-teri / mato (setka)'], ['Maks. yuk', '150 kg'], ["Qo'ltiqlar", '4D sozlanadi'], ['Suyanchiq burchagi', '90–155°'], ['Bosh va bel yostig\'i', 'Bor'], ['Rang', 'Qora / Qizil']] },
    { key: 'stol', name: 'Kompyuter stoli', cat: 'Mebel', specs: [["O'lcham", '140×70 sm'], ['Balandlik', 'Elektr sozlanadi 72–118 sm'], ['Material', 'LDSP, metall karkas'], ['Rang', 'Qora']] },
    { key: 'monitor-kronshteyn', name: 'Monitor kronshteyni', cat: 'Mebel', specs: [['Monitorlar soni', '1 / 2 ta'], ['Diagonal', '17–32"'], ['Maks. yuk', '9 kg'], ['VESA', '75×75, 100×100']] },
  ];
  const byKey = Object.fromEntries(TYPES.map(t => [t.key, t]));
  const api = { CATEGORIES, TYPES, typeOf: k => byKey[k] || null, typesOf: cat => TYPES.filter(t => t.cat === cat) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PRODUCT_TYPES = api;
})(typeof window !== 'undefined' ? window : globalThis);
