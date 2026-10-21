/*
 * ══════════════════════════════════════════════════════════════════════════════
 * ESP32 + WEBSERVER LITTLEFS + FUZZY MAMDANI 125 RULES + SUPABASE TELEMETRY
 * Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur
 *           Berbasis Fuzzy Logic Controller"
 * Peneliti: Dian Lestari Kurniawati (NIM: 230605110016)
 * ══════════════════════════════════════════════════════════════════════════════
 * 
 * Spesifikasi Baku Proposal Skripsi (Bab III):
 * 1. Database Supabase: Tabel Tunggal 'telemetry' (Tabel 3.5 Proposal)
 * 2. Algoritma FLC Mamdani 125 Rule Base (5 Suhu x 5 Kelembapan x 5 Amonia)
 * 3. Defuzzifikasi Centroid COA Domain [0..100] & Scaling PWM (Persamaan 3.1 & 3.2)
 * 4. Pin Hardware ESP32 Sesuai Gambar 3.5 Proposal:
 *    - GPIO 16 : Kipas Intake (MOSFET PWM)
 *    - GPIO 17 : Kipas Exhaust (MOSFET PWM)
 *    - GPIO 23 : Lampu Pemanas (MOSFET PWM)
 *    - GPIO 27 : Relai 1-Kanal Motor Konveyor (Digital HIGH/LOW)
 *    - Sensor SHT31 : Bus I2C ESP32 (SDA GPIO 21, SCL GPIO 22)
 *    - Sensor MQ-135: GPIO 34 (ADC Analog)
 * 5. Web Server Lokal LittleFS di Port 80 (Akses Offline Kandang via AP 'SmartFarm-Kandang')
 * 6. REST API: GET /api/data & POST /api/actuator
 * ══════════════════════════════════════════════════════════════════════════════
 */

#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>

// ─── 1. KONFIGURASI WIFI & ACCESS POINT ───────────────────────
const char* WIFI_SSID       = "SSID_WIFI_KANDANG";
const char* WIFI_PASSWORD   = "PASSWORD_WIFI_KANDANG";

// Access Point lokal (Bisa dibuka di HP walau tanpa internet)
const char* AP_SSID         = "SmartFarm-Kandang";
const char* AP_PASS         = "12345678"; // minimal 8 karakter

// ─── 2. KONFIGURASI SUPABASE (CLOUD DATABASE) ─────────────────
const char* SUPABASE_URL    = "https://jkgqmshsjngppsibwwyf.supabase.co";
const char* SUPABASE_KEY    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZ3Ftc2hzam5ncHBzaWJ3d3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNjQ5MzMsImV4cCI6MjEwNzc0MDkzM30.XzjuidtnuIyf2eldLsm0CHHB_AL7OOoVdRbEMuOD48g";

// ─── 3. PIN HARDWARE ESP32 (SESUAI GAMBAR 3.5 PROPOSAL) ─────
#define PIN_FAN_INTAKE      16     // Kipas Intake (MOSFET PWM)
#define PIN_FAN_EXHAUST     17     // Kipas Exhaust (MOSFET PWM)
#define PIN_HEATER          23     // Lampu Pemanas (MOSFET PWM)
#define PIN_CONVEYOR        27     // Relai 1-Kanal Motor Konveyor (Digital HIGH/LOW)
#define PIN_MQ135           34     // Sensor Gas Amonia MQ-135 (ADC Analog GPIO 34)

// Kanal & Parameter PWM LEDC ESP32
const int PWM_FREQ          = 5000;
const int PWM_RESOLUTION    = 8;
const int CH_FAN_INTAKE     = 0;
const int CH_FAN_EXHAUST    = 1;
const int CH_HEATER         = 2;

// Kompatibilitas ESP32 Arduino Core v2.x dan v3.x (Menghindari error 'ledcSetup' was not declared)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  #define INIT_PWM(pin, ch)        ledcAttach(pin, PWM_FREQ, PWM_RESOLUTION)
  #define WRITE_PWM(pin, ch, duty) ledcWrite(pin, duty)
#else
  #define INIT_PWM(pin, ch)        do { ledcSetup(ch, PWM_FREQ, PWM_RESOLUTION); ledcAttachPin(pin, ch); } while(0)
  #define WRITE_PWM(pin, ch, duty) ledcWrite(ch, duty)
#endif

Adafruit_SHT31 sht31 = Adafruit_SHT31();
bool sht31Available = false;
WebServer server(80);

// ─── 4. VARIABEL GLOBAL & SIKLUS INTERVAL ────────────────────
const unsigned long SEND_INTERVAL = 3000; // Siklus kirim 3 detik
unsigned long lastSendTime = 0;

float currentTemp    = 24.5f;
float currentHumid   = 68.0f;
float currentAmmonia = 12.0f;

