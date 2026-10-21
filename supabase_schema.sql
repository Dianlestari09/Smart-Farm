-- ═══════════════════════════════════════════════════════════════
-- SmartFarm Poultry — Supabase Database Schema (Tabel Tunggal: 'telemetry')
-- Skripsi: "Rancang Bangun Sistem Otomatisasi Mikroklimat
--           Kandang Ayam Petelur Berbasis Fuzzy Logic Controller"
-- Peneliti: Dian Lestari Kurniawati (NIM: 230605110016)
-- Sesuai Tabel 3.5 Proposal Skripsi
-- 
-- Jalankan skrip ini di: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════

-- Hapus tabel lama jika ingin reset struktur database
-- DROP TABLE IF EXISTS telemetry CASCADE;

-- ─────────────────────────────────────────────────────────
-- TABEL TUNGGAL TELEMETRI (Tabel 3.5 Proposal Skripsi)
-- Menyimpan telemetri sensor mikroklimat dan kontrol aktuator
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  suhu            REAL NOT NULL,        -- Suhu udara (°C)
  kelembapan      REAL NOT NULL,        -- Kelembapan relatif (%RH)
  amonia          REAL NOT NULL,        -- Konsentrasi gas amonia NH3 (ppm)
  pwm_intake      INT2 NOT NULL,        -- PWM Kipas Intake (0 - 100)
  pwm_exhaust     INT2 NOT NULL,        -- PWM Kipas Exhaust (0 - 100)
  pwm_pemanas     INT2 NOT NULL,        -- PWM Lampu Pemanas (0 - 100)
  status_konveyor BOOLEAN NOT NULL      -- Status Motor Konveyor (true=ON / false=OFF)
);

-- Index performa query riwayat dan grafik
CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry(created_at DESC);

-- ─────────────────────────────────────────────────────────
-- AKTIFKAN SUPABASE REALTIME (Aman dijalankan berulang kali)
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'telemetry'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.telemetry;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────────────────────
ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;

-- Izinkan pembacaan publik anon (Dashboard WebApps & Vercel)
DROP POLICY IF EXISTS "Public read telemetry" ON telemetry;
CREATE POLICY "Public read telemetry"
  ON telemetry FOR SELECT
  TO anon
  USING (true);

-- Izinkan penulisan telemetri anon (ESP32 via HTTP POST REST API)
DROP POLICY IF EXISTS "Public insert telemetry" ON telemetry;
CREATE POLICY "Public insert telemetry"
  ON telemetry FOR INSERT
  TO anon
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────
-- DATA AWAL PENGUJIAN (TEST ROW)
-- ─────────────────────────────────────────────────────────
INSERT INTO telemetry (suhu, kelembapan, amonia, pwm_intake, pwm_exhaust, pwm_pemanas, status_konveyor)
VALUES (24.2, 68.5, 12.4, 0, 0, 0, false);
