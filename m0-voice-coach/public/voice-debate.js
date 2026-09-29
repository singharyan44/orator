// Voice debate opponent (AssemblyAI Voice Agent API). The agent TALKS:
// mic → voice session (opponent persona) → spoken replies + transcripts.
// Measurement stays on the analysis side: user finals (+durations) go to the
// same diagnose endpoint as text debates. Realtime streaming transport is
// untouched — this is a second, independent connection used only in voice mode.
let voiceWS = null;
let voiceCtx = null;
let voiceSource = null;
let voiceWorklet = null;
let voiceReady = false;
let voicePlaybackTime = 0;
let voiceExchanges = [];
let voiceAnswers = [];
let voiceTurnStart = 0;
let voiceLastDeltaT = 0;
let voiceLastActivity = 0;
let voiceMode = false;
let voiceOwnsMic = false;
let voiceMicStream = null;

function voiceOpponentMode() {
  const c = document.querySelector('input[name="opponentMode"]:checked');
  return c && c.value === 'voice' ? 'voice' : 'text';
}

document.getElementById('endVoiceBtn').addEventListener('click', () => {
  if (voiceMode) endVoiceAndDiagnose();
});

function voiceModeActive() {
  return voiceMode;
}

function voiceNow() {
  return Date.now();
}

function voiceMarkActivity() {
  voiceLastActivity = voiceNow();
}

// 24 kHz capture worklet (Voice Agent API format). Inline so no extra file;
// chunked at 2400 samples (100 ms) like the streaming pipeline's rule.
function voiceWorkletCode() {
  return `
    class VoicePCM extends AudioWorkletProcessor {
      constructor() {
        super();
        this.ratio = sampleRate / 24000;
        this.pending = new Int16Array(0);
      }
      process(inputs) {
        const input = inputs[0]?.[0];
        if (input) {
          const outLen = Math.floor(input.length / this.ratio);
          if (outLen > 0) {
            const conv = new Int16Array(outLen);
            for (let i = 0; i < outLen; i++) {
              const s = input[Math.floor(i * this.ratio)] ?? 0;
              conv[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
            }
            const merged = new Int16Array(this.pending.length + conv.length);
            merged.set(this.pending);
            merged.set(conv, this.pending.length);
            this.pending = merged;
            while (this.pending.length >= 2400) {
              const chunk = this.pending.slice(0, 2400);
              this.pending = this.pending.slice(2400);
              this.port.postMessage(chunk.buffer, [chunk.buffer]);
            }
          }
        }
        return true;
      }
    }
    registerProcessor('voice-pcm', VoicePCM);
  `;
}

function b64encodeInt16(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function startVoiceDebate(motionId, side) {
  if (voiceMode) return;
  const motionText = motionSelect.options[motionSelect.selectedIndex].text;
  voiceMode = true;
  voiceExchanges = [];
  voiceAnswers = [];
  voiceReady = false;
  voiceTurnStart = 0;
  voiceLastDeltaT = 0;
  voiceLastActivity = 0;
  voiceOwnsMic = false;
  debateMotion = { id: motionId, motion: motionText };
  debateSide = side;
  debateExchanges = [];
  debateDelivery = [];
  if (typeof debateRecorder !== 'undefined') debateRecorder.resetToIdle();
  debateThread.innerHTML = '';
  debateDiagnosisPanel.hidden = true;
  debateArenaPanel.hidden = false;
  setDebateState('Connecting…', true);
  debateHintEl.textContent = 'Opening a voice session with your opponent… speak naturally, interruption works.';
  log('Voice debate starting: ' + motionText + ' (' + side + ')');
  updateDebateButtons();

  try {
    const tokenRes = await fetch('/api/voice-token');
    if (!tokenRes.ok) throw new Error('Voice token returned ' + tokenRes.status);
    const { token } = await tokenRes.json();

    const cfgRes = await fetch('/api/debate/voice-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motionId, userSide: side }),
    });
    const cfg = await cfgRes.json();
    if (!cfgRes.ok) throw new Error(cfg.error || ('Voice config returned ' + cfgRes.status));

    const url = new URL('wss://agents.assemblyai.com/v1/ws');
    url.searchParams.set('token', token);
    voiceWS = new WebSocket(url);

    voiceWS.addEventListener('open', () => {
      voiceWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: cfg.system_prompt,
          greeting: cfg.greeting,
          input: { format: { encoding: 'audio/pcm' } },
          output: { format: { encoding: 'audio/pcm' }, volume: 100 },
        },
      }));
      log('Voice session open, config sent');
    });

    voiceWS.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleVoiceMessage(msg);
    });

    voiceWS.addEventListener('close', () => {
      log('Voice session closed');
      if (voiceMode) {
        setDebateState('Disconnected', false);
        debateHintEl.textContent = 'Voice session ended. Press Start debate to talk again, or Diagnose.';
        voiceMode = false;
        stopVoiceAudio();
        updateDebateButtons();
      }
    });

    voiceWS.addEventListener('error', () => {
      log('Voice session error');
      debateHintEl.textContent = 'Voice connection error — try text opponent instead.';
    });
  } catch (e) {
    voiceMode = false;
    setDebateState('Ready', false);
    debateHintEl.textContent = 'Voice opponent failed: ' + e.message;
    log('Voice debate start failed: ' + e.message);
    updateDebateButtons();
  }
}

