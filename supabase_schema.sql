-- ═══════════════════════════════════════════════════════════
-- SmartFarm Poultry — Supabase Database Schema
-- Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat
--           Kandang Ayam Petelur Berbasis Fuzzy Logic Controller"
-- Oleh: Dian Lestari Kurniawati (230605110016)
-- Hardware: ESP32 + SHT31 + MQ-137
--
-- Jalankan di: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────
-- 1. TABEL SENSOR READINGS
--    Data dari ESP32 via sensor SHT31 (suhu+kelembapan)
--    dan MQ-137 (gas amonia NH3)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sensor_readings (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz DEFAULT now() NOT NULL,
  temperature   float4 NOT NULL,   -- Suhu udara (°C) — sensor SHT31
  humidity      float4 NOT NULL,   -- Kelembapan relatif (%) — sensor SHT31
  ammonia       float4 NOT NULL,   -- Konsentrasi gas NH3 (ppm) — sensor MQ-137
  device_id     text DEFAULT 'ESP32-01'
);

-- Index untuk query historis
CREATE INDEX IF NOT EXISTS idx_sensor_created_at ON sensor_readings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_device     ON sensor_readings(device_id, created_at DESC);


-- ─────────────────────────────────────────────────────────
-- 2. TABEL ACTUATOR STATUS
--    4 aktuator sesuai skripsi:
--    - fan_intake : Kipas Intake (masukkan udara segar)
--    - fan_exhaust: Kipas Exhaust (buang udara panas/beracun)
--    - heater     : Lampu Pemanas (tambah kalor saat suhu dingin)
--    - conveyor   : Motor Konveyor (pembersih kotoran otomatis)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actuator_status (
  id            bigserial PRIMARY KEY,
  updated_at    timestamptz DEFAULT now() NOT NULL,
  fan_intake    boolean DEFAULT false,   -- Kipas Intake ON/OFF
  fan_exhaust   boolean DEFAULT false,   -- Kipas Exhaust ON/OFF
  heater        boolean DEFAULT false,   -- Lampu Pemanas ON/OFF
  conveyor      boolean DEFAULT false,   -- Motor Konveyor ON/OFF
  device_id     text DEFAULT 'ESP32-01'
);

-- Insert default row (satu baris per device)
INSERT INTO actuator_status (fan_intake, fan_exhaust, heater, conveyor, device_id)
VALUES (false, false, false, false, 'ESP32-01')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────
-- 3. TABEL HASIL FUZZY LOGIC MAMDANI
--    Menyimpan seluruh proses: fuzzifikasi → inferensi → defuzzifikasi
--    Metode: FLC Mamdani (MIN-implikasi, MAX-agregasi, Centroid)
--    27 rule base (3 input × 3 himpunan = 3³)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuzzy_results (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz DEFAULT now() NOT NULL,

  -- Input crisp dari sensor
  input_temp          float4 NOT NULL,   -- Suhu (°C)
  input_humidity      float4 NOT NULL,   -- Kelembapan (%)
  input_ammonia       float4 NOT NULL,   -- Gas NH3 (ppm)

  -- Derajat keanggotaan (Fuzzifikasi)
  -- Variabel Suhu: Dingin | Normal | Panas
  -- Variabel Kelembapan: Kering | Normal | Basah
  -- Variabel Amonia: Aman | Waspada | Bahaya
  membership_degrees  jsonb DEFAULT '{}'::jsonb,
  -- Contoh:
  -- {
  --   "temperature": {"Dingin": 0.0, "Normal": 0.72, "Panas": 0.28},
  --   "humidity":    {"Kering": 0.0, "Normal": 0.85, "Basah": 0.15},
  --   "ammonia":     {"Aman": 0.60, "Waspada": 0.40, "Bahaya": 0.0}
  -- }

  -- Rule yang aktif setelah inferensi MIN
  active_rules        jsonb DEFAULT '[]'::jsonb,
  -- Contoh format setiap rule:
  -- [{"rule_id":3, "antecedent":"IF Suhu=Panas AND ...", "consequent":"THEN Fan_In=ON ...", "firing_strength":0.28}]

  -- Output crisp hasil defuzzifikasi Centroid (0–100)
  output_fan_intake   float4 DEFAULT 0,   -- Crisp output kipas intake
  output_fan_exhaust  float4 DEFAULT 0,   -- Crisp output kipas exhaust
  output_heater       float4 DEFAULT 0,   -- Crisp output lampu pemanas
  output_conveyor     float4 DEFAULT 0,   -- Crisp output konveyor

  -- Label kondisi lingkungan akhir
  condition_label     text DEFAULT 'Kondisi Normal',
  -- Nilai: "Kondisi Normal" | "Kondisi Waspada" | "Kondisi Bahaya"

  device_id           text DEFAULT 'ESP32-01'
);

