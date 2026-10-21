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
    Serial.println("[WARN] Sensor SHT31 tidak terdeteksi! Mode simulasi nilai aktif jika sensor dilepas.");
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

    // 1. Baca Sensor Suhu & Kelembapan (SHT31)
    float suhu = 24.5f;
    float kelembapan = 68.0f;

    if (sht31Available) {
      float t = sht31.readTemperature();
      float h = sht31.readHumidity();
      if (!isnan(t) && !isnan(h)) {
        suhu = t;
        kelembapan = h;
      } else {
        Serial.println("[WARN] Gagal membaca data dari SHT31.");
      }
    } else {
      // Fluktuasi demo jika sensor belum terpasang
      suhu = 24.0f + sin(millis() / 20000.0f) * 4.0f;
      kelembapan = 65.0f + cos(millis() / 25000.0f) * 10.0f;
    }

    // 2. Baca Sensor Gas Amonia (MQ-135 ADC GPIO 34)
    float amonia = readAmmonia();

    Serial.printf("\n[SENSOR] Suhu: %.1f °C | Kelembapan: %.1f %%RH | Amonia: %.1f ppm\n",
                  suhu, kelembapan, amonia);

    // 3. Jalankan Algoritma Fuzzy Mamdani 125 Rule Base
    FuzzyResult fuzzy = runMamdani125(suhu, kelembapan, amonia);

    // 4. Kendalikan Aktuator Fisik (PWM MOSFET & Relai Konveyor)
    applyActuators(fuzzy.pwm_intake, fuzzy.pwm_exhaust, fuzzy.pwm_pemanas, fuzzy.status_konveyor);

    Serial.printf("[FLC MAMDANI] Kondisi: %s\n", fuzzy.condition_label.c_str());
    Serial.printf("  * Kipas Intake  : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_intake, fuzzy.pwm_intake);
    Serial.printf("  * Kipas Exhaust : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_exhaust, fuzzy.pwm_exhaust);
    Serial.printf("  * Lampu Pemanas : y*=%.2f -> PWM %d%%\n", fuzzy.y_star_pemanas, fuzzy.pwm_pemanas);
    Serial.printf("  * Motor Konveyor: %s (Relai GPIO 27)\n", fuzzy.status_konveyor ? "ON (AKTIF)" : "OFF (MATI)");

    // 5. Kirim Telemetri ke Supabase Cloud (Tabel Tunggal: 'telemetry')
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
// ══════════════════════════════════════════════════════════════
float readAmmonia() {
  int rawADC = analogRead(PIN_MQ135);
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
RuleOutputTerms getRuleOutput(int t, int h, int a) {
  RuleOutputTerms out = {0, 0, 0};

  // 1. Lampu Pemanas (Heater)
  if (t == 0) { // SD (Sangat Dingin)
    out.htTerm = 4; // Maksimal
  } else if (t == 1) { // D (Dingin)
    if (a >= 3) out.htTerm = 3; // Tinggi
    else if (h >= 3) out.htTerm = 2; // Sedang
    else out.htTerm = (h == 0) ? 1 : 2;
  } else { // N, P, SP
    out.htTerm = 0; // Mati
  }

  // 2. Kipas Exhaust
  if (a == 4) { // ST (Sangat Bahaya)
    out.exTerm = (t >= 2) ? 4 : (t == 1 ? 3 : 2);
  } else if (a == 3) { // T (Bahaya)
    if (t >= 3) out.exTerm = 4;
    else if (t == 2) out.exTerm = 3;
    else if (t == 1) out.exTerm = 2;
    else out.exTerm = 1;
  } else if (a == 2) { // S (Waspada)
    if (t == 4) out.exTerm = 4;
    else if (t == 3) out.exTerm = 3;
    else if (t == 2) out.exTerm = 2;
    else if (t == 1) out.exTerm = 1;
    else out.exTerm = 0;
  } else { // R (Aman) & SR (Sangat Aman)
    if (t == 4) out.exTerm = 4;
    else if (t == 3) out.exTerm = 3;
    else if (t == 2) {
      if (h == 4) out.exTerm = 2;
      else if (h == 3) out.exTerm = 1;
      else out.exTerm = 0;
    } else {
      out.exTerm = 0;
    }
  }

  // 3. Kipas Intake
  if (t == 4) { // SP (Sangat Panas)
    out.inTerm = 4; // Maksimal
  } else if (t == 3) { // P (Panas)
    out.inTerm = (a >= 2 || h >= 3) ? 3 : 2; // Tinggi atau Sedang
  } else if (t == 2) { // N (Normal)
    if (a == 4) out.inTerm = 3;
    else if (a == 3) out.inTerm = 2;
    else if (a == 2) out.inTerm = 1;
    else {
      if (h == 4) out.inTerm = 2;
      else if (h == 3) out.inTerm = 1;
      else out.inTerm = 0;
    }
  } else if (t == 1) { // D (Dingin)
    out.inTerm = (a >= 3) ? 1 : 0;
  } else { // SD (Sangat Dingin)
    out.inTerm = 0;
  }

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
  float muA[5] = {
    calcLeftShoulder(nh3, 5.0f, 10.0f),         // SR: Sangat Aman [0, 0, 5, 10]
    calcTri(nh3, 5.0f, 10.0f, 15.0f),          // R: Aman [5, 10, 10, 15]
    calcTri(nh3, 10.0f, 15.0f, 20.0f),         // S: Waspada [10, 15, 15, 20]
    calcTri(nh3, 15.0f, 20.0f, 30.0f),         // T: Bahaya [15, 20, 20, 30]
    calcRightShoulder(nh3, 20.0f, 30.0f)        // ST: Sangat Bahaya [20, 30, 50, 50]
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

  // 6. Relai Biner Motor Konveyor (Sesuai Proposal: Amonia >= 20 ppm ATAU Kelembapan > 90%)
  bool conveyor = (nh3 >= 20.0f || humid > 90.0f);

  // Label kondisi mikroklimat
  String label = "Kondisi Normal";
  if (nh3 >= 20.0f || temp >= 31.0f || temp <= 14.0f) {
    label = "Kondisi Bahaya";
  } else if (nh3 >= 15.0f || temp >= 27.0f || temp <= 18.0f || humid >= 85.0f) {
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