async function startVoiceAudio() {
  voiceCtx = new AudioContext({ sampleRate: 24000 });
  await voiceCtx.resume().catch(() => {});
  const blob = new Blob([voiceWorkletCode()], { type: 'application/javascript' });
  await voiceCtx.audioWorklet.addModule(URL.createObjectURL(blob));
  let micStream = null;
  if (typeof stream !== 'undefined' && stream) {
    micStream = stream;
  } else if (typeof getMicStream === 'function') {
    micStream = await getMicStream();
    voiceOwnsMic = true;
    voiceMicStream = micStream;
  } else {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    voiceOwnsMic = true;
    voiceMicStream = micStream;
  }
  voiceSource = voiceCtx.createMediaStreamSource(micStream);
  voiceWorklet = new AudioWorkletNode(voiceCtx, 'voice-pcm');
  voiceWorklet.port.onmessage = (e) => {
    if (voiceReady && voiceWS && voiceWS.readyState === WebSocket.OPEN) {
      voiceWS.send(JSON.stringify({ type: 'input.audio', audio: b64encodeInt16(e.data) }));
    }
  };
  voiceSource.connect(voiceWorklet);
  voiceWorklet.connect(voiceCtx.destination);
  voicePlaybackTime = voiceCtx.currentTime;
}

