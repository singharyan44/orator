require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const { pickPrompt, getPrompt } = require('../coach/prompts');
const { createSession, getSession, addAttempt, makeAttempt } = require('../coach/session');
const { computeMetrics } = require('../coach/metrics');
const { analyzeAttempt } = require('../coach/analyze');
const { analyzeWithLLM } = require('../coach/llm-analyze');
const { getProviderConfig } = require('../coach/llm/provider');
const { analyzeAttemptForSession } = require('../coach/coach-engine');
const { buildHealth } = require('../coach/health');
const { buildProfile } = require('../coach/profile');
const { assignNext } = require('../coach/assign');
const { generateSampleText, staticSample } = require('../coach/sample-text');
const { MOTIONS, getMotion, stockChallenge, diagnoseRules } = require('../coach/debate');
const { opponentReply, diagnoseDebate } = require('../coach/debate-llm');
const { ROLES, getRole, stockFollowup, diagnoseInterviewRules } = require('../coach/interview');
const { interviewerNext, diagnoseInterview } = require('../coach/interview-llm');
const { buildVoiceOpponentPrompt } = require('../coach/voice-opponent');
const { compareAttempts } = require('../coach/compare');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!API_KEY) {
  console.error('Missing ASSEMBLYAI_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, '..', 'public')));
// 2 MB: attempt posts can carry word-timing arrays and histories.
// Default 100 KB would 413 larger attempts.
app.use(express.json({ limit: '2mb' }));

// Streaming token endpoint (Universal-3 Pro Streaming)
app.get('/token', async (req, res) => {
  try {
    const url = new URL('https://streaming.assemblyai.com/v3/token');
    url.searchParams.set('expires_in_seconds', '300');
    url.searchParams.set('max_session_duration_seconds', '8640');

    const response = await fetch(url, {
      headers: { Authorization: API_KEY }, // no Bearer prefix
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Token endpoint error:', response.status, text);
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json({ token: data.token });
  } catch (err) {
    console.error('Token fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch token', message: err.message });
  }
});

// Voice-agent token endpoint (spoken debate opponent). Separate from the
// streaming token above: different API, different auth (Bearer), single-use.
app.get('/api/voice-token', async (req, res) => {
  try {
    const url = new URL('https://agents.assemblyai.com/v1/token');
    url.searchParams.set('expires_in_seconds', '300');
    url.searchParams.set('max_session_duration_seconds', '3600');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Voice token endpoint error:', response.status, text);
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json({ token: data.token });
  } catch (err) {
    console.error('Voice token fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch voice token', message: err.message });
  }
});

// Inline session config for the spoken opponent (persona only — audio and
// measurement stay client-side / Realtime-side).
app.post('/api/debate/voice-config', (req, res) => {
  const body = req.body || {};
  const motion = getMotion(body.motionId);
  if (!motion) return res.status(400).json({ error: 'Unknown motion.' });
  if (body.userSide !== 'for' && body.userSide !== 'against') {
    return res.status(400).json({ error: 'userSide must be "for" or "against".' });
  }
  res.json(buildVoiceOpponentPrompt(motion, body.userSide));
});

// Local runs (`npm start`) listen here. Serverless hosts (Vercel
// @vercel/node) require() this file instead, so skip listening there.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Voice Coach M1 running at http://localhost:${PORT}`);
    console.log(`Token endpoint: http://localhost:${PORT}/token`);
    const coachCfg = getProviderConfig();
    console.log('Coach provider: ' + (coachCfg && !coachCfg.error
      ? coachCfg.name + ' / ' + coachCfg.model
      : 'none (deterministic rules)'));
  });
}

// Exported for serverless hosting (Vercel @vercel/node).
module.exports = app;

// ---------------- M1 coaching API (additive; /token + static untouched) ----------------

