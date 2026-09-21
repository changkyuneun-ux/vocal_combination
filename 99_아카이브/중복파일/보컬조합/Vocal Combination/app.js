/* Vocal Combination — multitrack browser mixer
 * - Web Audio API for decoding, playback, real-time mix
 * - Offline rendering for WAV export
 * - No localStorage (sandbox blocks it)
 */

(() => {
  // ---------- THEME TOGGLE ----------
  const themeBtn = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  function paintToggle() {
    themeBtn.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
    themeBtn.innerHTML =
      theme === 'dark'
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
  root.setAttribute('data-theme', theme);
  paintToggle();
  themeBtn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    paintToggle();
    drawAllTracks();
    drawRuler();
  });

  // ---------- AUDIO CONTEXT ----------
  let audioCtx = null;
  function ensureCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ---------- STATE ----------
  const TRACK_COLORS = ['var(--track-1)', 'var(--track-2)', 'var(--track-3)', 'var(--track-4)'];
  const TRACK_HEX = ['#ff5d8f', '#5ec5ff', '#ffb648', '#9d7bff'];
  let tracks = [
    makeTrack('Voice 1'),
    makeTrack('Voice 2'),
    makeTrack('Voice 3'),
  ];
  let isPlaying = false;
  let playStartCtxTime = 0;
  let playStartOffset = 0;
  let activeSources = []; // {src, gain}
  let masterGainNode = null;
  let masterVol = 1.0;
  let rafId = null;
  let nextTrackNumber = 4;

  function makeTrack(name) {
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
      name,
      buffer: null,        // AudioBuffer
      fileName: null,
      volume: 1.0,         // 0..1.5
      pan: 0,              // -1..1
      pitch: 0,            // semitones, -12..+12
      muted: false,
      solo: false,
    };
  }

  // ---------- DOM REFS ----------
  const tracksEl = document.getElementById('tracks');
  const playBtn = document.getElementById('play-btn');
  const playLabel = document.getElementById('play-label');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');
  const tcCurrent = document.getElementById('tc-current');
  const tcTotal = document.getElementById('tc-total');
  const masterVolEl = document.getElementById('master-vol');
  const masterVolVal = document.getElementById('master-vol-val');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const rulerCanvas = document.getElementById('ruler');
  const addTrackBtn = document.getElementById('add-track-btn');
  const helpBtn = document.getElementById('help-btn');
  const helpCard = document.getElementById('help-card');

  // ---------- STATUS ----------
  function setStatus(msg, state = 'idle') {
    statusText.textContent = msg;
    statusEl.setAttribute('data-state', state);
  }

  // ---------- RENDER TRACKS ----------
  function render() {
    tracksEl.innerHTML = '';
    tracks.forEach((tr, idx) => tracksEl.appendChild(buildTrackRow(tr, idx)));
    refreshControls();
    drawAllTracks();
    drawRuler();
  }

  function buildTrackRow(tr, idx) {
    const colorVar = TRACK_COLORS[idx % TRACK_COLORS.length];
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.id = tr.id;
    row.style.setProperty('--track-color', colorVar);

    // ---------- LEFT: controls ----------
    const ctrls = document.createElement('div');
    ctrls.className = 'track-controls';

    const colorBar = document.createElement('div');
    colorBar.className = 'track-color-bar';
    ctrls.appendChild(colorBar);

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = 'var(--space-2)';

    const nameInput = document.createElement('input');
    nameInput.className = 'track-name';
    nameInput.value = tr.name;
    nameInput.setAttribute('aria-label', '트랙 이름');
    nameInput.addEventListener('change', () => { tr.name = nameInput.value || `Voice ${idx + 1}`; });
    topRow.appendChild(nameInput);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'track-buttons';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'toggle-btn';
    muteBtn.textContent = 'M';
    muteBtn.setAttribute('aria-label', '음소거');
    muteBtn.setAttribute('aria-pressed', String(tr.muted));
    muteBtn.addEventListener('click', () => {
      tr.muted = !tr.muted;
      muteBtn.setAttribute('aria-pressed', String(tr.muted));
      applyLiveTrackVolume(tr);
    });
    btnGroup.appendChild(muteBtn);

    const soloBtn = document.createElement('button');
    soloBtn.className = 'toggle-btn solo';
    soloBtn.textContent = 'S';
    soloBtn.setAttribute('aria-label', '솔로');
    soloBtn.setAttribute('aria-pressed', String(tr.solo));
    soloBtn.addEventListener('click', () => {
      tr.solo = !tr.solo;
      soloBtn.setAttribute('aria-pressed', String(tr.solo));
      tracks.forEach(applyLiveTrackVolume);
    });
    btnGroup.appendChild(soloBtn);

    if (tracks.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'toggle-btn remove';
      removeBtn.setAttribute('aria-label', '트랙 삭제');
      removeBtn.title = '트랙 삭제';
      removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
      removeBtn.addEventListener('click', () => {
        if (isPlaying) stopPlayback();
        tracks = tracks.filter(t => t.id !== tr.id);
        render();
      });
      btnGroup.appendChild(removeBtn);
    }

    topRow.appendChild(btnGroup);
    ctrls.appendChild(topRow);

    const meta = document.createElement('div');
    meta.className = 'track-meta';
    meta.textContent = tr.buffer
      ? `${formatTime(tr.buffer.duration)} · ${tr.buffer.numberOfChannels === 1 ? 'mono' : 'stereo'}`
      : '비어 있음';
    ctrls.appendChild(meta);

    ctrls.appendChild(makeKnob('VOL', tr.volume, 0, 1.5, 0.01,
      v => `${Math.round(v * 100)}%`,
      v => { tr.volume = v; applyLiveTrackVolume(tr); }
    ));
    ctrls.appendChild(makeKnob('PAN', tr.pan, -1, 1, 0.02,
      v => v === 0 ? 'C' : (v < 0 ? `L${Math.round(Math.abs(v) * 100)}` : `R${Math.round(v * 100)}`),
      v => { tr.pan = v; applyLivePan(tr); }
    ));
    ctrls.appendChild(makeKnob('PIT', tr.pitch, -12, 12, 1,
      v => v === 0 ? '0st' : (v > 0 ? `+${v}st` : `${v}st`),
      v => { tr.pitch = v; if (isPlaying) restartPlayback(); }
    ));

    row.appendChild(ctrls);

    // ---------- RIGHT: waveform / dropzone ----------
    const cv = document.createElement('div');
    cv.className = 'track-canvas-wrap';

    const dz = document.createElement('div');
    dz.className = 'dropzone-track';
    dz.setAttribute('role', 'button');
    dz.setAttribute('tabindex', '0');
    dz.setAttribute('aria-label', '오디오 파일 불러오기');
    dz.addEventListener('click', () => triggerFileLoad(tr.id));
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerFileLoad(tr.id); }
    });
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await loadFileToTrack(tr.id, f);
    });

    const canvas = document.createElement('canvas');
    canvas.dataset.trackId = tr.id;

    const empty = document.createElement('div');
    empty.className = 'track-empty';
    empty.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      <span>클릭하거나 파일을 끌어다 놓으세요</span>
    `;

    cv.appendChild(canvas);
    cv.appendChild(empty);
    cv.appendChild(dz);

    // playhead lives in canvas wrap
    const ph = document.createElement('div');
    ph.className = 'playhead';
    ph.style.display = 'none';
    ph.dataset.role = 'playhead';
    cv.appendChild(ph);

    if (tr.buffer) empty.style.display = 'none';

    row.appendChild(cv);
    return row;
  }

  function makeKnob(label, value, min, max, step, fmt, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob-row';
    wrap.innerHTML = `<span>${label}</span>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = value;
    input.setAttribute('aria-label', label);
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = fmt(value);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = fmt(v);
      onChange(v);
    });
    // double-click to reset
    input.addEventListener('dblclick', () => {
      const def = (label === 'VOL') ? 1 : 0;
      input.value = def;
      val.textContent = fmt(def);
      onChange(def);
    });
    wrap.appendChild(input);
    wrap.appendChild(val);
    return wrap;
  }

  // ---------- FILE LOADING ----------
  const hiddenFile = document.getElementById('hidden-file-input');
  let pendingTrackId = null;
  function triggerFileLoad(trackId) {
    pendingTrackId = trackId;
    hiddenFile.value = '';
    hiddenFile.click();
  }
  hiddenFile.addEventListener('change', async () => {
    const f = hiddenFile.files && hiddenFile.files[0];
    if (f && pendingTrackId) await loadFileToTrack(pendingTrackId, f);
    pendingTrackId = null;
  });

  async function loadFileToTrack(trackId, file) {
    const tr = tracks.find(t => t.id === trackId);
    if (!tr) return;
    setStatus(`"${file.name}" 디코딩 중…`, 'working');
    try {
      const ctx = ensureCtx();
      const arr = await file.arrayBuffer();
      // decodeAudioData returns a Promise in modern browsers but legacy form takes callbacks
      const decoded = await new Promise((resolve, reject) => {
        try {
          const p = ctx.decodeAudioData(arr.slice(0), resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        } catch (e) { reject(e); }
      });
      tr.buffer = decoded;
      tr.fileName = file.name;
      // If the user hasn't customized the name, use the file's name (without extension)
      const idx = tracks.indexOf(tr);
      if (tr.name === `Voice ${idx + 1}`) {
        tr.name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || tr.name;
      }
      setStatus(`"${file.name}" 불러옴 (${formatTime(decoded.duration)})`, 'ok');
      render();
    } catch (err) {
      console.error(err);
      setStatus(`불러오기 실패: ${file.name} — ${err && err.message ? err.message : '알 수 없는 오류'}`, 'error');
    }
  }

  // ---------- DRAW WAVEFORMS ----------
  function pixelRatio() { return Math.max(1, Math.min(2, window.devicePixelRatio || 1)); }

  function drawAllTracks() {
    document.querySelectorAll('.track-canvas-wrap canvas').forEach(canvas => {
      const id = canvas.dataset.trackId;
      const tr = tracks.find(t => t.id === id);
      if (tr) drawWaveform(canvas, tr);
    });
  }

  function drawWaveform(canvas, tr) {
    const wrap = canvas.parentElement;
    const empty = wrap.querySelector('.track-empty');
    const dpr = pixelRatio();
    const cssW = wrap.clientWidth;
    const cssH = 96;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!tr.buffer) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    const buf = tr.buffer;
    const totalDur = getTotalDuration();
    if (totalDur <= 0) return;
    const trackPxWidth = cssW * (buf.duration / totalDur);

    const data = downmix(buf);
    const samplesPerPx = Math.max(1, Math.floor(data.length / Math.max(1, trackPxWidth)));
    const mid = cssH / 2;
    const idx = tracks.indexOf(tr);
    const color = TRACK_HEX[idx % TRACK_HEX.length];

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    for (let x = 0; x < trackPxWidth; x++) {
      let mn = 1, mx = -1;
      const start = x * samplesPerPx;
      const end = Math.min(data.length, start + samplesPerPx);
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const yTop = mid + mn * (mid - 2);
      const yBot = mid + mx * (mid - 2);
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
    ctx.globalAlpha = 1;

    // center line
    ctx.strokeStyle = 'rgba(127,127,127,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(cssW, mid + 0.5);
    ctx.stroke();
  }

  function downmix(buf) {
    const ch = buf.numberOfChannels;
    if (ch === 1) return buf.getChannelData(0);
    const a = buf.getChannelData(0);
    const b = buf.getChannelData(1);
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
    return out;
  }

  function drawRuler() {
    const dpr = pixelRatio();
    const cssW = rulerCanvas.parentElement.clientWidth;
    const cssH = 36;
    rulerCanvas.width = Math.max(1, Math.floor(cssW * dpr));
    rulerCanvas.height = Math.floor(cssH * dpr);
    rulerCanvas.style.width = cssW + 'px';
    rulerCanvas.style.height = cssH + 'px';
    const ctx = rulerCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const total = getTotalDuration();
    const muted = getCSS('--color-text-faint');
    const text = getCSS('--color-text-muted');
    ctx.font = '11px ' + (getCSS('--font-mono') || 'monospace');
    ctx.fillStyle = text;
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;

    if (total <= 0) {
      ctx.fillText('— 트랙을 불러오면 타임라인이 표시됩니다 —', 12, 22);
      return;
    }

    // Pick a tick interval that yields ~8 major ticks
    const target = total / 8;
    const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let interval = candidates[candidates.length - 1];
    for (const c of candidates) { if (c >= target) { interval = c; break; } }

    for (let t = 0; t <= total + 1e-6; t += interval) {
      const x = (t / total) * cssW;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, cssH - 8);
      ctx.lineTo(x + 0.5, cssH);
      ctx.stroke();
      const label = formatTime(t);
      const tw = ctx.measureText(label).width;
      const lx = Math.min(cssW - tw - 4, Math.max(2, x + 4));
      ctx.fillText(label, lx, 14);
    }
  }

  function getCSS(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function getTotalDuration() {
    let max = 0;
    for (const t of tracks) {
      if (t.buffer) {
        const dur = adjustedDuration(t);
        if (dur > max) max = dur;
      }
    }
    return max;
  }

  function adjustedDuration(tr) {
    if (!tr.buffer) return 0;
    const rate = Math.pow(2, tr.pitch / 12);
    return tr.buffer.duration / rate;
  }

  // ---------- PLAYBACK ----------
  function refreshControls() {
    const hasAudio = tracks.some(t => t.buffer);
    playBtn.disabled = !hasAudio;
    stopBtn.disabled = !hasAudio;
    exportBtn.disabled = !hasAudio;
    tcTotal.textContent = formatTime(getTotalDuration());
  }

  function startPlayback() {
    const ctx = ensureCtx();
    stopSources();
    masterGainNode = ctx.createGain();
    masterGainNode.gain.value = masterVol;
    masterGainNode.connect(ctx.destination);

    const anySolo = tracks.some(t => t.solo);
    activeSources = [];
    for (const tr of tracks) {
      if (!tr.buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = tr.buffer;
      src.playbackRate.value = Math.pow(2, tr.pitch / 12);

      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const gain = ctx.createGain();
      const audible = computeAudible(tr, anySolo);
      gain.gain.value = audible;

      let last = src;
      if (panner) { panner.pan.value = tr.pan; src.connect(panner); panner.connect(gain); }
      else { src.connect(gain); }
      gain.connect(masterGainNode);

      src.start(0);
      activeSources.push({ src, gain, panner, tr });
    }
    if (activeSources.length === 0) return;
    isPlaying = true;
    playStartCtxTime = ctx.currentTime;
    playStartOffset = 0;
    playLabel.textContent = '일시정지';
    playBtn.querySelector('svg').innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    setStatus('재생 중…', 'ok');

    // when longest finishes, stop
    const total = getTotalDuration();
    activeSources[0].src.onended = null;
    setTimeout(() => {
      if (isPlaying && audioCtx.currentTime - playStartCtxTime >= total - 0.05) {
        stopPlayback();
      }
    }, total * 1000 + 60);

    tickPlayhead();
  }

  function restartPlayback() {
    if (!isPlaying) return;
    startPlayback();
  }

  function stopSources() {
    for (const s of activeSources) {
      try { s.src.stop(); } catch (_) {}
      try { s.src.disconnect(); } catch (_) {}
      try { s.gain.disconnect(); } catch (_) {}
      if (s.panner) try { s.panner.disconnect(); } catch (_) {}
    }
    activeSources = [];
    if (masterGainNode) {
      try { masterGainNode.disconnect(); } catch (_) {}
      masterGainNode = null;
    }
  }

  function stopPlayback() {
    stopSources();
    isPlaying = false;
    playLabel.textContent = '재생';
    playBtn.querySelector('svg').innerHTML = '<polygon points="6,4 20,12 6,20"/>';
    cancelAnimationFrame(rafId);
    document.querySelectorAll('.playhead').forEach(p => p.style.display = 'none');
    tcCurrent.textContent = '0:00.0';
    setStatus('정지됨', 'idle');
  }

  function computeAudible(tr, anySolo) {
    if (tr.muted) return 0;
    if (anySolo && !tr.solo) return 0;
    return tr.volume;
  }

  function applyLiveTrackVolume(tr) {
    if (!isPlaying) return;
    const anySolo = tracks.some(t => t.solo);
    for (const s of activeSources) {
      if (s.tr.id === tr.id) {
        s.gain.gain.setTargetAtTime(computeAudible(s.tr, anySolo), audioCtx.currentTime, 0.01);
      } else {
        // solo states affect everyone
        s.gain.gain.setTargetAtTime(computeAudible(s.tr, anySolo), audioCtx.currentTime, 0.01);
      }
    }
  }
  function applyLivePan(tr) {
    if (!isPlaying) return;
    for (const s of activeSources) {
      if (s.tr.id === tr.id && s.panner) {
        s.panner.pan.setTargetAtTime(tr.pan, audioCtx.currentTime, 0.01);
      }
    }
  }

  function tickPlayhead() {
    if (!isPlaying) return;
    const elapsed = audioCtx.currentTime - playStartCtxTime + playStartOffset;
    const total = getTotalDuration();
    tcCurrent.textContent = formatTime(Math.min(elapsed, total));
    document.querySelectorAll('.track').forEach(rowEl => {
      const ph = rowEl.querySelector('[data-role="playhead"]');
      if (!ph) return;
      const wrap = rowEl.querySelector('.track-canvas-wrap');
      if (!wrap) return;
      const w = wrap.clientWidth;
      const x = total > 0 ? Math.min(w, (elapsed / total) * w) : 0;
      ph.style.display = '';
      ph.style.transform = `translateX(${x}px)`;
    });
    if (elapsed < total) {
      rafId = requestAnimationFrame(tickPlayhead);
    } else {
      stopPlayback();
    }
  }

  // ---------- EXPORT ----------
  async function exportWav() {
    const total = getTotalDuration();
    if (total <= 0) return;
    setStatus('WAV 렌더링 중…', 'working');
    try {
      const sampleRate = 44100;
      const offline = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);
      const masterG = offline.createGain();
      masterG.gain.value = masterVol;
      masterG.connect(offline.destination);

      const anySolo = tracks.some(t => t.solo);
      let sourcesAdded = 0;
      for (const tr of tracks) {
        if (!tr.buffer) continue;
        const audible = computeAudible(tr, anySolo);
        if (audible <= 0) continue;
        const src = offline.createBufferSource();
        src.buffer = tr.buffer;
        src.playbackRate.value = Math.pow(2, tr.pitch / 12);
        const gain = offline.createGain();
        gain.gain.value = audible;
        if (offline.createStereoPanner) {
          const pan = offline.createStereoPanner();
          pan.pan.value = tr.pan;
          src.connect(pan); pan.connect(gain);
        } else {
          src.connect(gain);
        }
        gain.connect(masterG);
        src.start(0);
        sourcesAdded++;
      }
      if (sourcesAdded === 0) {
        setStatus('내보낼 오디오가 없습니다 (모두 음소거 상태일 수 있음).', 'error');
        return;
      }

      const rendered = await offline.startRendering();
      const wav = encodeWav(rendered);
      const blob = new Blob([wav], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const ts = new Date();
      const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocal-combination-${stamp}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus(`WAV 내보내기 완료 (${formatTime(total)}, ${(blob.size / (1024*1024)).toFixed(2)} MB).`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(`내보내기 실패: ${err && err.message ? err.message : err}`, 'error');
    }
  }

  function encodeWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const headerSize = 44;
    const out = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(out);

    // RIFF header
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');
    // fmt chunk
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    // data chunk
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // interleave
    const chs = [];
    for (let c = 0; c < numCh; c++) chs.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chs[c][i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(offset, s | 0, true);
        offset += 2;
      }
    }
    return out;
  }

  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // ---------- HELPERS ----------
  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = (s - m * 60);
    const intSec = Math.floor(sec);
    const dec = Math.floor((sec - intSec) * 10);
    return `${m}:${String(intSec).padStart(2, '0')}.${dec}`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  // ---------- EVENTS ----------
  playBtn.addEventListener('click', () => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  });
  stopBtn.addEventListener('click', stopPlayback);
  exportBtn.addEventListener('click', exportWav);

  masterVolEl.addEventListener('input', () => {
    masterVol = parseInt(masterVolEl.value, 10) / 100;
    masterVolVal.textContent = `${masterVolEl.value}%`;
    if (masterGainNode) masterGainNode.gain.setTargetAtTime(masterVol, audioCtx.currentTime, 0.01);
  });

  addTrackBtn.addEventListener('click', () => {
    tracks.push(makeTrack(`Voice ${nextTrackNumber++}`));
    render();
  });

  helpBtn.addEventListener('click', () => {
    const open = helpCard.style.display !== 'none';
    helpCard.style.display = open ? 'none' : '';
  });

  // Spacebar play/pause
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (playBtn.disabled) return;
      if (isPlaying) stopPlayback(); else startPlayback();
    }
  });

  // Window-level drag-and-drop fallback: drop on any track row routes to that track,
  // drop on body fills the first empty (or new) track.
  document.addEventListener('dragover', e => { e.preventDefault(); });
  document.addEventListener('drop', async e => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    let tr = tracks.find(t => !t.buffer);
    if (!tr) { tr = makeTrack(`Voice ${nextTrackNumber++}`); tracks.push(tr); render(); }
    await loadFileToTrack(tr.id, f);
  });

  // Resize redraws
  let resizeTO = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTO);
    resizeTO = setTimeout(() => { drawAllTracks(); drawRuler(); }, 80);
  });

  // ---------- INIT ----------
  render();
  setStatus('트랙에 오디오 파일을 불러와 시작하세요.', 'idle');
})();
