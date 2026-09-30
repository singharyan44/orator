// Debate Coach v1 client (Days 3–5). Reuses the TrainingEngine loop:
// AttemptRecorder turn boundaries, selectedEngine(), history/profile,
// .feedback styles. Speech flow in script.js forwards Turn events here.
let debateMotion = null;
let debateSide = 'for';
let debateExchanges = [];
let debateDelivery = [];
let debateThinking = false;
// What the opponent has identified so far: [{ round, claim, weakest }] —
// rendered in the diagnosis so adaptation is visible, not just claimed.
let debateOpponentReads = [];
const debateRecorder = new AttemptRecorder();

const motionSelect = document.getElementById('motionSelect');
const motionContextEl = document.getElementById('motionContext');
const debateStartBtn = document.getElementById('debateStartBtn');
const debateSetupHint = document.getElementById('debateSetupHint');
const debateArenaPanel = document.getElementById('debateArenaPanel');
const debateStateEl = document.getElementById('debateState');
const debateThread = document.getElementById('debateThread');
const roundStartBtn = document.getElementById('roundStartBtn');
const roundFinishBtn = document.getElementById('roundFinishBtn');
const diagnoseBtn = document.getElementById('diagnoseBtn');
const rematchBtn = document.getElementById('rematchBtn');
const debateHintEl = document.getElementById('debateHint');
const debateTimerEl = document.getElementById('debateTimer');
let debateTimerStop = null;

function stopDebateTimer() {
  if (debateTimerStop) { try { debateTimerStop(); } catch (e) { /* ignore */ } debateTimerStop = null; }
  if (debateTimerEl) debateTimerEl.textContent = '';
}
const debateDiagnosisPanel = document.getElementById('debateDiagnosisPanel');
const debateDiagnosisBox = document.getElementById('debateDiagnosisBox');
const speechDrillBtn = document.getElementById('speechDrillBtn');
// Speech skill keys (mirrors coach/profile.js SKILLS): if the debate retry
// focus targets delivery, offer the matching speech drill.
const SPEECH_SKILLS = ['pace', 'fillers', 'repeats', 'structure', 'substance'];

speechDrillBtn.addEventListener('click', () => {
  if (typeof setDebateMode === 'function') setDebateMode(true);
  if (typeof refreshAssignment === 'function') refreshAssignment();
  log('Journey: debate diagnosis → speech drill');
});
const debateSampleBtn = document.getElementById('debateSampleBtn');
const debateSampleHintEl = document.getElementById('debateSampleHint');
const debateVoiceBtn = document.getElementById('debateVoiceBtn');
let debateSampleStreaming = false;
let debateVoiceOn = true;

