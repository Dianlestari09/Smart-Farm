/*
 * ESP32 Arduino Code — SmartFarm Poultry Monitor
 * Implementasi Fuzzy Logic Controller (FLC) Metode Mamdani (27 Rule Base)
 * Sesuai dengan Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur"
 * Oleh: Dian Lestari Kurniawati (NIM: 230605110016)
 *
 * Library yang dibutuhkan:
 * - WiFi (built-in ESP32)
 * - HTTPClient (built-in ESP32)
 * - ArduinoJson (install via Library Manager)
 * - DHT sensor library (install via Library Manager)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ─── WiFi Config ─────────────────────────────────
const char* WIFI_SSID     = "SSID_WIFI_ANDA";
const char* WIFI_PASSWORD = "PASSWORD_WIFI_ANDA";

// ─── Supabase Config ──────────────────────────────
const char* SUPABASE_URL  = "https://XXXXXXXXXXXX.supabase.co";
const char* SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."; // anon key
const char* DEVICE_ID     = "ESP32-01";

// ─── Sensor Config ───────────────────────────────
#define DHT_PIN    4      // GPIO pin SHT31 / DHT22
#define DHT_TYPE   DHT22  
#define MQ137_PIN  34     // GPIO ADC untuk sensor amonia MQ137

DHT dht(DHT_PIN, DHT_TYPE);

// ─── Aktuator Pin (Relay Active LOW/HIGH) ────────
#define PIN_FAN_INTAKE  25 // Kipas Intake
#define PIN_FAN_EXHAUST 27 // Kipas Exhaust
#define PIN_HEATER      26 // Lampu Pemanas
#define PIN_CONVEYOR    14 // Motor Konveyor Pembersih Kotoran

// ─── Interval pengiriman data (ms) ───────────────
const unsigned long SEND_INTERVAL = 5000; // 5 detik
unsigned long lastSendTime = 0;

// ─── Struct Data Rule & Output Fuzzy ────────────
struct ActiveRule {
  int rule_id;
  String antecedent;
  String consequent;
  float firing_strength; // alpha (μ)
};

struct FuzzyOutput {
  float membership_temp[3];   // Dingin, Normal, Panas
  float membership_humid[3];  // Kering, Normal, Basah
  float membership_ammonia[3];// Aman, Waspada, Bahaya
  
  ActiveRule active_rules[27];
  int active_rule_count;

  // Crisp output (0 - 100%)
  float fan_intake_pct;
  float fan_exhaust_pct;
  float heater_pct;
  float conveyor_pct;

  // Digital relay state (HIGH / LOW)
  bool fan_intake_state;
  bool fan_exhaust_state;
  bool heater_state;
  bool conveyor_state;

  String condition_label;
};

// Function prototypes
float calcTri(float x, float a, float b, float c);
float calcTrap(float x, float a, float b, float c, float d);
FuzzyOutput runMamdaniFuzzy(float temp, float humid, float ammonia);
float readAmmonia();
void controlActuators(const FuzzyOutput& fuzzy);
void sendSensorData(float temp, float humid, float ammonia);
void sendActuatorStatus(const FuzzyOutput& fuzzy);
void sendFuzzyResult(float temp, float humid, float ammonia, const FuzzyOutput& fuzzy);
void connectWiFi();

// ═══════════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  // Init pins aktuator
  pinMode(PIN_FAN_INTAKE,  OUTPUT);
  pinMode(PIN_FAN_EXHAUST, OUTPUT);
  pinMode(PIN_HEATER,      OUTPUT);
  pinMode(PIN_CONVEYOR,    OUTPUT);

  digitalWrite(PIN_FAN_INTAKE,  LOW);
  digitalWrite(PIN_FAN_EXHAUST, LOW);
  digitalWrite(PIN_HEATER,      LOW);
  digitalWrite(PIN_CONVEYOR,    LOW);

  // Init sensor
  dht.begin();

  // Connect WiFi
  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (millis() - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = millis();

    // Baca sensor
    float temperature = dht.readTemperature();
    float humidity    = dht.readHumidity();
    float ammonia     = readAmmonia();

    if (isnan(temperature) || isnan(humidity)) {
      Serial.println("[ERROR] Gagal membaca sensor!");
      return;
    }

    Serial.printf("\n[SENSOR REALTIME] Suhu=%.1f°C | Kelembapan=%.1f%% | Amonia=%.1f ppm\n",
                  temperature, humidity, ammonia);

    // 1. Jalankan FLC Mamdani (27 Rule Base Skripsi)
    FuzzyOutput fuzzyOut = runMamdaniFuzzy(temperature, humidity, ammonia);

    // 2. Kontrol aktuator fisik
    controlActuators(fuzzyOut);

    // 3. Kirim telemetry ke Supabase
    sendSensorData(temperature, humidity, ammonia);
    sendFuzzyResult(temperature, humidity, ammonia, fuzzyOut);
    sendActuatorStatus(fuzzyOut);
  }
}

// ═══════════════════════════════════════════════
// FUNGSI KEANGGOTAAN FUZZY (TRIANGULAR & TRAPEZOIDAL)
// ═══════════════════════════════════════════════
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

// ═══════════════════════════════════════════════
// BACA SENSOR AMONIA (MQ-137)
// ═══════════════════════════════════════════════
float readAmmonia() {
  int rawADC = analogRead(MQ137_PIN);
  float voltage = rawADC * (3.3f / 4095.0f);
  // Konversi ADC ke PPM Amonia (0 - 50 ppm)
  float ppm = (rawADC / 4095.0f) * 50.0f; 
  return ppm;
}

// ═══════════════════════════════════════════════
// LOGIKA FUZZY MAMDANI 27 RULE BASE SKRIPSI DIAN
// ═══════════════════════════════════════════════
FuzzyOutput runMamdaniFuzzy(float temp, float humid, float ammonia) {
  FuzzyOutput res;

  // 1. FUZZIFIKASI
  // Suhu: Dingin (<=18..23), Normal (18..23..28), Panas (23..28=>)
  res.membership_temp[0] = calcTrap(temp, 0, 0, 18, 23);     // Dingin
  res.membership_temp[1] = calcTri(temp, 18, 23, 28);        // Normal
  res.membership_temp[2] = calcTrap(temp, 23, 28, 100, 100);  // Panas

  // Kelembapan: Kering (<=50..70), Normal (50..70..85), Basah (70..85=>)
  res.membership_humid[0] = calcTrap(humid, 0, 0, 50, 70);    // Kering
  res.membership_humid[1] = calcTri(humid, 50, 70, 85);       // Normal
  res.membership_humid[2] = calcTrap(humid, 70, 85, 100, 100); // Basah

  // Amonia: Aman (<=10..18), Waspada (10..18..25), Bahaya (18..25=>)
  res.membership_ammonia[0] = calcTrap(ammonia, 0, 0, 10, 18);   // Aman
  res.membership_ammonia[1] = calcTri(ammonia, 10, 18, 25);      // Waspada
  res.membership_ammonia[2] = calcTrap(ammonia, 18, 25, 100, 100);// Bahaya

  // 2. INFERENSI 27 RULE BASE
  // Format Rule [ID, SuhuIdx, HumidIdx, AmoniaIdx, FanIn, FanOut, Heater, Conveyor]
  // SuhuIdx: 0=Dingin, 1=Normal, 2=Panas
  // HumidIdx: 0=Kering, 1=Normal, 2=Basah
  // AmoniaIdx: 0=Aman, 1=Waspada, 2=Bahaya
  struct RuleDef {
    int id;
    int tIdx; int hIdx; int aIdx;
    bool fanIn; bool fanOut; bool heater; bool conveyor;
    const char* tName; const char* hName; const char* aName;
  };

  RuleDef rules[27] = {
    // Dingin (t=0)
    { 1, 0,0,0, false,false,true, false, "Dingin","Kering","Aman" },
    { 2, 0,0,1, true, true, true, false, "Dingin","Kering","Waspada" },
    { 3, 0,0,2, true, true, true, true,  "Dingin","Kering","Bahaya" },
    { 4, 0,1,0, false,false,true, false, "Dingin","Normal","Aman" },
    { 5, 0,1,1, true, true, true, false, "Dingin","Normal","Waspada" },
    { 6, 0,1,2, true, true, true, true,  "Dingin","Normal","Bahaya" },
    { 7, 0,2,0, true, true, true, false, "Dingin","Basah","Aman" },
    { 8, 0,2,1, true, true, true, false, "Dingin","Basah","Waspada" },
    { 9, 0,2,2, true, true, true, true,  "Dingin","Basah","Bahaya" },

    // Normal (t=1)
    { 10, 1,0,0, false,false,false,false, "Normal","Kering","Aman" },
    { 11, 1,0,1, true, true, false,false, "Normal","Kering","Waspada" },
    { 12, 1,0,2, true, true, false,true,  "Normal","Kering","Bahaya" },
    { 13, 1,1,0, false,false,false,false, "Normal","Normal","Aman" },
    { 14, 1,1,1, true, true, false,false, "Normal","Normal","Waspada" },
    { 15, 1,1,2, true, true, false,true,  "Normal","Normal","Bahaya" },
    { 16, 1,2,0, true, true, false,false, "Normal","Basah","Aman" },
    { 17, 1,2,1, true, true, false,false, "Normal","Basah","Waspada" },
    { 18, 1,2,2, true, true, false,true,  "Normal","Basah","Bahaya" },

    // Panas (t=2)
    { 19, 2,0,0, true, true, false,false, "Panas","Kering","Aman" },
    { 20, 2,0,1, true, true, false,false, "Panas","Kering","Waspada" },
    { 21, 2,0,2, true, true, false,true,  "Panas","Kering","Bahaya" },
    { 22, 2,1,0, true, true, false,false, "Panas","Normal","Aman" },
    { 23, 2,1,1, true, true, false,false, "Panas","Normal","Waspada" },
    { 24, 2,1,2, true, true, false,true,  "Panas","Normal","Bahaya" },
    { 25, 2,2,0, true, true, false,false, "Panas","Basah","Aman" },
    { 26, 2,2,1, true, true, false,false, "Panas","Basah","Waspada" },
    { 27, 2,2,2, true, true, false,true,  "Panas","Basah","Bahaya" }
  };

  res.active_rule_count = 0;
  float sumAlpha = 0.0f;
  float numFanIn = 0.0f, numFanOut = 0.0f, numHeater = 0.0f, numConveyor = 0.0f;

  for (int i = 0; i < 27; i++) {
    float muT = res.membership_temp[rules[i].tIdx];
    float muH = res.membership_humid[rules[i].hIdx];
    float muA = res.membership_ammonia[rules[i].aIdx];

    // Implikasi MIN
    float alpha = min(muT, min(muH, muA));

    if (alpha > 0.001f) {
      if (res.active_rule_count < 27) {
        ActiveRule& ar = res.active_rules[res.active_rule_count++];
        ar.rule_id = rules[i].id;
        ar.antecedent = String("IF Suhu=") + rules[i].tName + " AND Kelembapan=" + rules[i].hName + " AND Amonia=" + rules[i].aName;
        ar.consequent = String("THEN FanIn=") + (rules[i].fanIn ? "ON" : "OFF") +
                        ", FanOut=" + (rules[i].fanOut ? "ON" : "OFF") +
                        ", Heater="  + (rules[i].heater ? "ON" : "OFF") +
                        ", Conveyor="+ (rules[i].conveyor ? "ON" : "OFF");
        ar.firing_strength = alpha;
      }

      sumAlpha += alpha;
      if (rules[i].fanIn)    numFanIn   += alpha;
      if (rules[i].fanOut)   numFanOut  += alpha;
      if (rules[i].heater)   numHeater  += alpha;
      if (rules[i].conveyor) numConveyor+= alpha;
    }
  }

  // 3. DEFUZZIFIKASI (Centroid / Center of Area)
  float denom = (sumAlpha > 0.0001f) ? sumAlpha : 1.0f;
  res.fan_intake_pct  = (numFanIn / denom) * 100.0f;
  res.fan_exhaust_pct = (numFanOut / denom) * 100.0f;
  res.heater_pct     = (numHeater / denom) * 100.0f;
  res.conveyor_pct   = (numConveyor / denom) * 100.0f;

  // 4. DIGITAL RELAY STATE DECISION (Crisp >= 50%)
  res.fan_intake_state  = (res.fan_intake_pct >= 50.0f);
  res.fan_exhaust_state = (res.fan_exhaust_pct >= 50.0f);
  res.heater_state      = (res.heater_pct >= 50.0f);
  res.conveyor_state    = (res.conveyor_pct >= 50.0f);

  // Label kondisi akhir
  if (res.membership_ammonia[2] > 0.4f || res.membership_temp[2] > 0.6f) {
    res.condition_label = "Kondisi Bahaya";
  } else if (res.membership_ammonia[1] > 0.4f || res.membership_temp[2] > 0.2f || res.membership_humid[2] > 0.5f) {
    res.condition_label = "Kondisi Waspada";
  } else {
    res.condition_label = "Kondisi Normal";
  }

  return res;
}

// ═══════════════════════════════════════════════
// EKSEKUSI AKTUATOR FISIK (RELAY)
// ═══════════════════════════════════════════════
void controlActuators(const FuzzyOutput& fuzzy) {
  digitalWrite(PIN_FAN_INTAKE,  fuzzy.fan_intake_state  ? HIGH : LOW);
  digitalWrite(PIN_FAN_EXHAUST, fuzzy.fan_exhaust_state ? HIGH : LOW);
  digitalWrite(PIN_HEATER,      fuzzy.heater_state      ? HIGH : LOW);
  digitalWrite(PIN_CONVEYOR,    fuzzy.conveyor_state    ? HIGH : LOW);

  Serial.printf("[FLC DECISION] Status Kandang: %s\n", fuzzy.condition_label.c_str());
  Serial.printf(" → Fan Intake  : %s (%.1f%%)\n", fuzzy.fan_intake_state  ? "ON " : "OFF", fuzzy.fan_intake_pct);
  Serial.printf(" → Fan Exhaust : %s (%.1f%%)\n", fuzzy.fan_exhaust_state ? "ON " : "OFF", fuzzy.fan_exhaust_pct);
  Serial.printf(" → Lampu Pemanas: %s (%.1f%%)\n", fuzzy.heater_state     ? "ON " : "OFF", fuzzy.heater_pct);
  Serial.printf(" → Motor Konveyor: %s (%.1f%%)\n", fuzzy.conveyor_state   ? "ON " : "OFF", fuzzy.conveyor_pct);
}

// ═══════════════════════════════════════════════
// TELEMETRY HTTP POST TO SUPABASE
// ═══════════════════════════════════════════════
void sendSensorData(float temp, float humid, float ammonia) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/sensor_readings";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  StaticJsonDocument<256> doc;
  doc["temperature"] = temp;
  doc["humidity"]    = humid;
  doc["ammonia"]     = ammonia;
  doc["device_id"]   = DEVICE_ID;

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  Serial.printf("[HTTP] sensor_readings → %d\n", code);
  http.end();
}

void sendActuatorStatus(const FuzzyOutput& fuzzy) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/actuator_status?device_id=eq." + DEVICE_ID;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  StaticJsonDocument<256> doc;
  doc["fan_intake"]  = fuzzy.fan_intake_state;
  doc["fan_exhaust"] = fuzzy.fan_exhaust_state;
  doc["heater"]      = fuzzy.heater_state;
  doc["conveyor"]    = fuzzy.conveyor_state;
  doc["updated_at"]  = "now()";

  String body;
  serializeJson(doc, body);
  int code = http.PATCH(body);
  Serial.printf("[HTTP] actuator_status → %d\n", code);
  http.end();
}

void sendFuzzyResult(float temp, float humid, float ammonia, const FuzzyOutput& fuzzy) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/fuzzy_results";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(2048);
  doc["input_temp"]          = temp;
  doc["input_humidity"]      = humid;
  doc["input_ammonia"]       = ammonia;
  doc["output_fan_intake"]   = fuzzy.fan_intake_pct;
  doc["output_fan_exhaust"]  = fuzzy.fan_exhaust_pct;
  doc["output_heater"]       = fuzzy.heater_pct;
  doc["output_conveyor"]     = fuzzy.conveyor_pct;
  doc["condition_label"]     = fuzzy.condition_label;
  doc["device_id"]           = DEVICE_ID;

  JsonArray rules = doc.createNestedArray("active_rules");
  for (int i = 0; i < fuzzy.active_rule_count; i++) {
    JsonObject r = rules.createNestedObject();
    r["rule_id"]          = fuzzy.active_rules[i].rule_id;
    r["antecedent"]       = fuzzy.active_rules[i].antecedent;
    r["consequent"]       = fuzzy.active_rules[i].consequent;
    r["firing_strength"]  = fuzzy.active_rules[i].firing_strength;
  }

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  Serial.printf("[HTTP] fuzzy_results → %d\n", code);
  http.end();
}

void connectWiFi() {
  Serial.printf("\n[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Gagal connect, retrying...");
  }
}
