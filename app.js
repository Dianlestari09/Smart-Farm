/**
 * ════════════════════════════════════════════════════════════════
 * SMART FARM POULTRY MONITOR — NATIVE VANILLA JAVASCRIPT
 * Skripsi: Dian Lestari Kurniawati (NIM: 230605110016)
 * "Rancang Bangun Sistem Otomatisasi Mikroklimat Kandang Ayam Petelur"
 * 
 * Features:
 * 1. 100% Vanilla JS (No build step, instant Vercel deploy)
 * 2. Official Supabase Realtime WebSocket Client + REST Fallback
 * 3. 27 Rule Base Fuzzy Mamdani Controller Client-Side & Live Simulator
 * 4. Pure HTML5 Canvas Offline/Online Realtime Chart
 * ════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ─── AMBANG BATAS STANDAR SKRIPSI ─────────────────────────────
  const THRESHOLDS = {
    temperature: { min: 10, max: 40, warning: 25, danger: 32 },
    humidity:    { min: 30, max: 100, warning: 80, danger: 90 },
    ammonia:     { min: 0,  max: 50,  warning: 20, danger: 25 }
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
      temperature: 24.2,
      humidity: 68.5,
      ammonia: 12.4,
      timestamp: new Date()
    },

    // Actuator states
    actuators: {
      fanIntake: false,
      fanExhaust: false,
      heater: false,
      conveyor: false,
      isManual: false
    },

    // Fuzzy Mamdani output
    fuzzy: null,

    // Historical buffer for charts (last 60 data points)
    history: [],

    // Notifications
    notifications: [],
    unreadCount: 0,

    // ESP32 Heartbeat tracking
    lastEsp32Heartbeat: null,

    // Chart settings
    chartRange: '1h',
    timerId: null
  };

  // ════════════════════════════════════════════════════════════════
  // 1. FUZZY LOGIC CONTROLLER MAMDANI (27 RULE BASE)
  // Sesuai dengan esp32_code.ino & Naskah Skripsi Dian
  // ════════════════════════════════════════════════════════════════

  function calcTri(x, a, b, c) {
    if (x <= a || x >= c) return 0;
    if (x === b) return 1;
    if (x < b) return (x - a) / (b - a);
    return (c - x) / (c - b);
  }

  function calcTrap(x, a, b, c, d) {
    if (x <= a || x >= d) return 0;
    if (x >= b && x <= c) return 1;
    if (x < b) return (x - a) / (b - a);
    return (d - x) / (d - c);
  }

  function computeFuzzyMamdani(temp, humid, nh3) {
    // 1. Fuzzifikasi Suhu (°C)
    const tD = calcTrap(temp, 0, 0, 18, 23);     // Dingin
    const tN = calcTri(temp, 18, 23, 28);        // Normal
    const tP = calcTrap(temp, 23, 28, 100, 100);  // Panas

    // 2. Fuzzifikasi Kelembapan (%)
    const hK = calcTrap(humid, 0, 0, 50, 70);    // Kering
    const hN = calcTri(humid, 50, 70, 85);       // Normal
    const hB = calcTrap(humid, 70, 85, 100, 100); // Basah

    // 3. Fuzzifikasi Amonia (ppm)
    const nA = calcTrap(nh3, 0, 0, 10, 18);      // Aman
    const nW = calcTri(nh3, 10, 18, 25);         // Waspada
    const nB = calcTrap(nh3, 18, 25, 100, 100);   // Bahaya

    // 4. Evaluasi 27 Rule Base
    const rules = [
      // Dingin (tD)
      { id:1,  t:tD, h:hK, a:nA, fin:false, fout:false, htr:true,  cnv:false, tN:'Dingin', hN:'Kering', aN:'Aman' },
      { id:2,  t:tD, h:hK, a:nW, fin:true,  fout:true,  htr:true,  cnv:false, tN:'Dingin', hN:'Kering', aN:'Waspada' },
      { id:3,  t:tD, h:hK, a:nB, fin:true,  fout:true,  htr:true,  cnv:true,  tN:'Dingin', hN:'Kering', aN:'Bahaya' },
      { id:4,  t:tD, h:hN, a:nA, fin:false, fout:false, htr:true,  cnv:false, tN:'Dingin', hN:'Normal', aN:'Aman' },
      { id:5,  t:tD, h:hN, a:nW, fin:true,  fout:true,  htr:true,  cnv:false, tN:'Dingin', hN:'Normal', aN:'Waspada' },
      { id:6,  t:tD, h:hN, a:nB, fin:true,  fout:true,  htr:true,  cnv:true,  tN:'Dingin', hN:'Normal', aN:'Bahaya' },
      { id:7,  t:tD, h:hB, a:nA, fin:true,  fout:true,  htr:true,  cnv:false, tN:'Dingin', hN:'Basah',  aN:'Aman' },
      { id:8,  t:tD, h:hB, a:nW, fin:true,  fout:true,  htr:true,  cnv:false, tN:'Dingin', hN:'Basah',  aN:'Waspada' },
      { id:9,  t:tD, h:hB, a:nB, fin:true,  fout:true,  htr:true,  cnv:true,  tN:'Dingin', hN:'Basah',  aN:'Bahaya' },

      // Normal (tN)
      { id:10, t:tN, h:hK, a:nA, fin:false, fout:false, htr:false, cnv:false, tN:'Normal', hN:'Kering', aN:'Aman' },
      { id:11, t:tN, h:hK, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Normal', hN:'Kering', aN:'Waspada' },
      { id:12, t:tN, h:hK, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Normal', hN:'Kering', aN:'Bahaya' },
      { id:13, t:tN, h:hN, a:nA, fin:false, fout:false, htr:false, cnv:false, tN:'Normal', hN:'Normal', aN:'Aman' },
      { id:14, t:tN, h:hN, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Normal', hN:'Normal', aN:'Waspada' },
      { id:15, t:tN, h:hN, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Normal', hN:'Normal', aN:'Bahaya' },
      { id:16, t:tN, h:hB, a:nA, fin:true,  fout:true,  htr:false, cnv:false, tN:'Normal', hN:'Basah',  aN:'Aman' },
      { id:17, t:tN, h:hB, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Normal', hN:'Basah',  aN:'Waspada' },
      { id:18, t:tN, h:hB, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Normal', hN:'Basah',  aN:'Bahaya' },

      // Panas (tP)
      { id:19, t:tP, h:hK, a:nA, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Kering', aN:'Aman' },
      { id:20, t:tP, h:hK, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Kering', aN:'Waspada' },
      { id:21, t:tP, h:hK, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Panas',  hN:'Kering', aN:'Bahaya' },
      { id:22, t:tP, h:hN, a:nA, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Normal', aN:'Aman' },
      { id:23, t:tP, h:hN, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Normal', aN:'Waspada' },
      { id:24, t:tP, h:hN, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Panas',  hN:'Normal', aN:'Bahaya' },
      { id:25, t:tP, h:hB, a:nA, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Basah',  aN:'Aman' },
      { id:26, t:tP, h:hB, a:nW, fin:true,  fout:true,  htr:false, cnv:false, tN:'Panas',  hN:'Basah',  aN:'Waspada' },
      { id:27, t:tP, h:hB, a:nB, fin:true,  fout:true,  htr:false, cnv:true,  tN:'Panas',  hN:'Basah',  aN:'Bahaya' }
    ];

    // Hitung derajat keanggotaan rule (MIN)
    const evaluated = rules.map(r => {
      const alpha = Math.min(r.t, r.h, r.a);
      const antecedent = `IF Suhu=${r.tN} AND Kelembapan=${r.hN} AND Amonia=${r.aN}`;
      const consequent = `THEN FanIn=${r.fin ? 'ON' : 'OFF'}, FanOut=${r.fout ? 'ON' : 'OFF'}, Heater=${r.htr ? 'ON' : 'OFF'}, Conv=${r.cnv ? 'ON' : 'OFF'}`;
      return { id: r.id, antecedent, consequent, alpha, fin: r.fin, fout: r.fout, htr: r.htr, cnv: r.cnv };
    });

    const activeRules = evaluated.filter(r => r.alpha > 0.001).sort((a, b) => b.alpha - a.alpha);
    const sumAlpha = activeRules.reduce((s, r) => s + r.alpha, 0) || 1;

    // Defuzzifikasi Sugeno/Mamdani Weighted Average (0 - 100%)
    const fanInPct  = Math.round((activeRules.filter(r => r.fin).reduce((s, r) => s + r.alpha, 0) / sumAlpha) * 100);
    const fanOutPct = Math.round((activeRules.filter(r => r.fout).reduce((s, r) => s + r.alpha, 0) / sumAlpha) * 100);
    const heaterPct = Math.round((activeRules.filter(r => r.htr).reduce((s, r) => s + r.alpha, 0) / sumAlpha) * 100);
    const convPct   = Math.round((activeRules.filter(r => r.cnv).reduce((s, r) => s + r.alpha, 0) / sumAlpha) * 100);

    // Penentuan Label Kondisi Lingkungan
    const isDanger = nB > 0.4 || tP > 0.6;
    const isWarning = nW > 0.4 || tP > 0.2 || hB > 0.5;
    const label = isDanger ? 'Kondisi Bahaya' : isWarning ? 'Kondisi Waspada' : 'Kondisi Normal';

    return {
      membership: {
        temp: { Dingin: tD, Normal: tN, Panas: tP },
        humid: { Kering: hK, Normal: hN, Basah: hB },
        ammonia: { Aman: nA, Waspada: nW, Bahaya: nB }
      },
      activeRules,
      crisp: {
        fanIntake: fanInPct,
        fanExhaust: fanOutPct,
        heater: heaterPct,
        conveyor: convPct
      },
      states: {
        fanIntake: fanInPct > 50,
        fanExhaust: fanOutPct > 50,
        heater: heaterPct > 50,
        conveyor: convPct > 50
      },
      conditionLabel: label,
      statusClass: isDanger ? 'danger' : isWarning ? 'warning' : 'normal'
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 2. SUPABASE REALTIME & DATA POLLING ENGINE
  // ════════════════════════════════════════════════════════════════

  function initMockHistory() {
    const hist = [];
    const now = Date.now();
    for (let i = 30; i >= 0; i--) {
      const time = new Date(now - i * 60 * 1000);
      const temp = +(22 + Math.sin(i * 0.18) * 4 + (Math.random() - 0.5) * 1).toFixed(1);
      const humid = +(68 + Math.cos(i * 0.12) * 8 + (Math.random() - 0.5) * 2).toFixed(1);
      const ammonia = +(13 + Math.sin(i * 0.25) * 5 + (Math.random() - 0.5) * 1.5).toFixed(1);
      hist.push({ time, temp, humid, ammonia });
    }
    state.history = hist;
  }

  function tickDemoData() {
    const now = new Date();
    const t = now.getTime();
    
    // Smooth oscillation mimicking chicken coop day/night & ventilation cycles
    const temp = +(23.5 + Math.sin(t / 25000) * 5 + (Math.random() - 0.5) * 0.8).toFixed(1);
    const humid = +(69.0 + Math.cos(t / 20000) * 10 + (Math.random() - 0.5) * 1.2).toFixed(1);
    const ammonia = +(14.2 + Math.sin(t / 18000) * 7 + (Math.random() - 0.5) * 1.0).toFixed(1);

    updateSensorData(temp, humid, ammonia);
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

      // 1. Ambil pembacaan sensor terkini untuk menguji koneksi database
      const { data: latestRows, error: errLatest } = await state.supabaseClient
        .from('sensor_readings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);

      if (errLatest) {
        console.error('Error koneksi Supabase:', errLatest);
        setConnectionStatus(false, 'Database: Terputus', errLatest.message || 'Gagal query Supabase');
        return false;
      }

      // Database berhasil terhubung!
      setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Online)');

      if (latestRows && latestRows.length > 0) {
        const latest = latestRows[0];
        updateSensorData(latest.temperature, latest.humidity, latest.ammonia, latest.created_at);
      } else {
        console.log('Tabel sensor_readings masih kosong. Menunggu data masuk dari ESP32...');
      }

      // 2. Ambil riwayat sensor 24 jam terakhir untuk grafik
      const cut = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: histData, error: errHist } = await state.supabaseClient
        .from('sensor_readings')
        .select('*')
        .gte('created_at', cut)
        .order('created_at', { ascending: true })
        .limit(100);

      if (!errHist && histData && histData.length > 0) {
        state.history = histData.map(d => ({
          time: new Date(d.created_at),
          temp: d.temperature,
          humid: d.humidity,
          ammonia: d.ammonia
        }));
        if (state.currentView === 'history') renderCanvasChart();
      }

      // 3. Ambil status aktuator terkini
      const { data: actRows } = await state.supabaseClient
        .from('actuator_status')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (actRows && actRows.length > 0) {
        const actData = actRows[0];
        state.actuators.fanIntake = actData.fan_intake;
        state.actuators.fanExhaust = actData.fan_exhaust;
        state.actuators.heater = actData.heater;
        state.actuators.conveyor = actData.conveyor;
        renderUI();
      }

      // 4. Langganan Supabase Realtime WebSocket Channel
      state.supabaseChannels.forEach(ch => state.supabaseClient.removeChannel(ch));
      state.supabaseChannels = [];

      const chSensor = state.supabaseClient
        .channel('realtime_sensor_readings')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_readings' }, (payload) => {
          const row = payload.new;
          console.log('[Supabase Realtime] Sensor masuk:', row);
          updateSensorData(row.temperature, row.humidity, row.ammonia, row.created_at);
          setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live Data)');
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Realtime)');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[Supabase Realtime] Status channel:', status);
          }
        });

      const chActuator = state.supabaseClient
        .channel('realtime_actuator_status')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'actuator_status' }, (payload) => {
          const row = payload.new;
          console.log('[Supabase Realtime] Aktuator update:', row);
          state.actuators.fanIntake = row.fan_intake;
          state.actuators.fanExhaust = row.fan_exhaust;
          state.actuators.heater = row.heater;
          state.actuators.conveyor = row.conveyor;
          renderUI();
        })
        .subscribe();

      state.supabaseChannels = [chSensor, chActuator];
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
      
      updateSensorData(data.temp, data.humid, data.ammonia, new Date());
      setConnectionStatus(true, 'ESP32 Terhubung');
    } catch (err) {
      console.warn('Gagal koneksi ke ESP32:', err.message);
      setConnectionStatus(false, 'ESP32 Offline');
    }
  }

  function updateSensorData(temp, humid, ammonia, timestamp) {
    state.sensors.temperature = Number(temp);
    state.sensors.humidity = Number(humid);
    state.sensors.ammonia = Number(ammonia);
    state.sensors.timestamp = timestamp ? new Date(timestamp) : new Date();

    if (state.connectionMode === 'demo') {
      state.lastEsp32Heartbeat = new Date();
    } else if (timestamp) {
      state.lastEsp32Heartbeat = new Date(timestamp);
    }

    evaluateEsp32Status();

    // Jalankan kalkulasi Fuzzy Mamdani
    state.fuzzy = computeFuzzyMamdani(temp, humid, ammonia);

    // Update aktuator otomatis jika tidak dalam mode manual
    if (!state.actuators.isManual) {
      state.actuators.fanIntake = state.fuzzy.states.fanIntake;
      state.actuators.fanExhaust = state.fuzzy.states.fanExhaust;
      state.actuators.heater = state.fuzzy.states.heater;
      state.actuators.conveyor = state.fuzzy.states.conveyor;
    }

    // Rekam histori grafik (max 60 titik)
    state.history.push({
      time: new Date(),
      temp: Number(temp),
      humid: Number(humid),
      ammonia: Number(ammonia)
    });
    if (state.history.length > 60) state.history.shift();

    // Cek alarm peringatan
    checkAlerts(temp, humid, ammonia);

    // Refresh UI
    renderUI();
  }

  function checkAlerts(t, h, a) {
    const alerts = [];
    const ts = new Date().toLocaleTimeString('id-ID');

    if (a >= THRESHOLDS.ammonia.danger) {
      alerts.push({ type: 'danger', msg: `Gas Amonia Kritis: ${a} ppm (Ambang Bahaya > 25 ppm)`, time: ts });
    } else if (a >= THRESHOLDS.ammonia.warning) {
      alerts.push({ type: 'warning', msg: `Gas Amonia Meningkat: ${a} ppm (Waspada > 20 ppm)`, time: ts });
    }

    if (t >= THRESHOLDS.temperature.danger) {
      alerts.push({ type: 'danger', msg: `Suhu Udara Ekstrem: ${t}°C (Risiko Heat Stress Tinggi)`, time: ts });
    } else if (t >= THRESHOLDS.temperature.warning) {
      alerts.push({ type: 'warning', msg: `Suhu di atas zona nyaman: ${t}°C (Ideal 20–25°C)`, time: ts });
    }

    if (h >= THRESHOLDS.humidity.danger) {
      alerts.push({ type: 'danger', msg: `Kelembapan sangat tinggi: ${h}% (Kandang Terlalu Basah)`, time: ts });
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
        if (dbSub) dbSub.textContent = subText || 'Supabase Cloud (Live)';
      } else {
        dbText.textContent = text || 'Database: Terputus';
        if (dbSub) dbSub.textContent = subText || 'Gagal Konek Supabase';
      }
    }

    evaluateEsp32Status();
  }

  // Evaluasi koneksi mikrokontroler ESP32
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

    const diff = Math.max(0, Math.round((Date.now() - state.lastEsp32Heartbeat.getTime()) / 1000));

    if (diff <= 15) {
      // Data masuk secara normal (ESP32 mengirim tiap 3-5 detik)
      dot.className = 'pulse-dot';
      text.textContent = 'ESP32: Terhubung (Online)';
      if (timeEl) timeEl.textContent = diff <= 1 ? '(Live)' : `(${diff}d lalu)`;
      if (chipDot) chipDot.className = 'pulse-dot';
      if (chipText) {
        chipText.textContent = `ESP32: Terhubung / Online ${diff <= 1 ? '(Live)' : '(' + diff + 's lalu)'}`;
        chipText.style.color = 'var(--success)';
      }
    } else if (diff <= 45) {
      // Sedikit terlambat / sinyal wifi kandang lemah
      dot.className = 'pulse-dot demo';
      text.textContent = 'ESP32: Sinyal Lambat';
      if (timeEl) timeEl.textContent = `(${diff}d lalu)`;
      if (chipDot) chipDot.className = 'pulse-dot demo';
      if (chipText) {
        chipText.textContent = `ESP32: Sinyal Lambat (${diff}s lalu)`;
        chipText.style.color = 'var(--warning)';
      }
    } else {
      // Lebih dari 45 detik tidak ada telemetri baru -> Alat mati/terputus
      dot.className = 'pulse-dot offline';
      text.textContent = 'ESP32: Terputus (Offline)';
      if (timeEl) timeEl.textContent = `(Mati sejak ${state.lastEsp32Heartbeat.toLocaleTimeString('id-ID')})`;
      if (chipDot) chipDot.className = 'pulse-dot offline';
      if (chipText) {
        chipText.textContent = `ESP32: Terputus / Offline (Terakhir ${state.lastEsp32Heartbeat.toLocaleTimeString('id-ID')})`;
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

    // Header updates
    const clockEl = document.getElementById('header-clock');
    if (clockEl) clockEl.textContent = s.timestamp.toLocaleTimeString('id-ID');

    // Condition Badge (Dashboard)
    const condBadge = document.getElementById('cond-badge');
    if (condBadge) {
      condBadge.className = `cond-badge ${f.statusClass}`;
      condBadge.textContent = f.conditionLabel;
    }

    // ─── 1. Sensor Cards ───
    updateCard('temp', s.temperature, THRESHOLDS.temperature, '°C');
    updateCard('humid', s.humidity, THRESHOLDS.humidity, '%');
    updateCard('ammonia', s.ammonia, THRESHOLDS.ammonia, 'ppm');

    // ─── 2. Actuator Cards ───
    updateActuatorCard('fan-in', state.actuators.fanIntake, f.crisp.fanIntake);
    updateActuatorCard('fan-out', state.actuators.fanExhaust, f.crisp.fanExhaust);
    updateActuatorCard('heater', state.actuators.heater, f.crisp.heater);
    updateActuatorCard('conveyor', state.actuators.conveyor, f.crisp.conveyor);

    // ─── 3. Fuzzy Membership Bars (Tab Fuzzy & Tab Dashboard) ───
    updateMembershipDisplay(f.membership);

    // ─── 4. Active Rules Table ───
    renderActiveRules(f.activeRules);

    // ─── 5. Notification Bell ───
    const notifBadge = document.getElementById('notif-badge');
    if (notifBadge) {
      if (state.unreadCount > 0) {
        notifBadge.style.display = 'flex';
        notifBadge.textContent = state.unreadCount;
      } else {
        notifBadge.style.display = 'none';
      }
    }

    // ─── 6. History Chart (jika tab history aktif) ───
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
      badgeEl.textContent = status === 'danger' ? 'BAHAYA' : status === 'warning' ? 'WASPADA' : 'NORMAL';
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

  function updateMembershipDisplay(mem) {
    setBarVal('m-temp-dingin', mem.temp.Dingin);
    setBarVal('m-temp-normal', mem.temp.Normal);
    setBarVal('m-temp-panas', mem.temp.Panas);

    setBarVal('m-hum-kering', mem.humid.Kering);
    setBarVal('m-hum-normal', mem.humid.Normal);
    setBarVal('m-hum-basah', mem.humid.Basah);

    setBarVal('m-nh3-aman', mem.ammonia.Aman);
    setBarVal('m-nh3-waspada', mem.ammonia.Waspada);
    setBarVal('m-nh3-bahaya', mem.ammonia.Bahaya);
  }

  function setBarVal(id, val) {
    const bar = document.getElementById(id);
    const txt = document.getElementById(`${id}-val`);
    if (bar) bar.style.width = `${(val * 100).toFixed(0)}%`;
    if (txt) txt.textContent = val.toFixed(2);
  }

  function renderActiveRules(rules) {
    const tbody = document.getElementById('active-rules-body');
    if (!tbody) return;

    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">Tidak ada rule aktif</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map(r => `
      <tr>
        <td><span class="rule-id-badge">R${String(r.id).padStart(2, '0')}</span></td>
        <td style="font-family:var(--font-mono);">${r.antecedent}</td>
        <td style="font-family:var(--font-mono);font-size:11px;">${r.consequent}</td>
        <td style="font-family:var(--font-mono);font-weight:700;color:var(--primary);text-align:right;">
          μ = ${r.alpha.toFixed(2)}
        </td>
      </tr>
    `).join('');
  }

  // ════════════════════════════════════════════════════════════════
  // 4. PURE HTML5 CANVAS LINE CHART
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
      ctx.fillText('Menunggu data telemetri...', w / 2 - 60, h / 2);
      return;
    }

    const minY = 0;
    const maxY = 100;

    // Draw horizontal grid lines
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

    drawSeries('humid', '#0284C7', 'rgba(2, 132, 199, 0.05)');
    drawSeries('temp', '#FF6B00', 'rgba(255, 107, 0, 0.08)');
    drawSeries('ammonia', '#10B981', 'rgba(16, 185, 129, 0.08)');

    ctx.fillStyle = '#8C90A0';
    ctx.textAlign = 'left';
    ctx.fillText(data[0].time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), padLeft, h - 10);
    if (data.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(data[data.length - 1].time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), w - padRight, h - 10);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5. EVENT LISTENERS & NAVIGATION
  // ════════════════════════════════════════════════════════════════

  function initEvents() {
    // Nav links (Sidebar & Mobile)
    const links = document.querySelectorAll('[data-view]');
    links.forEach(l => {
      l.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = l.getAttribute('data-view');
        switchView(targetView);
      });
    });

    // Chart range filter buttons
    const chartBtns = document.querySelectorAll('.chart-btn');
    chartBtns.forEach(b => {
      b.addEventListener('click', () => {
        chartBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.chartRange = b.getAttribute('data-range');
        renderCanvasChart();
      });
    });

    // Log sensor date filter listeners
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

    // Fuzzy Mamdani Live Simulator Sliders
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
      renderActiveRules(simFuzzy.activeRules);

      const simOutBox = document.getElementById('sim-output-text');
      if (simOutBox) {
        simOutBox.innerHTML = `
          <strong>Kondisi: ${simFuzzy.conditionLabel}</strong> | 
          Kipas In: ${simFuzzy.crisp.fanIntake}% (${simFuzzy.states.fanIntake ? 'ON':'OFF'}), 
          Kipas Out: ${simFuzzy.crisp.fanExhaust}% (${simFuzzy.states.fanExhaust ? 'ON':'OFF'}), 
          Pemanas: ${simFuzzy.crisp.heater}% (${simFuzzy.states.heater ? 'ON':'OFF'}), 
          Konveyor: ${simFuzzy.states.conveyor ? 'ON':'OFF'}
        `;
      }
    }

    if (simTemp && simHum && simNh3) {
      simTemp.addEventListener('input', onSimSliderChange);
      simHum.addEventListener('input', onSimSliderChange);
      simNh3.addEventListener('input', onSimSliderChange);
    }

    // Settings Modal Open / Close
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

        // Simpan ke localStorage
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

    // Notification dropdown toggle
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
  // 5. LOG DATA SENSOR & DATE FILTER (DATABASE SUPABASE)
  // ════════════════════════════════════════════════════════════════

  let currentLogs = [];

  async function fetchSensorLogs(startDate, endDate) {
    const tbody = document.getElementById('log-table-body');
    const badge = document.getElementById('log-count-badge');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted);">Sedang mengambil data dari Supabase...</td></tr>';

    try {
      if (state.connectionMode === 'supabase' && state.supabaseClient) {
        let query = state.supabaseClient
          .from('sensor_readings')
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
        // Mode Demo / Simulasi: Ambil dari state.history
        currentLogs = state.history.map((h, idx) => ({
          id: idx + 1,
          created_at: h.time.toISOString(),
          temperature: h.temp,
          humidity: h.humid,
          ammonia: h.ammonia,
          device_id: 'ESP32-01'
        })).reverse();
      }

      renderLogsTable(currentLogs);
    } catch (err) {
      console.error('Gagal mengambil log sensor:', err);
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--danger);">Gagal memuat log: ${err.message}</td></tr>`;
      if (badge) badge.textContent = 'Error';
    }
  }

  function renderLogsTable(logs) {
    const tbody = document.getElementById('log-table-body');
    const badge = document.getElementById('log-count-badge');
    if (!tbody) return;

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted);">Tidak ada data sensor pada rentang tanggal yang dipilih.</td></tr>';
      if (badge) badge.textContent = '0 Data';
      return;
    }

    if (badge) badge.textContent = `${logs.length} Data`;

    tbody.innerHTML = logs.map((item, index) => {
      const dt = new Date(item.created_at);
      const timeStr = dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + 
                      dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const t = Number(item.temperature);
      const h = Number(item.humidity);
      const a = Number(item.ammonia);

      // Evaluasi status kondisi mikroklimat
      let condText = 'Normal';
      let condClass = 'normal';
      if (a >= THRESHOLDS.ammonia.danger || t >= THRESHOLDS.temperature.danger) {
        condText = 'Kritis / Bahaya';
        condClass = 'danger';
      } else if (a >= THRESHOLDS.ammonia.warning || t >= THRESHOLDS.temperature.warning || h >= THRESHOLDS.humidity.danger) {
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
          <td><span class="badge-condition ${condClass}">${condText}</span></td>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${item.device_id || 'ESP32-01'}</td>
        </tr>
      `;
    }).join('');
  }

  function exportLogsToCSV() {
    if (!currentLogs || currentLogs.length === 0) {
      alert('Tidak ada data log untuk diunduh.');
      return;
    }

    let csv = 'No,Waktu,Suhu_C,Kelembapan_Persen,Amonia_PPM,Status,Device_ID\r\n';
    currentLogs.forEach((item, idx) => {
      const dt = new Date(item.created_at).toLocaleString('id-ID');
      const t = Number(item.temperature).toFixed(1);
      const h = Number(item.humidity).toFixed(1);
      const a = Number(item.ammonia).toFixed(1);
      const dev = item.device_id || 'ESP32-01';
      csv += `${idx + 1},"${dt}",${t},${h},${a},"${t > 30 ? 'Panas' : 'Normal'}",${dev}\r\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `log-sensor-kandang-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

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
    }
  }

  function restartPolling() {
    if (state.timerId) clearInterval(state.timerId);

    if (state.connectionMode === 'supabase') {
      setConnectionStatus(null, 'Database: Menghubungkan...', 'Memeriksa Supabase...');
      initSupabaseClient().then(success => {
        if (!success) {
          state.timerId = setInterval(tickDemoData, 3000);
          tickDemoData();
        } else {
          // Polling sinkronisasi database berkala setiap 5 detik
          state.timerId = setInterval(async () => {
            if (state.connectionMode === 'supabase' && state.supabaseClient) {
              try {
                const { data, error } = await state.supabaseClient
                  .from('sensor_readings')
                  .select('*')
                  .order('created_at', { ascending: false })
                  .limit(1);
                if (!error && data && data.length > 0) {
                  const r = data[0];
                  const rowTime = new Date(r.created_at);
                  if (!state.sensors.timestamp || rowTime > state.sensors.timestamp) {
                    updateSensorData(r.temperature, r.humidity, r.ammonia, r.created_at);
                  }
                  setConnectionStatus(true, 'Database: Terhubung', 'Supabase Cloud (Live)');
                }
              } catch (e) {
                console.warn('Sync periodic check error:', e);
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
  // 6. INITIALIZATION
  // ════════════════════════════════════════════════════════════════
  function init() {
    initMockHistory();
    initEvents();

    // Inisialisasi awal
    tickDemoData();
    restartPolling();

    // Timer watchdog status koneksi ESP32 tiap 1 detik
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
