# Panduan Firmware ESP32 & Web Monitor — Smart Farm Poultry

Sistem ini dibuat khusus untuk penelitian Skripsi:
**"Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur Berbasis Fuzzy Logic Controller"**  
Peneliti: **Dian Lestari Kurniawati** (NIM: **230605110016**)

---

## 📌 1. Konfigurasi Pin Hardware ESP32 (Sesuai Gambar 3.5 Proposal)

| Perangkat / Modul | Tipe Antarmuka | Pin ESP32 | Keterangan |
|---|---|---|---|
| **Sensor SHT31** | I2C Hardware | SDA: **GPIO 21**, SCL: **GPIO 22** | Suhu (°C) & Kelembapan (%RH) |
| **Sensor MQ-135** | ADC Analog | **GPIO 34** | Deteksi Gas Amonia (0–50 ppm) |
| **Kipas Intake** | MOSFET PWM | **GPIO 16** (LEDC CH 0) | Pasokan Udara Segar (0–100%) |
| **Kipas Exhaust** | MOSFET PWM | **GPIO 17** (LEDC CH 1) | Pembuangan Udara Panas/Amonia |
| **Lampu Pemanas** | MOSFET PWM | **GPIO 23** (LEDC CH 2) | Pemanas Kalor Kandang (0–100%) |
| **Motor Konveyor** | Relai Biner 1-CH | **GPIO 27** | Pembersih Kotoran Otomatis (ON/OFF) |

---

## 🗄️ 2. Skema Database Supabase (Tabel Tunggal: 'telemetry')

Sesuai **Tabel 3.5 Proposal Skripsi**, database hanya menggunakan 1 tabel:
- `id` (BIGINT, Primary Key, Auto Increment)
- `created_at` (TIMESTAMPTZ, default now())
- `suhu` (REAL, °C)
- `kelembapan` (REAL, %RH)
- `amonia` (REAL, ppm)
- `pwm_intake` (INT2, 0–100)
- `pwm_exhaust` (INT2, 0–100)
- `pwm_pemanas` (INT2, 0–100)
- `status_konveyor` (BOOLEAN, true=ON/false=OFF)

---

## 🧠 3. Logika Fuzzy Mamdani (125 Rule Base)

1. **Fuzzifikasi 5 Himpunan Keanggotaan:**
   - **Suhu (10–40 °C):** Sangat Dingin (SD), Dingin (D), Normal (N), Panas (P), Sangat Panas (SP)
   - **Kelembapan (20–100 %RH):** Sangat Kering (SK), Kering (K), Normal (N), Basah (B), Sangat Basah (SB)
   - **Gas Amonia (0–50 ppm):** Sangat Aman (SR), Aman (R), Waspada (S), Bahaya (T), Sangat Bahaya (ST)
2. **Defuzzifikasi Centroid COA & Scaling PWM (Persamaan 3.1 & 3.2):**
   $$y^* = \frac{\int_0^{100} y \cdot \mu(y) \, dy}{\int_0^{100} \mu(y) \, dy}$$
   $$y_{\text{pwm}} = \text{clamp}\left( \frac{y^* - 8.3}{91.7 - 8.3} \times 100, 0, 100 \right)$$
3. **Pemicu Relai Motor Konveyor (GPIO 27):**
   Aktif (true / HIGH) jika Amonia $\ge$ 20 ppm ATAU Kelembapan > 90%, selain itu OFF.

---

## 🚀 4. Berkas Sketch Arduino

- [esp32_code.ino](file:///d:/Kuliah/SKRIPSI%20DIAN/Skripsi%20Smart%20Farm%20Poultry/WebApps/smart-farm-monitor/arduino/esp32_code.ino): Kode baku mikrokontroler mandiri dengan koneksi langsung ke Supabase Cloud REST API.
- [esp32_with_webserver.ino](file:///d:/Kuliah/SKRIPSI%20DIAN/Skripsi%20Smart%20Farm%20Poultry/WebApps/smart-farm-monitor/arduino/esp32_with_webserver.ino): Kode ESP32 dengan Web Server LittleFS port 80 dan Access Point offline kandang `SmartFarm-Kandang` (IP: `192.168.4.1`).
