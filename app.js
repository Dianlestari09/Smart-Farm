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

  // ─── AMBANG BATAS STANDAR MIKROKLIMAT AYAM PETELUR ───────────
  const THRESHOLDS = {
    temperature: { min: 10, max: 40, warning: 27, danger: 31 },
    humidity:    { min: 20, max: 100, warning: 85, danger: 90 },
    ammonia:     { min: 0,  max: 50,  warning: 15, danger: 20 }
  };

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
    esp32Ip: localStorage.getItem('smartfarm_esp32_ip') || 'http://192.168.4.1',
    supabaseUrl: storedUrl,
    supabaseKey: storedKey,
    supabaseClient: null,
    supabaseChannels: [],

    // Live sensor values
    sensors: {
      suhu: 24.2,
      kelembapan: 68.5,
      amonia: 12.4,
      timestamp: new Date()
    },

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

  // Nama himpunan linguistik
  const T_LABELS = ['Sangat Dingin', 'Dingin', 'Normal', 'Panas', 'Sangat Panas'];
  const H_LABELS = ['Sangat Kering', 'Kering', 'Normal', 'Basah', 'Sangat Basah'];
  const A_LABELS = ['Sangat Aman', 'Aman', 'Waspada', 'Bahaya', 'Sangat Bahaya'];
  const OUT_LABELS = ['Mati', 'Rendah', 'Sedang', 'Tinggi', 'Maksimal'];

  // Definisi matriks output 125 aturan: [Intake, Exhaust, Pemanas]
  // Nilai term output: 0=Mati (0%), 1=Rendah (25%), 2=Sedang (50%), 3=Tinggi (75%), 4=Maksimal (100%)
  function determineRuleOutput(t, h, a) {
    let inTerm = 0;
    let exTerm = 0;
    let htTerm = 0;

    // 1. Pemanas (Heater): Merespons suhu dingin (SD & D)
    if (t === 0) { // SD (Sangat Dingin)
      htTerm = 4; // Maksimal (100%)
    } else if (t === 1) { // D (Dingin)
      if (a >= 3) {
        htTerm = 3; // Tinggi (75%) — kompensasi kalor saat exhaust membuang amonia
      } else if (h >= 3) {
        htTerm = 2; // Sedang (50%)
      } else {
        htTerm = (h === 0) ? 1 : 2; // Rendah (25%) atau Sedang (50%)
      }
    } else { // N, P, SP (Normal / Panas / Sangat Panas)
      htTerm = 0; // Mati (0%)
    }

    // 2. Kipas Exhaust: Membuang panas, amonia beracun, dan kelembapan tinggi
    if (a === 4) { // ST (Sangat Bahaya)
      exTerm = (t >= 2) ? 4 : (t === 1 ? 3 : 2);
    } else if (a === 3) { // T (Bahaya)
      if (t >= 3) exTerm = 4;
      else if (t === 2) exTerm = 3;
      else if (t === 1) exTerm = 2;
      else exTerm = 1;
    } else if (a === 2) { // S (Waspada)
      if (t === 4) exTerm = 4;
      else if (t === 3) exTerm = 3;
      else if (t === 2) exTerm = 2;
      else if (t === 1) exTerm = 1;
      else exTerm = 0;
    } else if (a === 1) { // R (Aman)
      if (t === 4) exTerm = 4;
      else if (t === 3) exTerm = 3;
      else if (t === 2) {
        if (h === 4) exTerm = 2;
        else if (h === 3) exTerm = 1;
        else exTerm = 0;
      } else {
        exTerm = 0;
      }
    } else { // SR (Sangat Aman)
      if (t === 4) exTerm = 4;
      else if (t === 3) exTerm = 3;
      else if (t === 2) {
        if (h === 4) exTerm = 2;
        else if (h === 3) exTerm = 1;
        else exTerm = 0;
      } else {
        exTerm = 0;
      }
    }

    // 3. Kipas Intake: Pasokan udara segar & sirkulasi ventilasi silang
    if (t === 4) { // SP (Sangat Panas)
      inTerm = 4; // Maksimal (100%)
    } else if (t === 3) { // P (Panas)
      inTerm = (a >= 2 || h >= 3) ? 3 : 2; // Tinggi (75%) atau Sedang (50%)
    } else if (t === 2) { // N (Normal)
      if (a === 4) inTerm = 3; // Tinggi
      else if (a === 3) inTerm = 2; // Sedang
      else if (a === 2) inTerm = 1; // Rendah
      else {
        if (h === 4) inTerm = 2;
        else if (h === 3) inTerm = 1;
        else inTerm = 0;
      }
    } else if (t === 1) { // D (Dingin)
      inTerm = (a >= 3) ? 1 : 0; // Sirkulasi minimal saat amonia bahaya
    } else { // SD (Sangat Dingin)
      inTerm = 0; // Mati (cegah hembusan dingin langsung)
    }

    return { inTerm, exTerm, htTerm };
  }

  // Bangun pustaka 125 aturan sekali saat startup
  const RULE_BASE_125 = [];
  let ruleCounter = 1;
  for (let t = 0; t < 5; t++) {
    for (let h = 0; h < 5; h++) {
      for (let a = 0; a < 5; a++) {
        const out = determineRuleOutput(t, h, a);
        RULE_BASE_125.push({
          id: ruleCounter++,
          tIdx: t,
          hIdx: h,
          aIdx: a,
          tName: T_LABELS[t],
          hName: H_LABELS[h],
          aName: A_LABELS[a],
          inTerm: out.inTerm,
          exTerm: out.exTerm,
          htTerm: out.htTerm,
          inName: OUT_LABELS[out.inTerm],
          exName: OUT_LABELS[out.exTerm],
          htName: OUT_LABELS[out.htTerm],
          antecedent: `IF Suhu=${T_LABELS[t]} AND Kelembapan=${H_LABELS[h]} AND Amonia=${A_LABELS[a]}`,
          consequent: `THEN Intake=${OUT_LABELS[out.inTerm]}, Exhaust=${OUT_LABELS[out.exTerm]}, Pemanas=${OUT_LABELS[out.htTerm]}`
        });
      }
    }
  }

  // ─── DEFUZZIFIKASI CENTROID COA (Persamaan 3.1 & 3.2) ────────
  function defuzzifyCentroid(betas) {
    const sumBeta = betas[0] + betas[1] + betas[2] + betas[3] + betas[4];
    if (sumBeta <= 0.0001) {
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
    const pwm = Math.max(0, Math.min(100, Math.round(pwmRaw)));

    return { yStar: +yStar.toFixed(2), pwm };
  }

  // ─── MESIN UTAMA FLC MAMDANI 125 RULE ─────────────────────────
  function computeFuzzyMamdani(temp, humid, nh3) {
    // 1. Fuzzifikasi Suhu (10–40 °C)
    const muT = [
      calcLeftShoulder(temp, 14, 18),        // SD: Sangat Dingin [10, 10, 14, 18]
      calcTri(temp, 14, 18, 20),             // D: Dingin [14, 18, 18, 20]
      calcTrap(temp, 18, 20, 25, 27),        // N: Normal [18, 20, 25, 27]
      calcTri(temp, 25, 27, 31),             // P: Panas [25, 27, 27, 31]
      calcRightShoulder(temp, 27, 31)        // SP: Sangat Panas [27, 31, 40, 40]
    ];

    // 2. Fuzzifikasi Kelembapan (20–100 %RH)
    const muH = [
      calcLeftShoulder(humid, 40, 50),       // SK: Sangat Kering [20, 20, 40, 50]
      calcTri(humid, 40, 50, 60),            // K: Kering [40, 50, 50, 60]
      calcTrap(humid, 50, 60, 80, 85),       // N: Normal [50, 60, 80, 85]
      calcTri(humid, 80, 85, 92),            // B: Basah [80, 85, 85, 92]
      calcRightShoulder(humid, 85, 92)       // SB: Sangat Basah [85, 92, 100, 100]
    ];

    // 3. Fuzzifikasi Gas Amonia (0–50 ppm)
    const muA = [
      calcLeftShoulder(nh3, 5, 10),          // SR: Sangat Aman [0, 0, 5, 10]
      calcTri(nh3, 5, 10, 15),               // R: Aman [5, 10, 10, 15]
      calcTri(nh3, 10, 15, 20),              // S: Waspada [10, 15, 15, 20]
      calcTri(nh3, 15, 20, 30),              // T: Bahaya [15, 20, 20, 30]
      calcRightShoulder(nh3, 20, 30)         // ST: Sangat Bahaya [20, 30, 50, 50]
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

    // 6. Logika Relai Biner Motor Konveyor (GPIO 27)
    // Sesuai Proposal: Aktif jika Amonia >= 20 ppm ATAU Kelembapan > 90%
    const conveyorState = (nh3 >= 20.0 || humid > 90.0);

    // 7. Penentuan Label Kondisi Mikroklimat Kandang
    const isDanger = nh3 >= 20.0 || temp >= 31.0 || temp <= 14.0;
    const isWarning = nh3 >= 15.0 || temp >= 27.0 || temp <= 18.0 || humid >= 85.0;
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

  function initMockHistory() {
    const hist = [];
    const now = Date.now();
    for (let i = 30; i >= 0; i--) {
      const time = new Date(now - i * 60 * 1000);
      const suhu = +(23.5 + Math.sin(i * 0.18) * 3 + (Math.random() - 0.5) * 0.8).toFixed(1);
      const kelembapan = +(68.0 + Math.cos(i * 0.12) * 6 + (Math.random() - 0.5) * 1.5).toFixed(1);
      const amonia = +(12.5 + Math.sin(i * 0.25) * 4 + (Math.random() - 0.5) * 1.0).toFixed(1);

      // Hitung simulasi aktuator
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

  function tickDemoData() {
    const now = new Date();
    const t = now.getTime();

    // Osilasi halus mensimulasikan lingkungan kandang ayam petelur
    const suhu = +(23.8 + Math.sin(t / 25000) * 4.5 + (Math.random() - 0.5) * 0.6).toFixed(1);
    const kelembapan = +(67.5 + Math.cos(t / 20000) * 8.0 + (Math.random() - 0.5) * 1.0).toFixed(1);
    const amonia = +(13.2 + Math.sin(t / 18000) * 5.5 + (Math.random() - 0.5) * 0.8).toFixed(1);

    updateTelemetryData({
      suhu,
      kelembapan,
      amonia,
      created_at: now.toISOString()
    });
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

      if (latestRows && latestRows.length > 0) {
        const latest = latestRows[0];
        updateTelemetryData(latest);
      } else {
        console.log('Tabel telemetry masih kosong. Menunggu data telemetri pertama dari ESP32...');
      }

      // 2. Ambil riwayat telemetri 24 jam terakhir untuk grafik
      const cut = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: histData, error: errHist } = await state.supabaseClient
        .from('telemetry')
        .select('*')
        .gte('created_at', cut)
        .order('created_at', { ascending: true })
        .limit(100);

      if (!errHist && histData && histData.length > 0) {
        state.history = histData.map(d => ({
          time: new Date(d.created_at),
          suhu: Number(d.suhu),
          kelembapan: Number(d.kelembapan),
          amonia: Number(d.amonia),
          pwm_intake: Number(d.pwm_intake || 0),
          pwm_exhaust: Number(d.pwm_exhaust || 0),
          pwm_pemanas: Number(d.pwm_pemanas || 0),
          status_konveyor: Boolean(d.status_konveyor)
        }));
        if (state.currentView === 'history') renderCanvasChart();
      }

      // 3. Berlangganan Supabase Realtime WebSocket ke tabel tunggal 'telemetry'
      state.supabaseChannels.forEach(ch => state.supabaseClient.removeChannel(ch));
      state.supabaseChannels = [];

      const chTelemetry = state.supabaseClient
        .channel('realtime_telemetry')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'telemetry' }, (payload) => {
          const row = payload.new;
          console.log('[Supabase Realtime] Telemetri masuk:', row);
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
    const suhu = Number(row.suhu !== undefined ? row.suhu : row.temperature);
    const kelembapan = Number(row.kelembapan !== undefined ? row.kelembapan : row.humidity);
    const amonia = Number(row.amonia !== undefined ? row.amonia : row.ammonia);
    const timestamp = row.created_at ? new Date(row.created_at) : new Date();

    state.sensors.suhu = suhu;
    state.sensors.kelembapan = kelembapan;
    state.sensors.amonia = amonia;
    state.sensors.timestamp = timestamp;

    // Catat heartbeat ESP32
    if (state.connectionMode === 'demo') {
      state.lastEsp32Heartbeat = new Date();
    } else if (row.created_at) {
      state.lastEsp32Heartbeat = new Date(row.created_at);
    }

    evaluateEsp32Status();

    // Jalankan kalkulasi Fuzzy Mamdani 125 rules di browser
    state.fuzzy = computeFuzzyMamdani(suhu, kelembapan, amonia);

    // Jika baris dari ESP32 memuat nilai aktuator nyata dari database, gunakan nilai tersebut
    if (row.pwm_intake !== undefined && row.pwm_intake !== null && !state.actuators.isManual) {
      state.actuators.pwmIntake = Number(row.pwm_intake);
      state.actuators.pwmExhaust = Number(row.pwm_exhaust);
      state.actuators.pwmPemanas = Number(row.pwm_pemanas);
      state.actuators.statusKonveyor = Boolean(row.status_konveyor);
    } else if (!state.actuators.isManual) {
      state.actuators.pwmIntake = state.fuzzy.crisp.fanIntake;
      state.actuators.pwmExhaust = state.fuzzy.crisp.fanExhaust;
      state.actuators.pwmPemanas = state.fuzzy.crisp.heater;
      state.actuators.statusKonveyor = state.fuzzy.states.conveyor;
    }

    // Rekam histori grafik (max 60 titik)
    state.history.push({
      time: timestamp,
      suhu,
      kelembapan,
      amonia,
      pwm_intake: state.actuators.pwmIntake,
      pwm_exhaust: state.actuators.pwmExhaust,
      pwm_pemanas: state.actuators.pwmPemanas,
      status_konveyor: state.actuators.statusKonveyor
    });
    if (state.history.length > 60) state.history.shift();

    // Evaluasi alarm peringatan
    checkAlerts(suhu, kelembapan, amonia);

    // Refresh UI
    renderUI();
  }

  function checkAlerts(t, h, a) {
    const alerts = [];
    const ts = new Date().toLocaleTimeString('id-ID');

    if (a >= THRESHOLDS.ammonia.danger) {
      alerts.push({ type: 'danger', msg: `Gas Amonia Bahaya: ${a} ppm (Ambang Batas >= 20 ppm)`, time: ts });
    } else if (a >= THRESHOLDS.ammonia.warning) {
      alerts.push({ type: 'warning', msg: `Gas Amonia Meningkat: ${a} ppm (Waspada >= 15 ppm)`, time: ts });
    }

    if (t >= THRESHOLDS.temperature.danger) {
      alerts.push({ type: 'danger', msg: `Suhu Udara Ekstrem: ${t}°C (Risiko Heat Stress Tinggi > 31°C)`, time: ts });
    } else if (t >= THRESHOLDS.temperature.warning) {
      alerts.push({ type: 'warning', msg: `Suhu Udara Panas: ${t}°C (Ideal 20–25°C)`, time: ts });
    } else if (t <= 14.0) {
      alerts.push({ type: 'danger', msg: `Suhu Sangat Dingin: ${t}°C (Risiko Hipotermia Ayam)`, time: ts });
    }

    if (h >= THRESHOLDS.humidity.danger) {
      alerts.push({ type: 'danger', msg: `Kelembapan sangat tinggi: ${h}% (Kandang Terlalu Basah > 90%)`, time: ts });
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

    evaluateEsp32Status();
  }

  // ─── WATCHDOG KONEKSI ESP32 (Sesuai Permintaan: Online jika <= 10 detik) ───
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
      return;
    }

    if (!state.lastEsp32Heartbeat) {
      dot.className = 'pulse-dot offline';
      text.textContent = 'ESP32: Belum Terhubung';
      if (timeEl) timeEl.textContent = '(Menunggu alat...)';
      if (chipDot) chipDot.className = 'pulse-dot offline';
      if (chipText) {
        chipText.textContent = 'ESP32: Belum Terhubung (Menunggu Data)';
        chipText.style.color = 'var(--danger)';
      }
      return;
    }

    // Hitung selisih waktu telemetri terhadap waktu sekarang (dalam detik)
    const diff = Math.max(0, Math.round((Date.now() - state.lastEsp32Heartbeat.getTime()) / 1000));

    if (diff <= 10) {
      // ONLINE: Data telemetri diterima dalam 10 detik terakhir
      dot.className = 'pulse-dot';
      text.textContent = 'ESP32: Terhubung (Online)';
      if (timeEl) timeEl.textContent = diff <= 1 ? '(Live)' : `(${diff}d lalu)`;
      if (chipDot) chipDot.className = 'pulse-dot';
      if (chipText) {
        chipText.textContent = `ESP32: Terhubung (Online) ${diff <= 1 ? '(Live)' : '(' + diff + 's lalu)'}`;
        chipText.style.color = 'var(--success)';
      }
    } else {
      // OFFLINE: Lebih dari 10 detik tanpa data baru
      dot.className = 'pulse-dot offline';
      text.textContent = 'ESP32: Terputus (Offline)';
      if (timeEl) timeEl.textContent = `(${diff}d lalu)`;
      if (chipDot) chipDot.className = 'pulse-dot offline';
      if (chipText) {
        chipText.textContent = `ESP32: Terputus (Offline) (Terakhir ${state.lastEsp32Heartbeat.toLocaleTimeString('id-ID')})`;
        chipText.style.color = 'var(--danger)';
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 3. UI RENDERING & DOM UPDATE
  // ════════════════════════════════════════════════════════════════

  function getStatusType(val, limits) {
    if (val >= limits.danger) return 'danger';
    if (val >= limits.warning) return 'warning';
    return 'normal';
  }

  function renderUI() {
    const s = state.sensors;
    const f = state.fuzzy;
    if (!f) return;

    // Header Clock
    const clockEl = document.getElementById('header-clock');
    if (clockEl) clockEl.textContent = s.timestamp.toLocaleTimeString('id-ID');

    // Condition Badge (Dashboard)
    const condBadge = document.getElementById('cond-badge');
    if (condBadge) {
      condBadge.className = `cond-badge ${f.statusClass}`;
      condBadge.textContent = f.conditionLabel;
    }

    // ─── 1. Sensor Cards ───
    updateCard('temp', s.suhu, THRESHOLDS.temperature, '°C');
    updateCard('humid', s.kelembapan, THRESHOLDS.humidity, '%');
    updateCard('ammonia', s.amonia, THRESHOLDS.ammonia, 'ppm');

    // ─── 2. Actuator Cards (Dashboard) ───
    updateActuatorCard('fan-in', state.actuators.pwmIntake > 0, state.actuators.pwmIntake);
    updateActuatorCard('fan-out', state.actuators.pwmExhaust > 0, state.actuators.pwmExhaust);
    updateActuatorCard('heater', state.actuators.pwmPemanas > 0, state.actuators.pwmPemanas);
    updateActuatorCard('conveyor', state.actuators.statusKonveyor, state.actuators.statusKonveyor ? 100 : 0);

    // ─── 3. Fuzzifikasi 5 Himpunan Keanggotaan ───
    updateMembershipDisplay(f.membership);

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

  function updateCard(idPrefix, val, limits, unit) {
    const valEl = document.getElementById(`val-${idPrefix}`);
    const badgeEl = document.getElementById(`badge-${idPrefix}`);
    const barEl = document.getElementById(`bar-${idPrefix}`);
    if (!valEl) return;

    const status = getStatusType(val, limits);
    valEl.textContent = val.toFixed(1);

    if (badgeEl) {
      badgeEl.className = `card-badge ${status}`;
      badgeEl.textContent = status === 'danger' ? 'BAHAYA' : (status === 'warning' ? 'WASPADA' : 'NORMAL');
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
      if (isOn) card.classList.add('on');
      else card.classList.remove('on');
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

    const ctx = canvas.getContext('2d');
    const w = canvas.parentElement.clientWidth;
    const h = 320;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const padLeft = 45;
    const padRight = 20;
    const padTop = 20;
    const padBottom = 35;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    const data = state.history;
    if (!data || data.length === 0) {
      ctx.fillStyle = '#8C90A0';
      ctx.font = '12px Inter';
      ctx.fillText('Menunggu data telemetri dari tabel telemetry...', w / 2 - 110, h / 2);
      return;
    }

    const minY = 0;
    const maxY = 100;

    // Garis grid horizontal
    ctx.strokeStyle = '#E2E4EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8C90A0';
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'right';

    for (let step = 0; step <= 100; step += 25) {
      const y = padTop + chartH - (step / maxY) * chartH;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      ctx.fillText(step.toString(), padLeft - 8, y + 3);
    }

    function drawSeries(key, color, fillRgba) {
      if (data.length === 1) {
        const x = padLeft + chartW / 2;
        const val = Math.min(maxY, Math.max(minY, data[0][key]));
        const y = padTop + chartH - (val / maxY) * chartH;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }

      ctx.beginPath();
      const points = [];
      for (let i = 0; i < data.length; i++) {
        const x = padLeft + (i / (data.length - 1)) * chartW;
        const val = Math.min(maxY, Math.max(minY, data[i][key]));
        const y = padTop + chartH - (val / maxY) * chartH;
        points.push({ x, y });
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.stroke();

      if (fillRgba) {
        ctx.lineTo(points[points.length - 1].x, padTop + chartH);
        ctx.lineTo(points[0].x, padTop + chartH);
        ctx.closePath();
        ctx.fillStyle = fillRgba;
        ctx.fill();
      }

      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    drawSeries('kelembapan', '#0284C7', 'rgba(2, 132, 199, 0.05)');
    drawSeries('suhu',       '#FF6B00', 'rgba(255, 107, 0, 0.08)');
    drawSeries('amonia',     '#10B981', 'rgba(16, 185, 129, 0.08)');

    ctx.fillStyle = '#8C90A0';
    ctx.textAlign = 'left';
    ctx.fillText(data[0].time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), padLeft, h - 10);
    if (data.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(data[data.length - 1].time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), w - padRight, h - 10);
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

    // Tombol Filter Rentang Grafik
    const chartBtns = document.querySelectorAll('.chart-btn[data-range]');
    chartBtns.forEach(b => {
      b.addEventListener('click', () => {
        chartBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.chartRange = b.getAttribute('data-range');
        renderCanvasChart();
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
    }

    if (simTemp && simHum && simNh3) {
      simTemp.addEventListener('input', onSimSliderChange);
      simHum.addEventListener('input', onSimSliderChange);
      simNh3.addEventListener('input', onSimSliderChange);
    }

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
        state.connectionMode = document.getElementById('input-conn-mode').value;
        state.supabaseUrl = document.getElementById('input-sb-url').value.trim();
        state.supabaseKey = document.getElementById('input-sb-key').value.trim();
        state.esp32Ip = document.getElementById('input-esp32-ip').value.trim();

        localStorage.setItem('smartfarm_conn_mode', state.connectionMode);
        localStorage.setItem('smartfarm_supabase_url', state.supabaseUrl);
        localStorage.setItem('smartfarm_supabase_key', state.supabaseKey);
        localStorage.setItem('smartfarm_esp32_ip', state.esp32Ip);

        if (state.connectionMode === 'demo') {
          localStorage.setItem('smartfarm_manual_demo', 'true');
        } else {
          localStorage.removeItem('smartfarm_manual_demo');
        }

        restartPolling();
        modal.classList.remove('open');
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

      const t = Number(item.suhu !== undefined ? item.suhu : item.temperature);
      const h = Number(item.kelembapan !== undefined ? item.kelembapan : item.humidity);
      const a = Number(item.amonia !== undefined ? item.amonia : item.ammonia);
      const pwmIn = Number(item.pwm_intake || 0);
      const pwmEx = Number(item.pwm_exhaust || 0);
      const pwmHt = Number(item.pwm_pemanas || 0);
      const cnv = Boolean(item.status_konveyor);

      let condText = 'Normal';
      let condClass = 'normal';
      if (a >= THRESHOLDS.ammonia.danger || t >= THRESHOLDS.temperature.danger || t <= 14.0) {
        condText = 'Kritis / Bahaya';
        condClass = 'danger';
      } else if (a >= THRESHOLDS.ammonia.warning || t >= THRESHOLDS.temperature.warning || t <= 18.0 || h >= THRESHOLDS.humidity.warning) {
        condText = 'Waspada';
        condClass = 'warning';
      }

      return `
        <tr>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${index + 1}</td>
          <td style="font-family:var(--font-mono);font-size:11px;font-weight:600;">${timeStr}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:#FF6B00;">${t.toFixed(1)} °C</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:#0284C7;">${h.toFixed(1)} %</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:#10B981;">${a.toFixed(1)} ppm</td>
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
      const t = Number(item.suhu !== undefined ? item.suhu : item.temperature).toFixed(1);
      const h = Number(item.kelembapan !== undefined ? item.kelembapan : item.humidity).toFixed(1);
      const a = Number(item.amonia !== undefined ? item.amonia : item.ammonia).toFixed(1);
      const pwmIn = Number(item.pwm_intake || 0);
      const pwmEx = Number(item.pwm_exhaust || 0);
      const pwmHt = Number(item.pwm_pemanas || 0);
      const cnv = Boolean(item.status_konveyor) ? 'ON' : 'OFF';

      let condText = 'Normal';
      if (Number(a) >= THRESHOLDS.ammonia.danger || Number(t) >= THRESHOLDS.temperature.danger || Number(t) <= 14.0) {
        condText = 'Kritis/Bahaya';
      } else if (Number(a) >= THRESHOLDS.ammonia.warning || Number(t) >= THRESHOLDS.temperature.warning || Number(t) <= 18.0 || Number(h) >= THRESHOLDS.humidity.warning) {
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
      setTimeout(renderCanvasChart, 50);
    } else if (viewName === 'logs') {
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
    if (state.timerId) clearInterval(state.timerId);

    if (state.connectionMode === 'supabase') {
      setConnectionStatus(null, 'Database: Menghubungkan...', 'Memeriksa tabel telemetry Supabase...');
      initSupabaseClient().then(success => {
        if (!success) {
          state.timerId = setInterval(tickDemoData, 3000);
          tickDemoData();
        } else {
          // Polling sinkronisasi database berkala setiap 5 detik ke tabel 'telemetry'
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
                  const rowTime = new Date(r.created_at);
                  if (!state.sensors.timestamp || rowTime > state.sensors.timestamp) {
                    updateTelemetryData(r);
                  }
                  setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live Data)');
                }
              } catch (e) {
                console.warn('Sinkronisasi berkala gagal:', e);
              }
            }
          }, 5000);
        }
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
    initMockHistory();
    initEvents();

    tickDemoData();
    restartPolling();

    // Watchdog status koneksi ESP32 tiap 1 detik
    setInterval(evaluateEsp32Status, 1000);

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