// Deployment self-check: which backends are configured (presence only,
// never key values). The UI shows this on load so a missing key explains
// itself instead of surfacing later as a cryptic token/analysis error.
app.get('/api/health', (req, res) => {
  res.json(buildHealth());
});

// Personal profile from a client-held history (stateless: the browser owns
// the attempt list in localStorage, the server only aggregates it).
app.post('/api/profile', (req, res) => {
  const attempts = req.body && Array.isArray(req.body.attempts) ? req.body.attempts.slice(0, 200) : [];
  res.json({ profile: buildProfile(attempts) });
});

// Start a practice session with a prompt. Accepts { promptId } to practice a
// specific (e.g. assigned) prompt, or { excludePromptId } for a random one.
app.post('/api/sessions', (req, res) => {
  const body = req.body || {};
  const prompt = (body.promptId && getPrompt(body.promptId)) || pickPrompt(body.excludePromptId);
  const session = createSession(prompt);
  res.json({ sessionId: session.id, prompt: session.prompt });
});

// Fresh practice sample text, written by the LLM per request (or a static
// fallback). The browser speaks it aloud; the live mic captures it.
app.post('/api/sample-text', async (req, res) => {
  const body = req.body || {};
  const kind = body.kind;
  if (!staticSampleSafe(kind)) return res.status(400).json({ error: 'Unknown sample kind.' });
  if (body.coachEngine === 'rules') {
    return res.json({ text: staticSample(kind), source: 'static' });
  }
  try {
    const out = await generateSampleText({
      kind,
      topic: body.topic,
      motion: body.motion,
      side: body.side,
    });
    res.json({ text: out.text, source: 'llm' });
  } catch (err) {
    console.error('Sample-text LLM unavailable, using static fallback:', err.message);
    res.json({ text: staticSample(kind), source: 'static', fallback: true });
  }
});

function staticSampleSafe(kind) {
  try { staticSample(kind); return true; } catch (e) { return false; }
}

// Adaptive assignment: weakest skill → targeted next exercise. Stateless —
// the browser sends its history, the server answers with prompt + reason.
app.post('/api/assign', (req, res) => {
  const body = req.body || {};
  const attempts = Array.isArray(body.attempts) ? body.attempts.slice(0, 200) : [];
  const assigned = assignNext(attempts, body.excludePromptId || null);
  res.json({ prompt: assigned.prompt, reason: assigned.reason, weakest: assigned.weakest });
});

