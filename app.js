'use strict';

/* ------------------------------------------------------------------
 * Sound engine
 *
 * Battery: the noise is rendered ONCE into a short seamless loop
 * (filters baked in via OfflineAudioContext). While playing, the audio
 * thread only reads that buffer: source -> gain -> gain -> speakers.
 * No per-sample JavaScript, no live filters, large output buffers
 * (latencyHint "playback"), and the AudioContext is suspended when
 * paused so the audio hardware can sleep.
 *
 * Speaker / hearing safety:
 *  - subsonic content removed (high-pass) so small speakers don't
 *    over-excurse on brown noise rumble they can't reproduce anyway
 *  - every loop is loudness-normalised and peak-capped well below
 *    full scale, so nothing can clip regardless of settings
 *  - perceptual volume curve with a hard ceiling, slow fade-in on
 *    start, fades on every change, long fade-out for the sleep timer
 * ------------------------------------------------------------------ */
const Engine = (() => {
  const LOOP_SEC = 24;      // loop length (mono, ~4.6 MB at 48 kHz)
  const XFADE_SEC = 1.0;    // loop seam crossfade
  const WARMUP_SEC = 0.5;   // discarded so filters start settled
  const HIGHPASS_HZ = 45;   // speaker protection
  const TARGET_RMS = 0.1;   // about -20 dBFS
  const PEAK_CAP = 0.6;     // about -4.4 dBFS, never clips
  const MAX_GAIN = 1.0;     // volume ceiling at 100 %

  let ctx = null, master = null, timerGain = null, voice = null;
  let buildId = 0;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    master = ctx.createGain();
    master.gain.value = 0;
    timerGain = ctx.createGain();
    master.connect(timerGain);
    timerGain.connect(ctx.destination);
    return ctx;
  }

  function toneToHz(tone) {
    // 0..100 -> 350 Hz .. 16 kHz, exponential so it feels even
    return 350 * Math.pow(16000 / 350, tone / 100);
  }

  function rawNoise(color, n) {
    const out = new Float32Array(n);
    if (color === 'brown') {
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        out[i] = last * 3.5;
      }
    } else {
      // Paul Kellet's refined pink filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    return out;
  }

  function renderOffline(off) {
    return new Promise((resolve, reject) => {
      off.oncomplete = (e) => resolve(e.renderedBuffer);
      const p = off.startRendering();
      if (p && p.then) p.then(resolve, reject);
    });
  }

  async function build(color, tone) {
    const sr = ensure().sampleRate;
    const N = Math.round(LOOP_SEC * sr);
    const F = Math.round(XFADE_SEC * sr);
    const W = Math.round(WARMUP_SEC * sr);
    const total = W + N + F;

    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, total, sr);
    const src0 = off.createBuffer(1, total, sr);
    src0.getChannelData(0).set(rawNoise(color, total));
    const src = off.createBufferSource();
    src.buffer = src0;
    const hp = off.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = HIGHPASS_HZ; hp.Q.value = 0.707;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = toneToHz(tone); lp.Q.value = 0.707;
    src.connect(hp); hp.connect(lp); lp.connect(off.destination);
    src.start(0);
    const seg = (await renderOffline(off)).getChannelData(0).subarray(W);

    // Seamless loop: equal-power crossfade of the tail into the head.
    const out = new Float32Array(N);
    out.set(seg.subarray(0, N));
    for (let i = 0; i < F; i++) {
      const t = (i / F) * Math.PI / 2;
      out[i] = seg[i] * Math.sin(t) + seg[N + i] * Math.cos(t);
    }

    // Remove DC, normalise loudness, cap peaks.
    let mean = 0;
    for (let i = 0; i < N; i++) mean += out[i];
    mean /= N;
    let sq = 0, peak = 0;
    for (let i = 0; i < N; i++) {
      const v = (out[i] -= mean);
      sq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sq / N) || 1;
    const k = Math.min(TARGET_RMS / rms, PEAK_CAP / (peak || 1));
    for (let i = 0; i < N; i++) out[i] *= k;

    const buf = ctx.createBuffer(1, N, sr);
    buf.getChannelData(0).set(out);
    return buf;
  }

  function hold(param, now) {
    const v = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v, now);
  }

  function startVoice(buffer, fade) {
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = ctx.createGain();
    if (fade) {
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + fade);
    }
    src.connect(g);
    g.connect(master);
    src.start(now);
    const old = voice;
    voice = { src, g };
    if (old) retire(old, fade || 0.05);
  }

  function retire(v, fade) {
    const now = ctx.currentTime;
    hold(v.g.gain, now);
    v.g.gain.linearRampToValueAtTime(0, now + fade);
    try { v.src.stop(now + fade + 0.05); } catch (e) {}
    v.src.onended = () => { v.src.disconnect(); v.g.disconnect(); };
  }

  const volToGain = (vol) => MAX_GAIN * Math.pow(vol / 100, 2);

  return {
    get state() { return ctx ? ctx.state : 'closed'; },
    get context() { return ctx; },
    unlock() { ensure(); return ctx.resume(); },

    /** Render a new loop and make it the active sound (crossfaded if already playing). */
    async load(color, tone, playing) {
      const id = ++buildId;
      const buf = await build(color, tone);
      if (id !== buildId) return false;          // superseded by a newer request
      if (playing) startVoice(buf, voice ? 1.5 : 0);
      this._buf = buf;
      return true;
    },

    async play(vol, fadeIn = 3) {
      ensure();
      await ctx.resume();
      const now = ctx.currentTime;
      hold(master.gain, now);
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(volToGain(vol), now + fadeIn);
      if (!voice && this._buf) startVoice(this._buf, 0);
    },

    async stop(fadeOut = 1.2) {
      if (!ctx) return;
      const now = ctx.currentTime;
      hold(master.gain, now);
      master.gain.linearRampToValueAtTime(0, now + fadeOut);
      const v = voice;
      voice = null;
      await new Promise((r) => setTimeout(r, fadeOut * 1000 + 80));
      if (v) { try { v.src.stop(); } catch (e) {} v.src.disconnect(); v.g.disconnect(); }
      if (!voice && ctx.state === 'running') await ctx.suspend();   // let the audio hardware sleep
    },

    setVolume(vol) {
      if (!ctx || !voice) return;
      const now = ctx.currentTime;
      hold(master.gain, now);
      master.gain.setTargetAtTime(volToGain(vol), now, 0.08);
    },

    /** Schedule the sleep-timer fade on the audio clock (no JS wake-ups needed). */
    armTimer(seconds, fade) {
      if (!ctx) return;
      const now = ctx.currentTime;
      const p = timerGain.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(1, now);
      if (seconds > 0) {
        const f = Math.min(fade, seconds / 2);
        p.setValueAtTime(1, now + seconds - f);
        p.linearRampToValueAtTime(0, now + seconds);
      }
    }
  };
})();

