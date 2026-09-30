// M1 unit tests: node coach/tests.js  (exit 1 on any failure)
// Covers: metrics, analyzer, comparison, session store, AttemptRecorder race,
// LLM provider config, LLM JSON validation, LLM fallback behavior.
const { AttemptRecorder } = require('../public/attempt-recorder');
const { computeMetrics } = require('./metrics');
const { analyzeAttempt } = require('./analyze');
const { compareAttempts } = require('./compare');
const { createSession, getSession, addAttempt, makeAttempt, sessionCount, MAX_SESSIONS } = require('./session');
const { pickPrompt, PROMPTS } = require('./prompts');
const { getProviderConfig } = require('./llm/provider');
const { analyzeWithLLM, buildCoachInput, validateFeedback } = require('./llm-analyze');
const { analyzeAttemptForSession } = require('./coach-engine');
const { buildHealth } = require('./health');
const { buildProfile, skillVerdicts } = require('./profile');
const { generateSampleText, staticSample } = require('./sample-text');
const { assignNext } = require('./assign');
const { MOTIONS, getMotion, validateOpponent, validateDiagnosis, stockChallenge, diagnoseRules, STOCK_CHALLENGES } = require('./debate');
const { opponentReply, diagnoseDebate } = require('./debate-llm');
const { ROLES, getRole, validateQuestion, validateInterviewDiagnosis, stockFollowup, diagnoseInterviewRules, STOCK_FOLLOWUPS } = require('./interview');
const { interviewerNext, diagnoseInterview } = require('./interview-llm');
const { LANGS, normalizeLang, langEntry, languageLine } = require('./language');
const { buildVoiceOpponentPrompt } = require('./voice-opponent');
const { splitSpokenText } = require('../public/speech-out');
const { formatElapsed, dayStats, withTimeout } = require('../public/stats');
const { buildSessionText, verdictSummary } = require('../public/export-text');
const { faceObservation, summarizeObservations, nativeFaceAvailable, MP } = require('../public/pose-est');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra || ''));
};

// ---------- AttemptRecorder race tests ----------
{
  // 1. Final already received before Finish → immediate submit
  const r = new AttemptRecorder();
  r.start(1000);
  r.onTurn({ text: 'I play football.', final: false, order: 0 });
  const d0 = r.onTurn({ text: 'I play football.', final: true, order: 0 });
  ok('race1 no early submit', d0 === null);
  const f = r.finish(5000);
  ok('race1 immediate submit', f.status === 'submitted' && f.attempt.transcript === 'I play football.' && f.attempt.durationMs === 4000 && f.attempt.turnCount === 1);
}
{
  // 2. Final arrives after Finish → waits, then submits once
  const r = new AttemptRecorder();
  r.start(1000);
  r.onTurn({ text: 'I play foot', final: false, order: 0 });
  const f = r.finish(3000);
  ok('race2 waiting', f.status === 'waiting' && r.isFinishing());
  const d = r.onTurn({ text: 'I play football.', final: true, order: 0 });
  ok('race2 submits on boundary', !!d && d.transcript === 'I play football.' && d.durationMs === 2000);
  ok('race2 state submitted', r.state === 'submitted');
}
{
  // 3. Multiple Turns after Finish → partials + final all included up to boundary
  const r = new AttemptRecorder();
  r.start(0);
  r.onTurn({ text: 'I play', final: false, order: 0 });
  ok('race3 finish waits', r.finish(1000).status === 'waiting');
  ok('race3 partial ignored', r.onTurn({ text: 'I play foot', final: false, order: 0 }) === null);
  ok('race3 partial2 ignored', r.onTurn({ text: 'I play football', final: false, order: 0 }) === null);
  const d = r.onTurn({ text: 'I play football every Sunday.', final: true, order: 0 });
  ok('race3 final submits all', !!d && d.transcript === 'I play football every Sunday.' && d.turnCount === 1);
}
{
  // 4. Speech before Start is excluded (incl. stale final arriving after Start)
  const r = new AttemptRecorder();
  r.onTurn({ text: 'Old speech.', final: false, order: 0 });
  r.onTurn({ text: 'Old speech.', final: true, order: 0 });
  r.start(5000);
  const stale = r.onTurn({ text: 'Old speech.', final: true, order: 0 });
  ok('race4 stale final excluded', stale === null);
  r.onTurn({ text: 'New words here.', final: true, order: 1 });
  const f = r.finish(9000);
  ok('race4 only new text', f.status === 'submitted' && f.attempt.transcript === 'New words here.');
}
{
  // 5. Speech after finalize is excluded
  const r = new AttemptRecorder();
  r.start(0);
  r.onTurn({ text: 'First attempt.', final: true, order: 0 });
  const f = r.finish(1000);
  ok('race5 submitted', f.status === 'submitted');
  ok('race5 later final excluded', r.onTurn({ text: 'Later speech.', final: true, order: 1 }) === null);
  ok('race5 later partial excluded', r.onTurn({ text: 'Later', final: false, order: 1 }) === null);
}
{
  // 6. Double finish cannot resubmit
  const r = new AttemptRecorder();
  r.start(0);
  r.onTurn({ text: 'Trying.', final: false, order: 0 });
  ok('race6 first finish waits', r.finish(1000).status === 'waiting');
  ok('race6 second finish duplicate', r.finish(1200).status === 'duplicate');
  const d = r.onTurn({ text: 'Trying again.', final: true, order: 0 });
  ok('race6 single submit', !!d && d.transcript === 'Trying again.');
  ok('race6 finish after submit duplicate', r.finish(2000).status === 'duplicate');
  ok('race6 empty finish', new AttemptRecorder().finish(0).status === 'invalid');
  const r2 = new AttemptRecorder();
  r2.start(0);
  ok('race6 silent finish empty', r2.finish(500).status === 'empty');
  const r3 = new AttemptRecorder();
  ok('idle fresh', r3.isIdle() && !r3.isRecording() && !r3.isFinishing(), '');
  r3.start(0);
  ok('idle false when recording', !r3.isIdle() && r3.isRecording(), '');
}