bool manualOverride  = false;
int statePwmIntake   = 0;
int statePwmExhaust  = 0;
int statePwmHeater   = 0;
bool stateConveyor   = false;

// ─── 5. STRUKTUR DATA FLC MAMDANI 125 ATURAN ──────────────────
struct RuleOutputTerms {
  uint8_t inTerm;
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

FuzzyResult currentFuzzy;

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
void sendTelemetryToSupabase();
void setupWebServer();

// ══════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n========================================================");
  Serial.println("  SmartFarm Poultry — ESP32 LittleFS + Mamdani 125 Rules");
  Serial.println("  Skripsi: Dian Lestari Kurniawati (230605110016)");
  Serial.println("========================================================");

  // 1. Inisialisasi PWM LEDC & Pin Relai (Mendukung Core v2 & v3)
  INIT_PWM(PIN_FAN_INTAKE, CH_FAN_INTAKE);
  INIT_PWM(PIN_FAN_EXHAUST, CH_FAN_EXHAUST);
  INIT_PWM(PIN_HEATER, CH_HEATER);

  pinMode(PIN_CONVEYOR, OUTPUT);
  digitalWrite(PIN_CONVEYOR, LOW);
  applyActuators(0, 0, 0, false);

  pinMode(PIN_MQ135, INPUT);

  // 2. Inisialisasi Sensor SHT31 (I2C)
  Wire.begin(21, 22);
  if (sht31.begin(0x44) || sht31.begin(0x45)) {
    sht31Available = true;
    Serial.println("[OK] Sensor SHT31 terhubung pada I2C.");
  } else {
    sht31Available = false;
    Serial.println("[WARN] Sensor SHT31 tidak terdeteksi (Simulasi data aktif).");
  }

  // 3. Inisialisasi LittleFS (File System Web Server)
  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] Gagal mount LittleFS! Periksa partisi flash.");
  } else {
    Serial.println("[OK] LittleFS berhasil dimuat.");
  }

  // 4. Inisialisasi WiFi (Dual Mode: AP + Station)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("[WIFI AP] SSID: "); Serial.println(AP_SSID);
  Serial.print("[WIFI AP] Buka di Browser HP: http://"); Serial.println(WiFi.softAPIP());

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WIFI STA] Menghubungkan ke "); Serial.println(WIFI_SSID);

  // 5. Inisialisasi Web Server Port 80
  setupWebServer();
  server.begin();
  Serial.println("[OK] Web Server Lokal Aktif di Port 80");
}

// ══════════════════════════════════════════════════════════════
// LOOP
// ══════════════════════════════════════════════════════════════
void loop() {
  server.handleClient();

  if (millis() - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = millis();

    // 1. Baca Sensor SHT31 & MQ-135
    if (sht31Available) {
      float t = sht31.readTemperature();
      float h = sht31.readHumidity();
      if (!isnan(t) && !isnan(h)) {
        currentTemp  = t;
        currentHumid = h;
      }
    } else {
      currentTemp  = 24.0f + sin(millis() / 20000.0f) * 4.0f;
      currentHumid = 65.0f + cos(millis() / 25000.0f) * 10.0f;
    }

    currentAmmonia = readAmmonia();

    // 2. Eksekusi FLC Mamdani 125 Rules
    currentFuzzy = runMamdani125(currentTemp, currentHumid, currentAmmonia);

    // 3. Kontrol Aktuator (Otomatis vs Override Manual)
    if (!manualOverride) {
      statePwmIntake  = currentFuzzy.pwm_intake;
      statePwmExhaust = currentFuzzy.pwm_exhaust;
      statePwmHeater  = currentFuzzy.pwm_pemanas;
      stateConveyor   = currentFuzzy.status_konveyor;
    }

    applyActuators(statePwmIntake, statePwmExhaust, statePwmHeater, stateConveyor);

    // 4. Kirim ke Supabase Cloud (Tabel Tunggal: 'telemetry')
    if (WiFi.status() == WL_CONNECTED) {
      sendTelemetryToSupabase();
    }
  }
}

