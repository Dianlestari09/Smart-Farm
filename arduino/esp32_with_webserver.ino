/*
 * ══════════════════════════════════════════════════════════════════════════════
 * ESP32 + WEBSERVER LITTLEFS + FUZZY MAMDANI 27 RULES + SUPABASE TELEMETRY
 * Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur"
 * Mahasiswa: Dian Lestari Kurniawati (NIM: 230605110016)
 * ══════════════════════════════════════════════════════════════════════════════
 * 
 * Library yang dibutuhkan (Bawaan ESP32 Arduino Core & Library Manager):
 * - WiFi.h (Bawaan ESP32)
 * - WebServer.h (Bawaan ESP32)
 * - LittleFS.h (Bawaan ESP32)
 * - HTTPClient.h (Bawaan ESP32)
 * - ArduinoJson.h (Install via Arduino Library Manager)
 * - DHT.h (Install via Arduino Library Manager)
 * 
 * Cara Kerja:
 * 1. Menjalankan Web Server lokal di ESP32 yang menyajikan index.html, style.css, app.js
 * 2. Mode AP (Access Point) "SmartFarm-AP": Bisa diakses via http://192.168.4.1 (OFFLINE KANDANG)
 * 3. Mode STA (WiFi Internet): Tetap mengirim telemetri otomatis ke Supabase Cloud
 * 4. Endpoint REST API:
 *    - GET  /api/data     -> Mengembalikan data sensor & status aktuator terkini (JSON)
 *    - POST /api/actuator -> Menerima kontrol manual dari web browser
 * ══════════════════════════════════════════════════════════════════════════════
 */

#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ─── 1. KONFIGURASI WIFI & ACCESS POINT ───────────────────────
const char* WIFI_SSID       = "SSID_WIFI_KANDANG";
const char* WIFI_PASSWORD   = "PASSWORD_WIFI_KANDANG";

// Access Point lokal (Bisa dibuka di HP walau tanpa internet)
const char* AP_SSID         = "SmartFarm-Kandang";
const char* AP_PASS         = "12345678"; // minimal 8 karakter

// ─── 2. KONFIGURASI SUPABASE (CLOUD) ──────────────────────────
const char* SUPABASE_URL    = "https://jkgqmshsjngppsibwwyf.supabase.co";
const char* SUPABASE_KEY    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZ3Ftc2hzam5ncHBzaWJ3d3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNjQ5MzMsImV4cCI6MjEwNzc0MDkzM30.XzjuidtnuIyf2eldLsm0CHHB_AL7OOoVdRbEMuOD48g";
const char* DEVICE_ID       = "ESP32-01";

// ─── 3. PIN SENSOR & AKTUATOR ─────────────────────────────────
#define DHT_PIN             4      // GPIO Sensor DHT22 / SHT31
#define DHT_TYPE            DHT22
#define MQ137_PIN           34     // GPIO ADC MQ-137 (Amonia)

#define PIN_FAN_INTAKE      25     // Kipas Intake (Inflow)
#define PIN_FAN_EXHAUST     27     // Kipas Exhaust (Outflow)
#define PIN_HEATER          26     // Lampu Pemanas
#define PIN_CONVEYOR        14     // Motor Pembersih Kotoran

DHT dht(DHT_PIN, DHT_TYPE);
WebServer server(80);

// ─── 4. VARIABEL GLOBAL & INTERVAL ────────────────────────────
const unsigned long SEND_INTERVAL = 3000; // Baca sensor tiap 3 detik
unsigned long lastSendTime = 0;

float currentTemp    = 24.0f;
float currentHumid   = 68.0f;
float currentAmmonia = 12.0f;

bool manualOverride  = false;
bool stateFanIn      = false;
bool stateFanOut     = false;
bool stateHeater     = false;
bool stateConveyor   = false;

// ─── 5. STRUCT HASIL FUZZY MAMDANI ────────────────────────────
struct FuzzyOutput {
  float membership_temp[3];
  float membership_humid[3];
  float membership_ammonia[3];