// ---------- metrics ----------
{
  const weak = computeMetrics({ transcript: 'Um, so like, I I think uh you know the the movie was was really really good basically.', durationMs: 12000, turnCount: 3 });
  ok('m words=18', weak.wordCount === 18, ' got ' + weak.wordCount);
  ok('m wpm=90', weak.wpm === 90, ' got ' + weak.wpm);
  ok('m fillers=5', weak.fillerCount === 5, ' got ' + weak.fillerCount);
  ok('m rate=27.8', weak.fillerRatePer100 === 27.8, ' got ' + weak.fillerRatePer100);
  ok('m repeats=4', weak.repeatCount === 4, ' got ' + weak.repeatCount);
  const strong = computeMetrics({ transcript: 'My name is Alex and I work as a nurse. I chose this job because I like helping people through difficult days. Last week a patient thanked me, and that reminded me why the work matters.', durationMs: 30000, turnCount: 2 });
  ok('m strong wpm=72', strong.wpm === 72, ' got ' + strong.wpm);
  ok('m strong fillers=1', strong.fillerCount === 1, ' got ' + strong.fillerCount);
  ok('m strong repeats=0', strong.repeatCount === 0);
  ok('m strong sentences=3', strong.sentenceCount === 3, ' got ' + strong.sentenceCount);
}

// ---------- analyzer ----------
{
  const weak = computeMetrics({ transcript: 'Um, so like, I I think uh you know the the movie was was really really good basically.', durationMs: 12000, turnCount: 3 });
  const wa = analyzeAttempt({ metrics: weak });
  ok('a shape', !!(wa.strengths && wa.areas_to_improve && wa.actionable_feedback && wa.retry_focus && wa.retry_focus.targets), '');
  ok('a weak areas', wa.areas_to_improve.length > 0);
  ok('a weak focus fillers', wa.retry_focus.targets.includes('fillerRatePer100'), '');
  ok('a no generic praise', !JSON.stringify(wa).match(/Good job|confidently/i), '');
  const strong = computeMetrics({ transcript: 'My name is Alex and I work as a nurse. I like helping people.', durationMs: 20000, turnCount: 1 });
  ok('a strong strengths', analyzeAttempt({ metrics: strong }).strengths.length > 0, '');
}

// ---------- comparison ----------
{
  const weak = computeMetrics({ transcript: 'Um, so like, I I think uh you know the the movie was was really really good basically.', durationMs: 12000, turnCount: 3 });
  const wa = analyzeAttempt({ metrics: weak });
  const better = computeMetrics({ transcript: 'My name is Alex and I work as a nurse. I chose this job because I like helping people through difficult days.', durationMs: 30000, turnCount: 2 });
  const ia = analyzeAttempt({ metrics: better });
  const cmp = compareAttempts(wa, ia, wa.retry_focus);
  ok('c shape', !!(cmp.improved && cmp.same && cmp.worse && cmp.next_focus), '');
  ok('c addressed', cmp.retry_focus_addressed === true, ' got ' + cmp.retry_focus_addressed);
  ok('c fillers improved', cmp.improved.some((i) => i.metric === 'fillerRatePer100'), '');
  const worseM = computeMetrics({ transcript: 'Um uh like basically you know um uh like it was was good um.', durationMs: 10000, turnCount: 2 });
  const cmpW = compareAttempts(ia, analyzeAttempt({ metrics: worseM }), ia.retry_focus);
  ok('c regression', cmpW.worse.length > 0, ' worse=' + cmpW.worse.length);
  ok('c regression focus false', cmpW.retry_focus_addressed === false, '');
  // client-shape previous: light analysis (no metrics inside) + separate metrics
  const lightPrev = { transcript: 'old words here', metrics: weak, analysis: { strengths: wa.strengths, areas_to_improve: wa.areas_to_improve, retry_focus: wa.retry_focus } };
  const cmpLight = compareAttempts({ ...lightPrev.analysis, metrics: lightPrev.metrics }, ia, lightPrev.analysis.retry_focus);
  ok('c light-shape previous', cmpLight.improved.some((i) => i.metric === 'fillerRatePer100'), '');
}

// ---------- session ----------
{
  const s = createSession(pickPrompt());
  ok('s prompts', PROMPTS.length > 0);
  ok('s created', !!s.id && !!s.prompt.title);
  const a1 = addAttempt(s.id, { transcript: 'x', durationMs: 1, turnCount: 1, metrics: {}, analysis: {} });
  const a2 = addAttempt(s.id, { transcript: 'y', durationMs: 1, turnCount: 1, metrics: {}, analysis: {} });
  ok('s numbering', a1.n === 1 && a2.n === 2);
  ok('s count', getSession(s.id).attempts.length === 2);
  ok('s unknown', getSession('nope') === null && addAttempt('nope', {}) === null);
  const stateless = makeAttempt(2, { transcript: 'hi there', durationMs: 1000, turnCount: 1, metrics: { wordCount: 2 }, analysis: { retry_focus: null } });
  ok('s stateless numbering', stateless.n === 2 && stateless.transcript === 'hi there' && !!stateless.id && !!stateless.createdAt, '');
  const first = createSession(pickPrompt());
  for (let i = 0; i < MAX_SESSIONS + 5; i++) createSession(pickPrompt());
  ok('s store capped', sessionCount() === MAX_SESSIONS && getSession(first.id) === null, '');
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);