// Submit a finalized attempt: joined finalized Turns + client-measured timing.
//
// Stateless by design: serverless hosts don't share memory between requests,
// so the session is OPTIONAL. The client sends `previous` (its last attempt)
// on retries; the server numbers from it and returns the comparison inline.
// When a live session exists (local dev) the attempt is also stored there.
app.post('/api/sessions/:id/attempts', async (req, res) => {
  const session = getSession(req.params.id);

  const transcript = (((req.body && req.body.transcript) || '').trim()).slice(0, 8000);
  if (!transcript) return res.status(400).json({ error: 'Empty transcript — speak before finishing the attempt.' });

  const durationMs = Number(req.body.durationMs);
  const turnCount = Number(req.body.turnCount);
  const metrics = computeMetrics({
    transcript,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    turnCount: Number.isFinite(turnCount) && turnCount >= 0 ? turnCount : 0,
    words: Array.isArray(req.body.words) ? req.body.words.slice(0, 50) : [],
    visual: req.body && typeof req.body.visual === 'object' ? req.body.visual : null,
  });

  // Retry context: prefer the client-sent previous (works across serverless
  // instances), fall back to the in-memory session (local dev).
  const bodyPrev = req.body && req.body.previous;
  let prev = null;
  if (bodyPrev && typeof bodyPrev.transcript === 'string' && bodyPrev.transcript.trim() && bodyPrev.analysis && bodyPrev.metrics) {
    const prevN = Number.isFinite(bodyPrev.n) ? Math.floor(bodyPrev.n) : 1;
    prev = {
      n: Math.min(1000, Math.max(1, prevN)),
      transcript: bodyPrev.transcript,
      metrics: bodyPrev.metrics,
      analysis: {
        strengths: bodyPrev.analysis.strengths || [],
        areas_to_improve: bodyPrev.analysis.areas_to_improve || [],
        retry_focus: bodyPrev.analysis.retry_focus || null,
      },
    };
  } else if (session && session.attempts.length > 0) {
    const last = session.attempts[session.attempts.length - 1];
    prev = {
      n: last.n,
      transcript: last.transcript,
      metrics: last.metrics,
      analysis: {
        strengths: last.analysis.strengths,
        areas_to_improve: last.analysis.areas_to_improve,
        retry_focus: last.analysis.retry_focus,
      },
    };
  }

  // Coach engine selected in the UI ('ai' default). Rules never touches the
  // LLM; AI falls back to rules on any provider failure. compare.js stays
  // deterministic either way.
  const requestedEngine = req.body && req.body.coachEngine === 'rules' ? 'rules' : 'ai';
  const routed = await analyzeAttemptForSession({
    engine: requestedEngine,
    prompt: session ? session.prompt : { title: 'Practice', objective: '' },
    transcript,
    metrics,
    previous: prev,
    llmAnalyze: analyzeWithLLM,
    rulesAnalyze: analyzeAttempt,
  });
  if (routed.fallback) {
    // Server-side log keeps the detail; the client gets a generic truthful flag.
    console.error('LLM coach unavailable, using deterministic fallback:', routed.fallbackReason);
  }
  const analysis = routed.analysis;
  const coachSource = routed.coachSource;

  const n = prev ? prev.n + 1 : 1;
  const attempt = session
    ? addAttempt(session.id, { transcript, durationMs: metrics.durationSec * 1000, turnCount: metrics.turnCount, metrics, analysis }) || makeAttempt(n, { transcript, durationMs: metrics.durationSec * 1000, turnCount: metrics.turnCount, metrics, analysis })
    : makeAttempt(n, { transcript, durationMs: metrics.durationSec * 1000, turnCount: metrics.turnCount, metrics, analysis });

  // Comparison rides along with attempt 2+ so retries need no extra round
  // trip and no shared server memory. prev.analysis travels light (no
  // metrics inside), so reattach prev.metrics before comparing.
  let comparison = null;
  if (prev && prev.metrics && prev.analysis && prev.analysis.retry_focus) {
    comparison = compareAttempts({ ...prev.analysis, metrics: prev.metrics }, analysis, prev.analysis.retry_focus);
  }

  res.json({ attempt, analysis, coachSource, requestedEngine: routed.requested, comparison, fallback: routed.fallback === true });
});

// ---------------- Speech attempts + comparison ----------------

// Compare the last two attempts of a session.
app.get('/api/sessions/:id/comparison', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session. Start a new practice session.' });
  if (session.attempts.length < 2) {
    return res.status(400).json({ error: 'Need at least two attempts before comparing.' });
  }
  const prev = session.attempts[session.attempts.length - 2];
  const curr = session.attempts[session.attempts.length - 1];
  res.json(compareAttempts(prev.analysis, curr.analysis, prev.analysis.retry_focus));
});

// ---------------- Debate Coach (stateless; same TrainingEngine loop) ----------------

app.get('/api/debate/motions', (req, res) => {
  res.json({ motions: MOTIONS });
});

function debateEngine(req) {
  return req.body && req.body.coachEngine === 'rules' ? 'rules' : 'ai';
}