// ══════════════════════════════════════════════════════════════
// WEB SERVER HANDLERS (LITTLEFS + REST API)
// ══════════════════════════════════════════════════════════════
void setupWebServer() {
  // REST API: Data telemetri real-time untuk web client
  server.on("/api/data", HTTP_GET, []() {
    StaticJsonDocument<512> doc;
    doc["suhu"]            = currentTemp;
    doc["kelembapan"]      = currentHumid;
    doc["amonia"]          = currentAmmonia;
    doc["pwm_intake"]      = statePwmIntake;
    doc["pwm_exhaust"]     = statePwmExhaust;
    doc["pwm_pemanas"]     = statePwmHeater;
    doc["status_konveyor"] = stateConveyor;
    doc["isManual"]        = manualOverride;
    doc["cond"]            = currentFuzzy.condition_label;
    doc["uptime"]          = millis() / 1000;

    String json;
    serializeJson(doc, json);
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
  });

  // REST API: Kontrol manual aktuator
  server.on("/api/actuator", HTTP_POST, []() {
    if (server.hasArg("plain")) {
      String body = server.arg("plain");
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, body);
      if (!err) {
        manualOverride = true;
        if (doc.containsKey("pwm_intake"))  statePwmIntake  = doc["pwm_intake"];
        if (doc.containsKey("pwm_exhaust")) statePwmExhaust = doc["pwm_exhaust"];
        if (doc.containsKey("pwm_pemanas")) statePwmHeater  = doc["pwm_pemanas"];
        if (doc.containsKey("status_konveyor")) stateConveyor = doc["status_konveyor"];

        applyActuators(statePwmIntake, statePwmExhaust, statePwmHeater, stateConveyor);
      }
    }
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // Sajikan berkas HTML, CSS, JS dari LittleFS
  server.on("/", HTTP_GET, []() {
    if (LittleFS.exists("/index.html")) {
      File f = LittleFS.open("/index.html", "r");
      server.streamFile(f, "text/html");
      f.close();
    } else {
      server.send(200, "text/plain", "SmartFarm ESP32: Silakan upload index.html ke LittleFS flash!");
    }
  });

  server.on("/style.css", HTTP_GET, []() {
    if (LittleFS.exists("/style.css")) {
      File f = LittleFS.open("/style.css", "r");
      server.streamFile(f, "text/css");
      f.close();
    }
  });

  server.on("/app.js", HTTP_GET, []() {
    if (LittleFS.exists("/app.js")) {
      File f = LittleFS.open("/app.js", "r");
      server.streamFile(f, "application/javascript");
      f.close();
    }
  });

  server.onNotFound([]() {
    server.send(404, "text/plain", "404: Halaman tidak ditemukan di ESP32");
  });
}

// ══════════════════════════════════════════════════════════════
// BACA MQ-135 (ADC GPIO 34)
// ══════════════════════════════════════════════════════════════
float readAmmonia() {
  int rawADC = analogRead(PIN_MQ135);
  float ppm = ((float)rawADC / 4095.0f) * 50.0f;
  if (ppm < 0.0f) ppm = 0.0f;
  if (ppm > 50.0f) ppm = 50.0f;
  return ppm;
}

// ══════════════════════════════════════════════════════════════
// FUNGSI KEANGGOTAAN FUZZY (TRIANGLE, TRAPEZOID, SHOULDER)
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
// MATRIKS 125 ATURAN MAMDANI (5 Suhu x 5 Kelembapan x 5 Amonia)
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

  float y_star = num / den;
  float pwmRaw = ((y_star - 8.3f) / (91.7f - 8.3f)) * 100.0f;
  int pwm = constrain((int)roundf(pwmRaw), 0, 100);

  return { y_star, pwm };
}

// ══════════════════════════════════════════════════════════════
// MESIN INFERENSI MAMDANI 125 RULE BASE
// ══════════════════════════════════════════════════════════════
FuzzyResult runMamdani125(float temp, float humid, float nh3) {
  float muT[5] = {
    calcLeftShoulder(temp, 14.0f, 18.0f),
    calcTri(temp, 14.0f, 18.0f, 20.0f),
    calcTrap(temp, 18.0f, 20.0f, 25.0f, 27.0f),
    calcTri(temp, 25.0f, 27.0f, 31.0f),
    calcRightShoulder(temp, 27.0f, 31.0f)
  };

  float muH[5] = {
    calcLeftShoulder(humid, 40.0f, 50.0f),
    calcTri(humid, 40.0f, 50.0f, 60.0f),
    calcTrap(humid, 50.0f, 60.0f, 80.0f, 85.0f),
    calcTri(humid, 80.0f, 85.0f, 92.0f),
    calcRightShoulder(humid, 85.0f, 92.0f)
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

  float betasIn[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  float betasEx[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  float betasHt[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};

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
// TELEMETRI KE TABEL TUNGGAL 'telemetry' SUPABASE (Tabel 3.5)
// ══════════════════════════════════════════════════════════════
void sendTelemetryToSupabase() {
  HTTPClient http;
  String endpoint = String(SUPABASE_URL) + "/rest/v1/telemetry";
  http.begin(endpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  StaticJsonDocument<384> doc;
  doc["suhu"]            = currentTemp;
  doc["kelembapan"]      = currentHumid;
  doc["amonia"]          = currentAmmonia;
  doc["pwm_intake"]      = statePwmIntake;
  doc["pwm_exhaust"]     = statePwmExhaust;
  doc["pwm_pemanas"]     = statePwmHeater;
  doc["status_konveyor"] = stateConveyor;

  String payload;
  serializeJson(doc, payload);
  int httpCode = http.POST(payload);
  Serial.printf("[HTTP POST] /rest/v1/telemetry -> %d\n", httpCode);
  http.end();
}
