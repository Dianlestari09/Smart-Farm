# Panduan Web Monitor Native (HTML/CSS/JS) untuk ESP32 & Offline Kandang

Sistem ini dibuat khusus untuk penelitian Skripsi:
**"Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur"**
Oleh: **Dian Lestari Kurniawati** (NIM: **230605110016**)

---

## 📁 Struktur Berkas Native

Semua berkas berada di folder `native-esp32-web/`:
```text
native-esp32-web/
├── index.html               # Halaman utama dashboard (Semantik HTML5)
├── style.css                # Tampilan modern, industrial, responsif mobile
├── app.js                   # Mesin FLC 27 Rule Mamdani + Canvas Chart + REST Poller
├── esp32_with_webserver.ino # Kode Arduino ESP32 (LittleFS Web Server + Supabase)
└── README_ESP32.md          # Panduan ini
```

---

## 🚀 1. Cara Menjalankan Langsung di Komputer (Tanpa Node.js / Tanpa Install)

1. Cukup buka folder [native-esp32-web](file:///d:/Kuliah/SKRIPSI%20DIAN/Skripsi%20Smart%20Farm%20Poultry/WebApps/smart-farm-monitor/native-esp32-web).
2. Klik ganda file [index.html](file:///d:/Kuliah/SKRIPSI%20DIAN/Skripsi%20Smart%20Farm%20Poultry/WebApps/smart-farm-monitor/native-esp32-web/index.html) menggunakan browser apa saja (Chrome, Edge, Firefox).
3. **Selesai!** Dashboard langsung aktif dengan **Mode Simulasi (Demo)**:
   - Data sensor berfluktuasi otomatis secara realistis.
   - 27 Rule Base Fuzzy Mamdani langsung bekerja dan menghitung persentase aktuator.
   - Grafik riwayat sensor digambar murni menggunakan HTML5 Canvas (100% offline tanpa perlu koneksi internet).

---

## 📶 2. Cara Mengunggah ke Memori Flash ESP32 (LittleFS)

Agar dashboard web ini bisa dibuka langsung dari ESP32 di area kandang:

### Langkah A: Siapkan Folder Data di Arduino
1. Buat folder bernama `data` di dalam folder sketch Arduino Anda.
2. Salin 3 berkas berikut ke dalam folder `data`:
   - `index.html`
   - `style.css`
   - `app.js`

### Langkah B: Upload ke Flash ESP32
1. Di Arduino IDE, pastikan plugin **ESP32 LittleFS Data Upload** sudah terpasang (Tools > ESP32 LittleFS Data Upload).
2. Tancapkan kabel USB ESP32 ke laptop.
3. Klik **Tools > ESP32 LittleFS Data Upload**.
4. Tunggu hingga proses upload partisi flash selesai.
5. Upload kode Arduino [esp32_with_webserver.ino](file:///d:/Kuliah/SKRIPSI%20DIAN/Skripsi%20Smart%20Farm%20Poultry/WebApps/smart-farm-monitor/native-esp32-web/esp32_with_webserver.ino) seperti biasa.

---

## 📱 3. Cara Mengakses di Kandang Ayam (Tanpa Kuota / Tanpa Internet)

1. Nyalakan alat ESP32 di kandang ayam.
2. Ambil HP / Smartphone peternak, lalu buka pengaturan WiFi.
3. Hubungkan HP ke WiFi Access Point:
   - **SSID:** `SmartFarm-Kandang`
   - **Password:** `12345678`
4. Buka browser HP (Chrome / Safari), ketik alamat:
   ```text
   http://192.168.4.1
   ```
5. Dashboard lengkap akan terbuka secara instan! Peternak dapat melihat kondisi suhu, kelembapan, kadar amonia, serta menyalakan/mematikan kipas & heater secara manual melalui tombol override.

---

## 🎛️ 4. Fitur Simulasi untuk Sidang Skripsi

Pada tab **Fuzzy Mamdani**:
- Tersedia **3 Slider Pengujian** (Suhu 10–40°C, Kelembapan 30–100%, Amonia 0–50 ppm).
- Dosen penguji dapat menggeser nilai slider untuk membuktikan bahwa **27 Rule Base Mamdani** merespon dengan benar sesuai naskah skripsi:
  - Misal Suhu Panas (>28°C) + Amonia Bahaya (>25 ppm) -> Kipas Intake, Kipas Exhaust, dan Konveyor otomatis menyala (ON).
  - Misal Suhu Dingin (<18°C) -> Lampu Pemanas (Heater) otomatis menyala.