debateVoiceBtn.addEventListener('click', () => {
  debateVoiceOn = !debateVoiceOn;
  debateVoiceBtn.textContent = debateVoiceOn ? '🔊 Voice on' : '🔇 Voice off';
  if (!debateVoiceOn) { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
});
const speechTabBtn = document.getElementById('speechTabBtn');
const debateTabBtn = document.getElementById('debateTabBtn');

function setDebateMode(speech) {
  document.getElementById('speechMode').hidden = !speech;
  document.getElementById('debateMode').hidden = speech;
  speechTabBtn.classList.toggle('mode-tab-active', speech);
  debateTabBtn.classList.toggle('mode-tab-active', !speech);
}
speechTabBtn.addEventListener('click', () => setDebateMode(true));
debateTabBtn.addEventListener('click', () => setDebateMode(false));

function setDebateState(text, active) {
  debateStateEl.textContent = text;
  debateStateEl.classList.toggle('state-active', !!active);
}

function debateConnected() {
  return typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN;
}

function updateDebateButtons() {
  const connected = debateConnected();
  const busy = debateRecorder.isRecording() || debateRecorder.isFinishing() || debateThinking;
  // Echo guard (safe when script.js hasn't defined the flag yet).
  const speaking = typeof speechPromptPlaying !== 'undefined' && speechPromptPlaying;
  const live = debateExchanges.length > 0;
  const voice = typeof voiceModeActive === 'function' && voiceModeActive();
  const endVoiceBtn = document.getElementById('endVoiceBtn');
  roundStartBtn.hidden = voice;
  roundFinishBtn.hidden = voice;
  debateSampleBtn.hidden = voice;
  diagnoseBtn.hidden = voice;
  if (endVoiceBtn) endVoiceBtn.hidden = !voice;
  roundStartBtn.disabled = busy || !connected || speaking;
  roundFinishBtn.disabled = !debateRecorder.isRecording() || !connected;
  const userTurns = debateExchanges.filter((e) => e.speaker === 'user').length;
  diagnoseBtn.disabled = busy || userTurns === 0;
  motionSelect.disabled = busy || live;
  Array.from(document.querySelectorAll('input[name="debateSide"]')).forEach((r) => { r.disabled = busy || live; });
  debateSampleBtn.disabled = !connected || debateSampleStreaming;
}

// Hands-free debate testing: the LLM writes a fresh argument for YOUR side,
// the browser speaks it aloud, and the live mic captures it like real
// speech. Press "Speak argument" first so the round recorder collects it.
async function playDebateSample() {
  if (debateSampleStreaming) return;
  if (!debateConnected()) {
    debateSampleHintEl.textContent = 'Connect first, then play a sample.';
    return;
  }
  if (!debateMotion) {
    debateSampleHintEl.textContent = 'Start a debate first, then play a sample.';
    return;
  }
  if (!debateRecorder.isRecording() && !debateRecorder.isFinishing()) {
    debateSampleHintEl.textContent = 'Press “Speak argument” first — then play the sample so it counts toward the round.';
  }
  debateSampleStreaming = true;
  updateDebateButtons();
  try {
    const res = await fetch('/api/sample-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'debate-' + debateSide,
        motion: debateMotion.motion,
        side: debateSide,
        history: debateExchanges,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Sample request returned ' + res.status));
    debateSampleHintEl.textContent = (data.source === 'llm' ? 'Fresh AI-written argument' : 'Built-in argument') +
      ' for YOUR side — listen, your live mic captures it. (Sound on!)';
    log('Debate sample (' + data.source + '): ' + data.text.slice(0, 80) + '…');
    await speakText(data.text, 'sample');
    debateSampleHintEl.textContent = 'Sample finished speaking.';
  } catch (e) {
    debateSampleHintEl.textContent = 'Sample failed: ' + e.message;
    log('Debate sample error: ' + e.message);
  }
  debateSampleStreaming = false;
  updateDebateButtons();
}

debateSampleBtn.addEventListener('click', playDebateSample);

async function loadMotions() {
  try {
    const res = await fetch('/api/debate/motions');
    const data = await res.json();
    if (!res.ok) throw new Error('motions returned ' + res.status);
    motionSelect.innerHTML = data.motions.map((m) =>
      '<option value="' + m.id + '">' + escapeHtml(m.motion) + '</option>').join('');
    showMotionContext();
  } catch (e) {
    debateSetupHint.textContent = 'Could not load motions: ' + e.message;
  }
}

function showMotionContext() {
  const opt = motionSelect.options[motionSelect.selectedIndex];
  motionContextEl.textContent = opt ? opt.text : '';
}
motionSelect.addEventListener('change', showMotionContext);

function debateSideValue() {
  const c = document.querySelector('input[name="debateSide"]:checked');
  return c && c.value === 'against' ? 'against' : 'for';
}

debateStartBtn.addEventListener('click', () => {
  const id = motionSelect.value;
  if (!id) { debateSetupHint.textContent = 'Pick a motion first.'; return; }
  if (typeof closeVoiceSession === 'function') closeVoiceSession();
  debateMotion = { id, motion: motionSelect.options[motionSelect.selectedIndex].text };
  debateSide = debateSideValue();
  debateExchanges = [];
  debateDelivery = [];
  debateOpponentReads = [];
  debateRecorder.resetToIdle();
  debateThread.innerHTML = '';
  debateDiagnosisPanel.hidden = true;
  speechDrillBtn.hidden = true;
  debateArenaPanel.hidden = false;
  if (typeof voiceOpponentMode === 'function' && voiceOpponentMode() === 'voice') {
    if (typeof startVoiceDebate === 'function') startVoiceDebate(id, debateSide);
    return;
  }
  setDebateState('Ready', false);
  debateHintEl.textContent = 'You argue ' + debateSide.toUpperCase() + ': "' + debateMotion.motion + '". Press “Speak argument”, make your case, then “Finish round”.';
  log('Debate started: ' + debateMotion.motion + ' (' + debateSide + ')');
  updateDebateButtons();
});

roundStartBtn.addEventListener('click', () => {
  if (!debateMotion || debateRecorder.isRecording() || debateRecorder.isFinishing() || debateThinking) return;
  if (!debateConnected()) { debateHintEl.textContent = 'Connect first (same connection as Speech).'; return; }
  // Echo guard: starting while the opponent's voice plays captures it into
  // the round. Samples are exempt (kind 'sample' never sets this flag).
  if (typeof speechPromptPlaying !== 'undefined' && speechPromptPlaying) {
    debateHintEl.textContent = 'Wait for the opponent’s voice to finish — otherwise it lands in your transcript.';
    return;
  }
  debateRecorder.start(Date.now());
  if (typeof recorder !== 'undefined') recorder.resetToIdle();
  if (typeof interviewRecorder !== 'undefined') interviewRecorder.resetToIdle();
  stopDebateTimer();
  debateTimerStop = startElapsedTimer(debateTimerEl, Date.now());
  setDebateState('Recording', true);
  debateHintEl.textContent = 'Recording your argument — speak now, then “Finish round”.';
  updateDebateButtons();
  log('Debate round recording started');
});

roundFinishBtn.addEventListener('click', () => {
  stopDebateTimer();
  const r = debateRecorder.finish(Date.now());
  updateDebateButtons();
  if (r.status === 'submitted') {
    submitDebateRound(r.attempt);
  } else if (r.status === 'waiting') {
    setDebateState('Finishing…', true);
    debateHintEl.textContent = 'Finishing… waiting for the final transcript.';
  } else if (r.status === 'empty') {
    debateHintEl.textContent = 'No speech recorded — press “Speak argument” first, then speak while Recording.';
  }
});

// Called from script.js handleMessage for every Turn event.
function debateOnPartial(text, order) {
  if (debateRecorder.isRecording()) debateRecorder.onTurn({ text, final: false, order });
  return null;
}

function debateOnFinal(text, order) {
  if (!debateRecorder.isRecording() && !debateRecorder.isFinishing()) return null;
  const done = debateRecorder.onTurn({ text, final: true, order });
  if (done) submitDebateRound(done);
  return null;
}

function appendThreadMsg(speaker, text, meta) {
  const div = document.createElement('div');
  div.className = 'thread-msg ' + (speaker === 'user' ? 'user' : 'opponent');
  div.innerHTML = '<strong>' + (speaker === 'user' ? 'You' : 'Opponent') + ':</strong> ' +
    escapeHtml(text) + (meta ? '<br><span class="hint">' + escapeHtml(meta) + '</span>' : '');
  debateThread.appendChild(div);
  debateThread.scrollTop = debateThread.scrollHeight;
}

async function submitDebateRound({ transcript, turnCount, durationMs }) {
  debateThinking = true;
  setDebateState('Opponent thinking…', true);
  debateHintEl.textContent = 'Your argument is with the opponent…';
  updateDebateButtons();
  try {
    const res = await fetch('/api/debate/opponent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motionId: debateMotion.id,
        userSide: debateSide,
        userTranscript: transcript,
        history: debateExchanges,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
        durationMs,
        turnCount,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Opponent returned ' + res.status));
    debateExchanges.push({ speaker: 'user', text: transcript });
    debateExchanges.push({ speaker: 'opponent', text: data.attack });
    debateDelivery.push(data.metrics);
    if (data.argument && data.argument.claim) {
      debateOpponentReads.push({
        round: debateExchanges.filter((e) => e.speaker === 'user').length,
        claim: data.argument.claim,
        weakest: data.weakestComponent || null,
      });
    }
    saveAttemptToHistory({
      promptTitle: 'Debate: ' + debateMotion.motion,
      transcript,
      metrics: data.metrics,
      analysis: null,
      coachSource: data.source === 'llm' ? 'llm' : 'rules',
      requestedEngine: selectedEngine(),
      createdAt: new Date().toISOString(),
    });
    renderHistory(loadHistory());
    refreshProfile();
    if (typeof updateStats === 'function') updateStats();
    appendThreadMsg('user', transcript, null);
    const meta = (data.weakestComponent ? 'attacked: ' + data.weakestComponent + ' · ' : '') +
      (data.source === 'llm' ? 'AI Coach' : (data.fallback ? 'Rules sparring — AI fallback' : 'Rules sparring'));
    appendThreadMsg('opponent', data.attack, meta);
    if (debateVoiceOn) speakText(data.attack);
    setDebateState('Your turn', false);
    debateHintEl.textContent = 'Your turn — “Speak argument” to respond, or “Diagnose debate” after 2+ rounds.';
    log('Opponent replied (weakest: ' + (data.weakestComponent || 'n/a') + ')');
  } catch (e) {
    debateHintEl.textContent = 'Opponent failed: ' + e.message;
    setDebateState('Ready', false);
    log('Opponent error: ' + e.message);
  }
  debateThinking = false;
  updateDebateButtons();
}

diagnoseBtn.addEventListener('click', async () => {
  const userTurns = debateExchanges.filter((e) => e.speaker === 'user').length;
  if (userTurns === 0 || debateThinking) return;
  setDebateState('Diagnosing…', true);
  debateHintEl.textContent = 'Diagnosing the debate…';
  updateDebateButtons();
  try {
    const res = await fetch('/api/debate/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motionId: debateMotion.id,
        userSide: debateSide,
        exchanges: debateExchanges,
        delivery: debateDelivery,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Diagnose returned ' + res.status));
    renderDebateDiagnosis(data.diagnosis, data.source);
    if (typeof refreshAssignment === 'function') refreshAssignment();
    setDebateState('Diagnosed', false);
    debateHintEl.textContent = 'Diagnosis ready. Rematch to argue the other side, or keep debating.';
  } catch (e) {
    debateHintEl.textContent = 'Diagnosis failed: ' + e.message;
    setDebateState('Your turn', false);
    log('Diagnose error: ' + e.message);
  }
  updateDebateButtons();
});

function renderDebateDiagnosis(d, source) {
  const li = (items) => items.map((t) => '<li>' + escapeHtml(t) + '</li>').join('');
  const sc = d.scorecard || {};
  const badge = source === 'llm' ? '<span class="hint">AI Coach</span>' : '<span class="hint">Rules Coach</span>';
  debateDiagnosisBox.innerHTML = '<div class="feedback">' +
    '<h3>Debate scorecard ' + badge + '</h3>' +
    '<div class="metrics">' +
    '<span class="metric">' + (sc.rounds || 0) + ' rounds</span>' +
    '<span class="metric">' + (sc.claims_made || 0) + ' claims</span>' +
    '<span class="metric">' + (sc.claims_supported || 0) + ' supported</span>' +
    '<span class="metric">' + (sc.rebuttals_addressed || 0) + ' rebuttals answered</span>' +
    '</div>' +
    (debateOpponentReads.length ? '<h3>What the opponent tracked</h3><ul>' + debateOpponentReads.map((r) =>
      '<li>Round ' + r.round + ' — attacked your <strong>' + escapeHtml(r.weakest || 'argument') + '</strong>: “' +
      escapeHtml(r.claim.length > 120 ? r.claim.slice(0, 120) + '…' : r.claim) + '”</li>').join('') + '</ul>' : '') +
    (d.strengths.length ? '<h3>Strengths</h3><ul>' + li(d.strengths) + '</ul>' : '') +
    (d.areas_to_improve.length ? '<h3>Work on</h3><ul>' + li(d.areas_to_improve) + '</ul>' : '') +
    (d.actionable_feedback.length ? '<h3>Do next time</h3><ul>' + li(d.actionable_feedback) + '</ul>' : '') +
    '<div class="retry-focus"><strong>Retry focus:</strong> ' + escapeHtml(d.retry_focus.focus) +
    '<br><span class="hint">' + escapeHtml(d.retry_focus.tip) + '</span></div>' +
    '</div>';
  debateDiagnosisPanel.hidden = false;
  const hitsSpeech = (d.retry_focus.targets || []).some((t) => SPEECH_SKILLS.includes(t));
  speechDrillBtn.hidden = !hitsSpeech;
}

rematchBtn.addEventListener('click', () => {
  if (!debateMotion || debateRecorder.isRecording() || debateRecorder.isFinishing() || debateThinking) return;
  if (typeof closeVoiceSession === 'function') closeVoiceSession();
  debateSide = debateSide === 'for' ? 'against' : 'for';
  document.querySelector('input[name="debateSide"][value="' + debateSide + '"]').checked = true;
  debateExchanges = [];
  debateDelivery = [];
  debateOpponentReads = [];
  debateRecorder.resetToIdle();
  debateThread.innerHTML = '';
  debateDiagnosisPanel.hidden = true;
  speechDrillBtn.hidden = true;
  setDebateState('Ready', false);
  debateHintEl.textContent = 'Rematch — now you argue ' + debateSide.toUpperCase() + '. Press “Speak argument”.';
  log('Debate rematch, sides swapped (' + debateSide + ')');
  updateDebateButtons();
});

loadMotions();
updateDebateButtons();