function stopVoiceAudio() {
  try { voiceWorklet && voiceWorklet.disconnect(); } catch (e) { /* ignore */ }
  try { voiceSource && voiceSource.disconnect(); } catch (e) { /* ignore */ }
  // NOTE: the shared streaming mic `stream` is owned by that connection —
  // only stop tracks for a mic this session opened itself.
  if (voiceOwnsMic && voiceMicStream) {
    try { voiceMicStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  }
  if (voiceCtx) voiceCtx.close().catch(() => {});
  voiceWorklet = null;
  voiceSource = null;
  voiceCtx = null;
  voiceReady = false;
  voicePlaybackTime = 0;
  voiceOwnsMic = false;
  voiceMicStream = null;
}

async function playVoiceReply(base64Data) {
  if (!voiceCtx) return;
  const raw = atob(base64Data);
  const pcm16 = new Int16Array(raw.length / 2);
  for (let i = 0; i < pcm16.length; i++) {
    pcm16[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
  }
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
  const buffer = voiceCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);
  const src = voiceCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(voiceCtx.destination);
  const now = voiceCtx.currentTime;
  voicePlaybackTime = Math.max(voicePlaybackTime, now);
  try { src.start(voicePlaybackTime); } catch (e) { /* ignore */ }
  voicePlaybackTime += buffer.duration;
}

function handleVoiceMessage(msg) {
  const type = msg.type || 'unknown';
  if (type === 'session.ready') {
    voiceReady = true;
    voiceMarkActivity();
    setDebateState('Live — speak now', true);
    debateHintEl.textContent = 'Live voice debate. Just talk — interruption works both ways. “End & Diagnose” when done.';
    log('Voice session ready');
    startVoiceAudio().catch((e) => {
      debateHintEl.textContent = 'Mic failed: ' + e.message;
      log('Voice mic error: ' + e.message);
    });
    updateDebateButtons();
  } else if (type === 'reply.audio') {
    if (msg.data) playVoiceReply(msg.data);
  } else if (type === 'reply.done') {
    voiceMarkActivity();
    if (msg.status === 'interrupted' && voiceCtx) voicePlaybackTime = voiceCtx.currentTime;
  } else if (type === 'transcript.user.delta' || type === 'transcript.agent.delta') {
    const now = voiceNow();
    if (now - voiceLastDeltaT > 2500) voiceTurnStart = now;
    voiceLastDeltaT = now;
  } else if (type === 'transcript.user') {
    const text = (msg.text || '').trim();
    if (!text) return;
    const durationMs = voiceTurnStart > 0 ? Math.max(500, voiceNow() - voiceTurnStart) : Math.max(500, voiceNow() - voiceLastActivity);
    voiceTurnStart = 0;
    voiceMarkActivity();
    voiceExchanges.push({ speaker: 'user', text });
    voiceAnswers.push({ transcript: text, durationMs });
    appendThreadMsg('user', text, null);
    log('Voice you: ' + text);
    updateDebateButtons();
  } else if (type === 'transcript.agent') {
    const text = (msg.text || '').trim();
    if (!text) return;
    voiceMarkActivity();
    voiceExchanges.push({ speaker: 'opponent', text });
    appendThreadMsg('opponent', text, msg.interrupted ? 'interrupted · voice opponent' : 'voice opponent');
    log('Voice opponent: ' + text.slice(0, 80));
  } else if (type === 'session.error') {
    debateHintEl.textContent = 'Voice error: ' + (msg.message || msg.code || 'unknown');
    log('Voice session error: ' + JSON.stringify(msg));
  } else if (type === 'session.ended') {
    log('Voice session ended by server');
    finishVoiceSession();
  }
}

function closeVoiceSession() {
  if (voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    try { voiceWS.send(JSON.stringify({ type: 'session.end' })); } catch (e) { /* ignore */ }
    setTimeout(() => { try { voiceWS && voiceWS.close(); } catch (e) { /* ignore */ } }, 400);
  } else if (voiceWS) {
    try { voiceWS.close(); } catch (e) { /* ignore */ }
  }
  voiceMode = false;
  stopVoiceAudio();
}

function finishVoiceSession() {
  closeVoiceSession();
  setDebateState('Ready', false);
  debateHintEl.textContent = 'Voice session ended. Diagnose whenever ready.';
  updateDebateButtons();
}

async function endVoiceAndDiagnose() {
  if (!debateMotion) return;
  closeVoiceSession();
  setDebateState('Diagnosing…', true);
  debateHintEl.textContent = 'Diagnosing the voice debate…';
  updateDebateButtons();
  try {
    const res = await fetch('/api/debate/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motionId: debateMotion.id,
        userSide: debateSide,
        exchanges: voiceExchanges,
        answers: voiceAnswers,
        coachEngine: selectedEngine(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Diagnose returned ' + res.status));
    // Save voice turns to history with server-computed metrics.
    const per = data.delivery && data.delivery.length ? data.delivery : [];
    voiceAnswers.forEach((a, i) => {
      saveAttemptToHistory({
        promptTitle: 'Voice debate: ' + debateMotion.motion,
        transcript: a.transcript,
        metrics: per[i] || { wordCount: a.transcript.split(/\s+/).length, wpm: null, fillerCount: 0, repeatCount: 0 },
        analysis: null,
        coachSource: 'voice',
        requestedEngine: selectedEngine(),
        createdAt: new Date().toISOString(),
      });
    });
    renderHistory(loadHistory());
    refreshProfile();
    renderDebateDiagnosis(data.diagnosis, data.source);
    setDebateState('Diagnosed', false);
    debateHintEl.textContent = 'Diagnosis ready. Start a new debate any time.';
  } catch (e) {
    debateHintEl.textContent = 'Diagnosis failed: ' + e.message;
    setDebateState('Ready', false);
    log('Voice diagnose error: ' + e.message);
  }
  updateDebateButtons();
}
