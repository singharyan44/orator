// Coach-engine routing for M1.
//
// The UI lets the user pick 'ai' or 'rules' per attempt. This module routes
// accordingly and keeps the source truthful:
//
//   engine 'rules' → deterministic analyzer only, nothing else invoked.
//   engine 'ai'    → text LLM; on ANY failure fall back to rules.
//
// Visual measurements (on-device landmarks) ride inside metrics — the vision
// work happens client-side, so there is no separate vision call here.
//
// Returns { analysis, coachSource: 'llm'|'rules', requested,
//           fallback: true|false }. Coach functions are injected so tests can
// spy on them without network access.

async function analyzeAttemptForSession({ engine, prompt, transcript, metrics, previous, llmAnalyze, rulesAnalyze }) {
  const requested = engine === 'rules' ? 'rules' : 'ai';
  if (requested === 'rules') {
    return { analysis: rulesAnalyze({ metrics }), coachSource: 'rules', requested, fallback: false };
  }
  try {
    const analysis = await llmAnalyze({ prompt, transcript, metrics, previous });
    return { analysis, coachSource: 'llm', requested, fallback: false };
  } catch (err) {
    return {
      analysis: rulesAnalyze({ metrics }),
      coachSource: 'rules',
      requested,
      fallback: true,
      fallbackReason: err && err.message ? String(err.message).slice(0, 200) : 'unknown error',
    };
  }
}

module.exports = { analyzeAttemptForSession };