// One opponent move: analyze the user's argument, attack its weakest part.
app.post('/api/debate/opponent', async (req, res) => {
  const body = req.body || {};
  const motion = getMotion(body.motionId);
  if (!motion) return res.status(400).json({ error: 'Unknown motion. Pick one from /api/debate/motions.' });
  if (body.userSide !== 'for' && body.userSide !== 'against') {
    return res.status(400).json({ error: 'userSide must be "for" or "against".' });
  }
  const transcript = (body.userTranscript || '').trim().slice(0, 8000);
  if (!transcript) return res.status(400).json({ error: 'Empty argument — speak before ending the round.' });
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
  // Delivery metrics for this spoken turn (powers diagnosis + history).
  const roundMs = Number(body.durationMs);
  const metrics = computeMetrics({
    transcript,
    durationMs: Number.isFinite(roundMs) && roundMs >= 0 ? roundMs : 0,
    turnCount: Number.isFinite(Number(body.turnCount)) && Number(body.turnCount) > 0 ? Math.floor(Number(body.turnCount)) : 1,
  });

  if (debateEngine(req) === 'rules') {
    const round = history.filter((h) => h.speaker === 'user').length;
    return res.json({
      attack: stockChallenge(round),
      weakestComponent: null,
      argument: null,
      source: 'rules',
      metrics,
    });
  }
  try {
    const out = await opponentReply({
      motion,
      userSide: body.userSide,
      userTranscript: transcript,
      history,
    });
    res.json({
      attack: out.attack,
      weakestComponent: out.weakest_component,
      argument: out.argument,
      source: 'llm',
      metrics,
    });
  } catch (err) {
    console.error('Debate opponent unavailable, using stock challenge:', err.message);
    const round = history.filter((h) => h.speaker === 'user').length;
    res.json({
      attack: stockChallenge(round),
      weakestComponent: null,
      argument: null,
      source: 'rules',
      fallback: true,
      metrics,
    });
  }
});

// Diagnose a completed debate: argument scorecard + retry focus.
app.post('/api/debate/diagnose', async (req, res) => {
  const body = req.body || {};
  const motion = getMotion(body.motionId);
  if (!motion) return res.status(400).json({ error: 'Unknown motion.' });
  if (body.userSide !== 'for' && body.userSide !== 'against') {
    return res.status(400).json({ error: 'userSide must be "for" or "against".' });
  }
  const exchanges = Array.isArray(body.exchanges) ? body.exchanges.slice(-20) : [];
  const answers = exchanges.filter((e) => e.speaker === 'user' && e.text && e.text.trim());
  if (answers.length === 0) return res.status(400).json({ error: 'No user arguments to diagnose yet.' });
  // Delivery metrics: precomputed per-turn objects, or computed here from
  // voice-mode answers ({transcript, durationMs}) — no word timings there,
  // so pause verdicts stay silent, everything else is measured.
  let delivery = Array.isArray(body.delivery) ? body.delivery.slice(-10) : [];
  if (delivery.length === 0 && Array.isArray(body.answers)) {
    delivery = body.answers.slice(-10).map((a) => {
      const ms = Number(a.durationMs);
      return computeMetrics({
        transcript: String(a.transcript || ''),
        durationMs: Number.isFinite(ms) && ms >= 0 ? ms : 0,
        turnCount: 1,
      });
    }).filter((m) => m.wordCount > 0);
  }

  if (debateEngine(req) === 'rules') {
    return res.json({ diagnosis: diagnoseRules({ userTurns: answers.map((t) => t.text), metricsList: delivery }), source: 'rules', delivery });
  }
  try {
    const out = await diagnoseDebate({ motion, userSide: body.userSide, exchanges, delivery });
    res.json({ diagnosis: out, source: 'llm', delivery });
  } catch (err) {
    console.error('Debate diagnosis unavailable, using deterministic fallback:', err.message);
    res.json({
      diagnosis: diagnoseRules({ userTurns: answers.map((t) => t.text), metricsList: delivery }),
      source: 'rules',
      fallback: true,
      delivery,
    });
  }
});

// ---------------- Interview Coach (stateless; same TrainingEngine loop) ----------------

app.get('/api/interview/roles', (req, res) => {
  res.json({ roles: ROLES });
});