// ---------- LLM provider config + validation + fallback (async) ----------
(async () => {
  const cfgNone = getProviderConfig({});
  ok('llm no keys -> null', cfgNone === null);
  const cfgOR = getProviderConfig({ COACH_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' });
  ok('llm openrouter defaults', cfgOR && cfgOR.name === 'openrouter' && cfgOR.model === 'openrouter/free' && cfgOR.baseURL.includes('openrouter'), '');
  const cfgGroq = getProviderConfig({ COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k', COACH_MODEL: 'llama-x' });
  ok('llm groq override', cfgGroq && cfgGroq.name === 'groq' && cfgGroq.model === 'llama-x' && cfgGroq.baseURL.includes('groq') && cfgGroq.apiKey === 'k', '');
  const cfgGroqDef = getProviderConfig({ COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' });
  ok('llm groq default model', cfgGroqDef && cfgGroqDef.model === 'openai/gpt-oss-20b', ' got ' + (cfgGroqDef && cfgGroqDef.model));

  // input builder
  const metrics = computeMetrics({ transcript: 'I play football every Sunday with friends.', durationMs: 8000, turnCount: 1 });
  const prompt = { title: 'T', objective: 'O' };
  const first = buildCoachInput({ prompt, transcript: 'hi', metrics, previous: null });
  ok('llm input first', first.previousAttempt === null && first.retryNote === null && first.attempt.metrics.wordCount === 7, '');
  const retry = buildCoachInput({ prompt, transcript: 'hi', metrics, previous: { transcript: 'old', metrics, analysis: { strengths: ['s'], areas_to_improve: ['a'], retry_focus: { focus: 'f', targets: ['wpm'], tip: 't' } } } });
  ok('llm input retry', !!retry.previousAttempt && typeof retry.retryNote === 'string' && retry.retryNote.includes('retry'), '');

  // validation
  const good = { strengths: ['Steady pace at 120 wpm.'], areas_to_improve: ['Two filler words.'], actionable_feedback: ['Pause instead of saying um.'], retry_focus: { focus: 'Cut fillers.', targets: ['fillerRatePer100'], tip: 'Pause silently.' }, observations: [] };
  const v = validateFeedback(good);
  ok('llm valid passes', v.retry_focus.focus === 'Cut fillers.' && v.strengths.length === 1, '');
  for (const [name, bad] of [
    ['missing keys', { strengths: [] }],
    ['empty strengths', { ...good, strengths: [] }],
    ['non-string item', { ...good, strengths: [42] }],
    ['bad retry_focus', { ...good, retry_focus: 'just try harder' }],
    ['not object', [1, 2]],
  ]) {
    let threw = false;
    try { validateFeedback(bad); } catch (e) { threw = true; }
    ok('llm invalid: ' + name, threw);
  }

  // no provider configured -> throws (caller falls back)
  let threwNone = false;
  try {
    await analyzeWithLLM({ prompt, transcript: 'hi', metrics, previous: null }, { env: {} });
  } catch (e) { threwNone = /No LLM provider/.test(e.message); }
  ok('llm unconfigured throws', threwNone);

  // mocked success (OpenRouter-shaped)
  const mockOK = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(good) } }] }),
  });
  const out = await analyzeWithLLM(
    { prompt, transcript: 'hi', metrics, previous: null },
    { env: { COACH_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }, fetchImpl: mockOK, timeoutMs: 2000 }
  );
  ok('llm mocked success', out.strengths.length === 1 && out.metrics === metrics && out.provider === 'openrouter', '');

  // malformed JSON -> throws
  const mockBadJSON = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json {{' } }] }) });
  let threwJSON = false;
  try {
    await analyzeWithLLM({ prompt, transcript: 'hi', metrics, previous: null }, { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockBadJSON, timeoutMs: 2000 });
  } catch (e) { threwJSON = true; }
  ok('llm malformed JSON throws', threwJSON);

  // HTTP 500 -> throws
  const mock500 = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  let threw500 = false;
  try {
    await analyzeWithLLM({ prompt, transcript: 'hi', metrics, previous: null }, { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mock500, timeoutMs: 2000 });
  } catch (e) { threw500 = /HTTP 500/.test(e.message); }
  ok('llm http500 throws', threw500);

  // network failure -> throws
  let threwNet = false;
  try {
    await analyzeWithLLM({ prompt, transcript: 'hi', metrics, previous: null }, { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('socket hangup'); }, timeoutMs: 2000 });
  } catch (e) { threwNet = /socket hangup/.test(e.message); }
  ok('llm network throws', threwNet);

  console.log('LLM-RESULT pass=' + pass + ' fail=' + fail);
  if (fail) process.exit(1);

  // ---------- coach-engine routing ----------
  const fakeMetrics = { wordCount: 10 };
  const fakeRules = { strengths: ['r'], areas_to_improve: [], actionable_feedback: [], retry_focus: { focus: 'f', targets: [], tip: '' } };
  const fakeLLM = { strengths: ['l'], areas_to_improve: [], actionable_feedback: [], retry_focus: { focus: 'f', targets: [], tip: '' } };
  let llmCalls = 0;
  let llmGot = null;
  const spyLLM = async (args) => { llmCalls++; llmGot = args; return fakeLLM; };
  const spyRules = () => fakeRules;

  const rRules = await analyzeAttemptForSession({ engine: 'rules', prompt: {}, transcript: 't', metrics: fakeMetrics, previous: null, llmAnalyze: spyLLM, rulesAnalyze: spyRules });
  ok('engine rules skips LLM', llmCalls === 0 && rRules.coachSource === 'rules' && rRules.requested === 'rules' && rRules.fallback === false, '');

  const rAI = await analyzeAttemptForSession({ engine: 'ai', prompt: { title: 'T' }, transcript: 'hello world', metrics: fakeMetrics, previous: { transcript: 'old' }, llmAnalyze: spyLLM, rulesAnalyze: spyRules });
  ok('engine ai invokes LLM', llmCalls === 1 && rAI.coachSource === 'llm' && rAI.requested === 'ai', '');
  ok('engine ai passes context', llmGot && llmGot.transcript === 'hello world' && llmGot.previous && llmGot.previous.transcript === 'old' && llmGot.metrics === fakeMetrics, '');

  const rDefault = await analyzeAttemptForSession({ prompt: {}, transcript: 't', metrics: fakeMetrics, previous: null, llmAnalyze: spyLLM, rulesAnalyze: spyRules });
  ok('engine default is ai', llmCalls === 2 && rDefault.requested === 'ai', '');

  const rFail = await analyzeAttemptForSession({ engine: 'ai', prompt: {}, transcript: 't', metrics: fakeMetrics, previous: null, llmAnalyze: async () => { throw new Error('down'); }, rulesAnalyze: spyRules });
  ok('engine ai failure falls back', rFail.coachSource === 'rules' && rFail.fallback === true && rFail.analysis === fakeRules && rFail.requested === 'ai', '');

  console.log('ENGINE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- deployment health checks ----------
  const hFull = buildHealth({ ASSEMBLYAI_API_KEY: 'k', COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k', COACH_MODEL: 'm' });
  ok('health full', hFull.ok === true && hFull.speech === 'ready' && hFull.coach === 'ai-groq' && hFull.coachModel === 'm', '');
  const hRules = buildHealth({ ASSEMBLYAI_API_KEY: 'k' });
  ok('health rules', hRules.ok === true && hRules.coach === 'rules' && hRules.coachModel === null, '');
  const hNone = buildHealth({});
  ok('health missing', hNone.ok === false && hNone.speech === 'missing-key' && hNone.coach === 'rules', '');
  ok('health no secrets', !JSON.stringify(buildHealth({ ASSEMBLYAI_API_KEY: 'sekret-key', GROQ_API_KEY: 'sekret-g' })).includes('sekret'), '');

  console.log('HEALTH-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- on-the-fly sample texts ----------
  {
    ok('sample static all kinds', ['speech-weak', 'speech-clean', 'debate-for', 'debate-against'].every((k) => {
      const t = staticSample(k);
      return typeof t === 'string' && t.length >= 20;
    }), '');
    let threwKind = false;
    try { staticSample('nope'); } catch (e) { threwKind = true; }
    ok('sample static unknown throws', threwKind);
    let threwGen = false;
    try {
      await generateSampleText({ kind: 'nope' }, { env: {} });
    } catch (e) { threwGen = true; }
    ok('sample unknown kind throws', threwGen);
    let threwUncfg = false;
    try {
      await generateSampleText({ kind: 'speech-clean', topic: 'weekends' }, { env: {} });
    } catch (e) { threwUncfg = /No LLM provider/.test(e.message); }
    ok('sample unconfigured throws', threwUncfg);
    const mockText = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: 'My weekend was quiet and restful, and I spent most of it reading outside.' }) } }] }),
    });
    const gen = await generateSampleText(
      { kind: 'speech-clean', topic: 'weekends' },
      { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockText, timeoutMs: 2000 }
    );
    ok('sample mocked LLM', gen.text.includes('weekend') && gen.provider === 'groq', '');
    const mockBad = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: 'x' }) } }] }),
    });
    let threwBad = false;
    try {
      await generateSampleText(
        { kind: 'speech-clean' },
        { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockBad, timeoutMs: 2000 }
      );
    } catch (e) { threwBad = true; }
    ok('sample invalid text throws', threwBad);
  }

  console.log('SAMPLE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- response language + conversational memory ----------
  {
    ok('lang normalize', normalizeLang('de') === 'de' && normalizeLang('DE') === 'de' && normalizeLang('xx') === 'en' && normalizeLang() === 'en' && langEntry('hi').tts === 'hi-IN', '');
    ok('lang list sane', LANGS.length >= 5 && LANGS.every((l) => l.code && l.name && l.tts) && new Set(LANGS.map((l) => l.code)).size === LANGS.length, '');
    ok('lang line pins values, keeps keys', languageLine('de').includes('German') && languageLine('de').includes('JSON keys'), '');
    // Capturing mock: records the system+user payload, returns canned content.
    const seen = {};
    const mockCapture = (content) => async (url, opts) => {
      try {
        const payload = JSON.parse(opts.body);
        seen.system = payload.messages[0].content;
        seen.user = payload.messages[1].content;
      } catch (e) { /* ignore */ }
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    const envGroq = { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, timeoutMs: 2000 };
    await opponentReply(
      { motion: getMotion('ai-education'), userSide: 'for', userTranscript: 'KI hilft.', history: [{ speaker: 'opponent', text: 'alter Angriff' }], language: 'de' },
      { ...envGroq, fetchImpl: mockCapture(JSON.stringify({ argument: { claim: 'c', evidence: [], reasoning: 'r' }, weakest_component: 'evidence', attack: 'Wo ist der Beleg für diese Behauptung? Nenne eine Studie mit echten Schülern und echten Ergebnissen, sonst bleibt es eine leere Aussage ohne Beweiskraft.' })) }
    );
    ok('opponent language+memory', seen.system.includes('German') && seen.user.includes('prior_exchanges') && seen.user.includes('alter Angriff'), '');
    await interviewerNext(
      { role: getRole('swe'), lastAnswer: 'On a livré à temps.', history: [{ speaker: 'interviewer', text: 'ancienne question' }], round: 1, language: 'fr' },
      { ...envGroq, fetchImpl: mockCapture(JSON.stringify({ question: 'Quel exemple concret ?', intent: 'probe' })) }
    );
    ok('interviewer language+memory', seen.system.includes('French') && seen.user.includes('ancienne question'), '');
    await generateSampleText(
      { kind: 'interview-answer', topic: 'Backend-Rolle', history: [{ speaker: 'interviewer', text: 'Erzähl mal?' }], language: 'de' },
      { ...envGroq, fetchImpl: mockCapture(JSON.stringify({ text: 'In meinem letzten Projekt haben wir pünktlich geliefert, weil wir die Tests automatisiert haben.' })) }
    );
    ok('sample language+memory', seen.system.includes('German') && seen.user.includes('prior_exchanges') && seen.user.includes('Erzähl mal?'), '');
    const vp = buildVoiceOpponentPrompt(getMotion('ai-education'), 'for', 'es');
    ok('voice prompt language', vp.system_prompt.includes('Spanish') && vp.greeting.length > 0, '');
    ok('rules challenge quotes', stockChallenge({ round: 1, lastUserText: 'KI personalisiert alles' }).startsWith('You said "KI personalisiert alles"'), '');
    ok('rules challenge legacy', stockChallenge(1) === STOCK_CHALLENGES[1 % STOCK_CHALLENGES.length], '');
    ok('rules followup quotes', stockFollowup({ round: 0, lastAnswer: 'wir lieferten pünktlich' }).startsWith('You mentioned "wir lieferten pünktlich"'), '');
    ok('rules followup legacy', stockFollowup(2) === STOCK_FOLLOWUPS[2 % STOCK_FOLLOWUPS.length], '');
    ok('static rotation', staticSample('interview-answer', 1) !== staticSample('interview-answer', 0) && staticSample('interview-answer') === staticSample('interview-answer', 0), '');
  }

  console.log('LANGMEM-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- personal profile ----------
  {
    const v = skillVerdicts({ wpm: 130, fillerRatePer100: 1, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 30 });
    ok('profile all good', v.pace && v.fillers && v.repeats && v.structure && v.substance, '');
    const v2 = skillVerdicts({ wpm: null, fillerRatePer100: 9, repeatCount: 3, fragmentCount: 0, longSentenceCount: 1, wordCount: 5 });
    ok('profile mixed', v2.pace === null && !v2.fillers && !v2.repeats && !v2.structure && !v2.substance, '');
    const mk = (metrics, target) => ({ promptTitle: 'P', metrics, analysis: { retry_focus: { focus: 'f', targets: [target], tip: 't' } }, createdAt: '2026-01-01T00:00:00.000Z' });
    const p = buildProfile([
      mk({ wpm: 130, fillerRatePer100: 8, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 30 }, 'fillerRatePer100'),
      mk({ wpm: 140, fillerRatePer100: 9, repeatCount: 1, fragmentCount: 0, longSentenceCount: 0, wordCount: 25 }, 'fillerRatePer100'),
      mk({ wpm: 120, fillerRatePer100: 1, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 22 }, 'wpm'),
    ]);
    ok('profile totals', p.totalAttempts === 3 && p.trends.length === 3 && p.promptsPracticed.length === 1, '');
    ok('profile strength', p.strengths.some((s) => s.key === 'structure'), '');
    ok('profile weakness', p.recurringWeaknesses.some((s) => s.key === 'fillers'), '');
    ok('profile top focus', p.topFocus && p.topFocus.target === 'fillerRatePer100' && p.topFocus.times === 2, '');
    const empty = buildProfile([]);
    ok('profile empty', empty.totalAttempts === 0 && empty.topFocus === null && empty.trends.length === 0, '');
    const junk = buildProfile([null, {}, { metrics: null }]);
    ok('profile junk ignored', junk.totalAttempts === 0, '');
  }

  console.log('PROFILE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- prompt library + adaptive assignment ----------
  {
    ok('prompts count>=12', PROMPTS.length >= 12, ' got ' + PROMPTS.length);
    const ids = PROMPTS.map((p) => p.id);
    ok('prompts unique ids', new Set(ids).size === ids.length, '');
    const validSkills = new Set(['pace', 'fillers', 'repeats', 'structure', 'substance']);
    ok('prompts skills valid', PROMPTS.every((p) => p.title && p.objective && Array.isArray(p.skills) && p.skills.length > 0 && p.skills.every((s) => validSkills.has(s))), '');
    ok('prompts skill coverage', [...validSkills].every((s) => PROMPTS.some((p) => p.skills.includes(s))), '');

    const mkA = (metrics, target) => ({ promptTitle: 'P', metrics, analysis: { retry_focus: { focus: 'f', targets: [target], tip: 't' } }, createdAt: '2026-01-01T00:00:00.000Z' });
    const fillerHeavy = [
      mkA({ wpm: 130, fillerRatePer100: 8, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 30 }, 'fillerRatePer100'),
      mkA({ wpm: 140, fillerRatePer100: 9, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 25 }, 'fillerRatePer100'),
    ];
    const a1 = assignNext(fillerHeavy, null);
    ok('assign weakest fillers', a1.weakest === 'fillers' && a1.prompt.skills.includes('fillers'), ' got ' + a1.weakest);
    ok('assign reason cites', /Filler words.*2 of your last 2/.test(a1.reason), ' got ' + a1.reason);
    const a2 = assignNext(fillerHeavy, a1.prompt.id);
    ok('assign respects exclude', a2.prompt.id !== a1.prompt.id && a2.prompt.skills.includes('fillers'), '');
    const a0 = assignNext([], null);
    ok('assign empty baseline', a0.weakest === null && !!a0.prompt.title && /baseline/.test(a0.reason), '');
    const strongHist = [
      mkA({ wpm: 130, fillerRatePer100: 1, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 30 }, 'wpm'),
      mkA({ wpm: 140, fillerRatePer100: 0, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 25 }, 'wpm'),
    ];
    const aS = assignNext(strongHist, null);
    ok('assign all-strong stretches', aS.weakest === null && /stretch/i.test(aS.reason), ' got ' + aS.reason);
    const paceWeak = [mkA({ wpm: 60, fillerRatePer100: 0, repeatCount: 0, fragmentCount: 0, longSentenceCount: 0, wordCount: 25 }, 'wpm')];
    const aP = assignNext(paceWeak, null);
    ok('assign pace drill', aP.weakest === 'pace' && aP.prompt.skills.includes('pace'), ' got ' + aP.prompt.id);
  }

  console.log('ASSIGN-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- debate coach ----------
  {
    ok('debate motions', MOTIONS.length >= 6 && MOTIONS.every((m) => m.id && m.motion), '');
    ok('debate getMotion', getMotion('ai-education').motion.includes('AI') && getMotion('nope') === null, '');
    const opp = validateOpponent({ argument: { claim: 'AI helps.', evidence: ['Study X.'], reasoning: 'Because Y.' }, weakest_component: 'evidence', attack: 'Study X was tiny and old — got anything representative?' });
    ok('debate opponent valid', opp.weakest_component === 'evidence' && opp.argument.evidence.length === 1, '');
    for (const [name, bad] of [
      ['no attack', { argument: { claim: 'C' }, weakest_component: 'claim', attack: '' }],
      ['short attack', { argument: { claim: 'C' }, weakest_component: 'claim', attack: 'No.' }],
      ['bad component', { argument: { claim: 'C' }, weakest_component: 'vibes', attack: 'This is a sufficiently long attack on your position here.' }],
      ['no claim', { argument: {}, weakest_component: 'claim', attack: 'This is a sufficiently long attack on your position here.' }],
    ]) {
      let threw = false;
      try { validateOpponent(bad); } catch (e) { threw = true; }
      ok('debate opponent invalid: ' + name, threw);
    }
    const dg = validateDiagnosis({ strengths: ['Sustained.'], areas_to_improve: ['Evidence thin.'], actionable_feedback: ['Cite one study.'], retry_focus: { focus: 'Support claims.', targets: ['evidence'], tip: 'One claim, one source.' }, scorecard: { claims_made: 2, claims_supported: 1, rebuttals_addressed: 0, rounds: 2 } });
    ok('debate diagnosis valid', dg.scorecard.claims_made === 2 && dg.retry_focus.targets[0] === 'evidence', '');
    let threwDg = false;
    try { validateDiagnosis({ strengths: [], areas_to_improve: ['x'], actionable_feedback: ['y'], retry_focus: { focus: 'f', targets: [], tip: '' } }); } catch (e) { threwDg = true; }
    ok('debate diagnosis invalid empty', threwDg);
    ok('debate stock rotates', stockChallenge(0) !== stockChallenge(1) && typeof stockChallenge(7) === 'string', '');
    const dr = diagnoseRules({ userTurns: ['I argue X because Y.', 'Also Z.'], metricsList: [{ wordCount: 20, fillerCount: 2 }, { wordCount: 25, fillerCount: 0 }] });
    ok('debate rules diagnosis', dr.strengths.length > 0 && dr.scorecard.rounds === 2 && dr.retry_focus.targets.length === 0, '');

    // mocked LLM opponent + diagnosis (no network)
    const mockOpp = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ argument: { claim: 'AI helps.', evidence: [], reasoning: 'Scale.' }, weakest_component: 'evidence', attack: 'No evidence offered — name one study with real students behind it.' }) } }] }),
    });
    const fetchOpp = async (url, opts) => mockOpp(url, opts);
    const oppOut = await opponentReply(
      { motion: getMotion('ai-education'), userSide: 'for', userTranscript: 'AI helps students.', history: [] },
      { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: fetchOpp, timeoutMs: 2000 }
    );
    ok('debate mocked opponent', oppOut.weakest_component === 'evidence' && oppOut.provider === 'groq', '');
    const mockDg = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ strengths: ['Two rounds sustained.'], areas_to_improve: ['No evidence cited.'], actionable_feedback: ['Cite one source.'], retry_focus: { focus: 'Support claims.', targets: ['evidence'], tip: 'One claim, one source.' }, scorecard: { claims_made: 2, claims_supported: 0, rebuttals_addressed: 1, rounds: 2 } }) } }] }),
    });
    const dgOut = await diagnoseDebate(
      { motion: getMotion('ai-education'), userSide: 'for', exchanges: [{ speaker: 'user', text: 'AI helps.' }], delivery: [] },
      { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockDg, timeoutMs: 2000 }
    );
    ok('debate mocked diagnosis', dgOut.scorecard.rounds === 2 && dgOut.retry_focus.targets[0] === 'evidence', '');
    let threwOpp = false;
    try {
      await opponentReply(
        { motion: getMotion('ai-education'), userSide: 'for', userTranscript: 'AI helps.', history: [] },
        { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('down'); }, timeoutMs: 2000 }
      );
    } catch (e) { threwOpp = true; }
    ok('debate opponent failure throws', threwOpp);
  }

  console.log('DEBATE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- on-device pose estimation (landmark geometry) ----------
  {
    ok('pose urls pinned', MP.BUNDLE_URL.includes('@mediapipe/tasks-vision@0.10.20/') && MP.WASM_URL.endsWith('/wasm') && MP.FACE_MODEL_URL.includes('storage.googleapis.com/mediapipe-models/face_landmarker/'), '');
    const fakeFace = ({ yaw = 0, pitch = 0.5, ear = 0.25 } = {}) => {
      const lm = Array.from({ length: 468 }, () => ({ x: 0, y: 0, z: 0 }));
      const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
      set(33, 0.4, 0.4); set(133, 0.47, 0.4); set(362, 0.53, 0.4); set(263, 0.6, 0.4);
      const half = (ear * 0.07) / 2;
      set(159, 0.435, 0.4 - half); set(145, 0.435, 0.4 + half);
      set(386, 0.565, 0.4 - half); set(374, 0.565, 0.4 + half);
      set(1, 0.5 + yaw * 0.2, 0.4 + pitch * 0.1);
      set(13, 0.5, 0.5); set(14, 0.5, 0.52);
      return lm;
    };
    const neutral = faceObservation(fakeFace());
    ok('pose neutral', neutral.face && neutral.yaw === 'center' && neutral.pitch === 'level' && neutral.eyesOpen, JSON.stringify(neutral));
    const down = faceObservation(fakeFace({ pitch: 0.75 }));
    ok('pose looking down', down.face && down.pitch === 'down', '');
    const right = faceObservation(fakeFace({ yaw: 0.2 }));
    ok('pose turned', right.face && right.yaw === 'right', '');
    const closed = faceObservation(fakeFace({ ear: 0.1 }));
    ok('pose eyes closed', closed.face && !closed.eyesOpen, '');
    ok('pose short array', faceObservation([{ x: 0, y: 0 }]).face === false, '');
    ok('pose missing points', faceObservation(new Array(468).fill({ x: 0, y: 0 })).face === true, 'all-zero is still a shape');
    const badLm = fakeFace(); badLm[1] = { x: NaN, y: 0 };
    ok('pose NaN safe', faceObservation(badLm).face === false, '');
    const sum = summarizeObservations([neutral, down, right, { face: false }, closed]);
    ok('pose summary', sum.frames === 5 && sum.faces === 4 && sum.lookingDown === 1 && sum.headTurned === 1 && sum.eyesClosed === 1, JSON.stringify(sum));
    ok('pose timeline', JSON.stringify(sum.timeline) === JSON.stringify(['center/level', 'center/down', 'right/level', 'absent', 'center/level']), JSON.stringify(sum.timeline));
    ok('pose summary empty', summarizeObservations(null).frames === 0, '');
    ok('pose native guard', nativeFaceAvailable() === false, 'no FaceDetector in node');
    const coarse = summarizeObservations([
      { face: true, coarse: true, yaw: 'center', pitch: 'level', eyesOpen: true },
      { face: true, coarse: true, yaw: 'center', pitch: 'level', eyesOpen: true },
      neutral,
    ]);
    ok('pose coarse counts presence only', coarse.faces === 3 && coarse.lookingDown === 0 && coarse.headTurned === 0, JSON.stringify(coarse));
    // engine ignores frames/visionScreen entirely now (no separate vision call)
    let vCalls2 = 0;
    const lOK2 = async () => ({ strengths: ['l'], areas_to_improve: [], actionable_feedback: [], retry_focus: { focus: 'f', targets: [], tip: '' } });
    const rSync2 = () => ({ strengths: ['r'], areas_to_improve: [], actionable_feedback: [], retry_focus: { focus: 'f', targets: [], tip: '' } });
    const eF = await analyzeAttemptForSession({ engine: 'ai', prompt: {}, transcript: 't', metrics: {}, previous: null, llmAnalyze: lOK2, rulesAnalyze: rSync2, visionScreen: async () => { vCalls2++; return {}; }, frames: ['data:image/jpeg;base64,AAA'] });
    ok('engine ignores visionScreen', eF.coachSource === 'llm' && vCalls2 === 0, '');

    // visual metrics ride inside metrics (computed from landmark summaries)
    const vm = computeMetrics({
      transcript: 'One two three four five six seven eight nine ten eleven twelve.',
      durationMs: 4800, turnCount: 1,
      visual: { frames: 3, faces: 3, lookingDown: 2, headTurned: 0, eyesClosed: 0 },
    });
    ok('visual attach', vm.visualMeasured === true && vm.visual.lookingDown === 2, '');
    const vmClamped = computeMetrics({ transcript: 'Hi there friend.', durationMs: 3000, turnCount: 1, visual: { frames: 2, faces: 99, lookingDown: -5, headTurned: 'x', timeline: ['center/level', 42, 'down'.repeat(50)] } });
    ok('visual sanitized', vmClamped.visual.faces === 2 && vmClamped.visual.lookingDown === 0 && vmClamped.visual.headTurned === 0, JSON.stringify(vmClamped.visual));
    ok('visual timeline sanitized', vmClamped.visual.timeline.length === 2 && vmClamped.visual.timeline[0] === 'center/level' && vmClamped.visual.timeline[1].length === 30, JSON.stringify(vmClamped.visual.timeline));
    const vmNone = computeMetrics({ transcript: 'Hi there friend.', durationMs: 3000, turnCount: 1, visual: { frames: 0 } });
    ok('visual empty', vmNone.visualMeasured === false && vmNone.visual === null, '');
    const vmJunk = computeMetrics({ transcript: 'Hi there friend.', durationMs: 3000, turnCount: 1, visual: 'junk' });
    ok('visual junk safe', vmJunk.visualMeasured === false, '');
    const va = analyzeAttempt({ metrics: vm });
    ok('visual area+focus', va.areas_to_improve.some((t) => /ooking down/.test(t)) && va.retry_focus.targets.length === 0, '');
    const vGood = computeMetrics({
      transcript: 'Um, I finished the quarterly report before lunch today and sent it to the team.',
      durationMs: 18000, turnCount: 1,
      visual: { frames: 3, faces: 3, lookingDown: 0, headTurned: 0, eyesClosed: 0 },
    });
    const vaGood = analyzeAttempt({ metrics: vGood });
    ok('visual strength', vaGood.strengths.some((t) => /camera presence/.test(t)), JSON.stringify(vaGood.strengths));
  }

  console.log('POSE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- interview coach ----------
  {
    ok('interview roles', ROLES.length >= 6 && ROLES.every((r) => r.id && r.title && r.opener && Array.isArray(r.focus)), '');
    ok('interview getRole', getRole('swe').title.includes('Software') && getRole('nope') === null, '');
    const q = validateQuestion({ question: 'What did you personally ship last quarter?', intent: 'probe' });
    ok('interview question valid', q.intent === 'probe', '');
    for (const [name, bad] of [
      ['short', { question: 'Why?', intent: 'probe' }],
      ['bad intent', { question: 'Tell me about a time you led something difficult.', intent: 'vibes' }],
      ['missing', { intent: 'probe' }],
    ]) {
      let threw = false;
      try { validateQuestion(bad); } catch (e) { threw = true; }
      ok('interview question invalid: ' + name, threw);
    }
    const dg = validateInterviewDiagnosis({ strengths: ['Answered directly.'], areas_to_improve: ['Thin evidence.'], actionable_feedback: ['Add numbers.'], retry_focus: { focus: 'Evidence.', targets: ['evidence'], tip: 'One number per answer.' }, scorecard: { questions_answered: 2, concise_answers: 1, evidence_given: 1, pressure_handled: 0 } });
    ok('interview diagnosis valid', dg.scorecard.questions_answered === 2, '');
    let threwDg = false;
    try { validateInterviewDiagnosis({ strengths: ['S.'], areas_to_improve: [], actionable_feedback: ['F.'], retry_focus: { focus: 'R.', targets: [], tip: '' } }); } catch (e) { threwDg = true; }
    ok('interview diagnosis invalid empty', threwDg);
    ok('interview stock rotates', stockFollowup(0) !== stockFollowup(1), '');
    const dr = diagnoseInterviewRules({ answers: ['I did X.', 'Then Y.'], metricsList: [{ wordCount: 15, fillerCount: 0 }, { wordCount: 20, fillerCount: 1 }] });
    ok('interview rules diagnosis', dr.scorecard.questions_answered === 2 && dr.strengths.length > 0, '');
    const mockQ = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ question: 'What was the hardest part, specifically?', intent: 'clarification' }) } }] }),
    });
    const qOut = await interviewerNext(
      { role: getRole('swe'), lastAnswer: 'I fixed a bug.', history: [], round: 1 },
      { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockQ, timeoutMs: 2000 }
    );
    ok('interview mocked question', qOut.intent === 'clarification' && qOut.provider === 'groq', '');
    const mockDg = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ strengths: ['Direct.'], areas_to_improve: ['Short.'], actionable_feedback: ['Say more.'], retry_focus: { focus: 'Evidence.', targets: ['evidence'], tip: 'Numbers.' }, scorecard: { questions_answered: 2, concise_answers: 2, evidence_given: 0, pressure_handled: 0 } }) } }] }),
    });
    const dgOut = await diagnoseInterview(
      { role: getRole('swe'), exchanges: [{ speaker: 'candidate', text: 'I did X.' }], delivery: [] },
      { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: mockDg, timeoutMs: 2000 }
    );
    ok('interview mocked diagnosis', dgOut.scorecard.concise_answers === 2, '');
    let threwQ = false;
    try {
      await interviewerNext(
        { role: getRole('swe'), lastAnswer: null, history: [], round: 0 },
        { env: { COACH_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('down'); }, timeoutMs: 2000 }
      );
    } catch (e) { threwQ = true; }
    ok('interview question failure throws', threwQ);
  }

  console.log('INTERVIEW-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- session export ----------
  {
    const emptyDoc = buildSessionText({ history: [], profile: null });
    ok('export empty', emptyDoc.includes('No attempts recorded'), '');
    const doc = buildSessionText({
      history: [{
        promptTitle: 'P', transcript: 'Hello world test.',
        metrics: { wordCount: 3, wpm: 90, fillerCount: 0, repeatCount: 0 },
        analysis: { strengths: ['Steady.'], areas_to_improve: ['More.'], retry_focus: { focus: 'Say more.' } },
        coachSource: 'llm', createdAt: '2026-01-01T00:00:00.000Z',
      }],
      profile: { totalAttempts: 1, strengths: [{ label: 'Steady pace', good: 1, total: 1 }], recurringWeaknesses: [], topFocus: null },
    });
    ok('export full', doc.includes('Attempt 1') && doc.includes('Hello world test.') && doc.includes('Steady pace') && doc.includes('AI'), '');
  }

  console.log('EXPORT-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- verdict summary ----------
  {
    const v = verdictSummary({
      improved: [{ metric: 'a', detail: 'x' }, { metric: 'b', detail: 'y' }],
      same: [{ metric: 'c', detail: 'z' }],
      worse: [{ metric: 'd', detail: 'w' }],
    });
    ok('verdict counts', v.improvedCount === 2 && v.worseCount === 1 && v.bottleneck === 'w', '');
    const v2 = verdictSummary({ improved: [], same: [{ metric: 'c', detail: 'z' }], worse: [] });
    ok('verdict no-worse fallback', v2.bottleneck === 'z', '');
    const v3 = verdictSummary(null);
    ok('verdict null-safe', v3.improvedCount === 0 && v3.bottleneck === null, '');
  }

  console.log('VERDICT-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- hesitation pauses (AssemblyAI word timings) ----------
  {
    const w = (s, e) => ({ text: 'w', start: s, end: e });
    const m = computeMetrics({
      transcript: 'One two three four five six seven eight.',
      durationMs: 3000, turnCount: 1,
      words: [[w(0, 300), w(400, 700), w(2000, 2300), w(2400, 2700), w(5000, 5300), w(5400, 5700), w(7000, 7300), w(7400, 7700)]],
    });
    ok('pauses counted', m.pauseCount === 3, ' got ' + m.pauseCount);
    ok('pauses longest', m.longestPauseMs === 2300, ' got ' + m.longestPauseMs);
    ok('pauses measured flag', m.pausesMeasured === true, '');
    const mEmpty = computeMetrics({ transcript: 'Hi there friend.', durationMs: 3000, turnCount: 1 });
    ok('pauses unmeasured', mEmpty.pauseCount === 0 && mEmpty.pausesMeasured === false, '');
    const mMessy = computeMetrics({
      transcript: 'Hi.', durationMs: 2000, turnCount: 1,
      words: [[w(900, 500), null, { text: 'x' }, w(0, 200)]],
    });
    ok('pauses messy input safe', mMessy.pauseCount === 0 && mMessy.pausesMeasured === true, '');
    const pa = analyzeAttempt({ metrics: m });
    ok('pauses area+focus', pa.areas_to_improve.some((t) => /hesitation pauses/.test(t)) && pa.retry_focus.targets.includes('pauses'), '');
    const cleanM = computeMetrics({
      transcript: 'Um, I finished the report before lunch today.',
      durationMs: 6000, turnCount: 1,
      words: [[w(0, 300), w(350, 600), w(650, 900), w(950, 1200), w(1250, 1500), w(1550, 1800), w(1850, 2100), w(2150, 2400)]],
    });
    const ca = analyzeAttempt({ metrics: cleanM });
    ok('pauses strength', ca.strengths.some((t) => /No hesitation pauses/.test(t)), '');
    const oldA = analyzeAttempt({ metrics: computeMetrics({ transcript: 'My name is Alex and I work.', durationMs: 8000, turnCount: 1 }) });
    ok('pauses silent when unmeasured', !JSON.stringify(oldA).includes('hesitation pause'), '');
    const cmpP = compareAttempts(
      { ...oldA, metrics: { ...oldA.metrics, pauseCount: 3 } },
      { ...ca, metrics: { ...cleanM, pauseCount: 0 } },
      { focus: 'f', targets: ['pauses'], tip: 't' }
    );
    ok('pauses verdict+addressed', cmpP.improved.some((i) => i.metric === 'pauses') && cmpP.retry_focus_addressed === true, '');
  }

  console.log('PAUSE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- voice opponent persona ----------
  {
    const cfg = buildVoiceOpponentPrompt({ motion: 'AI is good for education', context: 'Schools.' }, 'for');
    ok('voice persona sides', cfg.system_prompt.includes('AGAINST') && cfg.greeting.includes('for'), '');
    ok('voice persona motion', cfg.system_prompt.includes('AI is good for education'), '');
    ok('voice persona rules', /weakest component/i.test(cfg.system_prompt) && /Never comment on voice, accent/i.test(cfg.system_prompt), '');
    ok('voice persona concise', /1–3 short spoken sentences/.test(cfg.system_prompt), '');
    const cfgA = buildVoiceOpponentPrompt({ motion: 'M', context: 'C' }, 'against');
    ok('voice persona flipped', cfgA.system_prompt.includes('argue FOR') && cfgA.greeting.includes('against'), '');
  }

  console.log('VOICE-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- practice stats ----------
  {
    ok('stats format', formatElapsed(0) === '0:00' && formatElapsed(7000) === '0:07' && formatElapsed(65000) === '1:05' && formatElapsed(-500) === '0:00', '');
    // Local-noon dates: immune to timezone edges on any machine.
    const ld = (day) => new Date(2026, 8, day, 12, 0, 0).toISOString();
    const s = dayStats([
      { metrics: { durationSec: 60 }, createdAt: ld(20) },
      { metrics: { durationSec: 120 }, createdAt: ld(21) },
      { metrics: { durationSec: 30 }, createdAt: ld(22) },
    ], new Date(2026, 8, 22, 23, 0, 0));
    ok('stats streak', s.streak === 3 && s.todayCount === 1 && s.totalCount === 3 && s.totalMin === 3.5, JSON.stringify(s));
    const s2 = dayStats([{ metrics: { durationSec: 10 }, createdAt: ld(20) }], new Date(2026, 8, 22, 12, 0, 0));
    ok('stats broken streak', s2.streak === 0 && s2.todayCount === 0, '');
    const s3 = dayStats([{ metrics: {}, createdAt: ld(22) }], new Date(2026, 8, 22, 12, 0, 0));
    ok('stats missing metrics', s3.todayCount === 1 && s3.totalMin === 0, '');
    ok('stats empty', dayStats([], new Date()).todayCount === 0, '');
    const fast = await withTimeout(Promise.resolve(7), 1000);
    ok('timeout fast path', fast.timedOut === false && fast.value === 7, '');
    const slow = await withTimeout(new Promise(() => {}), 20);
    ok('timeout slow path', slow.timedOut === true, '');
  }

  console.log('STATS-RESULT pass=' + pass + ' fail=' + fail);

  // ---------- spoken-output chunking (macOS Safari-safe TTS) ----------
  {
    ok('speech short passthrough', JSON.stringify(splitSpokenText('Hello world.', 220)) === JSON.stringify(['Hello world.']), '');
    const multi = splitSpokenText('First sentence here. Second sentence there! And a third one?', 25);
    ok('speech sentence split', multi.length === 3, ' got ' + multi.length);
    const joined = ['a'.repeat(100) + '.', 'b'.repeat(100) + '.', 'c'.repeat(100) + '.'].join(' ');
    const packed = splitSpokenText(joined, 220);
    ok('speech packing', packed.length === 2 && packed.every((c) => c.length <= 220), JSON.stringify(packed.map((c) => c.length)));
    const monster = splitSpokenText('word '.repeat(100).trim() + '.', 220);
    ok('speech force-split', monster.length > 1 && monster.every((c) => c.length <= 220), '');
    ok('speech empty', splitSpokenText('   ', 220).length === 0 && splitSpokenText(null, 220).length === 0, '');
    const src = 'Um, so like, I think this works. Do you agree? Great stuff here!';
    const back = splitSpokenText(src, 220).join(' ');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    ok('speech lossless', norm(back) === norm(src), '');
  }

  console.log('SPEECH-RESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL llm harness crashed: ' + e.message); process.exit(1); });