/* ------------------------------------------------------------------
 * App / UI
 * ------------------------------------------------------------------ */
(() => {
  const $ = (s) => document.querySelector(s);
  const playBtn = $('#playBtn'), statusEl = $('#status');
  const toneEl = $('#tone'), volEl = $('#vol');
  const volHint = $('#volHint'), battHint = $('#battHint');
  const veil = $('#veil'), veilText = $('#veilText'), fsBtn = $('#fsBtn');
  const choices = [...document.querySelectorAll('.choice')];
  const chips = [...document.querySelectorAll('.chip')];

  const TIMER_FADE_SEC = 120;   // sleep timer fades out over 2 minutes
  const IDLE_DIM_MS = 20000;    // dim screen after 20 s untouched while playing
  const LOUD_AT = 75;

  const KEY = 'sleepnoise.v1';
  const s = Object.assign({ color: 'pink', tone: 55, vol: 35, timer: 0 }, load());
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  let playing = false, busy = false, loaded = false;
  let deadline = 0, stopTimer = 0, tickTimer = 0, idleTimer = 0;

  /* ---------- rendering of controls ---------- */
  function paint() {
    choices.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === s.color)));
    chips.forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.min === s.timer)));
    toneEl.value = s.tone;
    volEl.value = s.vol;
    volHint.hidden = s.vol < LOUD_AT;
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    paintStatus();
  }

  function fmtLeft(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  function paintStatus() {
    const name = s.color === 'pink' ? 'Pink noise' : 'Brown noise';
    let text;
    if (!playing) text = 'Tap to play';
    else if (deadline) text = name + ' · off in ' + fmtLeft(deadline - Date.now());
    else text = name + ' · playing';
    statusEl.textContent = text;
    veilText.textContent = playing ? text : 'Paused';
  }

  // Only refresh the countdown while someone can actually see it.
  function syncTick() {
    clearInterval(tickTimer);
    tickTimer = 0;
    if (playing && deadline && document.visibilityState === 'visible') {
      tickTimer = setInterval(paintStatus, 20000);
    }
  }

  /* ---------- playback ---------- */
  async function play() {
    if (busy || playing) return;
    busy = true;
    try {
      const unlocked = Engine.unlock();          // must start inside the tap on iOS
      if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
      if (!loaded) loaded = await Engine.load(s.color, s.tone, false);
      await unlocked;
      await Engine.play(s.vol);
      playing = true;
      armTimer();
      setMedia();
      paint();
      bumpIdle();
    } catch (e) {
      statusEl.textContent = 'Sound could not start. Tap to try again.';
    } finally {
      busy = false;
    }
  }

  async function pause(fade) {
    if (!playing) return;
    playing = false;
    clearTimeout(stopTimer);
    deadline = 0;
    syncTick();
    clearTimeout(idleTimer);
    undim();
    paint();
    setMedia();
    await Engine.stop(fade);
  }

  function armTimer() {
    clearTimeout(stopTimer);
    deadline = 0;
    const sec = s.timer * 60;
    Engine.armTimer(sec, TIMER_FADE_SEC);
    if (sec > 0 && playing) {
      deadline = Date.now() + sec * 1000;
      // The fade itself runs on the audio clock; this only releases the hardware afterwards.
      stopTimer = setTimeout(() => pause(0.1), sec * 1000 + 500);
    }
    syncTick();
    paintStatus();
  }

  async function changeSound() {
    loaded = false;
    const ok = await Engine.load(s.color, s.tone, playing);
    if (ok) loaded = true;
  }

  /* ---------- controls ---------- */
  playBtn.addEventListener('click', () => {
    if (playing) pause(); else { maybeFullscreen(); play(); }
  });

  choices.forEach((b) => b.addEventListener('click', () => {
    if (s.color === b.dataset.color) return;
    s.color = b.dataset.color; save(); paint(); setMedia(); changeSound();
  }));

  chips.forEach((b) => b.addEventListener('click', () => {
    s.timer = +b.dataset.min; save(); paint(); if (playing) armTimer();
  }));

  // Tone re-renders the loop, so do it when the finger lifts, not on every pixel.
  toneEl.addEventListener('change', () => { s.tone = +toneEl.value; save(); changeSound(); });

  volEl.addEventListener('input', () => {
    s.vol = +volEl.value;
    volHint.hidden = s.vol < LOUD_AT;
    Engine.setVolume(s.vol);
  });
  volEl.addEventListener('change', save);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); playBtn.click(); }
  });

  /* ---------- idle dim ---------- */
  function undim() { document.body.classList.remove('dim'); }
  function bumpIdle() {
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(() => document.body.classList.add('dim'), IDLE_DIM_MS);
  }
  // First tap on the dark veil only wakes the controls; it never changes a setting.
  veil.addEventListener('click', (e) => { e.stopPropagation(); undim(); bumpIdle(); });
  ['pointerdown', 'keydown'].forEach((t) =>
    document.addEventListener(t, () => { if (!document.body.classList.contains('dim')) bumpIdle(); }, { passive: true }));

  /* ---------- page lifecycle ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      paintStatus();
      // Recover if the OS interrupted audio (calls, alarms) while we were away.
      if (playing && Engine.state !== 'running') Engine.unlock().catch(() => {});
    } else {
      clearTimeout(idleTimer);
    }
    syncTick();
  });

  /* ---------- lock-screen / headset controls ---------- */
  function setMedia() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.color === 'pink' ? 'Pink noise' : 'Brown noise',
        artist: 'Sleep Noise',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch (e) {}
  }
  if ('mediaSession' in navigator) {
    const h = { play: () => play(), pause: () => pause(), stop: () => pause() };
    for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) {} }
  }

  /* ---------- full screen ---------- */
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
    || navigator.standalone === true;
  const canFs = !!document.documentElement.requestFullscreen && !standalone;
  fsBtn.hidden = !canFs;
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  fsBtn.addEventListener('click', toggleFs);
  // On phones opened in the browser, go full screen on the first Play.
  let triedFs = false;
  function maybeFullscreen() {
    if (triedFs || !canFs || document.fullscreenElement) return;
    triedFs = true;
    if (matchMedia('(pointer: coarse)').matches) toggleFs();
  }

  /* ---------- battery awareness (event-driven, no polling) ---------- */
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const check = () => { battHint.hidden = b.charging || b.level > 0.15; };
      b.addEventListener('levelchange', check);
      b.addEventListener('chargingchange', check);
      check();
    }).catch(() => {});
  }

  /* ---------- offline / installable ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  paint();
})();
