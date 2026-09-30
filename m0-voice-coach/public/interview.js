// Interview Coach client. Same TrainingEngine loop as Debate: voice answers
// (AttemptRecorder boundaries) → adaptive interviewer (text) → diagnosis +
// optional cross-interview comparison. Speech flow forwards Turns here.
let interviewRole = null;
let interviewExchanges = [];
let interviewDelivery = [];
let interviewThinking = false;
let lastInterview = null;
const interviewRecorder = new AttemptRecorder();

const roleSelect = document.getElementById('roleSelect');
const roleFocusEl = document.getElementById('roleFocus');
const interviewStartBtn = document.getElementById('interviewStartBtn');
const interviewSetupHint = document.getElementById('interviewSetupHint');
const interviewArenaPanel = document.getElementById('interviewArenaPanel');
const interviewStateEl = document.getElementById('interviewState');
const interviewThread = document.getElementById('interviewThread');
const answerStartBtn = document.getElementById('answerStartBtn');
const answerFinishBtn = document.getElementById('answerFinishBtn');
const diagnoseInterviewBtn = document.getElementById('diagnoseInterviewBtn');
const newInterviewBtn = document.getElementById('newInterviewBtn');
const interviewSampleBtn = document.getElementById('interviewSampleBtn');
const interviewHintEl = document.getElementById('interviewHint');
const interviewTimerEl = document.getElementById('interviewTimer');
let interviewTimerStop = null;

function stopInterviewTimer() {
  if (interviewTimerStop) { try { interviewTimerStop(); } catch (e) { /* ignore */ } interviewTimerStop = null; }
  if (interviewTimerEl) interviewTimerEl.textContent = '';
}
const interviewSampleHintEl = document.getElementById('interviewSampleHint');
const interviewVoiceBtn = document.getElementById('interviewVoiceBtn');
let interviewVoiceOn = true;