CREATE INDEX IF NOT EXISTS idx_fuzzy_created_at ON fuzzy_results(created_at DESC);


-- ─────────────────────────────────────────────────────────
-- AKTIFKAN REALTIME (WebSocket untuk dashboard)
-- ─────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE sensor_readings;
ALTER PUBLICATION supabase_realtime ADD TABLE actuator_status;
ALTER PUBLICATION supabase_realtime ADD TABLE fuzzy_results;


-- ─────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────
ALTER TABLE sensor_readings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE actuator_status  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuzzy_results    ENABLE ROW LEVEL SECURITY;

-- Dashboard (anon) bisa baca semua
CREATE POLICY "Public read sensor_readings"  ON sensor_readings  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read actuator_status"  ON actuator_status  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read fuzzy_results"    ON fuzzy_results    FOR SELECT TO anon USING (true);

-- ESP32 bisa insert/update (gunakan anon key di ESP32)
CREATE POLICY "ESP insert sensor_readings"   ON sensor_readings  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "ESP insert fuzzy_results"     ON fuzzy_results    FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "ESP update actuator_status"   ON actuator_status  FOR UPDATE TO anon USING (true);


-- ─────────────────────────────────────────────────────────
-- DATA TEST — Contoh insert dari ESP32
-- ─────────────────────────────────────────────────────────

-- Test sensor reading
INSERT INTO sensor_readings (temperature, humidity, ammonia, device_id)
VALUES (27.3, 72.5, 18.2, 'ESP32-01');

-- Test status aktuator (suhu agak panas, amonia mendekati batas)
UPDATE actuator_status
SET fan_intake = true, fan_exhaust = true, heater = false, conveyor = false,
    updated_at = now()
WHERE device_id = 'ESP32-01';

-- Test fuzzy result dengan derajat keanggotaan lengkap
INSERT INTO fuzzy_results (
  input_temp, input_humidity, input_ammonia,
  membership_degrees,
  active_rules,
  output_fan_intake, output_fan_exhaust, output_heater, output_conveyor,
  condition_label, device_id
) VALUES (
  27.3, 72.5, 18.2,
  '{
    "temperature": {"Dingin": 0.0, "Normal": 0.54, "Panas": 0.46},
    "humidity":    {"Kering": 0.0, "Normal": 0.90, "Basah": 0.10},
    "ammonia":     {"Aman": 0.23, "Waspada": 0.77, "Bahaya": 0.0}
  }',
  '[
    {"rule_id": 2, "antecedent": "IF Suhu=Panas AND Kelembapan=Normal AND Amonia=Waspada", "consequent": "THEN Fan_In=ON, Fan_Out=ON, Heater=OFF, Conveyor=OFF", "firing_strength": 0.46},
    {"rule_id": 6, "antecedent": "IF Suhu=Normal AND Kelembapan=Normal AND Amonia=Waspada", "consequent": "THEN Fan_In=ON, Fan_Out=OFF, Heater=OFF, Conveyor=OFF", "firing_strength": 0.54}
  ]',
  75.0, 60.0, 0.0, 0.0,
  'Kondisi Waspada', 'ESP32-01'
);
