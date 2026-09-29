let ws = null;
let audioCtx = null;
let stream = null;
let worklet = null;
let source = null;

const btn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const userBox = document.getElementById('userTranscript');
const agentBox = document.getElementById('agentTranscript');
const logEl = document.getElementById('log');

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, color = '#cbd5e1') {
  statusEl.textContent = text;
  statusEl.style.background = color === '#22d3ee' ? '#22d3ee20' : '#334155';
  statusEl.style.color = color;
  statusEl.style.borderColor = color + '33';
}

btn.addEventListener('click', async () => {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      endSession();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Connecting...';
    setStatus('Fetching token...', '#f59e0b');

    const tokenRes = await fetch('/token');
    if (!tokenRes.ok) {
      if (tokenRes.status === 401) {
        throw new Error('Token endpoint returned 401 — the server key was rejected. Check ASSEMBLYAI_API_KEY in the hosting env, then redeploy.');
      }
      throw new Error('Token endpoint returned ' + tokenRes.status);
    }
    const { token } = await tokenRes.json();

    setStatus('Opening WebSocket...', '#f59e0b');
    log('Token acquired');

    // Universal-3 Pro Streaming WebSocket endpoint
    const url = new URL('wss://streaming.assemblyai.com/v3/ws');
    url.searchParams.set('token', token);
    url.searchParams.set('speech_model', 'universal-3-5-pro');
    url.searchParams.set('encoding', 'pcm_s16le');
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('include_partial_turns', 'true');
    url.searchParams.set('language_codes', '["en"]');

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      log('WebSocket open — session starting');
      setStatus('Connected — speak now', '#22d3ee');
      btn.textContent = 'Disconnect';
      btn.disabled = false;
      // A fresh streaming session cannot deliver finals for a previous
      // attempt's wait: drop a stranded "finishing" state on reconnect.
      if (recorder.isFinishing()) {
        recorder.resetToIdle();
        setAttemptState('Ready', false);
        attemptHintEl.textContent = 'Reconnected. Press “Start attempt” for a new attempt.';
      }
      startMicrophone();
    });

    ws.addEventListener('message', (event) => {
      // Binary audio frames are sent by us, we only receive JSON text messages
      if (typeof event.data === 'string') {
        handleMessage(event.data);
      }
    });

    ws.addEventListener('close', () => {
      log('WebSocket closed');
      setStatus('Disconnected', '#64748b');
      btn.textContent = 'Connect';
      btn.disabled = false;
      stopTimer();
      cleanupAudio();
    });

    ws.addEventListener('error', (err) => {
      log('WebSocket error');
      setStatus('WebSocket error', '#ef4444');
    });

  } catch (err) {
    log('Connection error: ' + err.message);
    setStatus('Failed: ' + err.message, '#ef4444');
    btn.textContent = 'Connect';
    btn.disabled = false;
  }
});

function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch (e) { log('Invalid JSON: ' + data); return; }

  const type = msg.type;
  log('Event: ' + type);

  if (type === 'Begin') {
    log('Session started: ' + msg.id);
  } else if (type === 'Turn') {
    const transcript = msg.transcript || '';
    const order = (typeof msg.turn_order === 'number') ? msg.turn_order : null;
    if (msg.end_of_turn) {
      updateLiveWords(transcript);
      // Collect word timings for pause analysis (same acceptance rule as the
      // recorder: only turns belonging to this attempt, never stale/idle).
      if ((recorder.isRecording() || recorder.isFinishing()) &&
          (order === null || order > recorder.maxIdleOrder) &&
          Array.isArray(msg.words) && attemptWordGroups.length < 50) {
        attemptWordGroups.push(msg.words.filter((w) => w && typeof w.start === 'number' && typeof w.end === 'number'));
      }
      userBox.textContent = transcript;
      log('Final: ' + transcript);
      const done = recorder.onTurn({ text: transcript, final: true, order });
      if (done) {
        submitFinishedAttempt(done);
      }
      if (typeof debateOnFinal === 'function') debateOnFinal(transcript, order);
      if (typeof interviewOnFinal === 'function') interviewOnFinal(transcript, order); else if (recorder.isIdle() && attemptCount === 0 && transcript) {
        // Heard speech outside any attempt: teach the ordering now, while the
        // transcript is on screen — otherwise Finish later finds nothing.
        const heard = transcript.length > 60 ? transcript.slice(0, 60) + '…' : transcript;
        attemptHintEl.textContent = 'Heard “' + heard + '” — press “Start attempt” BEFORE speaking to record it.';
      }
    } else {
      recorder.onTurn({ text: transcript, final: false, order });
      updateLiveWords(transcript);
      if (typeof debateOnPartial === 'function') debateOnPartial(transcript, order);
      if (typeof interviewOnPartial === 'function') interviewOnPartial(transcript, order);
      userBox.textContent = transcript;
    }
  } else if (type === 'Termination') {
    log('Session terminated: ' + msg.audio_duration_seconds + 's audio, ' + msg.session_duration_seconds + 's session');
  } else if (type === 'Heartbeat') {
    // Optional: could use for monitoring
  } else if (type === 'Error') {
    log('Server error: ' + JSON.stringify(msg));
    setStatus('Error: ' + msg.message, '#ef4444');
  }
}