interviewVoiceBtn.addEventListener('click', () => {
  interviewVoiceOn = !interviewVoiceOn;
  interviewVoiceBtn.textContent = interviewVoiceOn ? '🔊 Voice on' : '🔇 Voice off';
  if (!interviewVoiceOn) { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
});
const interviewDiagnosisPanel = document.getElementById('interviewDiagnosisPanel');
const interviewDiagnosisBox = document.getElementById('interviewDiagnosisBox');
const interviewTabBtn = document.getElementById('interviewTabBtn');
let interviewSampleStreaming = false;

function setMode(mode) {
  document.getElementById('speechMode').hidden = mode !== 'speech';
  document.getElementById('debateMode').hidden = mode !== 'debate';
  document.getElementById('interviewMode').hidden = mode !== 'interview';
  speechTabBtn.classList.toggle('mode-tab-active', mode === 'speech');
  debateTabBtn.classList.toggle('mode-tab-active', mode === 'debate');
  interviewTabBtn.classList.toggle('mode-tab-active', mode === 'interview');
}
interviewTabBtn.addEventListener('click', () => setMode('interview'));
speechTabBtn.addEventListener('click', () => setMode('speech'));
debateTabBtn.addEventListener('click', () => setMode('debate'));

function setInterviewState(text, active) {
  interviewStateEl.textContent = text;
  interviewStateEl.classList.toggle('state-active', !!active);
}

function interviewConnected() {
  return typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN;
}

function updateInterviewButtons() {
  const connected = interviewConnected();
  const busy = interviewRecorder.isRecording() || interviewRecorder.isFinishing() || interviewThinking;
  // Echo guard (safe when script.js hasn't defined the flag yet).
  const speaking = typeof speechPromptPlaying !== 'undefined' && speechPromptPlaying;
  answerStartBtn.disabled = busy || !connected || speaking;
  answerFinishBtn.disabled = !interviewRecorder.isRecording() || !connected;
  const answered = interviewExchanges.filter((e) => e.speaker === 'candidate').length;
  diagnoseInterviewBtn.disabled = busy || answered === 0;
  roleSelect.disabled = busy || interviewExchanges.length > 0;
  interviewSampleBtn.disabled = !connected || interviewSampleStreaming;
}

async function loadRoles() {
  try {
    const res = await fetch('/api/interview/roles');
    const data = await res.json();
    if (!res.ok) throw new Error('roles returned ' + res.status);
    roleSelect.innerHTML = data.roles.map((r) =>
      '<option value="' + r.id + '">' + escapeHtml(r.title) + '</option>').join('');
    showRoleFocus();
  } catch (e) {
    interviewSetupHint.textContent = 'Could not load roles: ' + e.message;
  }
}

function showRoleFocus() {
  const opt = roleSelect.options[roleSelect.selectedIndex];
  roleFocusEl.textContent = opt ? opt.text : '';
}
roleSelect.addEventListener('change', showRoleFocus);

interviewStartBtn.addEventListener('click', async () => {
  const id = roleSelect.value;
  if (!id) { interviewSetupHint.textContent = 'Pick a role first.'; return; }
  interviewRole = { id, title: roleSelect.options[roleSelect.selectedIndex].text };
  interviewExchanges = [];
  interviewDelivery = [];
  interviewRecorder.resetToIdle();
  interviewThread.innerHTML = '';
  interviewDiagnosisPanel.hidden = true;
  interviewArenaPanel.hidden = false;
  setInterviewState('Thinking…', true);
  interviewHintEl.textContent = 'The interviewer is preparing your first question…';
  updateInterviewButtons();
  log('Interview started: ' + interviewRole.title);
  await fetchInterviewQuestion(null);
});

async function fetchInterviewQuestion(lastAnswer, durationMs, turnCount) {
  interviewThinking = true;
  updateInterviewButtons();
  try {
    const res = await fetch('/api/interview/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roleId: interviewRole.id,
        lastAnswer: lastAnswer || null,
        history: interviewExchanges,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
        durationMs: durationMs || 0,
        turnCount: turnCount || 0,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Question returned ' + res.status));
    if (lastAnswer !== null && lastAnswer !== undefined) {
      interviewExchanges.push({ speaker: 'candidate', text: lastAnswer });
      if (data.metrics) {
        interviewDelivery.push(data.metrics);
        saveAttemptToHistory({
          promptTitle: 'Interview: ' + interviewRole.title,
          transcript: lastAnswer,
          metrics: data.metrics,
          analysis: null,
          coachSource: data.source === 'llm' ? 'llm' : 'rules',
          requestedEngine: selectedEngine(),
          createdAt: new Date().toISOString(),
        });
        renderHistory(loadHistory());
        refreshProfile();
        if (typeof updateStats === 'function') updateStats();
      }
      appendInterviewMsg('candidate', lastAnswer, null);
    }
    interviewExchanges.push({ speaker: 'interviewer', text: data.question });
    appendInterviewMsg('interviewer', data.question,
      (data.intent ? 'intent: ' + data.intent + ' · ' : '') + (data.source === 'llm' ? 'AI Coach' : 'Rules interviewer'));
    if (interviewVoiceOn) speakText(data.question);
    setInterviewState('Your turn', false);
    interviewHintEl.textContent = 'Your turn — “Speak answer” to respond, or “Diagnose interview” after 2+ answers.';
    log('Interviewer asked (' + data.intent + ')');
  } catch (e) {
    interviewHintEl.textContent = 'Interviewer failed: ' + e.message;
    setInterviewState('Ready', false);
    log('Interviewer error: ' + e.message);
  }
  interviewThinking = false;
  updateInterviewButtons();
}

answerStartBtn.addEventListener('click', () => {
  if (!interviewRole || interviewRecorder.isRecording() || interviewRecorder.isFinishing() || interviewThinking) return;
  if (!interviewConnected()) { interviewHintEl.textContent = 'Connect first (same connection as Speech).'; return; }
  // Echo guard: starting while the interviewer's voice plays captures it
  // into the answer (this exact bug shipped in the demo video).
  if (typeof speechPromptPlaying !== 'undefined' && speechPromptPlaying) {
    interviewHintEl.textContent = 'Wait for the interviewer’s voice to finish — otherwise it lands in your transcript.';
    return;
  }
  interviewRecorder.start(Date.now());
  if (typeof recorder !== 'undefined') recorder.resetToIdle();
  if (typeof debateRecorder !== 'undefined') debateRecorder.resetToIdle();
  stopInterviewTimer();
  interviewTimerStop = startElapsedTimer(interviewTimerEl, Date.now());
  setInterviewState('Recording', true);
  interviewHintEl.textContent = 'Recording your answer — speak now, then “Finish answer”.';
  updateInterviewButtons();
  log('Interview answer recording started');
});

answerFinishBtn.addEventListener('click', () => {
  stopInterviewTimer();
  const r = interviewRecorder.finish(Date.now());
  updateInterviewButtons();
  if (r.status === 'submitted') {
    submitInterviewAnswer(r.attempt);
  } else if (r.status === 'waiting') {
    setInterviewState('Finishing…', true);
    interviewHintEl.textContent = 'Finishing… waiting for the final transcript.';
  } else if (r.status === 'empty') {
    interviewHintEl.textContent = 'No speech recorded — press “Speak answer” first, then speak while Recording.';
  }
});

// Called from script.js handleMessage for every Turn event.
function interviewOnPartial(text, order) {
  if (interviewRecorder.isRecording()) interviewRecorder.onTurn({ text, final: false, order });
  return null;
}

function interviewOnFinal(text, order) {
  if (!interviewRecorder.isRecording() && !interviewRecorder.isFinishing()) return null;
  const done = interviewRecorder.onTurn({ text, final: true, order });
  if (done) submitInterviewAnswer(done);
  return null;
}

function appendInterviewMsg(speaker, text, meta) {
  const div = document.createElement('div');
  div.className = 'thread-msg ' + (speaker === 'candidate' ? 'user' : 'opponent');
  div.innerHTML = '<strong>' + (speaker === 'candidate' ? 'You' : 'Interviewer') + ':</strong> ' +
    escapeHtml(text) + (meta ? '<br><span class="hint">' + escapeHtml(meta) + '</span>' : '');
  interviewThread.appendChild(div);
  interviewThread.scrollTop = interviewThread.scrollHeight;
}

async function submitInterviewAnswer({ transcript, turnCount, durationMs }) {
  setInterviewState('Interviewer thinking…', true);
  interviewHintEl.textContent = 'Your answer is with the interviewer…';
  await fetchInterviewQuestion(transcript, durationMs, turnCount);
}

diagnoseInterviewBtn.addEventListener('click', async () => {
  const answered = interviewExchanges.filter((e) => e.speaker === 'candidate').length;
  if (answered === 0 || interviewThinking) return;
  setInterviewState('Diagnosing…', true);
  interviewHintEl.textContent = 'Diagnosing the interview…';
  updateInterviewButtons();
  try {
    const res = await fetch('/api/interview/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roleId: interviewRole.id,
        exchanges: interviewExchanges,
        delivery: interviewDelivery,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
        previous: lastInterview,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Diagnose returned ' + res.status));
    renderInterviewDiagnosis(data.diagnosis, data.source, data.comparison);
    lastInterview = {
      transcript: interviewExchanges.filter((e) => e.speaker === 'candidate').map((e) => e.text).join(' '),
      metrics: sumDelivery(interviewDelivery),
      analysis: {
        strengths: data.diagnosis.strengths,
        areas_to_improve: data.diagnosis.areas_to_improve,
        retry_focus: data.diagnosis.retry_focus,
      },
    };
    setInterviewState('Diagnosed', false);
    interviewHintEl.textContent = 'Diagnosis ready. “New interview” runs it back with the same role.';
  } catch (e) {
    interviewHintEl.textContent = 'Diagnosis failed: ' + e.message;
    setInterviewState('Your turn', false);
    log('Interview diagnose error: ' + e.message);
  }
  updateInterviewButtons();
});

function sumDelivery(delivery) {
  const words = delivery.reduce((a, m) => a + (m.wordCount || 0), 0);
  const fillers = delivery.reduce((a, m) => a + (m.fillerCount || 0), 0);
  const repeats = delivery.reduce((a, m) => a + (m.repeatCount || 0), 0);
  return {
    wordCount: words,
    fillerCount: fillers,
    fillerRatePer100: words > 0 ? Math.round((fillers / words) * 1000) / 10 : 0,
    repeatCount: repeats,
    sentenceCount: 0,
    fragmentCount: 0,
    longSentenceCount: 0,
    wpm: null,
    durationSec: 0,
    turnCount: delivery.length,
  };
}

function renderInterviewDiagnosis(d, source, comparison) {
  const li = (items) => items.map((t) => '<li>' + escapeHtml(t) + '</li>').join('');
  const sc = d.scorecard || {};
  const badge = source === 'llm' ? '<span class="hint">AI Coach</span>' : '<span class="hint">Rules Coach</span>';
  let cmpHtml = '';
  if (comparison) {
    const sec = (title, items, cls) => items.length
      ? '<h3>' + title + '</h3><ul class="' + cls + '">' + items.map((i) => '<li>' + escapeHtml(i.detail) + '</li>').join('') + '</ul>'
      : '';
    const verdict = comparison.retry_focus_addressed == null ? ''
      : comparison.retry_focus_addressed
        ? '<p class="cmp-good"><strong>Yes — you addressed the previous retry focus.</strong></p>'
        : '<p class="cmp-bad"><strong>Not yet — the previous retry focus still needs work.</strong></p>';
    cmpHtml = '<h3>Vs last interview</h3>' + verdict +
      sec('Improved', comparison.improved, 'cmp-good') +
      sec('Stayed the same', comparison.same, 'cmp-same') +
      sec('Got worse', comparison.worse, 'cmp-bad');
  }
  interviewDiagnosisBox.innerHTML = '<div class="feedback">' +
    '<h3>Interview scorecard ' + badge + '</h3>' +
    '<div class="metrics">' +
    '<span class="metric">' + (sc.questions_answered || 0) + ' answered</span>' +
    '<span class="metric">' + (sc.concise_answers || 0) + ' concise</span>' +
    '<span class="metric">' + (sc.evidence_given || 0) + ' with evidence</span>' +
    '<span class="metric">' + (sc.pressure_handled || 0) + ' pressure handled</span>' +
    '</div>' +
    (d.strengths.length ? '<h3>Strengths</h3><ul>' + li(d.strengths) + '</ul>' : '') +
    (d.areas_to_improve.length ? '<h3>Work on</h3><ul>' + li(d.areas_to_improve) + '</ul>' : '') +
    (d.actionable_feedback.length ? '<h3>Do next time</h3><ul>' + li(d.actionable_feedback) + '</ul>' : '') +
    '<div class="retry-focus"><strong>Retry focus:</strong> ' + escapeHtml(d.retry_focus.focus) +
    '<br><span class="hint">' + escapeHtml(d.retry_focus.tip) + '</span></div>' +
    cmpHtml + '</div>';
  interviewDiagnosisPanel.hidden = false;
}

newInterviewBtn.addEventListener('click', () => {
  if (!interviewRole || interviewRecorder.isRecording() || interviewRecorder.isFinishing() || interviewThinking) return;
  interviewExchanges = [];
  interviewDelivery = [];
  interviewRecorder.resetToIdle();
  interviewThread.innerHTML = '';
  interviewDiagnosisPanel.hidden = true;
  setInterviewState('Thinking…', true);
  interviewHintEl.textContent = 'New interview, same role. The interviewer is preparing…';
  updateInterviewButtons();
  log('New interview: ' + interviewRole.title);
  fetchInterviewQuestion(null);
});

async function playInterviewSample() {
  if (interviewSampleStreaming) return;
  if (!interviewConnected()) {
    interviewSampleHintEl.textContent = 'Connect first, then play a sample.';
    return;
  }
  if (!interviewRole) {
    interviewSampleHintEl.textContent = 'Start an interview first, then play a sample.';
    return;
  }
  if (!interviewRecorder.isRecording() && !interviewRecorder.isFinishing()) {
    interviewSampleHintEl.textContent = 'Press “Speak answer” first — then play the sample so it counts toward the answer.';
  }
  interviewSampleStreaming = true;
  updateInterviewButtons();
  try {
    const res = await fetch('/api/sample-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'interview-answer',
        topic: interviewRole.title,
        history: interviewExchanges,
        language: (typeof selectedLanguage === 'function') ? selectedLanguage() : 'en',
        coachEngine: selectedEngine(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Sample request returned ' + res.status));
    interviewSampleHintEl.textContent = (data.source === 'llm' ? 'Fresh AI-written answer' : 'Built-in answer') +
      ' — listen, your live mic captures it. (Sound on!)';
    log('Interview sample (' + data.source + ')');
    await speakText(data.text, 'sample');
    interviewSampleHintEl.textContent = 'Sample finished speaking.';
  } catch (e) {
    interviewSampleHintEl.textContent = 'Sample failed: ' + e.message;
  }
  interviewSampleStreaming = false;
  updateInterviewButtons();
}

interviewSampleBtn.addEventListener('click', playInterviewSample);

loadRoles();
updateInterviewButtons();