function interviewEngine(req) {
  return req.body && req.body.coachEngine === 'rules' ? 'rules' : 'ai';
}

// Next interviewer question: opener when no answer yet, else adaptive
// follow-up grounded in the candidate's last answer.
app.post('/api/interview/question', async (req, res) => {
  const body = req.body || {};
  const role = getRole(body.roleId);
  if (!role) return res.status(400).json({ error: 'Unknown role. Pick one from /api/interview/roles.' });
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
  const round = history.filter((h) => h.speaker === 'candidate').length;
  const lastAnswer = typeof body.lastAnswer === 'string' && body.lastAnswer.trim() ? body.lastAnswer.trim().slice(0, 8000) : null;
  // Delivery metrics for the just-finished answer (powers diagnosis + history).
  const ansMs = Number(body.durationMs);
  const ansTurns = Number(body.turnCount);
  const answerMetrics = lastAnswer ? computeMetrics({
    transcript: lastAnswer,
    durationMs: Number.isFinite(ansMs) && ansMs >= 0 ? ansMs : 0,
    turnCount: Number.isFinite(ansTurns) && ansTurns > 0 ? Math.floor(ansTurns) : 1,
  }) : null;

  if (interviewEngine(req) === 'rules') {
    return res.json({
      question: lastAnswer ? stockFollowup(round) : role.opener,
      intent: lastAnswer ? 'probe' : 'opener',
      source: 'rules',
      metrics: answerMetrics,
    });
  }
  try {
    const out = await interviewerNext({ role, lastAnswer, history, round });
    res.json({ question: out.question, intent: out.intent, source: 'llm', metrics: answerMetrics });
  } catch (err) {
    console.error('Interviewer unavailable, using stock question:', err.message);
    res.json({
      question: lastAnswer ? stockFollowup(round) : role.opener,
      intent: lastAnswer ? 'probe' : 'opener',
      source: 'rules',
      fallback: true,
      metrics: answerMetrics,
    });
  }
});

// Diagnose a completed interview. Accepts `previous` (last interview) for a
// deterministic delivery comparison, same as speech retries.
app.post('/api/interview/diagnose', async (req, res) => {
  const body = req.body || {};
  const role = getRole(body.roleId);
  if (!role) return res.status(400).json({ error: 'Unknown role.' });
  const exchanges = Array.isArray(body.exchanges) ? body.exchanges.slice(-20) : [];
  const answers = exchanges.filter((e) => e.speaker === 'candidate' && e.text && e.text.trim());
  if (answers.length === 0) return res.status(400).json({ error: 'No answers to diagnose yet.' });
  const delivery = Array.isArray(body.delivery) ? body.delivery.slice(-10) : [];

  let diagnosis;
  let source;
  if (interviewEngine(req) === 'rules') {
    diagnosis = diagnoseInterviewRules({ answers: answers.map((a) => a.text), metricsList: delivery });
    source = 'rules';
  } else {
    try {
      diagnosis = await diagnoseInterview({ role, exchanges, delivery });
      source = 'llm';
    } catch (err) {
      console.error('Interview diagnosis unavailable, using deterministic fallback:', err.message);
      diagnosis = diagnoseInterviewRules({ answers: answers.map((a) => a.text), metricsList: delivery });
      source = 'rules';
    }
  }

  let comparison = null;
  const bp = body.previous;
  if (bp && bp.metrics && bp.analysis && bp.analysis.retry_focus) {
    comparison = compareAttempts({ ...bp.analysis, metrics: bp.metrics }, { ...diagnosis, metrics: deliverySummary(delivery) }, bp.analysis.retry_focus);
  }
  res.json({ diagnosis, source, comparison });
});

function deliverySummary(delivery) {  const words = delivery.reduce((a, m) => a + (m.wordCount || 0), 0);
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

// Unknown API routes answer JSON (the client parses every API response).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint: ' + req.path });
});