function startMicrophone() {
  if (!audioCtx) {
    // 16kHz for Streaming API (different from Voice Agent's 24kHz)
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  audioCtx.resume().catch(() => {});

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } })
    .then(async (s) => {
      stream = s;
      source = audioCtx.createMediaStreamSource(stream);

      try {
        await audioCtx.audioWorklet.addModule('pcm-processor.js');
        // Pass actual sample rate for resampling (Chrome honors 16000, Firefox/Safari may not)
        worklet = new AudioWorkletNode(audioCtx, 'pcm-processor', {
          processorOptions: { inputSampleRate: audioCtx.sampleRate }
        });
        connectWorklet();
        log('Worklet loaded (pcm-processor.js)');
      } catch (e) {
        log('Worklet file load failed, using inline');
        createInlineWorklet();
      }
    })
    .catch((e) => log('Mic error: ' + e.message));
}

function connectWorklet() {
  if (!worklet || !source || !audioCtx) return;
  try {
    source.connect(worklet);
    worklet.connect(audioCtx.destination);
    worklet.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Send raw binary PCM16 frames (not base64 JSON)
        ws.send(e.data);
      }
    };
    log('Mic audio connected to WebSocket');
  } catch (e) {
    log('Worklet connect error: ' + e.message);
  }
}

