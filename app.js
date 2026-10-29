/**
 * ════════════════════════════════════════════════════════════════
 * SMART FARM POULTRY MONITOR — NATIVE VANILLA JAVASCRIPT
 * Skripsi: Dian Lestari Kurniawati (NIM: 230605110016)
 * "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur
 *  Berbasis Fuzzy Logic Controller"
 * 
 * Sesuai Bab III Proposal Skripsi:
 * 1. Database Supabase Tabel Tunggal: 'telemetry' (Tabel 3.5 Proposal)
 * 2. Algoritma FLC Mamdani 125 Rule Base (5 Suhu x 5 Kelembapan x 5 Amonia)
 * 3. Defuzzifikasi Centroid COA Domain [0..100] & Scaling PWM (Persamaan 3.1 & 3.2)
 * 4. Relai Motor Konveyor Biner GPIO 27 (Amonia >= 20 ppm ATAU Kelembapan > 90%)
 * 5. Heartbeat Watchdog Status ESP32 Online <= 10 Detik
 * 6. Pure HTML5 Canvas Offline/Online Realtime Chart
 * ════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ─── AMBANG BATAS STANDAR MIKROKLIMAT AYAM PETELUR (BAB III PROPOSAL) ───
  // Sesuai Bab III Proposal Skripsi Dian Lestari Kurniawati:
  // 1. Suhu Udara: Dingin < 18°C, Ideal/Normal 20–25°C, Waspada Panas >= 27°C, Bahaya >= 31°C
  // 2. Kelembapan: Optimal 60–80%, Waspada >= 85%, Bahaya >= 92%
  // 3. Gas Amonia: Aman < 20 ppm, Waspada/Konveyor ON >= 20 ppm, Bahaya Kritis >= 30 ppm
  const THRESHOLDS = Object.freeze({
    temperature: { min: 10, max: 40, minCold: 18.0, warning: 27.0, danger: 31.0 },
    humidity:    { min: 20, max: 100, minDry: 50.0,  warning: 85.0, danger: 92.0 },
    ammonia:     { min: 0,  max: 50,  warning: 20.0, danger: 30.0 }
  });
  try { localStorage.removeItem('smartfarm_thresholds'); } catch (e) {}

  // Baca konfigurasi dari config.js atau localStorage
  const savedConfig = window.SMARTFARM_CONFIG || {};
  const storedUrl = localStorage.getItem('smartfarm_supabase_url') || savedConfig.SUPABASE_URL || '';
  const storedKey = localStorage.getItem('smartfarm_supabase_key') || savedConfig.SUPABASE_ANON_KEY || '';
  let storedMode = localStorage.getItem('smartfarm_conn_mode');
  if (!storedMode || (storedMode === 'demo' && !localStorage.getItem('smartfarm_manual_demo') && storedUrl && storedKey)) {
    storedMode = savedConfig.DEFAULT_MODE || 'supabase';
  }

  // ─── STATE MANAGEMENT ─────────────────────────────────────────
  const state = {
    currentView: 'dashboard',
    connectionMode: storedMode, // 'supabase' | 'demo' | 'esp32'
    demoSubMode: localStorage.getItem('smartfarm_demo_submode') || 'manual', // 'manual' | 'auto'
    demoValues: {
      suhu: 24.0,
      kelembapan: 65.0,
      amonia: 10.0
    },
    esp32Ip: localStorage.getItem('smartfarm_esp32_ip') || 'http://192.168.4.1',
    supabaseUrl: storedUrl,
    supabaseKey: storedKey,
    supabaseClient: null,
    supabaseChannels: [],

    // Live sensor values dari database (null jika sensor terputus / offline)
    sensors: {
      suhu: null,
      kelembapan: null,
      amonia: null,
      timestamp: null
    },
    isHardwareOnline: false,
    latestRow: null,
    lastTelemetryId: null,
    lastTelemetryCreatedAt: null,

    // Actuator states (PWM 0-100 & Konveyor boolean)
    actuators: {
      pwmIntake: 0,
      pwmExhaust: 0,
      pwmPemanas: 0,
      statusKonveyor: false,
      isManual: false
    },

    // Fuzzy Mamdani output
    fuzzy: null,

    // Historical buffer for charts (last 60 data points)
    history: [],

    // Notifications
    notifications: [],
    unreadCount: 0,

    // ESP32 Heartbeat tracking (timestamp dari baris telemetry terbaru)
    lastEsp32Heartbeat: null,

    // Chart settings
    chartRange: '1h',
    hoveredChartPoint: null,
    timerId: null,

    // Rule table display mode: 'active' | 'all'
    rulesDisplayMode: 'active',
    rulesSearchQuery: ''
  };

  // ════════════════════════════════════════════════════════════════
  // 1. FUZZY LOGIC CONTROLLER MAMDANI (125 RULE BASE)
  // Sesuai Bab III Proposal Skripsi Dian Lestari Kurniawati
  // ════════════════════════════════════════════════════════════════

  // Fungsi keanggotaan dasar
  function calcLeftShoulder(x, a, b) {
    if (x <= a) return 1.0;
    if (x >= b) return 0.0;
    return (b - x) / (b - a);
  }

  function calcRightShoulder(x, a, b) {
    if (x <= a) return 0.0;
    if (x >= b) return 1.0;
    return (x - a) / (b - a);
  }

  function calcTri(x, a, b, c) {
    if (x <= a || x >= c) return 0.0;
    if (x === b) return 1.0;
    if (x < b) return (x - a) / (b - a);
    return (c - x) / (c - b);
  }

  function calcTrap(x, a, b, c, d) {
    if (x <= a || x >= d) return 0.0;
    if (x >= b && x <= c) return 1.0;
    if (x < b) return (x - a) / (b - a);
    return (d - x) / (d - c);
  }

  // Nama himpunan linguistik (sesuai Tabel 125 Aturan Proposal)
  const T_LABELS = ['Sangat Dingin (<15)', 'Dingin (15-20)', 'Normal (20-25)', 'Panas (25-30)', 'Sangat Panas (>30)'];
  const H_LABELS = ['Sangat Kering (<40)', 'Kering (40-60)', 'Normal (60-80)', 'Basah (80-90)', 'Sangat Basah (>90)'];
  const A_LABELS = ['Sangat Rendah (<10)', 'Rendah (10-20)', 'Sedang (20-30)', 'Tinggi (30-40)', 'Sangat Tinggi (>40)'];
  const OUT_LABELS = ['Mati', 'Rendah', 'Sedang', 'Tinggi', 'Maksimal'];

  // 125 Matriks Baku Rule Base Mamdani sesuai Naskah Proposal Bab III:
  // Format tiap baris: [htTerm (Pemanas), exTerm (Exhaust), inTerm (Intake), konvTerm (Konveyor)]
  // Nilai term output: 0=Mati (0%), 1=Rendah (25%), 2=Sedang (50%), 3=Tinggi (75%), 4=Maksimal (100%)
  // Konveyor: 0=OFF, 1=ON
  const MAMDANI_RULES_DATA = [
    [4, 0, 0, 0], [4, 0, 0, 0], [4, 0, 1, 1], [3, 0, 2, 1], [3, 1, 3, 1], // R001-R005: Suhu < 15, RH < 40
    [4, 0, 0, 0], [4, 0, 0, 0], [4, 0, 1, 1], [3, 0, 2, 1], [3, 1, 3, 1], // R006-R010: Suhu < 15, RH 40-60
    [4, 0, 0, 0], [4, 0, 0, 0], [4, 0, 1, 1], [3, 0, 2, 1], [3, 1, 3, 1], // R011-R015: Suhu < 15, RH 60-80
    [4, 0, 1, 0], [4, 0, 1, 0], [3, 0, 2, 1], [3, 1, 3, 1], [2, 1, 4, 1], // R016-R020: Suhu < 15, RH 80-90
    [4, 0, 1, 0], [3, 0, 2, 0], [3, 1, 2, 1], [2, 1, 3, 1], [2, 1, 4, 1], // R021-R025: Suhu < 15, RH > 90

    [3, 0, 0, 0], [3, 0, 0, 0], [2, 0, 1, 1], [2, 0, 2, 1], [1, 1, 3, 1], // R026-R030: Suhu 15-20, RH < 40
    [3, 0, 0, 0], [3, 0, 0, 0], [2, 0, 1, 1], [2, 0, 2, 1], [1, 1, 3, 1], // R031-R035: Suhu 15-20, RH 40-60
    [2, 0, 0, 0], [2, 0, 0, 0], [2, 0, 1, 1], [1, 0, 2, 1], [1, 1, 3, 1], // R036-R040: Suhu 15-20, RH 60-80
    [2, 0, 1, 0], [2, 0, 1, 0], [1, 0, 2, 1], [1, 1, 3, 1], [0, 1, 4, 1], // R041-R045: Suhu 15-20, RH 80-90
    [2, 0, 1, 0], [1, 0, 2, 0], [1, 1, 2, 1], [0, 1, 3, 1], [0, 2, 4, 1], // R046-R050: Suhu 15-20, RH > 90

    [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 2, 3, 1], [0, 3, 4, 1], // R051-R055: Suhu 20-25, RH < 40
    [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 2, 3, 1], [0, 3, 4, 1], // R056-R060: Suhu 20-25, RH 40-60
    [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 2, 1], [0, 2, 3, 1], [0, 3, 4, 1], // R061-R065: Suhu 20-25, RH 60-80
    [0, 1, 1, 0], [0, 1, 2, 0], [0, 2, 2, 1], [0, 2, 3, 1], [0, 3, 4, 1], // R066-R070: Suhu 20-25, RH 80-90
    [0, 1, 2, 0], [0, 2, 2, 0], [0, 2, 3, 1], [0, 3, 3, 1], [0, 3, 4, 1], // R071-R075: Suhu 20-25, RH > 90

    [0, 2, 2, 0], [0, 2, 2, 0], [0, 2, 3, 1], [0, 3, 4, 1], [0, 4, 4, 1], // R076-R080: Suhu 25-30, RH < 40
    [0, 2, 2, 0], [0, 2, 2, 0], [0, 2, 3, 1], [0, 3, 4, 1], [0, 4, 4, 1], // R081-R085: Suhu 25-30, RH 40-60
    [0, 2, 3, 0], [0, 2, 3, 0], [0, 3, 3, 1], [0, 3, 4, 1], [0, 4, 4, 1], // R086-R090: Suhu 25-30, RH 60-80
    [0, 3, 3, 0], [0, 3, 3, 0], [0, 3, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R091-R095: Suhu 25-30, RH 80-90
    [0, 3, 4, 0], [0, 3, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R096-R100: Suhu 25-30, RH > 90

    [0, 4, 4, 0], [0, 4, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R101-R105: Suhu > 30, RH < 40
    [0, 4, 4, 0], [0, 4, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R106-R110: Suhu > 30, RH 40-60
    [0, 4, 4, 0], [0, 4, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R111-R115: Suhu > 30, RH 60-80
    [0, 4, 4, 0], [0, 4, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1], // R116-R120: Suhu > 30, RH 80-90
    [0, 4, 4, 0], [0, 4, 4, 0], [0, 4, 4, 1], [0, 4, 4, 1], [0, 4, 4, 1]  // R121-R125: Suhu > 30, RH > 90
  ];

  // Bangun pustaka 125 aturan sekali saat startup
  const RULE_BASE_125 = [];
  for (let idx = 0; idx < 125; idx++) {
    const t = Math.floor(idx / 25);
    const h = Math.floor((idx % 25) / 5);
    const a = idx % 5;
    const [htTerm, exTerm, inTerm, konvTerm] = MAMDANI_RULES_DATA[idx];
    RULE_BASE_125.push({
      id: idx + 1,
      tIdx: t,
      hIdx: h,
      aIdx: a,
      tName: T_LABELS[t],
      hName: H_LABELS[h],
      aName: A_LABELS[a],
      inTerm,
      exTerm,
      htTerm,
      konvTerm,
      inName: OUT_LABELS[inTerm],
      exName: OUT_LABELS[exTerm],
      htName: OUT_LABELS[htTerm],
      antecedent: `IF Suhu=${T_LABELS[t]} AND Kelembapan=${H_LABELS[h]} AND Amonia=${A_LABELS[a]}`,
      consequent: `THEN Pemanas=${OUT_LABELS[htTerm]}, Exhaust=${OUT_LABELS[exTerm]}, Intake=${OUT_LABELS[inTerm]}, Konveyor=${konvTerm ? 'ON' : 'OFF'}`
    });
  }

  // ─── DEFUZZIFIKASI CENTROID COA (Persamaan 3.1 & 3.2) ────────
  function defuzzifyCentroid(betas) {
    const sumBeta = betas[0] + betas[1] + betas[2] + betas[3] + betas[4];
    if (sumBeta <= 0.0001) {
      return { yStar: 8.3, pwm: 0 };
    }

    // Jika hanya term 0 (Mati) yang aktif (tidak ada term Rendah..Maksimal yang aktif),
    // maka aktuator secara tegas 0% PWM (Mati)
    if (betas[1] <= 0.0001 && betas[2] <= 0.0001 && betas[3] <= 0.0001 && betas[4] <= 0.0001) {
      return { yStar: 8.3, pwm: 0 };
    }

    let num = 0;
    let den = 0;
    const dy = 0.5;

    for (let y = 0; y <= 100; y += dy) {
      // 5 fungsi keanggotaan output domain [0..100]:
      // 0: Mati (Segitiga Siku-Siku 0..25)
      let m0 = (y <= 25) ? ((25 - y) / 25) : 0;

      // 1: Rendah (Segitiga 0..25..50)
      let m1 = 0;
      if (y < 25) m1 = y / 25;
      else if (y <= 50) m1 = (50 - y) / 25;

      // 2: Sedang (Segitiga 25..50..75)
      let m2 = 0;
      if (y >= 25 && y < 50) m2 = (y - 25) / 25;
      else if (y >= 50 && y <= 75) m2 = (75 - y) / 25;

      // 3: Tinggi (Segitiga 50..75..100)
      let m3 = 0;
      if (y >= 50 && y < 75) m3 = (y - 50) / 25;
      else if (y >= 75 && y <= 100) m3 = (100 - y) / 25;

      // 4: Maksimal (Segitiga Siku-Siku 75..100)
      let m4 = (y >= 75) ? ((y - 75) / 25) : 0;

      // Komposisi Mamdani: MAX dari MIN implikasi
      const mu = Math.max(
        Math.min(betas[0], m0),
        Math.min(betas[1], m1),
        Math.min(betas[2], m2),
        Math.min(betas[3], m3),
        Math.min(betas[4], m4)
      );

      num += y * mu * dy;
      den += mu * dy;
    }

    if (den <= 0.00001) {
      return { yStar: 8.3, pwm: 0 };
    }

    // Persamaan 3.1: Centroid COA
    const yStar = num / den;

    // Persamaan 3.2: Scaling PWM dari domain [8.3 .. 91.7] ke [0 .. 100]
    const pwmRaw = ((yStar - 8.3) / (91.7 - 8.3)) * 100;
    let pwm = Math.max(0, Math.min(100, Math.round(pwmRaw)));

    // Deadband thresholding untuk mencegah residual numerik kliping segitiga siku-siku
    if (pwm <= 2 && betas[1] <= 0.05 && betas[2] <= 0.05 && betas[3] <= 0.05 && betas[4] <= 0.05) {
      pwm = 0;
    }

    return { yStar: +yStar.toFixed(2), pwm };
  }

  // ─── MESIN UTAMA FLC MAMDANI 125 RULE (BAB III PROPOSAL SKRIPSI) ───
  function computeFuzzyMamdani(temp, humid, nh3) {
    // 1. Fuzzifikasi Suhu (10–40 °C) sesuai Bab III Proposal
    const muT = [
      calcLeftShoulder(temp, 14, 18),        // SD: Sangat Dingin [10, 10, 14, 18]
      calcTri(temp, 14, 18, 20),             // D: Dingin [14, 18, 18, 20]
      calcTrap(temp, 18, 20, 25, 27),        // N: Normal [18, 20, 25, 27]
      calcTri(temp, 25, 27, 31),             // P: Panas [25, 27, 27, 31]
      calcRightShoulder(temp, 27, 31)        // SP: Sangat Panas [27, 31, 40, 40]
    ];

    // 2. Fuzzifikasi Kelembapan (20–100 %RH) sesuai Bab III Proposal
    const muH = [
      calcLeftShoulder(humid, 40, 50),       // SK: Sangat Kering [20, 20, 40, 50]
      calcTri(humid, 40, 50, 60),            // K: Kering [40, 50, 50, 60]
      calcTrap(humid, 50, 60, 80, 85),       // N: Normal [50, 60, 80, 85]
      calcTri(humid, 80, 85, 92),            // B: Basah [80, 85, 85, 92]
      calcRightShoulder(humid, 85, 92)       // SB: Sangat Basah [85, 92, 100, 100]
    ];

    // 3. Fuzzifikasi Gas Amonia (0–50 ppm) sesuai Bab III Proposal
    // Sesuai Tabel Baku: SR (< 10 ppm), R (10–20 ppm), S (20–30 ppm), T (30–40 ppm), ST (> 40 ppm)
    const muA = [
      calcLeftShoulder(nh3, 5, 15),          // SR: Sangat Aman (< 10 ppm) [0, 0, 5, 15]
      calcTri(nh3, 5, 15, 25),               // R: Aman (10 – 20 ppm) [5, 15, 25]
      calcTri(nh3, 15, 25, 35),              // S: Waspada (20 – 30 ppm) [15, 25, 35]
      calcTri(nh3, 25, 35, 45),              // T: Bahaya (30 – 40 ppm) [25, 35, 45]
      calcRightShoulder(nh3, 35, 45)         // ST: Sangat Bahaya (> 40 ppm) [35, 45, 50, 50]
    ];

    // Array clipping alpha untuk 5 term output masing-masing aktuator
    const betasIn = [0, 0, 0, 0, 0];
    const betasEx = [0, 0, 0, 0, 0];
    const betasHt = [0, 0, 0, 0, 0];

    const evaluatedRules = [];

    // 4. Evaluasi 125 Aturan Mamdani (MIN antecedent & MAX aggregation)
    for (let i = 0; i < RULE_BASE_125.length; i++) {
      const r = RULE_BASE_125[i];
      const alpha = Math.min(muT[r.tIdx], muH[r.hIdx], muA[r.aIdx]);

      if (alpha > 0.001) {
        evaluatedRules.push({
          id: r.id,
          antecedent: r.antecedent,
          consequent: r.consequent,
          alpha: alpha,
          inTerm: r.inTerm,
          exTerm: r.exTerm,
          htTerm: r.htTerm
        });

        // Agregasi MAX
        if (alpha > betasIn[r.inTerm]) betasIn[r.inTerm] = alpha;
        if (alpha > betasEx[r.exTerm]) betasEx[r.exTerm] = alpha;
        if (alpha > betasHt[r.htTerm]) betasHt[r.htTerm] = alpha;
      }
    }

    // Urutkan aturan aktif berdasarkan alpha tertinggi
    evaluatedRules.sort((a, b) => b.alpha - a.alpha);

    // 5. Defuzzifikasi Centroid COA & Scaling PWM
    const resIn = defuzzifyCentroid(betasIn);
    const resEx = defuzzifyCentroid(betasEx);
    const resHt = defuzzifyCentroid(betasHt);

    // Proteksi & Penyesuaian Logika Lampu Pemanas (GPIO 23):
    // Pemanas hanya aktif saat suhu dingin (Suhu < 20°C, term SD & D).
    // Pada suhu ideal/normal (18-27°C, khususnya >= 20°C) atau panas (>= 27°C),
    // lampu pemanas WAJIB mati total (0% PWM & status OFF).
    if (temp >= 20.0 || (betasHt[1] <= 0.0001 && betasHt[2] <= 0.0001 && betasHt[3] <= 0.0001 && betasHt[4] <= 0.0001)) {
      resHt.pwm = 0;
      resHt.yStar = 8.3;
    }

    // 6. Logika Relai Biner Motor Konveyor (GPIO 27) Sesuai Bab III Proposal:
    // Aktif jika Amonia >= 20 ppm (Waspada/Bahaya) ATAU Kelembapan > 90% (Sangat Basah)
    const conveyorState = (nh3 >= 20.0 || humid > 90.0);

    // 7. Penentuan Label Kondisi Mikroklimat Kandang Baku Proposal:
    const isDanger = (nh3 >= 30.0 || temp >= 31.0 || temp <= 14.0);
    const isWarning = (nh3 >= 20.0 || temp >= 27.0 || temp <= 18.0 || humid >= 85.0);
    const conditionLabel = isDanger ? 'Kondisi Bahaya' : (isWarning ? 'Kondisi Waspada' : 'Kondisi Normal');
    const statusClass = isDanger ? 'danger' : (isWarning ? 'warning' : 'normal');

    return {
      membership: {
        temp: { SD: muT[0], D: muT[1], N: muT[2], P: muT[3], SP: muT[4] },
        humid: { SK: muH[0], K: muH[1], N: muH[2], B: muH[3], SB: muH[4] },
        ammonia: { SR: muA[0], R: muA[1], S: muA[2], T: muA[3], ST: muA[4] }
      },
      activeRules: evaluatedRules,
      centroid: {
        fanIntake: resIn.yStar,
        fanExhaust: resEx.yStar,
        heater: resHt.yStar
      },
      crisp: {
        fanIntake: resIn.pwm,
        fanExhaust: resEx.pwm,
        heater: resHt.pwm,
        conveyor: conveyorState ? 100 : 0
      },
      states: {
        fanIntake: resIn.pwm > 0,
        fanExhaust: resEx.pwm > 0,
        heater: resHt.pwm > 0,
        conveyor: conveyorState
      },
      conditionLabel,
      statusClass
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 2. SUPABASE REALTIME & DATABASE ENGINE (TABEL TUNGGAL 'telemetry')
  // Sesuai Tabel 3.5 Proposal Skripsi
  // ════════════════════════════════════════════════════════════════

  function generateMockHistoryForRange(range = state.chartRange) {
    const hours = range === '24h' ? 24 : (range === '6h' ? 6 : 1);
    const count = range === '24h' ? 48 : (range === '6h' ? 36 : 30);
    const stepMs = (hours * 3600 * 1000) / count;
    const now = Date.now();
    const hist = [];

    for (let i = count; i >= 0; i--) {
      const time = new Date(now - i * stepMs);
      const hoursAgo = (now - time.getTime()) / (3600 * 1000);

      // Fluktuasi siklus yang realistis sesuai rentang jam
      let baseTemp = 24.2;
      let baseHum = 68.0;
      let baseNh3 = 12.0;

      if (range === '24h') {
        // Siklus diurnal 24 jam (siang lebih panas, malam lebih dingin & lembap)
        const hourOfDay = time.getHours() + time.getMinutes() / 60;
        baseTemp = 24.5 + Math.sin((hourOfDay - 9) * Math.PI / 12) * 4.5;
        baseHum = 67.0 - Math.sin((hourOfDay - 9) * Math.PI / 12) * 8.0;
        baseNh3 = 13.0 + Math.cos((hourOfDay - 14) * Math.PI / 12) * 4.0;
      } else if (range === '6h') {
        // Tren dinamis 6 jam
        baseTemp = 24.2 + Math.sin(hoursAgo * 1.2) * 2.8;
        baseHum = 68.5 - Math.sin(hoursAgo * 1.1) * 4.5;
        baseNh3 = 12.5 + Math.cos(hoursAgo * 1.4) * 3.2;
      } else {
        // Fluktuasi mikro 1 jam
        baseTemp = 24.5 + Math.sin(hoursAgo * 4.5) * 1.2;
        baseHum = 69.0 + Math.cos(hoursAgo * 3.8) * 2.0;
        baseNh3 = 12.2 + Math.sin(hoursAgo * 5.0) * 1.5;
      }

      const suhu = +(baseTemp + (Math.random() - 0.5) * 0.4).toFixed(1);
      const kelembapan = +(baseHum + (Math.random() - 0.5) * 0.8).toFixed(1);
      const amonia = +(baseNh3 + (Math.random() - 0.5) * 0.5).toFixed(1);

      const fSim = computeFuzzyMamdani(suhu, kelembapan, amonia);

      hist.push({
        time,
        suhu: Number(suhu),
        kelembapan: Number(kelembapan),
        amonia: Number(amonia),
        pwm_intake: fSim.crisp.fanIntake,
        pwm_exhaust: fSim.crisp.fanExhaust,
        pwm_pemanas: fSim.crisp.heater,
        status_konveyor: fSim.states.conveyor
      });
    }

    state.history = hist;
  }

  // ─── VALIDATOR SENSOR FISIK (Bukan Dummy & Bukan Sentinel -999) ───
  function isSensorValid(val, minLimit = -40, maxLimit = 150) {
    if (val === null || val === undefined) return false;
    const num = Number(val);
    if (isNaN(num)) return false;
    if (num <= -900) return false; // Nilai -999 menandakan sensor fisik terputus
    if (num < minLimit || num > maxLimit) return false;
    return true;
  }

  async function fetchChartHistory(range = state.chartRange) {
    const hours = range === '24h' ? 24 : (range === '6h' ? 6 : 1);
    const cut = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    if (state.connectionMode === 'supabase' && state.supabaseClient) {
      try {
        const { data, error } = await state.supabaseClient
          .from('telemetry')
          .select('*')
          .gte('created_at', cut)
          .order('created_at', { ascending: true })
          .limit(range === '24h' ? 500 : (range === '6h' ? 300 : 100));

        if (!error) {
          // HANYA gunakan data nyata yang tersimpan di tabel telemetry Supabase!
          state.history = (data || []).map(d => {
            const rawT = d.suhu !== undefined ? d.suhu : d.temperature;
            const rawH = d.kelembapan !== undefined ? d.kelembapan : d.humidity;
            const rawA = d.amonia !== undefined ? d.amonia : d.ammonia;

            const tValid = isSensorValid(rawT, 0, 60);
            const hValid = isSensorValid(rawH, 0, 100);
            const aValid = isSensorValid(rawA, 0, 200);

            return {
              time: new Date(d.created_at),
              suhu: tValid ? Number(rawT) : null,
              kelembapan: hValid ? Number(rawH) : null,
              amonia: aValid ? Number(rawA) : null,
              pwm_intake: Number(d.pwm_intake || 0),
              pwm_exhaust: Number(d.pwm_exhaust || 0),
              pwm_pemanas: Number(d.pwm_pemanas || 0),
              status_konveyor: Boolean(d.status_konveyor)
            };
          });
          renderCanvasChart();
          return;
        }
      } catch (err) {
        console.warn('Gagal memuat histori Supabase untuk rentang', range, err);
      }
    }

    if (state.connectionMode === 'demo') {
      generateMockHistoryForRange(range);
    } else {
      state.history = [];
    }
    renderCanvasChart();
  }

  function initMockHistory() {
    generateMockHistoryForRange(state.chartRange || '1h');
  }

  function tickDemoData() {
    const now = new Date();
    if (state.demoSubMode === 'manual') {
      // Pada mode manual (Uji Semhas), gunakan nilai input manual pengguna secara stabil & tunggu input
      updateTelemetryData({
        suhu: state.demoValues.suhu,
        kelembapan: state.demoValues.kelembapan,
        amonia: state.demoValues.amonia,
        created_at: now.toISOString(),
        _isDemoData: true
      });
      syncDemoInputs(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);
      updateDemoFeedbackBar();
      // Keepalive nirkabel berkala ke ESP32 fisik agar kontrol aktuator tidak timeout
      sendHardwareDemoCommand(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia, true);
      return;
    }

    const t = now.getTime();
    // Osilasi halus mensimulasikan lingkungan kandang ayam petelur
    const suhu = +(23.8 + Math.sin(t / 25000) * 4.5 + (Math.random() - 0.5) * 0.6).toFixed(1);
    const kelembapan = +(67.5 + Math.cos(t / 20000) * 8.0 + (Math.random() - 0.5) * 1.0).toFixed(1);
    const amonia = +(13.2 + Math.sin(t / 18000) * 5.5 + (Math.random() - 0.5) * 0.8).toFixed(1);

    state.demoValues.suhu = suhu;
    state.demoValues.kelembapan = kelembapan;
    state.demoValues.amonia = amonia;

    syncDemoInputs(suhu, kelembapan, amonia);

    updateTelemetryData({
      suhu,
      kelembapan,
      amonia,
      created_at: now.toISOString(),
      _isDemoData: true
    });

    updateDemoFeedbackBar();
  }

  // ─── KONTROL FISIK HARDWARE ESP32 VIA WEB SERIAL (USB) & HTTP ───
  let serialPort = null;
  let serialWriter = null;
  let isSerialConnected = false;
  let lastHardwareCmd = '';
  let hwDebounceTimer = null;

  async function connectUsbEsp32() {
    if (!('serial' in navigator)) {
      alert('Browser Anda tidak mendukung Web Serial API. Untuk mengendalikan modul hardware ESP32 secara langsung via USB, silakan gunakan Google Chrome atau Microsoft Edge.');
      return;
    }

    if (isSerialConnected) {
      try {
        sendHardwareAutoCommand();
        if (serialWriter) {
          await serialWriter.close();
          serialWriter = null;
        }
        if (serialPort) {
          await serialPort.close();
          serialPort = null;
        }
      } catch (e) {
        console.warn('Error saat menutup serial port:', e);
      }
      isSerialConnected = false;
      updateUsbButtonUI(false);
      return;
    }

    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 115200 });
      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(serialPort.writable);
      serialWriter = textEncoder.writable.getWriter();
      isSerialConnected = true;
      updateUsbButtonUI(true);

      // Jika saat ini di submode manual, langsung ambil alih aktuator fisik dengan nilai saat ini
      if (state.demoSubMode === 'manual') {
        sendHardwareDemoCommand(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        console.error('Gagal menghubungkan serial port:', err);
        alert('Gagal menghubungkan ke ESP32 via USB: ' + err.message);
      }
      isSerialConnected = false;
      updateUsbButtonUI(false);
    }
  }

  function updateUsbButtonUI(connected) {
    const btnUsb = document.getElementById('btn-connect-usb-esp32');
    const label = document.getElementById('usb-btn-label');
    const icon = document.getElementById('usb-status-icon');
    const hwDot = document.getElementById('hw-conn-dot');
    const hwText = document.getElementById('demo-hw-status-text');

    if (btnUsb) {
      if (connected) {
        btnUsb.classList.add('connected');
        if (label) label.textContent = 'ESP32 USB Terhubung (Putuskan)';
        if (icon) icon.textContent = '🟢';
      } else {
        btnUsb.classList.remove('connected');
        if (label) label.textContent = 'Hubungkan ESP32 (USB)';
        if (icon) icon.textContent = '🔌';
      }
    }

    if (hwDot && hwText) {
      if (connected) {
        hwDot.textContent = '🟢';
        hwText.textContent = 'Diambil Alih (Fisik Aktif)';
        hwText.style.color = '#059669';
      } else {
        hwDot.textContent = '⚪';
        hwText.textContent = 'Standby (Sensor Fisik)';
        hwText.style.color = 'var(--text-muted)';
      }
    }
  }

  async function testEsp32Connection(targetUrl) {
    const hwDot = document.getElementById('hw-conn-dot');
    const hwText = document.getElementById('demo-hw-status-text');
    if (hwDot) hwDot.textContent = '🔄';
    if (hwText) {
      hwText.textContent = 'Menguji koneksi WiFi ESP32...';
      hwText.style.color = '#D97706';
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${targetUrl}/api/ping`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        if (hwDot) hwDot.textContent = '🟢';
        if (hwText) {
          hwText.textContent = `Terkendali (${targetUrl.replace(/^https?:\/\//, '')})`;
          hwText.style.color = '#059669';
        }
        return true;
      }
    } catch (e) {
      console.warn('Uji ping ke ESP32 gagal:', e);
    }

    if (hwDot) hwDot.textContent = '🟡';
    if (hwText) {
      hwText.textContent = `Menghubungkan ke ${targetUrl.replace(/^https?:\/\//, '')}...`;
      hwText.style.color = '#D97706';
    }
    return false;
  }

  let isSendingDemoCmd = false;

  async function sendHardwareDemoCommand(suhu, kelembapan, amonia, isKeepalive = false) {
    // Sesuai permintaan: yang demo otomatis tidak perlu bisa mengontrol aktuator fisik
    if (state.demoSubMode !== 'manual') return;

    const s = Number(suhu).toFixed(1);
    const k = Number(kelembapan).toFixed(1);
    const a = Number(amonia).toFixed(1);
    const cmd = `SET ${s} ${k} ${a}`;

    if (!isKeepalive && cmd === lastHardwareCmd) return;
    lastHardwareCmd = cmd;

    // 1. Kirim via Web Serial (Kabel Data USB ESP32 jika terhubung)
    if (serialWriter && isSerialConnected) {
      try {
        await serialWriter.write(cmd + '\n');
        console.log('[ESP32 USB SERIAL SENT]', cmd);
      } catch (e) {
        console.warn('Gagal kirim via Web Serial:', e);
      }
    }

    // 2. Kirim via Local HTTP ke ESP32 pada Hotspot HP / mDNS / SoftAP
    const endpoints = [];
    if (state.esp32Ip) endpoints.push(state.esp32Ip.replace(/\/+$/, ''));
    if (!endpoints.includes('http://smartfarm.local')) endpoints.push('http://smartfarm.local');
    if (!endpoints.includes('http://192.168.4.1')) endpoints.push('http://192.168.4.1');

    if (isSendingDemoCmd && isKeepalive) return;
    isSendingDemoCmd = true;

    let successBase = null;
    for (const baseUrl of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${baseUrl}/api/demo?suhu=${s}&kelembapan=${k}&amonia=${a}`, {
          method: 'GET',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          successBase = baseUrl;
          break;
        }
      } catch (e) {
        // Coba endpoint alternatif berikutnya
      }
    }
    isSendingDemoCmd = false;

    // Perbarui indikator visual koneksi hardware fisik di bar feedback demo
    const hwDot = document.getElementById('hw-conn-dot');
    const hwText = document.getElementById('demo-hw-status-text');

    if (successBase) {
      if (state.esp32Ip !== successBase) {
        state.esp32Ip = successBase;
        localStorage.setItem('smartfarm_esp32_ip', successBase);
        updateWifiIpButton();
      }
      if (hwDot) hwDot.textContent = '🟢';
      if (hwText) {
        const cleanIp = successBase.replace(/^https?:\/\//, '');
        hwText.textContent = `Terkendali (${cleanIp})`;
        hwText.style.color = '#059669';
      }
    } else if (isSerialConnected) {
      if (hwDot) hwDot.textContent = '🟢';
      if (hwText) {
        hwText.textContent = 'Terkendali (USB)';
        hwText.style.color = '#059669';
      }
    } else {
      if (hwDot) hwDot.textContent = '🟡';
      if (hwText) {
        const cleanIp = (state.esp32Ip || 'smartfarm.local').replace(/^https?:\/\//, '');
        hwText.textContent = `Menghubungkan ke ${cleanIp}...`;
        hwText.style.color = '#D97706';
      }
    }
  }

  function sendHardwareAutoCommand() {
    lastHardwareCmd = 'AUTO';
    if (serialWriter && isSerialConnected) {
      try {
        serialWriter.write('AUTO\n');
        console.log('[ESP32 USB SERIAL SENT] AUTO');
      } catch (e) {
        console.warn('Gagal kirim AUTO:', e);
      }
    }
    const endpoints = [];
    if (state.esp32Ip) endpoints.push(state.esp32Ip.replace(/\/+$/, ''));
    if (!endpoints.includes('http://smartfarm.local')) endpoints.push('http://smartfarm.local');
    if (!endpoints.includes('http://192.168.4.1')) endpoints.push('http://192.168.4.1');

    endpoints.forEach(async (baseUrl) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        await fetch(`${baseUrl}/api/auto`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (e) {}
    });

    const hwDot = document.getElementById('hw-conn-dot');
    const hwText = document.getElementById('demo-hw-status-text');
    if (hwDot) hwDot.textContent = '⚪';
    if (hwText) {
      hwText.textContent = 'Standby (Sensor Fisik)';
      hwText.style.color = 'var(--text-muted)';
    }
  }

  // ─── FUNGSI PERALIHAN MODE SUMBER DATA (REALTIME vs DEMO) ───
  function switchConnectionMode(newMode) {
    const prevMode = state.connectionMode;
    state.connectionMode = newMode;
    localStorage.setItem('smartfarm_conn_mode', newMode);

    if (newMode === 'demo') {
      localStorage.setItem('smartfarm_manual_demo', 'true');
      state.demoSubMode = 'manual';
      localStorage.setItem('smartfarm_demo_submode', 'manual');

      const btnDemoManual = document.getElementById('btn-demo-manual');
      const btnDemoAuto = document.getElementById('btn-demo-auto');
      if (btnDemoManual && btnDemoAuto) {
        btnDemoManual.classList.add('active');
        btnDemoAuto.classList.remove('active');
      }

      // Bersihkan buffer histori lama dan inisialisasi grafik simulasi
      state.history = [];
      initMockHistory();

      // Langsung set dari kondisi IDEAL (24.0°C, 65.0%, 10.0 ppm) & murni menunggu inputan pengguna
      applyDemoValues(24.0, 65.0, 10.0);
    } else {
      localStorage.removeItem('smartfarm_manual_demo');
      // Beritahu ESP32 bahwa mode simulasi selesai, seketika baca sensor fisik kandang
      sendHardwareAutoCommand();

      // Reset total nilai sensor agar data simulasi tidak pernah 'nyangkut'
      state.sensors.suhu = null;
      state.sensors.kelembapan = null;
      state.sensors.amonia = null;
      state.sensors.timestamp = null;
      state.latestRow = null;
      state.lastTelemetryId = null;
      state.lastTelemetryCreatedAt = null;
      state.lastEsp32Heartbeat = null;
      state.isHardwareOnline = false;
      state.fuzzy = null;
      state.history = [];
    }

    renderUI();
    restartPolling();
  }

  function applyDemoValues(suhu, kelembapan, amonia) {
    state.demoValues.suhu = parseFloat(suhu);
    state.demoValues.kelembapan = parseFloat(kelembapan);
    state.demoValues.amonia = parseFloat(amonia);

    syncDemoInputs(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);

    const now = new Date();
    updateTelemetryData({
      suhu: state.demoValues.suhu,
      kelembapan: state.demoValues.kelembapan,
      amonia: state.demoValues.amonia,
      created_at: now.toISOString(),
      _isDemoData: true
    });

    updateDemoFeedbackBar();

    // Ambil alih aktuator fisik jika submode manual aktif
    if (state.demoSubMode === 'manual') {
      sendHardwareDemoCommand(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);
    }
  }

  function syncDemoInputs(s, k, a) {
    const inTemp = document.getElementById('demo-input-temp');
    const slTemp = document.getElementById('demo-slider-temp');
    const inHum = document.getElementById('demo-input-humid');
    const slHum = document.getElementById('demo-slider-humid');
    const inNh3 = document.getElementById('demo-input-nh3');
    const slNh3 = document.getElementById('demo-slider-nh3');

    if (inTemp && document.activeElement !== inTemp) inTemp.value = Number(s).toFixed(1);
    if (slTemp && document.activeElement !== slTemp) slTemp.value = s;
    if (inHum && document.activeElement !== inHum) inHum.value = Number(k).toFixed(1);
    if (slHum && document.activeElement !== slHum) slHum.value = k;
    if (inNh3 && document.activeElement !== inNh3) inNh3.value = Number(a).toFixed(1);
    if (slNh3 && document.activeElement !== slNh3) slNh3.value = a;

    // Sinkronisasi ke simulator tab Fuzzy Mamdani
    const simTemp = document.getElementById('sim-temp');
    const simHum = document.getElementById('sim-hum');
    const simNh3 = document.getElementById('sim-nh3');
    if (simTemp && document.activeElement !== simTemp) {
      simTemp.value = s;
      const valEl = document.getElementById('sim-temp-val');
      if (valEl) valEl.textContent = `${Number(s).toFixed(1)} °C`;
    }
    if (simHum && document.activeElement !== simHum) {
      simHum.value = k;
      const valEl = document.getElementById('sim-hum-val');
      if (valEl) valEl.textContent = `${Number(k).toFixed(1)} %`;
    }
    if (simNh3 && document.activeElement !== simNh3) {
      simNh3.value = a;
      const valEl = document.getElementById('sim-nh3-val');
      if (valEl) valEl.textContent = `${Number(a).toFixed(1)} ppm`;
    }
  }

  function updateDemoFeedbackBar() {
    const fbFanIn = document.getElementById('demo-fb-fan-in');
    const fbFanOut = document.getElementById('demo-fb-fan-out');
    const fbHeater = document.getElementById('demo-fb-heater');
    const fbConveyor = document.getElementById('demo-fb-conveyor');
    const fbStatus = document.getElementById('demo-fb-status');

    if (fbFanIn) fbFanIn.textContent = `${state.actuators.pwmIntake}% PWM`;
    if (fbFanOut) fbFanOut.textContent = `${state.actuators.pwmExhaust}% PWM`;
    if (fbHeater) fbHeater.textContent = `${state.actuators.pwmPemanas}% PWM`;
    if (fbConveyor) {
      fbConveyor.textContent = state.actuators.statusKonveyor ? 'ON (RELAY AKTIF)' : 'OFF (STANDBY)';
      fbConveyor.style.color = state.actuators.statusKonveyor ? 'var(--success)' : 'var(--text-muted)';
    }
    if (fbStatus && state.fuzzy) {
      fbStatus.className = `demo-feedback-status ${state.fuzzy.statusClass}`;
      fbStatus.textContent = state.fuzzy.conditionLabel;
    }

    const hwDot = document.getElementById('hw-conn-dot');
    const hwText = document.getElementById('demo-hw-status-text');
    if (hwDot && hwText) {
      if (state.demoSubMode === 'manual') {
        hwDot.textContent = isSerialConnected ? '🟢' : '📶';
        hwText.textContent = isSerialConnected ? 'Diambil Alih (USB)' : 'Diambil Alih (Hotspot WiFi)';
        hwText.style.color = '#059669';
      } else {
        hwDot.textContent = '⚪';
        hwText.textContent = 'Standby (Simulasi Layar)';
        hwText.style.color = 'var(--text-muted)';
      }
    }
  }

  async function initSupabaseClient() {
    if (!state.supabaseUrl || !state.supabaseKey) {
      console.warn('Supabase URL atau Key belum diisi, fallback ke Mode Demo.');
      state.connectionMode = 'demo';
      setConnectionStatus(true, 'Database: Mode Demo', 'Silakan atur Supabase di ⚙️');
      return false;
    }

    if (!window.supabase) {
      console.warn('Supabase SDK belum selesai dimuat dari CDN.');
      setConnectionStatus(false, 'Database: SDK Error', 'CDN belum selesai dimuat');
      return false;
    }

    try {
      state.supabaseClient = window.supabase.createClient(state.supabaseUrl, state.supabaseKey);

      // 1. Ambil data telemetri terkini dari tabel tunggal 'telemetry'
      const { data: latestRows, error: errLatest } = await state.supabaseClient
        .from('telemetry')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);

      if (errLatest) {
        console.error('Error query tabel telemetry Supabase:', errLatest);
        setConnectionStatus(false, 'Database: Terputus', errLatest.message || 'Gagal query tabel telemetry');
        return false;
      }

      setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Online)');

      // Hanya perbarui sensor & UI jika sedang dalam Mode Realtime (Supabase).
      // Jika pengguna sedang di Mode Simulasi, biarkan nilai simulasi tetap stabil.
      if (state.connectionMode !== 'demo') {
        if (latestRows && latestRows.length > 0) {
          const latest = latestRows[0];
          state.latestRow = latest;
          state.lastTelemetryId = latest.id;
          state.lastTelemetryCreatedAt = latest.created_at;

          // Cek umur data di database terhadap waktu sekarang
          const rowTime = new Date(latest.created_at).getTime();
          const diffSec = Math.max(0, Math.round((Date.now() - rowTime) / 1000));

          state.lastTelemetryId = latest.id;
          state.lastTelemetryCreatedAt = latest.created_at;
          state.lastEsp32Heartbeat = new Date(latest.created_at);

          // ESP32 mengirim data tiap 3 detik. Jika data dibuat <= 15 detik lalu, alat benar-benar online.
          if (diffSec <= 15) {
            state.isHardwareOnline = true;
            updateTelemetryData(latest);
            setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live Data)');
          } else {
            // Data di database sudah lampau (> 15 detik), berarti ESP32 fisik sedang OFF!
            state.isHardwareOnline = false;
            state.sensors.suhu = null;
            state.sensors.kelembapan = null;
            state.sensors.amonia = null;
            state.sensors.timestamp = new Date(latest.created_at);
            state.actuators.pwmIntake = 0;
            state.actuators.pwmExhaust = 0;
            state.actuators.pwmPemanas = 0;
            state.actuators.statusKonveyor = false;
            state.fuzzy = null;
            renderUI();
            evaluateEsp32Status();
            setConnectionStatus(true, 'Database: Terhubung', 'ESP32 Sedang Offline');
          }
        } else {
          state.latestRow = null;
          state.lastTelemetryId = null;
          state.lastTelemetryCreatedAt = null;
          state.lastEsp32Heartbeat = null;
          state.sensors.suhu = null;
          state.sensors.kelembapan = null;
          state.sensors.amonia = null;
          state.sensors.timestamp = null;
          state.isHardwareOnline = false;
          evaluateEsp32Status();
          renderUI();
        }
      }
      // 2. Ambil riwayat telemetri dari database Supabase untuk grafik
      await fetchChartHistory(state.chartRange || '1h');

      // 3. Berlangganan Supabase Realtime WebSocket ke tabel tunggal 'telemetry'
      state.supabaseChannels.forEach(ch => state.supabaseClient.removeChannel(ch));
      state.supabaseChannels = [];

      const chTelemetry = state.supabaseClient
        .channel('realtime_telemetry')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'telemetry' }, (payload) => {
          const row = payload.new;
          console.log('[Supabase Realtime] Telemetri baru masuk:', row);
          state.lastTelemetryId = row.id;
          state.lastTelemetryCreatedAt = row.created_at;
          state.lastEsp32Heartbeat = new Date(row.created_at || Date.now());
          state.isHardwareOnline = true;
          evaluateEsp32Status();

          // Jika sedang dalam Mode Demo, jangan pernah menimpa nilai sensor & aktuator input pengguna!
          if (state.connectionMode === 'demo') {
            return;
          }

          updateTelemetryData(row);
          setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live Data)');
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Realtime)');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[Supabase Realtime] Status channel:', status);
          }
        });

      state.supabaseChannels = [chTelemetry];
      return true;
    } catch (err) {
      console.error('Inisialisasi Supabase gagal:', err);
      setConnectionStatus(false, 'Database: Terputus', err.message || 'Koneksi Gagal');
      return false;
    }
  }

  async function pollEsp32Data() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${state.esp32Ip}/api/data`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error('ESP32 HTTP Error');
      const data = await res.json();

      updateTelemetryData({
        suhu: data.suhu !== undefined ? data.suhu : data.temp,
        kelembapan: data.kelembapan !== undefined ? data.kelembapan : data.humid,
        amonia: data.amonia !== undefined ? data.amonia : data.ammonia,
        pwm_intake: data.pwm_intake,
        pwm_exhaust: data.pwm_exhaust,
        pwm_pemanas: data.pwm_pemanas,
        status_konveyor: data.status_konveyor,
        created_at: new Date().toISOString()
      });

      setConnectionStatus(true, 'ESP32 Terhubung');
    } catch (err) {
      console.warn('Gagal koneksi langsung ke ESP32:', err.message);
      setConnectionStatus(false, 'ESP32 Offline');
    }
  }

  // ─── UPDATE STATE TELEMETRI ───────────────────────────────────
  function updateTelemetryData(row) {
    if (!row) return;

    // ISOLASI TOTAL: Mode Simulasi vs Mode Realtime
    // 1. Saat mode demo, tolak semua data yang bukan berasal dari simulasi (_isDemoData)!
    if (state.connectionMode === 'demo' && !row._isDemoData) {
      return;
    }
    // 2. Saat mode realtime, tolak data simulasi (_isDemoData) agar tidak nyangkut!
    if (state.connectionMode !== 'demo' && row._isDemoData) {
      return;
    }

    const rawSuhu = row.suhu !== undefined ? row.suhu : row.temperature;
    const rawHumid = row.kelembapan !== undefined ? row.kelembapan : row.humidity;
    const rawAmonia = row.amonia !== undefined ? row.amonia : row.ammonia;
    const timestamp = row.created_at ? new Date(row.created_at) : new Date();

    // Catat heartbeat ESP32 berdasarkan waktu baris data riil (bukan waktu lokal browser)
    state.lastEsp32Heartbeat = timestamp;
    const diffSec = Math.max(0, Math.round((Date.now() - timestamp.getTime()) / 1000));
    const isLive = (state.connectionMode === 'demo') || (diffSec <= 15);
    state.isHardwareOnline = isLive;

    // Jika telemetri di database sudah basi (> 15 detik) dan mode bukan demo, ESP32 sedang OFF
    if (!isLive) {
      state.sensors.suhu = null;
      state.sensors.kelembapan = null;
      state.sensors.amonia = null;
      state.sensors.timestamp = timestamp;
      state.actuators.pwmIntake = 0;
      state.actuators.pwmExhaust = 0;
      state.actuators.pwmPemanas = 0;
      state.actuators.statusKonveyor = false;
      state.fuzzy = null;
      evaluateEsp32Status();
      renderUI();
      return;
    }

    evaluateEsp32Status();

    // Periksa validitas masing-masing sensor fisik (nilai < 0 seperti -999 atau NaN berarti sensor terputus)
    const suhuValid = isSensorValid(rawSuhu, 0, 60);
    const humidValid = isSensorValid(rawHumid, 0, 100);
    const amoniaValid = isSensorValid(rawAmonia, 0, 200);

    const suhu = suhuValid ? Number(rawSuhu) : null;
    const kelembapan = humidValid ? Number(rawHumid) : null;
    const amonia = amoniaValid ? Number(rawAmonia) : null;

    state.sensors.suhu = suhu;
    state.sensors.kelembapan = kelembapan;
    state.sensors.amonia = amonia;
    state.sensors.timestamp = timestamp;

    // Jalankan kalkulasi Fuzzy Mamdani 125 rules jika semua sensor terpasang
    if (suhu !== null && kelembapan !== null && amonia !== null) {
      state.fuzzy = computeFuzzyMamdani(suhu, kelembapan, amonia);
    } else {
      let condLabel = 'Sensor Belum Terpasang';
      if (suhu !== null && kelembapan !== null && amonia === null) {
        condLabel = 'Sensor MQ-135 Terputus';
      } else if ((suhu === null || kelembapan === null) && amonia !== null) {
        condLabel = 'Sensor SHT31 Terputus';
      }
      state.fuzzy = {
        crisp: { fanIntake: 0, fanExhaust: 0, heater: 0 },
        states: { intake: false, exhaust: false, heater: false, conveyor: false },
        conditionLabel: condLabel,
        statusClass: 'offline',
        activeRules: [],
        membership: null
      };
    }

    // Perbarui status aktuator otomatis berdasarkan keputusan FLC Mamdani yang diselaraskan dengan Ambang Batas aktif
    if (!state.actuators.isManual && state.fuzzy) {
      state.actuators.pwmIntake = state.fuzzy.crisp.fanIntake;
      state.actuators.pwmExhaust = state.fuzzy.crisp.fanExhaust;
      state.actuators.pwmPemanas = state.fuzzy.crisp.heater;
      state.actuators.statusKonveyor = state.fuzzy.states.conveyor;
    } else if (row.pwm_intake !== undefined && row.pwm_intake !== null && !state.actuators.isManual) {
      state.actuators.pwmIntake = Number(row.pwm_intake);
      state.actuators.pwmExhaust = Number(row.pwm_exhaust);
      state.actuators.pwmPemanas = Number(row.pwm_pemanas);
      state.actuators.statusKonveyor = Boolean(row.status_konveyor);
    }

    // Rekam histori grafik secara live jika alat sedang online
    if (state.connectionMode === 'demo' || state.isHardwareOnline) {
      const exists = state.history.some(h => {
        const ht = h.time instanceof Date ? h.time.getTime() : new Date(h.time).getTime();
        return Math.abs(ht - timestamp.getTime()) < 1000;
      });
      if (!exists) {
        state.history.push({
          time: timestamp,
          suhu: suhu,
          kelembapan: kelembapan,
          amonia: amonia,
          pwm_intake: state.actuators.pwmIntake,
          pwm_exhaust: state.actuators.pwmExhaust,
          pwm_pemanas: state.actuators.pwmPemanas,
          status_konveyor: state.actuators.statusKonveyor
        });
        const rangeHours = state.chartRange === '24h' ? 24 : (state.chartRange === '6h' ? 6 : 1);
        const maxHist = Math.max(60, rangeHours * 15);
        if (state.history.length > maxHist) state.history.shift();
      }
    }

    // Evaluasi alarm peringatan hanya untuk sensor yang aktif
    checkAlerts(suhu, kelembapan, amonia);

    // Refresh UI
    renderUI();
    if (state.currentView === 'history') renderCanvasChart();
  }

  function checkAlerts(t, h, a) {
    const alerts = [];
    const ts = new Date().toLocaleTimeString('id-ID');

    const minC = THRESHOLDS.temperature.minCold || 18.0;
    const wT   = THRESHOLDS.temperature.warning;
    const dT   = THRESHOLDS.temperature.danger;
    const wA   = THRESHOLDS.ammonia.warning;
    const dA   = THRESHOLDS.ammonia.danger;
    const dH   = THRESHOLDS.humidity.danger;

    if (a !== null && a >= dA) {
      alerts.push({ type: 'danger', msg: `Gas Amonia Bahaya: ${a.toFixed(1)} ppm (Batas Kritis ≥ ${dA} ppm — Konveyor ON)`, time: ts });
    } else if (a !== null && a >= wA) {
      alerts.push({ type: 'warning', msg: `Gas Amonia Waspada: ${a.toFixed(1)} ppm (Waspada ≥ ${wA} ppm — Konveyor ON)`, time: ts });
    }

    if (t !== null && t >= dT) {
      alerts.push({ type: 'danger', msg: `Suhu Udara Bahaya: ${t.toFixed(1)}°C (Risiko Heat Stress Ekstrem ≥ ${dT}°C)`, time: ts });
    } else if (t !== null && t >= wT) {
      alerts.push({ type: 'warning', msg: `Suhu Udara Panas: ${t.toFixed(1)}°C (Waspada Panas ≥ ${wT}°C — Kipas Dingin Max)`, time: ts });
    } else if (t !== null && t <= minC) {
      alerts.push({ type: 'warning', msg: `Suhu Udara Dingin: ${t.toFixed(1)}°C (Di bawah ${minC}°C — Pemanas ON)`, time: ts });
    }

    if (h !== null && h >= dH) {
      alerts.push({ type: 'danger', msg: `Kelembapan sangat tinggi: ${h.toFixed(1)}% (Kandang Basah ≥ ${dH}%)`, time: ts });
    }

    if (alerts.length > 0) {
      state.notifications = [...alerts, ...state.notifications].slice(0, 8);
      state.unreadCount = alerts.length;
    }
  }

  function setConnectionStatus(online, text, subText) {
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-text');
    const dbDot = document.getElementById('db-status-dot');
    const dbText = document.getElementById('db-status-text');
    const dbSub = document.getElementById('db-status-sub');

    const isDemo = state.connectionMode === 'demo';
    let dotClass = 'pulse-dot ';
    if (isDemo) {
      dotClass += 'demo';
    } else if (online === null || online === undefined) {
      dotClass += 'demo';
    } else if (online) {
      dotClass += '';
    } else {
      dotClass += 'offline';
    }

    if (dot && label) {
      dot.className = dotClass;
      label.textContent = text || (online ? 'Online' : 'Offline');
    }

      if (dbDot && dbText) {
      dbDot.className = dotClass;
      if (isDemo) {
        dbText.textContent = text || 'Database: Mode Demo';
        if (dbSub) dbSub.textContent = subText || 'Data Simulasi Lokal';
      } else if (online === null || online === undefined) {
        dbText.textContent = text || 'Database: Menghubungkan...';
        if (dbSub) dbSub.textContent = subText || 'Supabase Cloud';
      } else if (online) {
        dbText.textContent = text || 'Database: Terhubung';
        if (dbSub) dbSub.textContent = subText || 'Supabase Cloud (Tabel telemetry)';
      } else {
        dbText.textContent = text || 'Database: Terputus';
        if (dbSub) dbSub.textContent = subText || 'Gagal Konek Supabase';
      }
    }

    // Sinkronisasi ke Mobile Status Hub
    const mDbDot = document.getElementById('m-db-status-dot');
    const mDbText = document.getElementById('m-db-status-text');
    const mDbSub = document.getElementById('m-db-status-sub');
    const mQuickLabel = document.getElementById('m-quick-demo-toggle-label');

    if (mDbDot && mDbText) {
      mDbDot.className = dotClass;
      if (isDemo) {
        mDbText.textContent = text || 'Database: Mode Demo';
        if (mDbSub) mDbSub.textContent = subText || 'Data Simulasi Lokal';
      } else if (online === null || online === undefined) {
        mDbText.textContent = text || 'Database: Menghubungkan...';
        if (mDbSub) mDbSub.textContent = subText || 'Supabase Cloud';
      } else if (online) {
        mDbText.textContent = text || 'Database: Terhubung';
        if (mDbSub) mDbSub.textContent = subText || 'Supabase Cloud (Online)';
      } else {
        mDbText.textContent = text || 'Database: Terputus';
        if (mDbSub) mDbSub.textContent = subText || 'Gagal Konek Supabase';
      }
    }
    const dQuickLabel = document.getElementById('quick-demo-toggle-label');
    if (mQuickLabel) {
      mQuickLabel.textContent = (state.connectionMode === 'demo') ? '📡 Sensor Realtime' : '🧪 Buka Demo';
    }
    if (dQuickLabel) {
      dQuickLabel.textContent = (state.connectionMode === 'demo') ? '📡 Sensor Realtime' : '🧪 Buka Mode Demo';
    }

    evaluateEsp32Status();
  }

  // ─── WATCHDOG KONEKSI ESP32 (Sesuai Permintaan: Online jika data baru <= 15 detik) ───
  function evaluateEsp32Status() {
    const dot = document.getElementById('esp32-dot');
    const text = document.getElementById('esp32-text');
    const timeEl = document.getElementById('esp32-time');
    const chipDot = document.getElementById('esp32-chip-dot');
    const chipText = document.getElementById('esp32-chip-text');

    if (!dot || !text) return;

    if (state.connectionMode === 'demo') {
      dot.className = 'pulse-dot demo';
      text.textContent = 'ESP32: Mode Demo';
      if (timeEl) timeEl.textContent = '(Simulasi)';
      if (chipDot) chipDot.className = 'pulse-dot demo';
      if (chipText) {
        chipText.textContent = 'ESP32: Mode Simulasi Aktif';
        chipText.style.color = 'var(--warning)';
      }
      const mEspDot = document.getElementById('m-esp32-dot');
      const mEspText = document.getElementById('m-esp32-text');
      const mEspTime = document.getElementById('m-esp32-time');
      if (mEspDot) mEspDot.className = 'pulse-dot demo';
      if (mEspText) mEspText.textContent = 'ESP32: Mode Demo';
      if (mEspTime) mEspTime.textContent = 'Simulasi Layar';
      return;
    }

    if (!state.lastEsp32Heartbeat) {
      state.isHardwareOnline = false;
      dot.className = 'pulse-dot offline';
      text.textContent = 'ESP32: Belum Terhubung';
      if (timeEl) timeEl.textContent = '(Menunggu alat...)';
      if (chipDot) chipDot.className = 'pulse-dot offline';
      if (chipText) {
        chipText.textContent = 'ESP32: Belum Terhubung (Menunggu Data)';
        chipText.style.color = 'var(--danger)';
      }
      const mEspDot = document.getElementById('m-esp32-dot');
      const mEspText = document.getElementById('m-esp32-text');
      const mEspTime = document.getElementById('m-esp32-time');
      if (mEspDot) mEspDot.className = 'pulse-dot offline';
      if (mEspText) mEspText.textContent = 'ESP32: Belum Terhubung';
      if (mEspTime) mEspTime.textContent = 'Menunggu koneksi...';
      return;
    }

    // Hitung selisih waktu telemetri terhadap waktu sekarang (dalam detik)
    const diff = Math.max(0, Math.round((Date.now() - state.lastEsp32Heartbeat.getTime()) / 1000));
    const prevOnline = state.isHardwareOnline;
    // ESP32 mengirim data tiap 3 detik. Jika data lebih dari 15 detik lalu, ESP32 OFF!
    state.isHardwareOnline = (diff <= 15);

    const timeStr = state.lastEsp32Heartbeat.toLocaleTimeString('id-ID');

    if (state.isHardwareOnline) {
      const liveStr = diff <= 2 ? 'Live' : `${diff}s lalu`;
      dot.className = 'pulse-dot';
      text.textContent = 'ESP32: Terhubung (Online)';
      if (timeEl) timeEl.textContent = `(${liveStr})`;
      if (chipDot) chipDot.className = 'pulse-dot';
      if (chipText) {
        chipText.textContent = `ESP32: Terhubung (Online) (${liveStr})`;
        chipText.style.color = 'var(--success)';
      }
    } else {
      const agoStr = diff < 60 ? `(${diff}d lalu)` : (diff < 3600 ? `(${Math.round(diff / 60)}m lalu)` : `(Terakhir ${timeStr})`);
      dot.className = 'pulse-dot offline';
      text.textContent = 'ESP32: Terputus (Offline)';
      if (timeEl) timeEl.textContent = agoStr;
      if (chipDot) chipDot.className = 'pulse-dot offline';
      if (chipText) {
        chipText.textContent = `ESP32: Terputus (Offline) (Terakhir ${timeStr})`;
        chipText.style.color = 'var(--danger)';
      }

      // Kosongkan sensor riil dan matikan status aktuator jika ESP32 mati/offline
      state.sensors.suhu = null;
      state.sensors.kelembapan = null;
      state.sensors.amonia = null;
      state.actuators.pwmIntake = 0;
      state.actuators.pwmExhaust = 0;
      state.actuators.pwmPemanas = 0;
      state.actuators.statusKonveyor = false;
      state.fuzzy = null;
    }

    // Sinkronisasi status ESP32 ke Mobile Status Hub
    const mEspDot = document.getElementById('m-esp32-dot');
    const mEspText = document.getElementById('m-esp32-text');
    const mEspTime = document.getElementById('m-esp32-time');

    if (mEspDot && mEspText) {
      if (state.isHardwareOnline) {
        mEspDot.className = 'pulse-dot';
        mEspText.textContent = 'ESP32: Terhubung (Online)';
        if (mEspTime) mEspTime.textContent = diff <= 2 ? `Live (${timeStr})` : `${diff}s lalu (${timeStr})`;
      } else {
        mEspDot.className = 'pulse-dot offline';
        mEspText.textContent = 'ESP32: Terputus (Offline)';
        if (mEspTime) mEspTime.textContent = diff < 60 ? `${diff}s lalu (${timeStr})` : `Terakhir: ${timeStr}`;
      }
    }

    if (prevOnline !== state.isHardwareOnline) {
      renderUI();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 3. UI RENDERING & DOM UPDATE
  // ════════════════════════════════════════════════════════════════

  function getStatusType(val, limits) {
    if (limits.minCold && val <= limits.minCold) return 'warning';
    if (limits.minDry && val <= limits.minDry) return 'warning';
    if (val >= limits.danger) return 'danger';
    if (val >= limits.warning) return 'warning';
    return 'normal';
  }

  function renderUI() {
    const s = state.sensors;
    const f = state.fuzzy;
    const isOnline = state.connectionMode === 'demo' ? true : state.isHardwareOnline;

    // Header Clock
    const clockEl = document.getElementById('header-clock');
    if (clockEl) {
      clockEl.textContent = new Date().toLocaleTimeString('id-ID');
    }

    // Condition Badge (Dashboard)
    const condBadge = document.getElementById('cond-badge');
    if (condBadge) {
      if (!isOnline) {
        condBadge.className = 'cond-badge offline';
        condBadge.textContent = 'ESP32 Terputus (Offline)';
      } else if (f) {
        condBadge.className = `cond-badge ${f.statusClass}`;
        condBadge.textContent = f.conditionLabel;
      } else {
        condBadge.className = 'cond-badge';
        condBadge.textContent = 'Menunggu Sensor...';
      }
    }

    // Panel Demo Visibility & Feedback
    const demoPanel = document.getElementById('demo-interactive-panel');
    if (demoPanel) {
      demoPanel.style.display = (state.connectionMode === 'demo') ? 'block' : 'none';
    }

    const quickToggleLabel = document.getElementById('quick-demo-toggle-label');
    if (quickToggleLabel) {
      quickToggleLabel.textContent = (state.connectionMode === 'demo') ? '📡 Sensor Realtime' : '🧪 Buka Mode Demo (Semhas)';
    }
    const mQuickLabel = document.getElementById('m-quick-demo-toggle-label');
    if (mQuickLabel) {
      mQuickLabel.textContent = (state.connectionMode === 'demo') ? '📡 Sensor Realtime' : '🧪 Buka Demo';
    }

    // Subtext Baku Kartu Sensor Dashboard Sesuai Bab III Proposal Skripsi
    const subTemp = document.querySelector('#val-temp')?.closest('.sensor-card')?.querySelector('.card-subtext');
    if (subTemp) {
      subTemp.innerHTML = '<span>Zona Nyaman: 20–25°C</span><span>Batas Kritis: &ge; 31°C</span>';
    }
    const subHum = document.querySelector('#val-humid')?.closest('.sensor-card')?.querySelector('.card-subtext');
    if (subHum) {
      subHum.innerHTML = '<span>Optimal: 60–80%</span><span>Batas Kritis: &ge; 90%</span>';
    }
    const subNh3 = document.querySelector('#val-ammonia')?.closest('.sensor-card')?.querySelector('.card-subtext');
    if (subNh3) {
      subNh3.innerHTML = '<span>Batas Aman: &lt; 20 ppm</span><span>Batas Kritis: &ge; 30 ppm</span>';
    }

    // ─── 1. Sensor Cards (Suhu, Kelembapan, Gas Amonia) ───
    if (!isOnline || s.suhu === null) {
      renderOfflineSensorCard('temp', !isOnline ? 'OFFLINE' : 'TERPUTUS');
    } else {
      updateCard('temp', s.suhu, THRESHOLDS.temperature, '°C');
    }

    if (!isOnline || s.kelembapan === null) {
      renderOfflineSensorCard('humid', !isOnline ? 'OFFLINE' : 'TERPUTUS');
    } else {
      updateCard('humid', s.kelembapan, THRESHOLDS.humidity, '%');
    }

    if (!isOnline || s.amonia === null) {
      renderOfflineSensorCard('ammonia', !isOnline ? 'OFFLINE' : 'TERPUTUS');
    } else {
      updateCard('ammonia', s.amonia, THRESHOLDS.ammonia, 'ppm');
    }

    // ─── 2. Actuator Cards (Dashboard) ───
    if (!isOnline) {
      renderOfflineActuatorCard('fan-in');
      renderOfflineActuatorCard('fan-out');
      renderOfflineActuatorCard('heater');
      renderOfflineActuatorCard('conveyor');
    } else {
      updateActuatorCard('fan-in', state.actuators.pwmIntake > 0, state.actuators.pwmIntake);
      updateActuatorCard('fan-out', state.actuators.pwmExhaust > 0, state.actuators.pwmExhaust);
      updateActuatorCard('heater', state.actuators.pwmPemanas > 0, state.actuators.pwmPemanas);
      updateActuatorCard('conveyor', state.actuators.statusKonveyor, state.actuators.statusKonveyor ? 100 : 0);
    }

    // ─── 3. Fuzzifikasi 5 Himpunan Keanggotaan ───
    updateMembershipDisplay(isOnline && f ? f.membership : null);

    // ─── 4. Tabel Aturan Mamdani ───
    renderRulesTable();

    // ─── 5. Notification Bell Badge ───
    const notifBadge = document.getElementById('notif-badge');
    if (notifBadge) {
      if (state.unreadCount > 0) {
        notifBadge.style.display = 'flex';
        notifBadge.textContent = state.unreadCount;
      } else {
        notifBadge.style.display = 'none';
      }
    }

    // ─── 6. History Chart (Jika tab Riwayat Grafik aktif) ───
    if (state.currentView === 'history') {
      renderCanvasChart();
    }
  }

  function renderOfflineSensorCard(idPrefix, labelText = 'OFFLINE') {
    const valEl = document.getElementById(`val-${idPrefix}`);
    const badgeEl = document.getElementById(`badge-${idPrefix}`);
    const barEl = document.getElementById(`bar-${idPrefix}`);

    if (valEl) valEl.textContent = '--';
    if (badgeEl) {
      badgeEl.className = 'card-badge offline';
      badgeEl.textContent = labelText;
    }
    if (barEl) {
      barEl.style.width = '0%';
      barEl.className = 'progress-bar';
    }
  }

  function renderOfflineActuatorCard(idPrefix) {
    const card = document.getElementById(`act-${idPrefix}`);
    const pill = document.getElementById(`pill-${idPrefix}`);
    const dutyVal = document.getElementById(`duty-val-${idPrefix}`);
    const dutyFill = document.getElementById(`duty-fill-${idPrefix}`);

    if (card) {
      card.classList.remove('on');
      card.classList.remove('fan-active');
      card.classList.remove('heater-active');
      card.classList.remove('conveyor-active');
    }
    if (pill) pill.textContent = 'OFF';
    if (dutyVal) dutyVal.textContent = '--%';
    if (dutyFill) dutyFill.style.width = '0%';
  }

  function updateCard(idPrefix, val, limits, unit) {
    const valEl = document.getElementById(`val-${idPrefix}`);
    const badgeEl = document.getElementById(`badge-${idPrefix}`);
    const barEl = document.getElementById(`bar-${idPrefix}`);
    if (!valEl) return;

    const status = getStatusType(val, limits);
    valEl.textContent = val.toFixed(1);

    if (badgeEl) {
      badgeEl.className = `card-badge ${status}`;
      if (limits.minCold && val <= limits.minCold) {
        badgeEl.textContent = 'DINGIN';
      } else if (limits.minDry && val <= limits.minDry) {
        badgeEl.textContent = 'KERING';
      } else {
        badgeEl.textContent = status === 'danger' ? 'BAHAYA' : (status === 'warning' ? 'WASPADA' : 'NORMAL');
      }
    }

    if (barEl) {
      const pct = Math.min(100, Math.max(0, ((val - limits.min) / (limits.max - limits.min)) * 100));
      barEl.style.width = `${pct}%`;
      barEl.className = `progress-bar ${status}`;
    }
  }

  function updateActuatorCard(idPrefix, isOn, dutyPct) {
    const card = document.getElementById(`act-${idPrefix}`);
    const pill = document.getElementById(`pill-${idPrefix}`);
    const dutyVal = document.getElementById(`duty-val-${idPrefix}`);
    const dutyFill = document.getElementById(`duty-fill-${idPrefix}`);

    if (card) {
      if (isOn) {
        card.classList.add('on');
        if (idPrefix === 'fan-in' || idPrefix === 'fan-out') {
          card.classList.add('fan-active');
          const speed = Math.max(0.25, (110 - dutyPct) / 80).toFixed(2);
          card.style.setProperty('--fan-speed', `${speed}s`);
        } else if (idPrefix === 'heater') {
          card.classList.add('heater-active');
        } else if (idPrefix === 'conveyor') {
          card.classList.add('conveyor-active');
        }
      } else {
        card.classList.remove('on');
        card.classList.remove('fan-active');
        card.classList.remove('heater-active');
        card.classList.remove('conveyor-active');
      }
    }

    if (pill) {
      pill.textContent = isOn ? 'ON' : 'OFF';
    }

    if (idPrefix === 'conveyor') {
      if (dutyVal) dutyVal.textContent = isOn ? 'ON' : 'OFF';
      if (dutyFill) dutyFill.style.width = isOn ? '100%' : '0%';
    } else {
      if (dutyVal) dutyVal.textContent = `${dutyPct}%`;
      if (dutyFill) dutyFill.style.width = `${dutyPct}%`;
    }
  }

  // Update visualisasi 15 kurva himpunan keanggotaan
  function updateMembershipDisplay(mem) {
    if (!mem) {
      // Jika sensor terputus / offline, bersihkan bar keanggotaan ke 0
      const ids = [
        'm-temp-sd', 'm-temp-d', 'm-temp-n', 'm-temp-p', 'm-temp-sp',
        'm-hum-sk', 'm-hum-k', 'm-hum-n', 'm-hum-b', 'm-hum-sb',
        'm-nh3-sr', 'm-nh3-r', 'm-nh3-s', 'm-nh3-t', 'm-nh3-st'
      ];
      ids.forEach(id => setBarVal(id, 0));
      return;
    }
    // Suhu (5 himpunan)
    setBarVal('m-temp-sd', mem.temp.SD);
    setBarVal('m-temp-d',  mem.temp.D);
    setBarVal('m-temp-n',  mem.temp.N);
    setBarVal('m-temp-p',  mem.temp.P);
    setBarVal('m-temp-sp', mem.temp.SP);

    // Kelembapan (5 himpunan)
    setBarVal('m-hum-sk', mem.humid.SK);
    setBarVal('m-hum-k',  mem.humid.K);
    setBarVal('m-hum-n',  mem.humid.N);
    setBarVal('m-hum-b',  mem.humid.B);
    setBarVal('m-hum-sb', mem.humid.SB);

    // Amonia (5 himpunan)
    setBarVal('m-nh3-sr', mem.ammonia.SR);
    setBarVal('m-nh3-r',  mem.ammonia.R);
    setBarVal('m-nh3-s',  mem.ammonia.S);
    setBarVal('m-nh3-t',  mem.ammonia.T);
    setBarVal('m-nh3-st', mem.ammonia.ST);
  }

  function setBarVal(id, val) {
    const bar = document.getElementById(id);
    const txt = document.getElementById(`${id}-val`);
    const num = Number(val || 0);
    if (bar) bar.style.width = `${Math.min(100, Math.round(num * 100))}%`;
    if (txt) txt.textContent = num.toFixed(2);
  }

  // Render tabel aturan (Aktif Saja vs Semua 125 Aturan)
  function renderRulesTable() {
    const tbody = document.getElementById('active-rules-body');
    if (!tbody || !state.fuzzy) return;

    if (state.rulesDisplayMode === 'active') {
      const activeRules = state.fuzzy.activeRules;
      if (activeRules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">Tidak ada aturan yang aktif (&mu; = 0)</td></tr>';
        return;
      }

      tbody.innerHTML = activeRules.map(r => `
        <tr>
          <td><span class="rule-id-badge">R${String(r.id).padStart(3, '0')}</span></td>
          <td style="font-family:var(--font-mono);font-size:12px;">${r.antecedent}</td>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-main);">${r.consequent}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:var(--primary);text-align:right;">
            &alpha; = ${r.alpha.toFixed(2)}
          </td>
        </tr>
      `).join('');
    } else {
      // Tampilkan seluruh 125 aturan dengan pencarian
      const query = (state.rulesSearchQuery || '').toLowerCase();
      const activeMap = new Map();
      state.fuzzy.activeRules.forEach(r => activeMap.set(r.id, r.alpha));

      const filtered = RULE_BASE_125.filter(r => {
        if (!query) return true;
        const text = `r${r.id} ${r.antecedent} ${r.consequent}`.toLowerCase();
        return text.includes(query);
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">Tidak ada aturan yang cocok dengan pencarian</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(r => {
        const activeAlpha = activeMap.get(r.id);
        const isActive = activeAlpha !== undefined && activeAlpha > 0.001;
        const rowBg = isActive ? 'background:rgba(255, 107, 0, 0.06);' : '';
        const badgeStyle = isActive ? 'border-color:var(--primary);font-weight:800;' : 'opacity:0.7;';

        return `
          <tr style="${rowBg}">
            <td><span class="rule-id-badge" style="${badgeStyle}">R${String(r.id).padStart(3, '0')}</span></td>
            <td style="font-family:var(--font-mono);font-size:12px;">${r.antecedent}</td>
            <td style="font-family:var(--font-mono);font-size:11px;">${r.consequent}</td>
            <td style="font-family:var(--font-mono);font-weight:${isActive?'700':'400'};color:${isActive?'var(--primary)':'var(--text-muted)'};text-align:right;">
              ${isActive ? `&alpha; = ${activeAlpha.toFixed(2)}` : '0.00'}
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 4. PURE HTML5 CANVAS REALTIME CHART
  // ════════════════════════════════════════════════════════════════

  function renderCanvasChart() {
    const canvas = document.getElementById('history-chart-canvas');
    if (!canvas) return;

    // Pasang ResizeObserver agar kanvas selalu responsif terhadap perubahan ukuran container
    if (canvas.parentElement && window.ResizeObserver && !window._chartResizeObserved) {
      window._chartResizeObserved = true;
      const ro = new ResizeObserver(() => {
        if (state.currentView === 'history') {
          renderCanvasChart();
        }
      });
      ro.observe(canvas.parentElement);
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.parentElement.clientWidth;
    const parentH = canvas.parentElement.clientHeight;
    const h = parentH > 150 ? parentH : 380;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const padLeft = 45;
    const padRight = 25;
    const padTop = 20;
    const padBottom = 38;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    const minY = 0;
    const maxY = 100;

    const data = state.history;
    if (!data || data.length === 0) {
      // Gambarkan grid horizontal tetap ada
      ctx.strokeStyle = '#EEF0F4';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'right';

      for (let step = 0; step <= 100; step += 25) {
        const y = padTop + chartH - (step / maxY) * chartH;
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(step.toString(), padLeft - 8, y + 3);
      }

      ctx.fillStyle = '#64748B';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      const rangeLabel = state.chartRange === '24h' ? '24 Jam' : (state.chartRange === '6h' ? '6 Jam' : '1 Jam');
      ctx.fillText(`Tidak ada data sensor di database dalam rentang ${rangeLabel} terakhir.`, w / 2, h / 2 - 14);
      ctx.fillStyle = '#94A3B8';
      ctx.font = '12px Inter, sans-serif';
      if (state.lastEsp32Heartbeat) {
        const lastStr = state.lastEsp32Heartbeat.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';
        ctx.fillText(`Sensor ESP32 Offline (Terakhir tercatat di database: ${lastStr}).`, w / 2, h / 2 + 10);
      } else {
        ctx.fillText('(Hardware ESP32 dalam status offline / belum ada pengiriman data)', w / 2, h / 2 + 10);
      }
      ctx.fillStyle = '#FF6B00';
      ctx.font = '500 11px Inter, sans-serif';
      ctx.fillText('💡 Klik tombol "6 Jam" atau "24 Jam" di atas untuk melihat riwayat data dari database', w / 2, h / 2 + 34);
      return;
    }

    // 1. Garis Grid Horizontal & Skala Y (0, 25, 50, 75, 100)
    ctx.strokeStyle = '#E2E4EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8C90A0';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';

    for (let step = 0; step <= 100; step += 25) {
      const y = padTop + chartH - (step / maxY) * chartH;
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(step.toString(), padLeft - 8, y + 3);
    }

    // 2. Skala Sumbu X & Garis Grid Vertikal Sesuai Rentang Jam (1 Jam / 6 Jam / 24 Jam)
    const rangeHours = state.chartRange === '24h' ? 24 : (state.chartRange === '6h' ? 6 : 1);
    const nowTime = Date.now();
    const durationMs = rangeHours * 3600 * 1000;
    const startTime = nowTime - durationMs;

    // Tentukan interval pembagian jam
    let tickCount = 4; // 1 Jam: tiap 15 menit
    if (rangeHours === 6) tickCount = 6; // 6 Jam: tiap 1 jam
    if (rangeHours === 24) tickCount = 6; // 24 Jam: tiap 4 jam

    for (let k = 0; k <= tickCount; k++) {
      const ratio = k / tickCount;
      const x = padLeft + ratio * chartW;
      const tTick = new Date(startTime + ratio * durationMs);

      // Garis grid vertikal putus-putus
      ctx.strokeStyle = '#EEF0F4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label jam di bawah sumbu X
      ctx.fillStyle = '#8C90A0';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = k === 0 ? 'left' : (k === tickCount ? 'right' : 'center');

      const timeStr = tTick.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      let label = timeStr;
      if (rangeHours === 24) {
        const dateStr = tTick.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
        label = k === 0 || k === tickCount ? `${dateStr} ${timeStr}` : timeStr;
      }
      ctx.fillText(label, x, padTop + chartH + 18);
    }

    // 3. Gambar Kurva Tiap Sensor (Kelembapan, Suhu, Amonia)
    function drawSeries(key, color, fillRgba) {
      const sorted = [...data].sort((a, b) => {
        const ta = a.time instanceof Date ? a.time.getTime() : new Date(a.time).getTime();
        const tb = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
        return ta - tb;
      });

      const points = [];
      for (let i = 0; i < sorted.length; i++) {
        const item = sorted[i];
        if (item[key] === null || item[key] === undefined || isNaN(item[key]) || item[key] < 0) continue;
        const itemTime = item.time instanceof Date ? item.time.getTime() : new Date(item.time).getTime();
        if (itemTime < startTime || itemTime > nowTime) continue;
        const tRatio = Math.max(0, Math.min(1, (itemTime - startTime) / durationMs));
        const x = padLeft + tRatio * chartW;
        const val = Math.min(maxY, Math.max(minY, Number(item[key])));
        const y = padTop + chartH - (val / maxY) * chartH;
        points.push({ x, y });
      }

      if (points.length === 0) return;

      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        if (i === 0) ctx.moveTo(points[i].x, points[i].y);
        else ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      if (fillRgba && points.length > 1) {
        ctx.lineTo(points[points.length - 1].x, padTop + chartH);
        ctx.lineTo(points[0].x, padTop + chartH);
        ctx.closePath();
        ctx.fillStyle = fillRgba;
        ctx.fill();
      }

      // Titik indikator lingkaran di data terkini
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    drawSeries('kelembapan', '#0284C7', 'rgba(2, 132, 199, 0.05)');
    drawSeries('suhu',       '#FF6B00', 'rgba(255, 107, 0, 0.08)');
    drawSeries('amonia',     '#10B981', 'rgba(16, 185, 129, 0.08)');

    // 4. Garis Vertikal & Titik Saat Kursor Mengarah ke Grafik (Hover)
    if (state.hoveredChartPoint) {
      const hPt = state.hoveredChartPoint;
      const hTime = hPt.time instanceof Date ? hPt.time.getTime() : new Date(hPt.time).getTime();

      const tRatio = Math.max(0, Math.min(1, (hTime - startTime) / durationMs));
      const hX = padLeft + tRatio * chartW;

      // Garis vertikal tipis seperti referensi (Humidity Analytics)
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hX, padTop);
      ctx.lineTo(hX, padTop + chartH);
      ctx.stroke();

      // Titik lingkaran pada masing-masing kurva
      const seriesData = [
        { val: hPt.kelembapan, color: '#0284C7' },
        { val: hPt.suhu,       color: '#FF6B00' },
        { val: hPt.amonia,     color: '#10B981' }
      ];

      seriesData.forEach(s => {
        if (s.val === null || s.val === undefined || isNaN(s.val) || s.val < 0) return;
        const val = Math.min(maxY, Math.max(minY, Number(s.val)));
        const y = padTop + chartH - (val / maxY) * chartH;

        // Lingkaran luar halus
        ctx.beginPath();
        ctx.arc(hX, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Lingkaran dalam solid dengan border putih
        ctx.beginPath();
        ctx.arc(hX, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
  }

  function updateChartTooltip(item, mouseX, mouseY) {
    let tooltip = document.getElementById('chart-tooltip');
    if (!tooltip) {
      const container = document.querySelector('#view-history .canvas-container');
      if (container) {
        tooltip = document.createElement('div');
        tooltip.id = 'chart-tooltip';
        tooltip.className = 'chart-tooltip';
        container.appendChild(tooltip);
      }
    }
    if (!tooltip) return;

    if (!item) {
      tooltip.style.display = 'none';
      return;
    }

    const t = item.time instanceof Date ? item.time : new Date(item.time);
    const timeExact = t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';
    let titleStr = timeExact;
    if (state.chartRange === '24h') {
      const dateStr = t.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
      titleStr = `${dateStr} • ${timeExact}`;
    }

    const tVal = (item.suhu !== null && item.suhu !== undefined && item.suhu >= 0) ? `${Number(item.suhu).toFixed(1)} °C` : '-- (Terputus)';
    const hVal = (item.kelembapan !== null && item.kelembapan !== undefined && item.kelembapan >= 0) ? `${Number(item.kelembapan).toFixed(1)} %` : '-- (Terputus)';
    const aVal = (item.amonia !== null && item.amonia !== undefined && item.amonia >= 0) ? `${Number(item.amonia).toFixed(1)} ppm` : '-- (Terputus)';

    tooltip.innerHTML = `
      <div class="chart-tooltip-time">${titleStr}</div>
      <div class="chart-tooltip-row temp">
        <span class="label">Suhu :</span>
        <span class="val">${tVal}</span>
      </div>
      <div class="chart-tooltip-row humid">
        <span class="label">Kelembapan :</span>
        <span class="val">${hVal}</span>
      </div>
      <div class="chart-tooltip-row ammonia">
        <span class="label">Gas Amonia :</span>
        <span class="val">${aVal}</span>
      </div>
    `;

    tooltip.style.display = 'block';

    const container = tooltip.parentElement;
    if (!container) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const tw = tooltip.offsetWidth || 180;
    const th = tooltip.offsetHeight || 105;

    // Posisikan tooltip di sebelah kanan kursor, atau di kiri jika mendekati batas kanan
    let left = mouseX + 16;
    if (left + tw > cw - 12) {
      left = mouseX - tw - 16;
    }
    if (left < 10) left = 10;

    let top = (mouseY || 60) - th / 2;
    if (top < 10) top = 10;
    if (top + th > ch - 10) top = ch - th - 10;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function handleChartPointerMove(e) {
    const canvas = document.getElementById('history-chart-canvas');
    if (!canvas || !state.history || state.history.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    let clientX = e.clientX !== undefined ? e.clientX - rect.left : 0;
    let clientY = e.clientY !== undefined ? e.clientY - rect.top : 0;
    if (e.touches && e.touches[0]) {
      clientX = e.touches[0].clientX - rect.left;
      clientY = e.touches[0].clientY - rect.top;
    }

    const w = canvas.parentElement.clientWidth;
    const parentH = canvas.parentElement.clientHeight;
    const h = parentH > 150 ? parentH : 380;
    const padLeft = 45;
    const padRight = 25;
    const padTop = 20;
    const padBottom = 38;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    if (clientX < padLeft || clientX > w - padRight) {
      if (state.hoveredChartPoint) {
        state.hoveredChartPoint = null;
        updateChartTooltip(null);
        renderCanvasChart();
      }
      return;
    }

    const rangeHours = state.chartRange === '24h' ? 24 : (state.chartRange === '6h' ? 6 : 1);
    const nowTime = Date.now();
    const durationMs = rangeHours * 3600 * 1000;
    const startTime = nowTime - durationMs;

    const ratio = Math.max(0, Math.min(1, (clientX - padLeft) / chartW));
    const targetTime = startTime + ratio * durationMs;

    // Cari titik telemetri yang terdekat dengan posisi kursor horizontal
    let closest = null;
    let minDiff = Infinity;
    for (const item of state.history) {
      const itemTime = item.time instanceof Date ? item.time.getTime() : new Date(item.time).getTime();
      const diff = Math.abs(itemTime - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = item;
      }
    }

    if (closest) {
      const cTime = closest.time instanceof Date ? closest.time.getTime() : new Date(closest.time).getTime();
      const ptRatio = Math.max(0, Math.min(1, (cTime - startTime) / durationMs));
      const ptX = padLeft + ptRatio * chartW;

      // Hanya tampilkan penunjuk jika kursor dekat dengan titik data nyata (dalam radius 35px)
      if (Math.abs(clientX - ptX) <= 35) {
        state.hoveredChartPoint = closest;
        renderCanvasChart();
        updateChartTooltip(closest, ptX, clientY);
      } else {
        if (state.hoveredChartPoint) {
          state.hoveredChartPoint = null;
          updateChartTooltip(null);
          renderCanvasChart();
        }
      }
    }
  }

  function handleChartPointerLeave(e) {
    const container = document.querySelector('#view-history .canvas-container');
    if (e && e.relatedTarget && container && container.contains(e.relatedTarget)) {
      return;
    }
    if (state.hoveredChartPoint) {
      state.hoveredChartPoint = null;
      updateChartTooltip(null);
      renderCanvasChart();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5. EVENT LISTENERS & LIVE SIMULATOR
  // ════════════════════════════════════════════════════════════════

  function initEvents() {
    // Navigasi Link View (Sidebar & Mobile)
    const links = document.querySelectorAll('[data-view]');
    links.forEach(l => {
      l.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = l.getAttribute('data-view');
        switchView(targetView);
      });
    });

    // Event Kursor Mengarah ke Grafik (Hover Tooltip Persis Seperti Referensi)
    const chartContainer = document.querySelector('#view-history .canvas-container');
    if (chartContainer) {
      chartContainer.addEventListener('mousemove', handleChartPointerMove);
      chartContainer.addEventListener('click', handleChartPointerMove);
      chartContainer.addEventListener('mouseleave', handleChartPointerLeave);
      chartContainer.addEventListener('touchmove', handleChartPointerMove, { passive: true });
      chartContainer.addEventListener('touchstart', handleChartPointerMove, { passive: true });
      chartContainer.addEventListener('touchend', handleChartPointerLeave);
    }

    // Tombol Filter Rentang Grafik
    const chartBtns = document.querySelectorAll('.chart-btn[data-range]');
    chartBtns.forEach(b => {
      b.addEventListener('click', async () => {
        chartBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.chartRange = b.getAttribute('data-range');
        state.hoveredChartPoint = null;
        updateChartTooltip(null);
        await fetchChartHistory(state.chartRange);
      });
    });

    // Tombol Tab Aturan Mamdani (Aktif vs Semua 125 Aturan)
    const btnActiveRules = document.getElementById('btn-show-active-rules');
    const btnAllRules = document.getElementById('btn-show-all-rules');
    const headingRules = document.getElementById('rules-view-heading');
    const searchRules = document.getElementById('rule-search-input');

    if (btnActiveRules && btnAllRules) {
      btnActiveRules.addEventListener('click', () => {
        state.rulesDisplayMode = 'active';
        btnActiveRules.classList.add('active');
        btnAllRules.classList.remove('active');
        if (headingRules) headingRules.textContent = 'Daftar Aturan yang Sedang Aktif:';
        if (searchRules) searchRules.style.display = 'none';
        renderRulesTable();
      });

      btnAllRules.addEventListener('click', () => {
        state.rulesDisplayMode = 'all';
        btnAllRules.classList.add('active');
        btnActiveRules.classList.remove('active');
        if (headingRules) headingRules.textContent = 'Seluruh 125 Aturan Mamdani (5 × 5 × 5):';
        if (searchRules) {
          searchRules.style.display = 'inline-block';
          searchRules.focus();
        }
        renderRulesTable();
      });
    }

    if (searchRules) {
      searchRules.addEventListener('input', (e) => {
        state.rulesSearchQuery = e.target.value;
        renderRulesTable();
      });
    }

    // Filter Tanggal Log Sensor
    const btnFilter = document.getElementById('btn-filter-logs');
    if (btnFilter) {
      btnFilter.addEventListener('click', () => {
        const s = document.getElementById('log-date-start')?.value;
        const e = document.getElementById('log-date-end')?.value;
        fetchSensorLogs(s, e);
      });
    }

    const btnResetLogs = document.getElementById('btn-reset-logs');
    if (btnResetLogs) {
      btnResetLogs.addEventListener('click', () => {
        const today = new Date().toISOString().slice(0, 10);
        const inputS = document.getElementById('log-date-start');
        const inputE = document.getElementById('log-date-end');
        if (inputS) inputS.value = today;
        if (inputE) inputE.value = today;
        fetchSensorLogs(today, today);
      });
    }

    const btnExport = document.getElementById('btn-export-logs');
    if (btnExport) {
      btnExport.addEventListener('click', exportLogsToCSV);
    }

    // ─── Live Simulator Slider ────────────────────────────────────
    const simTemp = document.getElementById('sim-temp');
    const simHum = document.getElementById('sim-hum');
    const simNh3 = document.getElementById('sim-nh3');

    function onSimSliderChange() {
      const t = parseFloat(simTemp.value);
      const h = parseFloat(simHum.value);
      const a = parseFloat(simNh3.value);

      document.getElementById('sim-temp-val').textContent = `${t.toFixed(1)} °C`;
      document.getElementById('sim-hum-val').textContent = `${h.toFixed(1)} %`;
      document.getElementById('sim-nh3-val').textContent = `${a.toFixed(1)} ppm`;

      const simFuzzy = computeFuzzyMamdani(t, h, a);
      updateMembershipDisplay(simFuzzy.membership);

      // Tampilkan hasil defuzzifikasi Centroid & Scaling PWM
      const simOutBox = document.getElementById('sim-output-text');
      if (simOutBox) {
        simOutBox.innerHTML = `
          <div style="margin-bottom:4px;">
            <strong>Status Kandang:</strong> <span class="badge-condition ${simFuzzy.statusClass}">${simFuzzy.conditionLabel}</span>
            &nbsp;|&nbsp; <strong>Aturan Aktif:</strong> ${simFuzzy.activeRules.length} dari 125 Aturan
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:6px;margin-top:6px;font-size:11px;">
            <div>🌀 <strong>Intake:</strong> y*=${simFuzzy.centroid.fanIntake} &rarr; <strong>${simFuzzy.crisp.fanIntake}% PWM</strong></div>
            <div>💨 <strong>Exhaust:</strong> y*=${simFuzzy.centroid.fanExhaust} &rarr; <strong>${simFuzzy.crisp.fanExhaust}% PWM</strong></div>
            <div>🔥 <strong>Pemanas:</strong> y*=${simFuzzy.centroid.heater} &rarr; <strong>${simFuzzy.crisp.heater}% PWM</strong></div>
            <div>⚙️ <strong>Konveyor:</strong> <strong style="color:${simFuzzy.states.conveyor?'var(--success)':'var(--text-muted)'};">${simFuzzy.states.conveyor ? 'ON (AKTIF)' : 'OFF (MATI)'}</strong></div>
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">
            *Defuzzifikasi Centroid COA domain [0..100] &amp; Scaling PWM Persamaan 3.2: y_pwm = ((y* - 8.3) / 83.4) &times; 100.
          </div>
        `;
      }

      state.fuzzy = simFuzzy;
      renderRulesTable();

      // Jika dalam mode demo, sinkronkan juga ke dashboard & aktuator
      if (state.connectionMode === 'demo') {
        applyDemoValues(t, h, a);
      }
    }

    if (simTemp && simHum && simNh3) {
      simTemp.addEventListener('input', onSimSliderChange);
      simHum.addEventListener('input', onSimSliderChange);
      simNh3.addEventListener('input', onSimSliderChange);
    }

    // ─── PANEL UJI INTERAKTIF SEMINAR HASIL (MODE DEMO) ────────────
    const btnDemoManual = document.getElementById('btn-demo-manual');
    const btnDemoAuto = document.getElementById('btn-demo-auto');
    if (btnDemoManual && btnDemoAuto) {
      btnDemoManual.addEventListener('click', () => {
        state.demoSubMode = 'manual';
        localStorage.setItem('smartfarm_demo_submode', 'manual');
        btnDemoManual.classList.add('active');
        btnDemoAuto.classList.remove('active');
        applyDemoValues(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);
      });

      btnDemoAuto.addEventListener('click', () => {
        state.demoSubMode = 'auto';
        localStorage.setItem('smartfarm_demo_submode', 'auto');
        btnDemoAuto.classList.add('active');
        btnDemoManual.classList.remove('active');
        // Sesuai permintaan: demo otomatis tidak mengontrol aktuator fisik, kembalikan kontrol ke sensor riil/standby
        sendHardwareAutoCommand();
        tickDemoData();
      });

      if (state.demoSubMode === 'auto') {
        btnDemoAuto.classList.add('active');
        btnDemoManual.classList.remove('active');
      } else {
        btnDemoManual.classList.add('active');
        btnDemoAuto.classList.remove('active');
      }
    }

    // Tombol Konfigurasi IP WiFi ESP32 (Hotspot HP)
    const btnWifiIp = document.getElementById('btn-demo-wifi-ip');
    const wifiIpVal = document.getElementById('demo-wifi-ip-val');

    function updateWifiIpButton() {
      if (!wifiIpVal) return;
      const clean = (state.esp32Ip || 'http://smartfarm.local').replace(/^https?:\/\//, '');
      wifiIpVal.textContent = clean;
    }

    if (btnWifiIp) {
      updateWifiIpButton();
      btnWifiIp.addEventListener('click', () => {
        const cur = (state.esp32Ip || 'http://smartfarm.local').replace(/^https?:\/\//, '');
        const input = prompt(
          "Masukkan Alamat IP ESP32 pada Hotspot HP Anda:\n(Contoh: 192.168.43.45 atau smartfarm.local)",
          cur
        );
        if (input !== null && input.trim() !== '') {
          let val = input.trim();
          if (!val.startsWith('http://') && !val.startsWith('https://')) {
            val = 'http://' + val;
          }
          val = val.replace(/\/+$/, '');
          state.esp32Ip = val;
          localStorage.setItem('smartfarm_esp32_ip', val);
          updateWifiIpButton();
          testEsp32Connection(val);

          if (state.demoSubMode === 'manual') {
            sendHardwareDemoCommand(state.demoValues.suhu, state.demoValues.kelembapan, state.demoValues.amonia);
          }
        }
      });
    }

    const btnCollapse = document.getElementById('btn-demo-collapse');
    const demoBody = document.getElementById('demo-panel-body');
    if (btnCollapse && demoBody) {
      btnCollapse.addEventListener('click', () => {
        demoBody.classList.toggle('collapsed');
        btnCollapse.textContent = demoBody.classList.contains('collapsed') ? '▲' : '▼';
      });
    }

    // Tombol Keluar dari Mode Demo & Quick Toggle Sidebar
    const btnExitDemo = document.getElementById('btn-exit-demo');
    if (btnExitDemo) {
      btnExitDemo.addEventListener('click', () => {
        switchConnectionMode('supabase');
      });
    }

    const btnQuickToggle = document.getElementById('btn-quick-demo-toggle');
    if (btnQuickToggle) {
      btnQuickToggle.addEventListener('click', () => {
        switchConnectionMode(state.connectionMode === 'demo' ? 'supabase' : 'demo');
      });
    }

    const btnMQuickToggle = document.getElementById('btn-m-quick-demo-toggle');
    if (btnMQuickToggle) {
      btnMQuickToggle.addEventListener('click', () => {
        switchConnectionMode(state.connectionMode === 'demo' ? 'supabase' : 'demo');
      });
    }

    // Input & Slider Interaktif Demo Panel
    const demoInTemp = document.getElementById('demo-input-temp');
    const demoSlTemp = document.getElementById('demo-slider-temp');
    const demoInHum = document.getElementById('demo-input-humid');
    const demoSlHum = document.getElementById('demo-slider-humid');
    const demoInNh3 = document.getElementById('demo-input-nh3');
    const demoSlNh3 = document.getElementById('demo-slider-nh3');

    function onDemoInteractiveChange() {
      // Beralih ke submode manual saat pengguna mengubah nilai
      state.demoSubMode = 'manual';
      localStorage.setItem('smartfarm_demo_submode', 'manual');
      if (btnDemoManual && btnDemoAuto) {
        btnDemoManual.classList.add('active');
        btnDemoAuto.classList.remove('active');
      }

      const t = parseFloat(demoInTemp?.value || demoSlTemp?.value || 24);
      const h = parseFloat(demoInHum?.value || demoSlHum?.value || 65);
      const a = parseFloat(demoInNh3?.value || demoSlNh3?.value || 12);
      applyDemoValues(t, h, a);
    }

    if (demoSlTemp) {
      demoSlTemp.addEventListener('input', (e) => {
        if (demoInTemp) demoInTemp.value = Number(e.target.value).toFixed(1);
        onDemoInteractiveChange();
      });
    }
    if (demoInTemp) {
      demoInTemp.addEventListener('input', (e) => {
        if (demoSlTemp) demoSlTemp.value = e.target.value;
        onDemoInteractiveChange();
      });
    }

    if (demoSlHum) {
      demoSlHum.addEventListener('input', (e) => {
        if (demoInHum) demoInHum.value = Number(e.target.value).toFixed(1);
        onDemoInteractiveChange();
      });
    }
    if (demoInHum) {
      demoInHum.addEventListener('input', (e) => {
        if (demoSlHum) demoSlHum.value = e.target.value;
        onDemoInteractiveChange();
      });
    }

    if (demoSlNh3) {
      demoSlNh3.addEventListener('input', (e) => {
        if (demoInNh3) demoInNh3.value = Number(e.target.value).toFixed(1);
        onDemoInteractiveChange();
      });
    }
    if (demoInNh3) {
      demoInNh3.addEventListener('input', (e) => {
        if (demoSlNh3) demoSlNh3.value = e.target.value;
        onDemoInteractiveChange();
      });
    }

    // Tombol Preset Skenario Uji Sidang Semhas
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        state.demoSubMode = 'manual';
        localStorage.setItem('smartfarm_demo_submode', 'manual');
        if (btnDemoManual && btnDemoAuto) {
          btnDemoManual.classList.add('active');
          btnDemoAuto.classList.remove('active');
        }

        const preset = btn.getAttribute('data-preset');
        if (preset === 'cold') {
          applyDemoValues(15.0, 55.0, 6.0);
        } else if (preset === 'normal') {
          applyDemoValues(24.0, 65.0, 10.0);
        } else if (preset === 'hot') {
          applyDemoValues(35.0, 70.0, 12.0);
        } else if (preset === 'ammonia') {
          applyDemoValues(26.0, 75.0, 32.0);
        } else if (preset === 'danger') {
          applyDemoValues(37.0, 92.0, 42.0);
        }
      });
    });


    // Modal Pengaturan Supabase
    const btnSettings = document.getElementById('btn-open-settings');
    const modal = document.getElementById('settings-modal');
    const modalClose = document.getElementById('modal-close');
    const btnSaveSettings = document.getElementById('btn-save-settings');

    if (btnSettings && modal) {
      btnSettings.addEventListener('click', () => {
        modal.classList.add('open');
        document.getElementById('input-conn-mode').value = state.connectionMode;
        document.getElementById('input-sb-url').value = state.supabaseUrl;
        document.getElementById('input-sb-key').value = state.supabaseKey;
        document.getElementById('input-esp32-ip').value = state.esp32Ip;
      });
    }

    if (modalClose && modal) {
      modalClose.addEventListener('click', () => modal.classList.remove('open'));
    }

    if (btnSaveSettings && modal) {
      btnSaveSettings.addEventListener('click', () => {
        const selectedMode = document.getElementById('input-conn-mode').value;
        state.supabaseUrl = document.getElementById('input-sb-url').value.trim();
        state.supabaseKey = document.getElementById('input-sb-key').value.trim();
        state.esp32Ip = document.getElementById('input-esp32-ip').value.trim();

        localStorage.setItem('smartfarm_supabase_url', state.supabaseUrl);
        localStorage.setItem('smartfarm_supabase_key', state.supabaseKey);
        localStorage.setItem('smartfarm_esp32_ip', state.esp32Ip);

        modal.classList.remove('open');
        switchConnectionMode(selectedMode);
      });
    }

    // Modal Peringatan Notifikasi
    const btnNotif = document.getElementById('btn-notif');
    const notifModal = document.getElementById('notif-modal');
    if (btnNotif && notifModal) {
      btnNotif.addEventListener('click', (e) => {
        e.stopPropagation();
        state.unreadCount = 0;
        const notifBadge = document.getElementById('notif-badge');
        if (notifBadge) notifBadge.style.display = 'none';

        const list = document.getElementById('notif-list');
        if (list) {
          if (state.notifications.length === 0) {
            list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">Tidak ada pemberitahuan baru</div>';
          } else {
            list.innerHTML = state.notifications.map(n => `
              <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;background:${n.type==='danger'?'rgba(220,38,38,0.06)':'rgba(217,119,6,0.06)'};">
                <div style="display:flex;justify-content:space-between;font-weight:700;color:${n.type==='danger'?'var(--danger)':'var(--warning)'};margin-bottom:2px;">
                  <span>${n.type === 'danger' ? '🚨 BAHAYA' : '⚠ PERINGATAN'}</span>
                  <span style="font-size:10px;font-family:var(--font-mono);color:var(--text-muted);">${n.time}</span>
                </div>
                <div style="color:var(--text-secondary);">${n.msg}</div>
              </div>
            `).join('');
          }
        }
        notifModal.classList.toggle('open');
      });

      document.addEventListener('click', (e) => {
        if (!notifModal.contains(e.target) && e.target !== btnNotif) {
          notifModal.classList.remove('open');
        }
      });
    }

    window.addEventListener('resize', () => {
      if (state.currentView === 'history') renderCanvasChart();
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 6. LOG DATA SENSOR & UNDUH CSV (TABEL TUNGGAL 'telemetry')
  // Sesuai Tabel 3.5 Proposal Skripsi
  // ════════════════════════════════════════════════════════════════

  let currentLogs = [];

  async function fetchSensorLogs(startDate, endDate) {
    const tbody = document.getElementById('log-table-body');
    const badge = document.getElementById('log-count-badge');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted);">Sedang mengambil data dari tabel telemetry Supabase...</td></tr>';

    try {
      if (state.connectionMode === 'supabase' && state.supabaseClient) {
        let query = state.supabaseClient
          .from('telemetry')
          .select('*')
          .order('created_at', { ascending: false });

        if (startDate) {
          query = query.gte('created_at', `${startDate}T00:00:00.000Z`);
        }
        if (endDate) {
          query = query.lte('created_at', `${endDate}T23:59:59.999Z`);
        }

        query = query.limit(200);

        const { data, error } = await query;
        if (error) throw error;

        currentLogs = data || [];
      } else {
        // Mode Demo / Simulasi Lokal
        currentLogs = state.history.map((h, idx) => ({
          id: idx + 1,
          created_at: h.time.toISOString(),
          suhu: h.suhu,
          kelembapan: h.kelembapan,
          amonia: h.amonia,
          pwm_intake: h.pwm_intake,
          pwm_exhaust: h.pwm_exhaust,
          pwm_pemanas: h.pwm_pemanas,
          status_konveyor: h.status_konveyor
        })).reverse();
      }

      renderLogsTable(currentLogs);
    } catch (err) {
      console.error('Gagal mengambil log telemetry:', err);
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--danger);">Gagal memuat log: ${err.message}</td></tr>`;
      if (badge) badge.textContent = 'Error';
    }
  }

  function renderLogsTable(logs) {
    const tbody = document.getElementById('log-table-body');
    const badge = document.getElementById('log-count-badge');
    if (!tbody) return;

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted);">Tidak ada data telemetri pada rentang tanggal yang dipilih.</td></tr>';
      if (badge) badge.textContent = '0 Data';
      return;
    }

    if (badge) badge.textContent = `${logs.length} Data`;

    tbody.innerHTML = logs.map((item, index) => {
      const dt = new Date(item.created_at);
      const timeStr = dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
                      dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const rawT = item.suhu !== undefined ? item.suhu : item.temperature;
      const rawH = item.kelembapan !== undefined ? item.kelembapan : item.humidity;
      const rawA = item.amonia !== undefined ? item.amonia : item.ammonia;

      const tValid = isSensorValid(rawT, 0, 60);
      const hValid = isSensorValid(rawH, 0, 100);
      const aValid = isSensorValid(rawA, 0, 200);

      const tStr = tValid ? `${Number(rawT).toFixed(1)} °C` : '--';
      const hStr = hValid ? `${Number(rawH).toFixed(1)} %` : '--';
      const aStr = aValid ? `${Number(rawA).toFixed(1)} ppm` : '--';

      const pwmIn = Number(item.pwm_intake || 0);
      const pwmEx = Number(item.pwm_exhaust || 0);
      const pwmHt = Number(item.pwm_pemanas || 0);
      const cnv = Boolean(item.status_konveyor);

      let condText = 'Normal';
      let condClass = 'normal';
      if (!tValid && !hValid && !aValid) {
        condText = 'Sensor Terputus';
        condClass = 'offline';
      } else if (!tValid || !hValid) {
        condText = 'SHT31 Terputus';
        condClass = 'warning';
      } else if (!aValid) {
        condText = 'MQ135 Terputus';
        condClass = 'warning';
      } else if (Number(rawA) >= THRESHOLDS.ammonia.danger || Number(rawT) >= THRESHOLDS.temperature.danger || Number(rawT) <= ((THRESHOLDS.temperature.minCold || 18.0) - 4.0)) {
        condText = 'Kritis / Bahaya';
        condClass = 'danger';
      } else if (Number(rawA) >= THRESHOLDS.ammonia.warning || Number(rawT) >= THRESHOLDS.temperature.warning || Number(rawT) <= (THRESHOLDS.temperature.minCold || 18.0) || Number(rawH) >= THRESHOLDS.humidity.warning) {
        condText = 'Waspada';
        condClass = 'warning';
      }

      return `
        <tr>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${index + 1}</td>
          <td style="font-family:var(--font-mono);font-size:11px;font-weight:600;">${timeStr}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:${tValid ? '#FF6B00' : 'var(--text-muted)'};">${tStr}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:${hValid ? '#0284C7' : 'var(--text-muted)'};">${hStr}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:${aValid ? '#10B981' : 'var(--text-muted)'};">${aStr}</td>
          <td style="font-family:var(--font-mono);font-weight:600;">${pwmIn}%</td>
          <td style="font-family:var(--font-mono);font-weight:600;">${pwmEx}%</td>
          <td style="font-family:var(--font-mono);font-weight:600;">${pwmHt}%</td>
          <td><span class="actuator-binary-badge ${cnv?'on':''}">${cnv ? 'ON' : 'OFF'}</span></td>
          <td><span class="badge-condition ${condClass}">${condText}</span></td>
        </tr>
      `;
    }).join('');
  }

  function exportLogsToCSV() {
    if (!currentLogs || currentLogs.length === 0) {
      alert('Tidak ada data log untuk diunduh.');
      return;
    }

    let csv = 'No,Waktu,Suhu_C,Kelembapan_RH,Amonia_PPM,PWM_Intake,PWM_Exhaust,PWM_Pemanas,Status_Konveyor,Status_Kondisi\r\n';
    currentLogs.forEach((item, idx) => {
      const dt = new Date(item.created_at).toLocaleString('id-ID');
      const rawT = item.suhu !== undefined ? item.suhu : item.temperature;
      const rawH = item.kelembapan !== undefined ? item.kelembapan : item.humidity;
      const rawA = item.amonia !== undefined ? item.amonia : item.ammonia;

      const tValid = isSensorValid(rawT, 0, 60);
      const hValid = isSensorValid(rawH, 0, 100);
      const aValid = isSensorValid(rawA, 0, 200);

      const t = tValid ? Number(rawT).toFixed(1) : '--';
      const h = hValid ? Number(rawH).toFixed(1) : '--';
      const a = aValid ? Number(rawA).toFixed(1) : '--';

      const pwmIn = Number(item.pwm_intake || 0);
      const pwmEx = Number(item.pwm_exhaust || 0);
      const pwmHt = Number(item.pwm_pemanas || 0);
      const cnv = Boolean(item.status_konveyor) ? 'ON' : 'OFF';

      let condText = 'Normal';
      if (!tValid && !hValid && !aValid) {
        condText = 'Sensor Terputus';
      } else if (!tValid || !hValid) {
        condText = 'SHT31 Terputus';
      } else if (!aValid) {
        condText = 'MQ135 Terputus';
      } else if (Number(rawA) >= THRESHOLDS.ammonia.danger || Number(rawT) >= THRESHOLDS.temperature.danger || Number(rawT) <= ((THRESHOLDS.temperature.minCold || 18.0) - 4.0)) {
        condText = 'Kritis/Bahaya';
      } else if (Number(rawA) >= THRESHOLDS.ammonia.warning || Number(rawT) >= THRESHOLDS.temperature.warning || Number(rawT) <= (THRESHOLDS.temperature.minCold || 18.0) || Number(rawH) >= THRESHOLDS.humidity.warning) {
        condText = 'Waspada';
      }

      csv += `${idx + 1},"${dt}",${t},${h},${a},${pwmIn},${pwmEx},${pwmHt},"${cnv}","${condText}"\r\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemetry-kandang-ayam-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ════════════════════════════════════════════════════════════════
  // 7. SIKLUS HIDUP & POLLING
  // ════════════════════════════════════════════════════════════════

  function switchView(viewName) {
    state.currentView = viewName;

    document.querySelectorAll('[data-view]').forEach(l => {
      if (l.getAttribute('data-view') === viewName) l.classList.add('active');
      else l.classList.remove('active');
    });

    document.querySelectorAll('.view-section').forEach(s => {
      if (s.id === `view-${viewName}`) s.classList.add('active');
      else s.classList.remove('active');
    });

    if (viewName === 'history') {
      fetchChartHistory(state.chartRange);
    } else {
      state.hoveredChartPoint = null;
      updateChartTooltip(null);
    }

    if (viewName === 'logs') {
      const inputS = document.getElementById('log-date-start');
      const inputE = document.getElementById('log-date-end');
      const today = new Date().toISOString().slice(0, 10);
      if (inputS && !inputS.value) inputS.value = today;
      if (inputE && !inputE.value) inputE.value = today;
      fetchSensorLogs(inputS ? inputS.value : '', inputE ? inputE.value : '');
    } else if (viewName === 'fuzzy') {
      renderRulesTable();
    }
  }

  function restartPolling() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }

    if (state.connectionMode === 'supabase') {
      setConnectionStatus(null, 'Database: Menghubungkan...', 'Memeriksa tabel telemetry Supabase...');
      initSupabaseClient().then(success => {
        if (!success) {
          console.warn('Inisialisasi Supabase belum berhasil, menunggu koneksi...');
        }
        // Polling berkala setiap 3 detik ke tabel 'telemetry' Supabase sebagai jaminan data selalu segar
        state.timerId = setInterval(async () => {
          if (state.connectionMode === 'supabase' && state.supabaseClient) {
            try {
              const { data, error } = await state.supabaseClient
                .from('telemetry')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(1);

              if (!error && data && data.length > 0) {
                const r = data[0];
                const rowTime = new Date(r.created_at).getTime();
                const ageSec = Math.max(0, Math.round((Date.now() - rowTime) / 1000));

                state.lastTelemetryId = r.id;
                state.lastTelemetryCreatedAt = r.created_at;
                state.lastEsp32Heartbeat = new Date(r.created_at);

                if (ageSec <= 15) {
                  // ESP32 aktif & mengirim data baru
                  const wasOffline = !state.isHardwareOnline || state.sensors.suhu === null;
                  state.isHardwareOnline = true;
                  updateTelemetryData(r);
                  setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live Data)');
                  if (wasOffline) {
                    evaluateEsp32Status();
                  }
                } else {
                  // Data terakhir di database sudah basi (> 15 detik), ESP32 sedang OFF!
                  const wasOnline = state.isHardwareOnline;
                  state.isHardwareOnline = false;
                  state.sensors.suhu = null;
                  state.sensors.kelembapan = null;
                  state.sensors.amonia = null;
                  state.sensors.timestamp = new Date(r.created_at);
                  state.actuators.pwmIntake = 0;
                  state.actuators.pwmExhaust = 0;
                  state.actuators.pwmPemanas = 0;
                  state.actuators.statusKonveyor = false;
                  state.fuzzy = null;
                  evaluateEsp32Status();
                  renderUI();
                  setConnectionStatus(true, 'Database: Terhubung', 'ESP32 Sedang Offline');
                }
              }
            } catch (e) {
              console.warn('Sinkronisasi berkala gagal:', e);
            }
          }
        }, 3000);
      });
    } else if (state.connectionMode === 'esp32') {
      setConnectionStatus(null, 'ESP32: Menghubungkan...', 'Direct IP');
      pollEsp32Data();
      state.timerId = setInterval(pollEsp32Data, 3000);
    } else {
      setConnectionStatus(true, 'Database: Mode Demo', 'Data Simulasi Lokal');
      state.timerId = setInterval(tickDemoData, 3000);
      tickDemoData();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 8. INITIALIZATION
  // ════════════════════════════════════════════════════════════════
  function init() {
    initEvents();
    renderUI();
    restartPolling();

    // Watchdog status koneksi ESP32 tiap 1 detik
    setInterval(evaluateEsp32Status, 1000);

    // Detik jam header setiap 1 detik
    setInterval(() => {
      const clockEl = document.getElementById('header-clock');
      if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('id-ID');
    }, 1000);

    const simTemp = document.getElementById('sim-temp');
    if (simTemp) {
      simTemp.dispatchEvent(new Event('input'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