  float fan_intake_pct;
  float fan_exhaust_pct;
  float heater_pct;
  float conveyor_pct;

  bool fan_intake_state;
  bool fan_exhaust_state;
  bool heater_state;
  bool conveyor_state;

  String condition_label;
};

FuzzyOutput currentFuzzy;

// Prototypes
float calcTri(float x, float a, float b, float c);
float calcTrap(float x, float a, float b, float c, float d);
FuzzyOutput runMamdaniFuzzy(float temp, float humid, float ammonia);
float readAmmonia();
void controlActuators(const FuzzyOutput& fuzzy);
void sendToSupabase();
void setupWebServer();

// ══════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=========================================");
  Serial.println("  SmartFarm Poultry Monitor (ESP32)");
  Serial.println("  Dian Lestari Kurniawati (230605110016)");
  Serial.println("=========================================");

  // 1. Inisialisasi Pin Relay Aktuator
  pinMode(PIN_FAN_INTAKE,  OUTPUT);
  pinMode(PIN_FAN_EXHAUST, OUTPUT);
  pinMode(PIN_HEATER,      OUTPUT);
  pinMode(PIN_CONVEYOR,    OUTPUT);

  digitalWrite(PIN_FAN_INTAKE,  LOW);
  digitalWrite(PIN_FAN_EXHAUST, LOW);
  digitalWrite(PIN_HEATER,      LOW);
  digitalWrite(PIN_CONVEYOR,    LOW);

  // 2. Inisialisasi Sensor
  dht.begin();

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

  // Connect ke WiFi Internet
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WIFI STA] Menghubungkan ke "); Serial.println(WIFI_SSID);

  // 5. Setup Web Server lokal
  setupWebServer();
  server.begin();
  Serial.println("[OK] Web Server Lokal Aktif di Port 80");
}

// ══════════════════════════════════════════════════════════════
// LOOP
// ══════════════════════════════════════════════════════════════
void loop() {
  // Tangani request HTTP dari browser pengunjung
  server.handleClient();

  // Interval pembacaan sensor dan komputasi FLC
  if (millis() - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = millis();

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    float a = readAmmonia();

    if (!isnan(t) && !isnan(h)) {
      currentTemp    = t;
      currentHumid   = h;
      currentAmmonia = a;
    }

    // Jalankan FLC Mamdani
    currentFuzzy = runMamdaniFuzzy(currentTemp, currentHumid, currentAmmonia);

    // Kontrol relay aktuator (jika tidak dalam override manual)
    if (!manualOverride) {
      stateFanIn    = currentFuzzy.fan_intake_state;
      stateFanOut   = currentFuzzy.fan_exhaust_state;
      stateHeater   = currentFuzzy.heater_state;
      stateConveyor = currentFuzzy.conveyor_state;
    }

    digitalWrite(PIN_FAN_INTAKE,  stateFanIn    ? HIGH : LOW);
    digitalWrite(PIN_FAN_EXHAUST, stateFanOut   ? HIGH : LOW);
    digitalWrite(PIN_HEATER,      stateHeater   ? HIGH : LOW);
    digitalWrite(PIN_CONVEYOR,    stateConveyor ? HIGH : LOW);

    // Kirim telemetri ke Supabase jika terhubung WiFi
    if (WiFi.status() == WL_CONNECTED) {
      sendToSupabase();
    }
  }
}