function createInlineWorklet() {
  // Fallback mirror of pcm-processor.js: resample to 16 kHz mono PCM16 and
  // emit fixed ~100 ms (1600-sample) chunks. AssemblyAI requires 50–1000 ms
  // per binary message, so this path must buffer exactly like the file one.
  const code = `
    class PCMProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buffer = new Float32Array();
        this.pending = new Int16Array(0);
        this.CHUNK_SAMPLES = 1600;
        this.MIN_SAMPLES = 800;
      }
      process(inputs) {
        const input = inputs[0]?.[0];
        if (input) {
          const inputRate = sampleRate;
          const targetRate = 16000;
          const ratio = inputRate / targetRate;
          const newBuffer = new Float32Array(this.buffer.length + input.length);
          newBuffer.set(this.buffer);
          newBuffer.set(input, this.buffer.length);
          this.buffer = newBuffer;
          const outputLength = Math.floor(this.buffer.length / ratio);
          if (outputLength > 0) {
            const resampled = new Int16Array(outputLength);
            for (let i = 0; i < outputLength; i++) {
              const sample = this.buffer[Math.floor(i * ratio)] ?? 0;
              resampled[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
            }
            const consumed = Math.floor(outputLength * ratio);
            if (consumed > 0) this.buffer = this.buffer.slice(consumed);
            const merged = new Int16Array(this.pending.length + resampled.length);
            merged.set(this.pending);
            merged.set(resampled, this.pending.length);
            this.pending = merged;
            while (this.pending.length >= this.CHUNK_SAMPLES) {
              const chunk = this.pending.slice(0, this.CHUNK_SAMPLES);
              this.pending = this.pending.slice(this.CHUNK_SAMPLES);
              this.port.postMessage(chunk.buffer, [chunk.buffer]);
            }
          }
        } else if (this.pending.length >= this.MIN_SAMPLES) {
          const chunk = this.pending;
          this.pending = new Int16Array(0);
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
        }
        return true;
      }
    }
    registerProcessor('pcm-processor', PCMProcessor);
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  audioCtx.audioWorklet.addModule(url).then(() => {
    worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
    connectWorklet();
    log('Inline worklet connected');
  }).catch((e) => log('Inline worklet error: ' + e.message));
}

function endSession() {
  if (typeof closeVoiceSession === 'function') closeVoiceSession();
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Send Terminate to finalize the current turn
    ws.send(JSON.stringify({ type: 'Terminate' }));
  }
  cleanupAudio();
  setTimeout(() => {
    if (ws) ws.close();
  }, 500);
}

function cleanupAudio() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (worklet) { worklet.disconnect(); worklet = null; }
  if (source) { source.disconnect(); source = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}

window.addEventListener('pagehide', () => {
  if (typeof closeVoiceSession === 'function') closeVoiceSession();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'Terminate' }));
  }
});

// ================= M1: practice loop (additive; M0 transport above untouched) =================

let sessionId = null;
let currentPromptId = null;
let attemptCount = 0;
// Last completed attempt, kept client-side so retries work even when the
// server keeps no memory (serverless hosts). Sent back as `previous`.
let lastAttempt = null;
// Transcripts for the before/after replay (previous overwritten on submit).
let replayPrev = null;
let replayCurr = null;
const recorder = new AttemptRecorder();
// Per-final word-timing groups for pause analysis (reset each attempt).
let attemptWordGroups = [];

const promptTitleEl = document.getElementById('promptTitle');
const promptObjectiveEl = document.getElementById('promptObjective');
const newPromptBtn = document.getElementById('newPromptBtn');
const startAttemptBtn = document.getElementById('startAttemptBtn');
const finishAttemptBtn = document.getElementById('finishAttemptBtn');
const retryBtn = document.getElementById('retryBtn');
const attemptNumEl = document.getElementById('attemptNum');
const attemptHintEl = document.getElementById('attemptHint');
const feedbackBox = document.getElementById('agentTranscript');
const comparisonPanel = document.getElementById('comparisonPanel');
const comparisonBox = document.getElementById('comparisonBox');
const debateCtaBtn = document.getElementById('debateCtaBtn');
const welcomePanel = document.getElementById('welcomePanel');
const dismissWelcomeBtn = document.getElementById('dismissWelcomeBtn');
const copyFeedbackBtn = document.getElementById('copyFeedbackBtn');
const exportBtn = document.getElementById('exportBtn');
const ONBOARD_KEY = 'voicecoach.onboarded.v1';

// First-run onboarding: one dismissible panel, never again.
if (!localStorage.getItem(ONBOARD_KEY)) welcomePanel.hidden = false;
dismissWelcomeBtn.addEventListener('click', () => {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* ignore */ }
  welcomePanel.hidden = true;
});

copyFeedbackBtn.addEventListener('click', async () => {
  const text = feedbackBox.innerText || '';
  if (!text.trim()) { attemptHintEl.textContent = 'Nothing to copy yet — finish an attempt first.'; return; }
  try {
    await navigator.clipboard.writeText(text);
    attemptHintEl.textContent = 'Feedback copied to clipboard.';
  } catch (e) {
    attemptHintEl.textContent = 'Copy failed: ' + e.message;
  }
});

exportBtn.addEventListener('click', async () => {
  const history = loadHistory();
  let profile = null;
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: history }),
    });
    const data = await res.json();
    if (res.ok) profile = data.profile;
  } catch (e) { /* export proceeds without profile */ }
  const text = buildSessionText({ history, profile });
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'voice-coach-session.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  log('Session exported (' + history.length + ' attempts)');
});

// Cross-mode link: comparison → debate arena (Day 6 integration).
debateCtaBtn.addEventListener('click', () => {
  if (typeof setDebateMode === 'function') setDebateMode(false);
  log('Journey: speech comparison → debate');
});
const attemptStateEl = document.getElementById('attemptState');
const cameraToggleBtn = document.getElementById('cameraToggleBtn');
const cameraPreview = document.getElementById('cameraPreview');
const cameraHintEl = document.getElementById('cameraHint');
let cameraStream = null;
let attemptFrames = [];

// ---- Multimodal thin slice: opt-in camera, 3 frames per attempt ----
cameraToggleBtn.addEventListener('click', async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    cameraPreview.srcObject = null;
    cameraPreview.hidden = true;
    cameraToggleBtn.textContent = 'Enable camera';
    log('Camera off');
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } } });
    cameraPreview.srcObject = cameraStream;
    cameraPreview.hidden = false;
    // A video element with a stream source does NOT auto-play reliably
    // (Safari especially): without play() it stays black AND videoWidth
    // stays 0, which silently kills frame capture too.
    try {
      await cameraPreview.play();
    } catch (e) {
      cameraHintEl.textContent = 'Camera preview could not start playing: ' + e.message;
      log('Camera play error: ' + e.message);
    }
    cameraToggleBtn.textContent = 'Disable camera';
    log('Camera on — frames are analyzed then discarded, never stored');
  } catch (e) {
    cameraHintEl.textContent = 'Camera unavailable: ' + e.message;
    log('Camera error: ' + e.message);
  }
});

function captureFrame() {
  try {
    if (!cameraStream || !cameraPreview.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = Math.round(cameraPreview.videoHeight * (320 / cameraPreview.videoWidth));
    c.getContext('2d').drawImage(cameraPreview, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch (e) { return null; }
}
const healthLineEl = document.getElementById('healthLine');
const statsLineEl = document.getElementById('statsLine');
const attemptTimerEl = document.getElementById('attemptTimer');
const liveWordsEl = document.getElementById('liveWords');
let timerStop = null;

function stopTimer() {
  if (timerStop) { try { timerStop(); } catch (e) { /* ignore */ } timerStop = null; }
  attemptTimerEl.textContent = '';
}

function updateLiveWords(text) {
  const n = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  liveWordsEl.textContent = n > 0 ? n + ' words' : '';
}

function updateStats() {
  try {
    const s = dayStats(loadHistory());
    const bits = ['Today: ' + s.todayCount + ' attempt' + (s.todayCount === 1 ? '' : 's')];
    if (s.streak >= 2) bits.push(s.streak + '-day streak');
    bits.push(s.totalCount + ' total');
    if (s.totalMin > 0) bits.push(s.totalMin + ' min practiced');
    statsLineEl.textContent = bits.join(' · ');
  } catch (e) { /* ignore */ }
}
const sampleABtn = document.getElementById('sampleABtn');
const sampleBBtn = document.getElementById('sampleBBtn');
const sampleHintEl = document.getElementById('sampleHint');
const profilePanel = document.getElementById('profilePanel');
const profileBox = document.getElementById('profileBox');
const historyBox = document.getElementById('historyBox');
const assignPanel = document.getElementById('assignPanel');
const assignTitleEl = document.getElementById('assignTitle');
const assignObjectiveEl = document.getElementById('assignObjective');
const assignReasonEl = document.getElementById('assignReasonText');
const practiceAssignedBtn = document.getElementById('practiceAssignedBtn');
let assignedPrompt = null;

// ---- Day 2: adaptive assignment (weakest skill → targeted exercise) ----
async function refreshAssignment() {
  const history = loadHistory();
  if (!history.length) { assignPanel.hidden = true; assignedPrompt = null; return; }
  try {
    const res = await fetch('/api/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('assign returned ' + res.status);
    assignedPrompt = data.prompt;
    assignTitleEl.textContent = data.prompt.title;
    assignObjectiveEl.textContent = data.prompt.objective;
    assignReasonEl.textContent = data.reason;
    assignPanel.hidden = false;
    log('Assigned next: ' + data.prompt.title + ' (' + (data.weakest || 'baseline') + ')');
  } catch (e) {
    log('Assignment refresh failed: ' + e.message);
  }
}

practiceAssignedBtn.addEventListener('click', async () => {
  if (!assignedPrompt || recorder.isRecording() || recorder.isFinishing()) return;
  try {
    await newSession(null, assignedPrompt.id);
    attemptHintEl.textContent = 'Assigned practice loaded. Connect, then press “Start attempt”.';
  } catch (e) {
    attemptHintEl.textContent = 'Could not load the assigned prompt: ' + e.message;
  }
});
let sampleStreaming = false;

// ---- Day 1: local history (survives reload, free-tier safe) ----
const HISTORY_KEY = 'voicecoach.history.v1';
const HISTORY_MAX = 100;

function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function saveAttemptToHistory(record) {
  const h = loadHistory();
  h.push(record);
  while (h.length > HISTORY_MAX) h.shift();
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) { /* storage full/blocked */ }
  return h;
}

function renderHistory(history) {
  if (!history.length) {
    historyBox.innerHTML = 'No attempts yet — your practice history will appear here and survive reloads.';
    return;
  }
  historyBox.innerHTML = '<div class="feedback"><ul>' + history.slice().reverse().map((a) => {
    const when = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
    const m = a.metrics || {};
    const pace = m.wpm == null ? 'n/a' : m.wpm + ' wpm';
    const focus = a.analysis && a.analysis.retry_focus ? a.analysis.retry_focus.focus : '';
    return '<li><strong>' + escapeHtml(a.promptTitle || 'Practice') + '</strong> <span class="hint">' + escapeHtml(when) + '</span><br>' +
      '<span class="hint">' + (m.wordCount || 0) + ' words · ' + pace + ' · ' + (m.fillerCount || 0) + ' fillers · ' +
      escapeHtml(a.coachSource === 'llm' ? 'AI Coach' : a.coachSource === 'voice' ? 'Voice debate' : 'Rules Coach') + '</span>' +
      (focus ? '<br>Focus was: ' + escapeHtml(focus) : '') + '</li>';
  }).join('') + '</ul></div>';
}

async function refreshProfile(history) {
  const list = history || loadHistory();
  if (!list.length) { profilePanel.hidden = true; return; }
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: list }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('profile returned ' + res.status);
    renderProfile(data.profile);
  } catch (e) {
    log('Profile refresh failed: ' + e.message);
  }
}

function renderProfile(p) {
  const measured = p.skills.filter((s) => s.status !== 'unknown');
  const bar = (s) => {
    const pct = s.total > 0 ? Math.round((s.good / s.total) * 100) : 0;
    const cls = s.status === 'strength' ? 'cmp-good' : s.status === 'weakness' ? 'cmp-bad' : 'cmp-same';
    const tag = s.status === 'strength' ? 'Strong' : s.status === 'weakness' ? 'Focus' : 'Developing';
    return '<div class="skill-row"><span class="skill-name">' + escapeHtml(s.label) + '</span>' +
      '<span class="skill-bar"><span class="skill-fill ' + cls + '" style="width:' + pct + '%"></span></span>' +
      '<span class="hint">' + tag + ' ' + s.good + '/' + s.total + '</span></div>';
  };
  const first = p.trends[0], last = p.trends[p.trends.length - 1];
  const trendLine = (label, a, b, suffix) => (a == null || b == null) ? '' :
    '<span class="metric">' + label + ' ' + a + ' → ' + b + (suffix || '') + '</span>';
  profileBox.innerHTML = '<div class="feedback">' +
    '<div class="metrics"><span class="metric">' + p.totalAttempts + ' attempts</span>' +
    trendLine('pace', first && first.wpm, last && last.wpm, ' wpm') +
    trendLine('fillers', first && first.fillerRatePer100, last && last.fillerRatePer100, '/100w') +
    '</div>' +
    (measured.length ? '<h3>Skill levels (share of attempts rated good)</h3>' + measured.map(bar).join('') : '') +
    (p.topFocus ? '<div class="retry-focus"><strong>Training focus:</strong> ' + escapeHtml(p.topFocus.target) +
      ' <span class="hint">(flagged ' + p.topFocus.times + '×)</span></div>' : '') +
    '</div>';
  profilePanel.hidden = false;
}

function updateSampleButtons() {
  const connected = ws && ws.readyState === WebSocket.OPEN;
  sampleABtn.disabled = !connected || sampleStreaming;
  sampleBBtn.disabled = !connected || sampleStreaming;
}

async function playSample(kind, label, topic) {
  if (sampleStreaming) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    sampleHintEl.textContent = 'Connect first, then play a sample.';
    return;
  }
  if (!recorder.isRecording() && !recorder.isFinishing()) {
    sampleHintEl.textContent = 'Press “Start attempt” first — then play ' + label + ' so it counts toward the attempt.';
  }
  sampleStreaming = true;
  updateSampleButtons();
  updateAttemptButtons();
  try {
    const res = await fetch('/api/sample-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, topic: topic || null, coachEngine: selectedEngine() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Sample request returned ' + res.status));
    sampleHintEl.textContent = (data.source === 'llm' ? 'Fresh AI-written sample' : 'Built-in sample') +
      ' — listen, your live mic captures it like real speech. (Sound on!)';
    log('Sample (' + data.source + '): ' + data.text.slice(0, 80) + '…');
    await speakText(data.text);
    sampleHintEl.textContent = 'Sample finished speaking.';
  } catch (e) {
    sampleHintEl.textContent = 'Sample failed: ' + e.message;
    log('Sample error: ' + e.message);
  }
  sampleStreaming = false;
  updateSampleButtons();
  updateAttemptButtons();
}

sampleABtn.addEventListener('click', () => playSample('speech-weak', 'Sample 1', promptTitleEl.textContent + '. ' + promptObjectiveEl.textContent));
sampleBBtn.addEventListener('click', () => playSample('speech-clean', 'Sample 2', promptTitleEl.textContent + '. ' + promptObjectiveEl.textContent));

// Speak text aloud via built-in browser TTS. The LIVE mic captures it, so
// AssemblyAI transcribes it exactly like user speech. Hardened for macOS
// Safari: voices arrive late (waited for), long utterances stall (spoken in
// sentence chunks + resume watchdog), quality varies (local English voice
// preferred). Resolves when done, on error, or if the connection drops.
let cachedVoices = null;

function ensureVoices() {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  const have = speechSynthesis.getVoices();
  if (have.length > 0) return Promise.resolve(have);
  if (!cachedVoices) {
    cachedVoices = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
      try {
        speechSynthesis.onvoiceschanged = () => {
          clearTimeout(timer);
          resolve(speechSynthesis.getVoices());
        };
      } catch (e) { /* ignore */ }
    });
  }
  return cachedVoices;
}

function pickVoice(voices) {
  const en = (voices || []).filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  if (!en.length) return null;
  return en.find((v) => v.localService) || en.find((v) => v.default) || en[0];
}

function speakChunk(text, voice) {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1;
      if (voice) u.voice = voice;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // Watchdog: Safari stalls long speech; resume() unsticks it. The
      // disconnect watch stops everything if the socket dies mid-speech.
      const watch = setInterval(() => {
        try {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
            finish();
          } else if (speechSynthesis.paused) {
            speechSynthesis.resume();
          }
        } catch (e) { finish(); }
      }, 1000);
      const done2 = () => { clearInterval(watch); finish(); };
      u.onend = done2;
      u.onerror = done2;
      speechSynthesis.speak(u);
    } catch (e) { resolve(); }
  });
}

async function speakText(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const voices = await ensureVoices();
    const voice = pickVoice(voices);
    const chunks = splitSpokenText(text, 220);
    for (const chunk of chunks) {
      if (!ws || ws.readyState !== WebSocket.OPEN) break;
      await speakChunk(chunk, voice);
    }
  } catch (e) { /* resolve silently — speech is a test aid, never fatal */ }
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('health returned ' + res.status);
    const h = await res.json();
    const speech = h.speech === 'ready' ? 'Speech ready' : 'Speech unavailable (server key missing)';
    const coach = h.coach === 'rules' ? 'Coach Rules' : 'Coach AI (' + h.coach.slice(3) + ')';
    healthLineEl.textContent = 'System: ' + speech + ' · ' + coach;
    if (h.speech !== 'ready') {
      log('Health: ASSEMBLYAI_API_KEY missing on server — Connect will fail with 401.');
    }
  } catch (e) {
    healthLineEl.textContent = 'System: status unknown (could not reach server).';
    log('Health check failed: ' + e.message);
  }
}

function setAttemptState(text, active) {
  attemptStateEl.textContent = text;
  attemptStateEl.classList.toggle('state-active', !!active);
}

// Coach Engine selection. Default is AI Coach (best experience first; if no
// LLM provider is configured the attempt truthfully falls back to Rules).
// Read at submit time so the attempt is associated with the user's choice.
function selectedEngine() {
  const checked = document.querySelector('input[name="coachEngine"]:checked');
  return checked && checked.value === 'rules' ? 'rules' : 'ai';
}

function engineRadios() {
  return Array.from(document.querySelectorAll('input[name="coachEngine"]'));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function newSession(excludePromptId, promptId) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ excludePromptId: excludePromptId || null, promptId: promptId || null }),
  });
  if (!res.ok) throw new Error('Session request returned ' + res.status);
  const data = await res.json();
  sessionId = data.sessionId;
  currentPromptId = data.prompt.id;
  promptTitleEl.textContent = data.prompt.title;
  promptObjectiveEl.textContent = data.prompt.objective;
  attemptCount = 0;
  attemptNumEl.textContent = '1';
  lastAttempt = null;
  recorder.resetToIdle();
  setAttemptState('Ready', false);
  feedbackBox.innerHTML = '';
  comparisonPanel.hidden = true;
  updateAttemptButtons();
  attemptHintEl.textContent = 'Connect, then press “Start attempt” and speak.';
  log('New session: ' + sessionId);
}

async function initSession() {
  try {
    await newSession(null);
  } catch (e) {
    promptTitleEl.textContent = 'Could not load a prompt';
    promptObjectiveEl.textContent = 'Start the server and reload. (' + e.message + ')';
    log('Session init failed: ' + e.message);
  }
}

function updateAttemptButtons() {
  const connected = ws && ws.readyState === WebSocket.OPEN;
  const busy = recorder.isRecording() || recorder.isFinishing();
  startAttemptBtn.disabled = busy || !connected || !sessionId;
  // Finish requires a live connection: without one no final Turn can arrive,
  // and the UI would strand in "Finishing…" forever.
  finishAttemptBtn.disabled = !recorder.isRecording() || !connected;
  retryBtn.disabled = busy || attemptCount === 0;
  // Never discard an in-progress attempt by switching prompt mid-recording.
  newPromptBtn.disabled = busy;
  // The engine choice belongs to the attempt: lock it while one is in flight
  // so a mid-attempt switch cannot create ambiguous state. The selection is
  // preserved across retries (only the disabled flag changes).
  engineRadios().forEach((r) => { r.disabled = busy; });
}

// Keep attempt + sample buttons in sync with connection state.
const _setStatusForM1 = setStatus;
setStatus = function (text, color) {
  _setStatusForM1(text, color);
  try { updateAttemptButtons(); updateSampleButtons(); if (typeof updateDebateButtons === 'function') updateDebateButtons(); } catch (e) { /* UI not ready yet */ }
};

startAttemptBtn.addEventListener('click', () => {
  if (!sessionId || recorder.isRecording() || recorder.isFinishing()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    attemptHintEl.textContent = 'Connect first, then start the attempt.';
    return;
  }
  recorder.start(Date.now());
  // One live recording at a time: starting here abandons any stale round in
  // the other modes so a single final Turn can't submit twice.
  if (typeof debateRecorder !== 'undefined') debateRecorder.resetToIdle();
  if (typeof interviewRecorder !== 'undefined') interviewRecorder.resetToIdle();
  attemptFrames = [captureFrame()].filter(Boolean);
  attemptWordGroups = [];
  liveWordsEl.textContent = '';
  stopTimer();
  timerStop = startElapsedTimer(attemptTimerEl, Date.now());
  userBox.textContent = '';
  setAttemptState('Recording', true);
  attemptHintEl.textContent = 'Recording attempt ' + (attemptCount + 1) + ' — speak now, then press “Finish attempt”.';
  updateAttemptButtons();
  log('Attempt recording started');
});

finishAttemptBtn.addEventListener('click', () => {
  stopTimer();
  const f = captureFrame();
  if (f) attemptFrames.push(f);
  const r = recorder.finish(Date.now());
  updateAttemptButtons();
  if (r.status === 'submitted') {
    submitFinishedAttempt(r.attempt);
  } else if (r.status === 'waiting') {
    setAttemptState('Finishing…', true);
    attemptHintEl.textContent = 'Finishing… waiting for the final transcript, then analyzing.';
    log('Finish clicked — waiting for end-of-turn boundary');
  } else if (r.status === 'empty') {
    attemptHintEl.textContent = 'No speech recorded — press “Start attempt” first, then speak while it shows Recording.';
    log('Finish with empty transcript; attempt not submitted');
  }
  // 'duplicate'/'invalid' are safely ignored: no double submit.
});

async function submitFinishedAttempt({ transcript, turnCount, durationMs }) {
  setAttemptState('Analyzing…', true);
  attemptHintEl.textContent = 'Analyzing attempt…';
  const coachEngine = selectedEngine();
  const f = captureFrame();
  if (f) attemptFrames.push(f);
  // Frames ride along (max 3, never stored client-side either — lastAttempt
  // and history records below deliberately exclude them).
  const frames = attemptFrames.filter(Boolean).slice(-3);  try {
    const res = await fetch('/api/sessions/' + sessionId + '/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, durationMs, turnCount, coachEngine, previous: lastAttempt, frames, words: attemptWordGroups }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Attempt request returned ' + res.status));
    attemptCount = data.attempt.n;
    attemptNumEl.textContent = String(attemptCount + 1);
    replayPrev = lastAttempt ? lastAttempt.transcript : null;
    replayCurr = transcript;
    lastAttempt = {
      n: data.attempt.n,
      transcript,
      metrics: data.analysis.metrics,
      analysis: {
        strengths: data.analysis.strengths,
        areas_to_improve: data.analysis.areas_to_improve,
        retry_focus: data.analysis.retry_focus,
      },
    };
    renderAnalysis(data.analysis, data.attempt, data.coachSource, data.requestedEngine || coachEngine, data.fallback === true, frames.length);
    const history = saveAttemptToHistory({
      promptTitle: promptTitleEl.textContent,
      transcript,
      metrics: data.analysis.metrics,
      analysis: {
        strengths: data.analysis.strengths,
        areas_to_improve: data.analysis.areas_to_improve,
        retry_focus: data.analysis.retry_focus,
      },
      coachSource: data.coachSource,
      requestedEngine: data.requestedEngine || coachEngine,
      createdAt: new Date().toISOString(),
    });
    renderHistory(history);
    refreshProfile(history);
    await refreshAssignment();
    updateStats();
    attemptHintEl.textContent = 'Feedback is ready. Press “Try again” for attempt ' + (attemptCount + 1) + '.';
    if (data.comparison) {
      renderComparisonData(data.comparison);
    } else if (attemptCount >= 2) {
      await loadComparison();
    }
  } catch (e) {
    attemptHintEl.textContent = 'Analysis failed: ' + e.message;
    log('Attempt submit failed: ' + e.message);
  }
  updateAttemptButtons();
}

retryBtn.addEventListener('click', () => {
  if (recorder.isRecording() || recorder.isFinishing() || attemptCount === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    attemptHintEl.textContent = 'Reconnect first, then retry.';
    return;
  }
  setAttemptState('Retry', true);
  startAttemptBtn.click();
});

newPromptBtn.addEventListener('click', async () => {
  try {
    await newSession(currentPromptId);
  } catch (e) {
    attemptHintEl.textContent = 'Could not load a new prompt: ' + e.message;
  }
});

function renderAnalysis(analysis, attempt, coachSource, requestedEngine, fallback, cameraFrames) {
  const m = analysis.metrics;
  const li = (items) => items.map((t) => '<li>' + escapeHtml(t) + '</li>').join('');
  const pace = m.wpm == null ? 'n/a' : m.wpm + ' wpm';
  // Requested engine (the user's choice) vs the actual source (truthful in
  // every combination, including vision-notes-on-rules-text).
  const requested = requestedEngine === 'rules' ? 'Rules Coach' : 'AI Coach';
  const badge = coachSource === 'llm'
    ? '<span class="hint">AI Coach</span>'
    : (coachSource === 'vision'
      ? (fallback
        ? '<span class="hint">Rules Coach + camera notes</span>'
        : '<span class="hint">AI Coach + camera</span>')
      : (requestedEngine === 'rules'
        ? '<span class="hint">Rules Coach</span>'
        : '<span class="hint">Rules Coach — AI fallback</span>'));
  feedbackBox.innerHTML =
    '<div class="feedback">' +
    '<h3>Attempt ' + attempt.n + ' · Coach: ' + escapeHtml(requested) + ' ' + badge + '</h3>' +
    '<div class="metrics">' +
    '<span class="metric">' + m.wordCount + ' words</span>' +
    '<span class="metric">' + m.durationSec + 's</span>' +
    '<span class="metric">' + pace + '</span>' +
    '<span class="metric">' + m.fillerCount + ' fillers</span>' +
    '<span class="metric">' + m.repeatCount + ' repeats</span>' +
    '<span class="metric">' + m.sentenceCount + ' sentences</span>' +
    (m.pausesMeasured ? '<span class="metric">' + m.pauseCount + ' pauses</span>' : '') +
    '</div>' +
    (analysis.strengths.length ? '<h3>Strengths</h3><ul>' + li(analysis.strengths) + '</ul>' : '') +
    (analysis.areas_to_improve.length ? '<h3>Work on</h3><ul>' + li(analysis.areas_to_improve) + '</ul>' : '') +
    (analysis.actionable_feedback.length ? '<h3>Do next time</h3><ul>' + li(analysis.actionable_feedback) + '</ul>' : '') +
    ((analysis.visual_notes && analysis.visual_notes.length) ? '<h3>On camera</h3><ul>' + li(analysis.visual_notes) + '</ul>' : '') +
    ((cameraFrames > 0 && !(analysis.visual_notes && analysis.visual_notes.length)) ? '<div class="hint">Camera was on (' + cameraFrames + ' frame' + (cameraFrames === 1 ? '' : 's') + ' sent) but the vision model did not respond — free quota is often dry; text feedback unaffected.</div>' : '') +
    '<div class="retry-focus"><strong>Retry focus:</strong> ' + escapeHtml(analysis.retry_focus.focus) +
    '<br><span class="hint">' + escapeHtml(analysis.retry_focus.tip) + '</span></div>' +
    '</div>';
  log('Attempt ' + attempt.n + ' analyzed');
}

async function loadComparison() {
  try {
    const res = await fetch('/api/sessions/' + sessionId + '/comparison');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Comparison request returned ' + res.status));
    renderComparisonData(data);
    log('Comparison rendered');
  } catch (e) {
    log('Comparison failed: ' + e.message);
  }
}

function renderComparisonData(data) {
    document.getElementById('cmpPrev').textContent = String(attemptCount - 1);
    document.getElementById('cmpCurr').textContent = String(attemptCount);
    const sec = (title, items, cls) => items.length
      ? '<h3>' + title + '</h3><ul class="' + cls + '">' + items.map((i) => '<li>' + escapeHtml(i.detail) + '</li>').join('') + '</ul>'
      : '';
    const focusVerdict = data.retry_focus_addressed == null ? ''
      : data.retry_focus_addressed
        ? '<p class="cmp-good"><strong>Yes — you addressed the previous retry focus.</strong></p>'
        : '<p class="cmp-bad"><strong>Not yet — the previous retry focus still needs work.</strong></p>';
    const quote = (t) => escapeHtml(t && t.length > 220 ? t.slice(0, 220) + '…' : (t || ''));
    const replayHtml = (replayPrev && replayCurr)
      ? '<div class="replay"><blockquote><cite>Attempt ' + (attemptCount - 1) + '</cite>' + quote(replayPrev) + '</blockquote>' +
        '<blockquote class="after"><cite>Attempt ' + attemptCount + '</cite>' + quote(replayCurr) + '</blockquote></div>'
      : '';
    const v = verdictSummary(data);
    const nextDrill = (typeof assignedPrompt !== 'undefined' && assignedPrompt)
      ? 'Next up: <strong>' + escapeHtml(assignedPrompt.title) + '</strong> — see your Up-next card.'
      : 'See your Up-next card for the assigned drill.';
    const verdictHtml = '<div class="retry-focus"><strong>Today’s verdict:</strong> ' +
      escapeHtml(v.improvedCount + ' area' + (v.improvedCount === 1 ? '' : 's') + ' improved' + (v.worseCount ? ', ' + v.worseCount + ' slipped' : '') + '.') +
      (v.bottleneck ? '<br>Remaining bottleneck: ' + escapeHtml(v.bottleneck) : '') +
      '<br>' + nextDrill + '</div>';
    comparisonBox.innerHTML = '<div class="feedback">' + replayHtml + verdictHtml + focusVerdict +
      sec('Improved', data.improved, 'cmp-good') +
      sec('Stayed the same', data.same, 'cmp-same') +
      sec('Got worse', data.worse, 'cmp-bad') +
      '<div class="retry-focus"><strong>Next focus:</strong> ' + escapeHtml(data.next_focus.focus) +
      '<br><span class="hint">' + escapeHtml(data.next_focus.tip) + '</span></div></div>';
    comparisonPanel.hidden = false;
    setAttemptState('Comparison', false);
    log('Comparison rendered');
}

initSession();
checkHealth();
updateSampleButtons();
renderHistory(loadHistory());
refreshProfile();
refreshAssignment();
updateStats();