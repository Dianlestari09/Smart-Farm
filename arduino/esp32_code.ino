/*
 * ══════════════════════════════════════════════════════════════════════════════
 * ESP32 FIRMWARE — SMART FARM POULTRY MONITOR
 * Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur
 *           Berbasis Fuzzy Logic Controller"
 * Peneliti: Dian Lestari Kurniawati (NIM: 230605110016)
 *
 * Spesifikasi Baku Proposal Skripsi (Bab III):
 * 1. Database Supabase Tabel Tunggal: 'telemetry' (Tabel 3.5 Proposal)
 * 2. Algoritma FLC Mamdani 125 Rule Base (5 Suhu x 5 Kelembapan x 5 Amonia)
 * 3. Defuzzifikasi Centroid COA Domain [0..100] & Scaling PWM (Persamaan 3.1 & 3.2)
 * 4. Pin Hardware ESP32 Sesuai Gambar 3.5 Proposal:
 *    - GPIO 16 : Kipas Intake (MOSFET PWM)
 *    - GPIO 17 : Kipas Exhaust (MOSFET PWM)
 *    - GPIO 23 : Lampu Pemanas (MOSFET PWM)
 *    - GPIO 27 : Relai 1-Kanal Motor Konveyor (Digital HIGH/LOW)
 *    - Sensor SHT31 : Bus I2C ESP32 (SDA GPIO 21, SCL GPIO 22)
 *    - Sensor MQ-135: GPIO 34 (ADC Analog)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Library yang dibutuhkan (Install via Arduino Library Manager):
 * - ArduinoJson (v6.x) by Benoit Blanchon
 * - Adafruit SHT31 Library by Adafruit
 * - Wire, WiFi, HTTPClient (Bawaan ESP32 Arduino Core)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>

// ─── 1. KONFIGURASI WIFI & SUPABASE ──────────────────────────
const char* WIFI_SSID     = "SSID_WIFI_ANDA";
const char* WIFI_PASSWORD = "PASSWORD_WIFI_ANDA";

const char* SUPABASE_URL  = "https://jkgqmshsjngppsibwwyf.supabase.co";
const char* SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZ3Ftc2hzam5ncHBzaWJ3d3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNjQ5MzMsImV4cCI6MjEwNzc0MDkzM30.XzjuidtnuIyf2eldLsm0CHHB_AL7OOoVdRbEMuOD48g";

// ─── 2. PIN HARDWARE ESP32 (SESUAI GAMBAR 3.5 PROPOSAL) ─────
#define PIN_FAN_INTAKE   16  // Kipas Intake (MOSFET PWM)
#define PIN_FAN_EXHAUST  17  // Kipas Exhaust (MOSFET PWM)
#define PIN_HEATER       23  // Lampu Pemanas (MOSFET PWM)
#define PIN_CONVEYOR     27  // Relai 1-Kanal Motor Konveyor (Digital HIGH/LOW)
#define PIN_MQ135        34  // Sensor Gas Amonia MQ-135 (ADC Analog GPIO 34)

// Kanal & Parameter PWM LEDC ESP32 (Frekuensi 5 kHz, Resolusi 8-bit: 0 - 255)
const int PWM_FREQ        = 5000;
const int PWM_RESOLUTION  = 8;
const int CH_FAN_INTAKE   = 0;
const int CH_FAN_EXHAUST  = 1;
const int CH_HEATER       = 2;

// Kompatibilitas ESP32 Arduino Core v2.x dan v3.x (Menghindari error 'ledcSetup' was not declared)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  #define INIT_PWM(pin, ch)        ledcAttach(pin, PWM_FREQ, PWM_RESOLUTION)
  #define WRITE_PWM(pin, ch, duty) ledcWrite(pin, duty)
#else
  #define INIT_PWM(pin, ch)        do { ledcSetup(ch, PWM_FREQ, PWM_RESOLUTION); ledcAttachPin(pin, ch); } while(0)
  #define WRITE_PWM(pin, ch, duty) ledcWrite(ch, duty)
#endif

// Interval pengiriman telemetri ke database Supabase (3000 ms = 3 detik)
const unsigned long SEND_INTERVAL = 3000;
unsigned long lastSendTime = 0;

// Objek Sensor SHT31 (I2C SDA=21, SCL=22)
Adafruit_SHT31 sht31 = Adafruit_SHT31();
bool sht31Available = false;

// ─── 3. STRUKTUR DATA FLC MAMDANI ───────────────────────────
struct RuleOutputTerms {
  uint8_t inTerm; // 0=Mati, 1=Rendah, 2=Sedang, 3=Tinggi, 4=Maksimal
  uint8_t exTerm;
  uint8_t htTerm;
};

struct CentroidResult {
  float y_star;
  int pwm;
};

struct FuzzyResult {
  float y_star_intake;
  float y_star_exhaust;
  float y_star_pemanas;
  int pwm_intake;
  int pwm_exhaust;
  int pwm_pemanas;
  bool status_konveyor;
  String condition_label;
};

// Prototipe Fungsi
float calcLeftShoulder(float x, float a, float b);
float calcRightShoulder(float x, float a, float b);
float calcTri(float x, float a, float b, float c);
float calcTrap(float x, float a, float b, float c, float d);
RuleOutputTerms getRuleOutput(int t, int h, int a);
CentroidResult defuzzifyCentroid(const float betas[5]);
FuzzyResult runMamdani125(float temp, float humid, float nh3);
float readAmmonia();
void applyActuators(int pwm_in, int pwm_ex, int pwm_ht, bool conveyor_on);
void sendTelemetryToSupabase(float suhu, float humid, float nh3, const FuzzyResult& f);
void connectWiFi();

// ══════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n========================================================");
  Serial.println("  SMART FARM POULTRY MONITOR — ESP32 FL MAMDANI");
  Serial.println("  Skripsi: Dian Lestari Kurniawati (NIM: 230605110016)");
  Serial.println("========================================================");

  // 1. Inisialisasi Pin & Kanal PWM LEDC ESP32 (Mendukung Core v2 & v3)
  INIT_PWM(PIN_FAN_INTAKE, CH_FAN_INTAKE);
  INIT_PWM(PIN_FAN_EXHAUST, CH_FAN_EXHAUST);
  INIT_PWM(PIN_HEATER, CH_HEATER);

  // Inisialisasi Pin Relai Motor Konveyor (Digital Output)
  pinMode(PIN_CONVEYOR, OUTPUT);
  digitalWrite(PIN_CONVEYOR, LOW);

  // Output awal aktuator mati (0% duty cycle)
  applyActuators(0, 0, 0, false);

  // Inisialisasi Pin ADC MQ-135
  pinMode(PIN_MQ135, INPUT);

  // 2. Inisialisasi Bus I2C & Sensor SHT31
  Wire.begin(21, 22);
  if (sht31.begin(0x44) || sht31.begin(0x45)) {
    sht31Available = true;
    Serial.println("[OK] Sensor SHT31 terhubung pada bus I2C (SDA 21, SCL 22).");
  } else {
    sht31Available = false;
    Serial.println("[WARN] Sensor SHT31 tidak terdeteksi! Menunggu sensor dipasang pada bus I2C (SDA 21, SCL 22).");
  }

  // 3. Hubungkan ke Jaringan WiFi
  connectWiFi();
}

// ══════════════════════════════════════════════════════════════
// LOOP UTAMA
// ══════════════════════════════════════════════════════════════
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  unsigned long currentMillis = millis();
  if (currentMillis - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = currentMillis;

    // 1. Periksa ketersediaan Sensor Suhu & Kelembapan (SHT31)
    if (!sht31Available) {
      // Coba re-deteksi I2C jika sensor baru saja dipasang
      if (sht31.begin(0x44) || sht31.begin(0x45)) {
        sht31Available = true;
        Serial.println("[OK] Sensor SHT31 berhasil terdeteksi!");
      }
    }

    float t = NAN;
    float h = NAN;
    if (sht31Available) {
      t = sht31.readTemperature();
      h = sht31.readHumidity();
      if (isnan(t) || isnan(h)) {
        Serial.println("[WARN] Pembacaan SHT31 gagal / kabel terlepas.");
        sht31Available = false;
      }
    }

    bool shtValid = sht31Available && !isnan(t) && !isnan(h);
    float suhu = shtValid ? t : -999.0f;
    float kelembapan = shtValid ? h : -999.0f;

    // 2. Baca Sensor Gas Amonia (MQ-135 ADC GPIO 34)
    float amonia = readAmmonia();
    bool mqValid = (amonia >= 0.0f);

    // Cetak status sensor ke Serial Monitor
    if (shtValid) {
      Serial.printf("\n[SENSOR] Suhu: %.1f °C | Kelembapan: %.1f %%RH | ", suhu, kelembapan);
    } else {
      Serial.print("\n[SENSOR] SHT31: [TIDAK TERHUBUNG] | ");
    }
    if (mqValid) {
      Serial.printf("Amonia: %.1f ppm\n", amonia);
    } else {
      Serial.println("MQ-135: [TIDAK TERHUBUNG]");
    }

    // 3. Kontrol Aktuator & Fuzzy Mamdani
    FuzzyResult fuzzy;
    if (shtValid && mqValid) {
      // Semua sensor terpasang: Jalankan Algoritma Fuzzy Mamdani 125 Rule Base
      fuzzy = runMamdani125(suhu, kelembapan, amonia);
      applyActuators(fuzzy.pwm_intake, fuzzy.pwm_exhaust, fuzzy.pwm_pemanas, fuzzy.status_konveyor);

      Serial.printf("[FLC MAMDANI] Kondisi: %s\n", fuzzy.condition_label.c_str());
      Serial.printf("  * Kipas Intake  : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_intake, fuzzy.pwm_intake);
      Serial.printf("  * Kipas Exhaust : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_exhaust, fuzzy.pwm_exhaust);
      Serial.printf("  * Lampu Pemanas : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_pemanas, fuzzy.pwm_pemanas);
      Serial.printf("  * Motor Konveyor: %s (Relai GPIO 27)\n", fuzzy.status_konveyor ? "ON (AKTIF)" : "OFF (MATI)");
    } else {
      // Jika salah satu atau kedua sensor tidak terpasang, matikan aktuator demi keselamatan ternak
      applyActuators(0, 0, 0, false);
      fuzzy.pwm_intake = 0;
      fuzzy.pwm_exhaust = 0;
      fuzzy.pwm_pemanas = 0;
      fuzzy.status_konveyor = false;
      fuzzy.y_star_intake = 0;
      fuzzy.y_star_exhaust = 0;
      fuzzy.y_star_pemanas = 0;
      if (!shtValid && !mqValid) {
        fuzzy.condition_label = "Semua Sensor Terputus";
      } else if (!shtValid) {
        fuzzy.condition_label = "Sensor SHT31 Terputus";
      } else {
        fuzzy.condition_label = "Sensor MQ-135 Terputus";
      }
      Serial.printf("[STATUS] %s -> Aktuator dimatikan (Safety Mode).\n", fuzzy.condition_label.c_str());
    }

    // 4. TETAP KIRIM TELEMETRI KE SUPABASE CLOUD
    // ESP32 tetap Online di Dashboard. Nilai -999.0f menandakan sensor tidak terpasang (tanpa dummy).
    sendTelemetryToSupabase(suhu, kelembapan, amonia, fuzzy);
  }
}

// ══════════════════════════════════════════════════════════════
// FUNGSI KEANGGOTAAN FUZZY (MEMBERSHIP FUNCTIONS)
// ══════════════════════════════════════════════════════════════
float calcLeftShoulder(float x, float a, float b) {
  if (x <= a) return 1.0f;
  if (x >= b) return 0.0f;
  return (b - x) / (b - a);
}

float calcRightShoulder(float x, float a, float b) {
  if (x <= a) return 0.0f;
  if (x >= b) return 1.0f;
  return (x - a) / (b - a);
}

float calcTri(float x, float a, float b, float c) {
  if (x <= a || x >= c) return 0.0f;
  if (x == b) return 1.0f;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

float calcTrap(float x, float a, float b, float c, float d) {
  if (x <= a || x >= d) return 0.0f;
  if (x >= b && x <= c) return 1.0f;
  if (x < b) return (x - a) / (b - a);
  return (d - x) / (d - c);
}

// ══════════════════════════════════════════════════════════════
// BACA SENSOR AMONIA MQ-135 (GPIO 34 ADC)
// Mengembalikan -999.0f jika sensor MQ-135 belum terpasang (rawADC <= 10)
// ══════════════════════════════════════════════════════════════
float readAmmonia() {
  int rawADC = analogRead(PIN_MQ135);
  // Jika rawADC <= 10 (tegangan < 0.01V, pin terbuka / sensor belum terpasang)
  if (rawADC <= 10) {
    return -999.0f;
  }
  // Konversi rentang ADC ESP32 (0 - 4095) ke konsentrasi PPM (0 - 50 ppm)
  float ppm = ((float)rawADC / 4095.0f) * 50.0f;
  if (ppm < 0.0f) ppm = 0.0f;
  if (ppm > 50.0f) ppm = 50.0f;
  return ppm;
}

// ══════════════════════════════════════════════════════════════
// MATRIKS 125 ATURAN MAMDANI (5 Suhu x 5 Kelembapan x 5 Amonia)
// Output: 0=Mati, 1=Rendah (25%), 2=Sedang (50%), 3=Tinggi (75%), 4=Maksimal (100%)
// ══════════════════════════════════════════════════════════════
// 125 Matriks Baku Rule Base Mamdani sesuai Naskah Proposal Bab III:
// Format tiap baris: {htTerm (Pemanas), exTerm (Exhaust), inTerm (Intake), konvTerm (Konveyor)}
// Nilai term output: 0=Mati (0%), 1=Rendah (25%), 2=Sedang (50%), 3=Tinggi (75%), 4=Maksimal (100%)
// Konveyor: 0=OFF, 1=ON
const uint8_t RULE_TABLE[125][4] PROGMEM = {
  {4, 0, 0, 0}, {4, 0, 0, 0}, {4, 0, 1, 1}, {3, 0, 2, 1}, {3, 1, 3, 1}, // R001-R005: Suhu < 15, RH < 40
  {4, 0, 0, 0}, {4, 0, 0, 0}, {4, 0, 1, 1}, {3, 0, 2, 1}, {3, 1, 3, 1}, // R006-R010: Suhu < 15, RH 40-60
  {4, 0, 0, 0}, {4, 0, 0, 0}, {4, 0, 1, 1}, {3, 0, 2, 1}, {3, 1, 3, 1}, // R011-R015: Suhu < 15, RH 60-80
  {4, 0, 1, 0}, {4, 0, 1, 0}, {3, 0, 2, 1}, {3, 1, 3, 1}, {2, 1, 4, 1}, // R016-R020: Suhu < 15, RH 80-90
  {4, 0, 1, 0}, {3, 0, 2, 0}, {3, 1, 2, 1}, {2, 1, 3, 1}, {2, 1, 4, 1}, // R021-R025: Suhu < 15, RH > 90

  {3, 0, 0, 0}, {3, 0, 0, 0}, {2, 0, 1, 1}, {2, 0, 2, 1}, {1, 1, 3, 1}, // R026-R030: Suhu 15-20, RH < 40
  {3, 0, 0, 0}, {3, 0, 0, 0}, {2, 0, 1, 1}, {2, 0, 2, 1}, {1, 1, 3, 1}, // R031-R035: Suhu 15-20, RH 40-60
  {2, 0, 0, 0}, {2, 0, 0, 0}, {2, 0, 1, 1}, {1, 0, 2, 1}, {1, 1, 3, 1}, // R036-R040: Suhu 15-20, RH 60-80
  {2, 0, 1, 0}, {2, 0, 1, 0}, {1, 0, 2, 1}, {1, 1, 3, 1}, {0, 1, 4, 1}, // R041-R045: Suhu 15-20, RH 80-90
  {2, 0, 1, 0}, {1, 0, 2, 0}, {1, 1, 2, 1}, {0, 1, 3, 1}, {0, 2, 4, 1}, // R046-R050: Suhu 15-20, RH > 90

  {0, 0, 0, 0}, {0, 0, 0, 0}, {0, 1, 1, 1}, {0, 2, 3, 1}, {0, 3, 4, 1}, // R051-R055: Suhu 20-25, RH < 40
  {0, 0, 0, 0}, {0, 0, 0, 0}, {0, 1, 1, 1}, {0, 2, 3, 1}, {0, 3, 4, 1}, // R056-R060: Suhu 20-25, RH 40-60
  {0, 0, 0, 0}, {0, 0, 0, 0}, {0, 1, 2, 1}, {0, 2, 3, 1}, {0, 3, 4, 1}, // R061-R065: Suhu 20-25, RH 60-80
  {0, 1, 1, 0}, {0, 1, 2, 0}, {0, 2, 2, 1}, {0, 2, 3, 1}, {0, 3, 4, 1}, // R066-R070: Suhu 20-25, RH 80-90
  {0, 1, 2, 0}, {0, 2, 2, 0}, {0, 2, 3, 1}, {0, 3, 3, 1}, {0, 3, 4, 1}, // R071-R075: Suhu 20-25, RH > 90

  {0, 2, 2, 0}, {0, 2, 2, 0}, {0, 2, 3, 1}, {0, 3, 4, 1}, {0, 4, 4, 1}, // R076-R080: Suhu 25-30, RH < 40
  {0, 2, 2, 0}, {0, 2, 2, 0}, {0, 2, 3, 1}, {0, 3, 4, 1}, {0, 4, 4, 1}, // R081-R085: Suhu 25-30, RH 40-60
  {0, 2, 3, 0}, {0, 2, 3, 0}, {0, 3, 3, 1}, {0, 3, 4, 1}, {0, 4, 4, 1}, // R086-R090: Suhu 25-30, RH 60-80
  {0, 3, 3, 0}, {0, 3, 3, 0}, {0, 3, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R091-R095: Suhu 25-30, RH 80-90
  {0, 3, 4, 0}, {0, 3, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R096-R100: Suhu 25-30, RH > 90

  {0, 4, 4, 0}, {0, 4, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R101-R105: Suhu > 30, RH < 40
  {0, 4, 4, 0}, {0, 4, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R106-R110: Suhu > 30, RH 40-60
  {0, 4, 4, 0}, {0, 4, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R111-R115: Suhu > 30, RH 60-80
  {0, 4, 4, 0}, {0, 4, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}, // R116-R120: Suhu > 30, RH 80-90
  {0, 4, 4, 0}, {0, 4, 4, 0}, {0, 4, 4, 1}, {0, 4, 4, 1}, {0, 4, 4, 1}  // R121-R125: Suhu > 30, RH > 90
};

RuleOutputTerms getRuleOutput(int t, int h, int a) {
  int idx = (t * 25) + (h * 5) + a;
  RuleOutputTerms out;
  out.htTerm = pgm_read_byte(&(RULE_TABLE[idx][0]));
  out.exTerm = pgm_read_byte(&(RULE_TABLE[idx][1]));
  out.inTerm = pgm_read_byte(&(RULE_TABLE[idx][2]));
  return out;
}

// ══════════════════════════════════════════════════════════════
// DEFUZZIFIKASI CENTROID COA & SCALING PWM (Persamaan 3.1 & 3.2)
// ══════════════════════════════════════════════════════════════
CentroidResult defuzzifyCentroid(const float betas[5]) {
  float sumBeta = betas[0] + betas[1] + betas[2] + betas[3] + betas[4];
  if (sumBeta <= 0.0001f) {
    return { 8.3f, 0 };
  }

  float num = 0.0f;
  float den = 0.0f;
  const float dy = 0.5f;

  for (float y = 0.0f; y <= 100.0f; y += dy) {
    // 5 fungsi keanggotaan output domain [0..100]
    float m0 = (y <= 25.0f) ? ((25.0f - y) / 25.0f) : 0.0f;

    float m1 = 0.0f;
    if (y < 25.0f) m1 = y / 25.0f;
    else if (y <= 50.0f) m1 = (50.0f - y) / 25.0f;

    float m2 = 0.0f;
    if (y >= 25.0f && y < 50.0f) m2 = (y - 25.0f) / 25.0f;
    else if (y >= 50.0f && y <= 75.0f) m2 = (75.0f - y) / 25.0f;

    float m3 = 0.0f;
    if (y >= 50.0f && y < 75.0f) m3 = (y - 50.0f) / 25.0f;
    else if (y >= 75.0f && y <= 100.0f) m3 = (100.0f - y) / 25.0f;

    float m4 = (y >= 75.0f) ? ((y - 75.0f) / 25.0f) : 0.0f;

    float mu = max(min(betas[0], m0),
               max(min(betas[1], m1),
               max(min(betas[2], m2),
               max(min(betas[3], m3), min(betas[4], m4)))));

    num += y * mu * dy;
    den += mu * dy;
  }

  if (den <= 0.00001f) {
    return { 8.3f, 0 };
  }

  // Persamaan 3.1: Centroid COA domain [0..100]
  float y_star = num / den;

  // Persamaan 3.2: Scaling PWM dari [8.3 .. 91.7] ke [0 .. 100]
  float pwmRaw = ((y_star - 8.3f) / (91.7f - 8.3f)) * 100.0f;
  int pwm = constrain((int)roundf(pwmRaw), 0, 100);

  return { y_star, pwm };
}

// ══════════════════════════════════════════════════════════════
// MESIN INFERENSI FUZZY MAMDANI 125 RULE BASE
// ══════════════════════════════════════════════════════════════
FuzzyResult runMamdani125(float temp, float humid, float nh3) {
  // 1. Fuzzifikasi Suhu (10–40 °C)
  float muT[5] = {
    calcLeftShoulder(temp, 14.0f, 18.0f),       // SD: Sangat Dingin [10, 10, 14, 18]
    calcTri(temp, 14.0f, 18.0f, 20.0f),        // D: Dingin [14, 18, 18, 20]
    calcTrap(temp, 18.0f, 20.0f, 25.0f, 27.0f),// N: Normal [18, 20, 25, 27]
    calcTri(temp, 25.0f, 27.0f, 31.0f),        // P: Panas [25, 27, 27, 31]
    calcRightShoulder(temp, 27.0f, 31.0f)       // SP: Sangat Panas [27, 31, 40, 40]
  };

  // 2. Fuzzifikasi Kelembapan (20–100 %RH)
  float muH[5] = {
    calcLeftShoulder(humid, 40.0f, 50.0f),      // SK: Sangat Kering [20, 20, 40, 50]
    calcTri(humid, 40.0f, 50.0f, 60.0f),       // K: Kering [40, 50, 50, 60]
    calcTrap(humid, 50.0f, 60.0f, 80.0f, 85.0f),// N: Normal [50, 60, 80, 85]
    calcTri(humid, 80.0f, 85.0f, 92.0f),       // B: Basah [80, 85, 85, 92]
    calcRightShoulder(humid, 85.0f, 92.0f)      // SB: Sangat Basah [85, 92, 100, 100]
  };

  // 3. Fuzzifikasi Gas Amonia (0–50 ppm)
  // Sesuai Tabel Baku: SR (< 10 ppm), R (10–20 ppm), S (20–30 ppm), T (30–40 ppm), ST (> 40 ppm)
  float muA[5] = {
    calcLeftShoulder(nh3, 5.0f, 15.0f),         // SR: Sangat Aman (< 10 ppm) [0, 0, 5, 15]
    calcTri(nh3, 5.0f, 15.0f, 25.0f),          // R: Aman (10 – 20 ppm) [5, 15, 25]
    calcTri(nh3, 15.0f, 25.0f, 35.0f),         // S: Waspada (20 – 30 ppm) [15, 25, 35]
    calcTri(nh3, 25.0f, 35.0f, 45.0f),         // T: Bahaya (30 – 40 ppm) [25, 35, 45]
    calcRightShoulder(nh3, 35.0f, 45.0f)        // ST: Sangat Bahaya (> 40 ppm) [35, 45, 50, 50]
  };

  // Array clipping alpha untuk 5 term output
  float betasIn[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  float betasEx[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  float betasHt[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};

  // 4. Inferensi 125 Aturan (5x5x5) dengan Implikasi MIN & Agregasi MAX
  for (int t = 0; t < 5; t++) {
    for (int h = 0; h < 5; h++) {
      for (int a = 0; a < 5; a++) {
        float alpha = min(muT[t], min(muH[h], muA[a]));
        if (alpha > 0.001f) {
          RuleOutputTerms out = getRuleOutput(t, h, a);
          if (alpha > betasIn[out.inTerm]) betasIn[out.inTerm] = alpha;
          if (alpha > betasEx[out.exTerm]) betasEx[out.exTerm] = alpha;
          if (alpha > betasHt[out.htTerm]) betasHt[out.htTerm] = alpha;
        }
      }
    }
  }

  // 5. Defuzzifikasi Centroid & Scaling PWM
  CentroidResult resIn = defuzzifyCentroid(betasIn);
  CentroidResult resEx = defuzzifyCentroid(betasEx);
  CentroidResult resHt = defuzzifyCentroid(betasHt);

  // 6. Relai Biner Motor Konveyor (Sesuai Proposal & Tabel Aksi Aktuator: Amonia >= 20.0 ppm ATAU Kelembapan > 90%)
  bool conveyor = (nh3 >= 20.0f || humid > 90.0f);

  // Label kondisi mikroklimat (Amonia < 20 ppm Normal, 20-30 ppm Waspada, >= 30 ppm Bahaya)
  String label = "Kondisi Normal";
  if (nh3 >= 30.0f || temp >= 31.0f || temp <= 14.0f) {
    label = "Kondisi Bahaya";
  } else if (nh3 >= 20.0f || temp >= 27.0f || temp <= 18.0f || humid >= 85.0f) {
    label = "Kondisi Waspada";
  }

  FuzzyResult result;
  result.y_star_intake   = resIn.y_star;
  result.y_star_exhaust  = resEx.y_star;
  result.y_star_pemanas  = resHt.y_star;
  result.pwm_intake      = resIn.pwm;
  result.pwm_exhaust     = resEx.pwm;
  result.pwm_pemanas     = resHt.pwm;
  result.status_konveyor = conveyor;
  result.condition_label = label;

  return result;
}

// ══════════════════════════════════════════════════════════════
// KONTROL AKTUATOR FISIK (PWM MOSFET & RELAI KONVEYOR)
// ══════════════════════════════════════════════════════════════
void applyActuators(int pwm_in, int pwm_ex, int pwm_ht, bool conveyor_on) {
  int dutyIn = (pwm_in * 255) / 100;
  int dutyEx = (pwm_ex * 255) / 100;
  int dutyHt = (pwm_ht * 255) / 100;

  WRITE_PWM(PIN_FAN_INTAKE,  CH_FAN_INTAKE,  dutyIn);
  WRITE_PWM(PIN_FAN_EXHAUST, CH_FAN_EXHAUST, dutyEx);
  WRITE_PWM(PIN_HEATER,      CH_HEATER,      dutyHt);

  digitalWrite(PIN_CONVEYOR, conveyor_on ? HIGH : LOW);
}

// ══════════════════════════════════════════════════════════════
// KIRIM TELEMETRI KE TABEL TUNGGAL 'telemetry' SUPABASE (Tabel 3.5)
// ══════════════════════════════════════════════════════════════
void sendTelemetryToSupabase(float suhu, float humid, float nh3, const FuzzyResult& f) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/telemetry";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  // Format JSON sesuai Tabel 3.5 Proposal Skripsi
  StaticJsonDocument<384> doc;
  doc["suhu"]            = suhu;
  doc["kelembapan"]      = humid;
  doc["amonia"]          = nh3;
  doc["pwm_intake"]      = f.pwm_intake;
  doc["pwm_exhaust"]     = f.pwm_exhaust;
  doc["pwm_pemanas"]     = f.pwm_pemanas;
  doc["status_konveyor"] = f.status_konveyor;

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  Serial.printf("[HTTP POST] /rest/v1/telemetry -> %d\n", code);
  http.end();
}

// ══════════════════════════════════════════════════════════════
// KONEKSI KE JARINGAN WIFI
// ══════════════════════════════════════════════════════════════
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("\n[WiFi] Menghubungkan ke %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 25) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Berhasil Terhubung! Alamat IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Belum terhubung, akan mencoba kembali pada siklus berikutnya...");
  }
}