// ══════════════════════════════════════════════════════════════
// WEB SERVER HANDLERS (LITTLEFS + REST API)
// ══════════════════════════════════════════════════════════════
void setupWebServer() {
  // REST API: Kirim data sensor & status terkini ke Web Browser
  server.on("/api/data", HTTP_GET, []() {
    StaticJsonDocument<512> doc;
    doc["temp"]       = currentTemp;
    doc["humid"]      = currentHumid;
    doc["ammonia"]    = currentAmmonia;
    doc["fanIn"]      = stateFanIn;
    doc["fanOut"]     = stateFanOut;
    doc["heater"]     = stateHeater;
    doc["conveyor"]   = stateConveyor;
    doc["isManual"]   = manualOverride;
    doc["cond"]       = currentFuzzy.condition_label;
    doc["uptime"]     = millis() / 1000;

    String json;
    serializeJson(doc, json);
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
  });

  // REST API: Terima perintah kontrol manual aktuator dari Web Browser
  server.on("/api/actuator", HTTP_POST, []() {
    if (server.hasArg("plain")) {
      String body = server.arg("plain");
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, body);
      if (!err) {
        manualOverride = true;
        if (doc.containsKey("fanIntake"))  stateFanIn    = doc["fanIntake"];
        if (doc.containsKey("fanExhaust")) stateFanOut   = doc["fanExhaust"];
        if (doc.containsKey("heater"))     stateHeater   = doc["heater"];
        if (doc.containsKey("conveyor"))   stateConveyor = doc["conveyor"];

        digitalWrite(PIN_FAN_INTAKE,  stateFanIn    ? HIGH : LOW);
        digitalWrite(PIN_FAN_EXHAUST, stateFanOut   ? HIGH : LOW);
        digitalWrite(PIN_HEATER,      stateHeater   ? HIGH : LOW);
        digitalWrite(PIN_CONVEYOR,    stateConveyor ? HIGH : LOW);
      }
    }
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", "{\"status\":\"ok\"}");
  });

  // Melayani file statis dari LittleFS flash memory
  server.on("/", HTTP_GET, []() {
    if (LittleFS.exists("/index.html")) {
      File f = LittleFS.open("/index.html", "r");
      server.streamFile(f, "text/html");
      f.close();
    } else {
      server.send(200, "text/plain", "SmartFarm ESP32: Silakan upload file web ke LittleFS!");
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
// BACA MQ-137 (AMONIA)
// ══════════════════════════════════════════════════════════════
float readAmmonia() {
  int rawADC = analogRead(MQ137_PIN);
  float ppm = (rawADC / 4095.0f) * 50.0f; // Kalibrasi 0 - 50 ppm
  return ppm;
}

// ══════════════════════════════════════════════════════════════
// FUNGSI KEANGGOTAAN FUZZY (MAMDANI)
// ══════════════════════════════════════════════════════════════
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

FuzzyOutput runMamdaniFuzzy(float temp, float humid, float ammonia) {
  FuzzyOutput res;

  // 1. Fuzzifikasi
  float tD = calcTrap(temp, 0, 0, 18, 23);
  float tN = calcTri(temp, 18, 23, 28);
  float tP = calcTrap(temp, 23, 28, 100, 100);

  float hK = calcTrap(humid, 0, 0, 50, 70);
  float hN = calcTri(humid, 50, 70, 85);
  float hB = calcTrap(humid, 70, 85, 100, 100);

  float nA = calcTrap(ammonia, 0, 0, 10, 18);
  float nW = calcTri(ammonia, 10, 18, 25);
  float nB = calcTrap(ammonia, 18, 25, 100, 100);

  res.membership_temp[0] = tD; res.membership_temp[1] = tN; res.membership_temp[2] = tP;
  res.membership_humid[0] = hK; res.membership_humid[1] = hN; res.membership_humid[2] = hB;
  res.membership_ammonia[0] = nA; res.membership_ammonia[1] = nW; res.membership_ammonia[2] = nB;

  // 2. 27 Rule Base (Suhu, Humid, Ammonia)
  struct RuleDef {
    float alpha;
    bool fin; bool fout; bool htr; bool cnv;
  };

  RuleDef rules[27] = {
    // Dingin
    { min(tD, min(hK, nA)), false, false, true,  false },
    { min(tD, min(hK, nW)), true,  true,  true,  false },
    { min(tD, min(hK, nB)), true,  true,  true,  true  },
    { min(tD, min(hN, nA)), false, false, true,  false },
    { min(tD, min(hN, nW)), true,  true,  true,  false },
    { min(tD, min(hN, nB)), true,  true,  true,  true  },
    { min(tD, min(hB, nA)), true,  true,  true,  false },
    { min(tD, min(hB, nW)), true,  true,  true,  false },
    { min(tD, min(hB, nB)), true,  true,  true,  true  },

    // Normal
    { min(tN, min(hK, nA)), false, false, false, false },
    { min(tN, min(hK, nW)), true,  true,  false, false },
    { min(tN, min(hK, nB)), true,  true,  false, true  },
    { min(tN, min(hN, nA)), false, false, false, false },
    { min(tN, min(hN, nW)), true,  true,  false, false },
    { min(tN, min(hN, nB)), true,  true,  false, true  },
    { min(tN, min(hB, nA)), true,  true,  false, false },
    { min(tN, min(hB, nW)), true,  true,  false, false },
    { min(tN, min(hB, nB)), true,  true,  false, true  },

    // Panas
    { min(tP, min(hK, nA)), true,  true,  false, false },
    { min(tP, min(hK, nW)), true,  true,  false, false },
    { min(tP, min(hK, nB)), true,  true,  false, true  },
    { min(tP, min(hN, nA)), true,  true,  false, false },
    { min(tP, min(hN, nW)), true,  true,  false, false },
    { min(tP, min(hN, nB)), true,  true,  false, true  },
    { min(tP, min(hB, nA)), true,  true,  false, false },
    { min(tP, min(hB, nW)), true,  true,  false, false },
    { min(tP, min(hB, nB)), true,  true,  false, true  }
  };

  float sumAlpha = 0;
  float sumFin = 0, sumFout = 0, sumHtr = 0, sumCnv = 0;

  for (int i = 0; i < 27; i++) {
    if (rules[i].alpha > 0.001f) {
      sumAlpha += rules[i].alpha;
      if (rules[i].fin)  sumFin  += rules[i].alpha;
      if (rules[i].fout) sumFout += rules[i].alpha;
      if (rules[i].htr)  sumHtr  += rules[i].alpha;
      if (rules[i].cnv)  sumCnv  += rules[i].alpha;
    }
  }

  if (sumAlpha <= 0.001f) sumAlpha = 1.0f;

  res.fan_intake_pct  = (sumFin  / sumAlpha) * 100.0f;
  res.fan_exhaust_pct = (sumFout / sumAlpha) * 100.0f;
  res.heater_pct      = (sumHtr  / sumAlpha) * 100.0f;
  res.conveyor_pct    = (sumCnv  / sumAlpha) * 100.0f;

  res.fan_intake_state  = res.fan_intake_pct  > 50.0f;
  res.fan_exhaust_state = res.fan_exhaust_pct > 50.0f;
  res.heater_state      = res.heater_pct      > 50.0f;
  res.conveyor_state    = res.conveyor_pct    > 50.0f;

  if (nB > 0.4f || tP > 0.6f) {
    res.condition_label = "Kondisi Bahaya";
  } else if (nW > 0.4f || tP > 0.2f || hB > 0.5f) {
    res.condition_label = "Kondisi Waspada";
  } else {
    res.condition_label = "Kondisi Normal";
  }

  return res;
}

// ══════════════════════════════════════════════════════════════
// KIRIM KE SUPABASE CLOUD VIA REST API
// ══════════════════════════════════════════════════════════════
void sendToSupabase() {
  if (String(SUPABASE_URL).indexOf("XXXX") >= 0) return; // Skip bila masih placeholder

  HTTPClient http;
  String endpoint = String(SUPABASE_URL) + "/rest/v1/sensor_readings";
  http.begin(endpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);

  StaticJsonDocument<256> doc;
  doc["device_id"]   = DEVICE_ID;
  doc["temperature"] = currentTemp;
  doc["humidity"]    = currentHumid;
  doc["ammonia"]     = currentAmmonia;

  String payload;
  serializeJson(doc, payload);
  int httpCode = http.POST(payload);
  http.end();
}
