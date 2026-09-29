// LLM-backed coaching analyzer. Implements the same contract as
// coach/analyze.js analyzeAttempt() so the two are interchangeable:
//
//   { metrics, observations, strengths, areas_to_improve,
//     actionable_feedback, retry_focus: { focus, targets, tip } }
//
// Never called with audio. Input is transcript + deterministic metrics only.
// Any failure (not configured, network, malformed JSON, schema violation)
// throws, and the caller falls back to the rule-based analyzer.

const { getProviderConfig } = require('./llm/provider');
const openrouter = require('./llm/openrouter');
const groq = require('./llm/groq');

const PROVIDER_MODULES = { openrouter, groq };

const SYSTEM_PROMPT = `You are a speech coach analyzing a voice-practice attempt.
You receive the practice prompt, the speaker's complete finalized transcript, and deterministic speech metrics.

STRICT RULES:
- Ground every claim in the transcript or metrics. Never invent words, events, or measurements.
- Distinguish measured facts (pace, filler counts) from interpretation.
- Avoid generic praise like "Good job!". Be specific and concrete.
- Give ONE clear retry focus, not a long list.
- Never judge accent, intelligence, or personality.
- Never claim to measure emotion, body language, facial expression, pitch quality, or vocal confidence.
- Keep each list item under 200 characters.

Respond with JSON ONLY, no markdown fences, exactly this shape:
{
  "strengths": ["..."],
  "areas_to_improve": ["..."],
  "actionable_feedback": ["..."],
  "retry_focus": { "focus": "...", "targets": ["wpm" | "fillerRatePer100" | "repeatCount" | "wordCount" | "fragmentCount" | "longSentenceCount"], "tip": "..." },
  "observations": ["..."]
}
1-3 items per list. "targets" names the metrics the retry focus addresses (may be empty). "observations" may be empty.`;

function slimMetrics(m) {
  return {
    durationSeconds: m.durationSec,
    wordCount: m.wordCount,
    wpm: m.wpm,
    fillers: m.fillerCount,
    fillerRatePer100: m.fillerRatePer100,
    repeats: m.repeatCount,
    sentences: m.sentenceCount,
    fragments: m.fragmentCount,
    longSentences: m.longSentenceCount,
    pauses: m.pausesMeasured ? { count: m.pauseCount, longestMs: m.longestPauseMs } : null,
    visual: m.visualMeasured ? m.visual : null,
  };
}

function buildCoachInput({ prompt, transcript, metrics, previous }) {
  const input = {
    prompt: { title: prompt.title, objective: prompt.objective },
    attempt: { transcript, metrics: slimMetrics(metrics) },
    previousAttempt: null,
    retryNote: null,
  };
  if (previous) {
    input.previousAttempt = {
      transcript: previous.transcript,
      metrics: slimMetrics(previous.metrics),
      feedback: {
        strengths: previous.analysis.strengths,
        areas_to_improve: previous.analysis.areas_to_improve,
        retry_focus: previous.analysis.retry_focus,
      },
    };
    input.retryNote = 'This is a retry. Evaluate whether the previous retry focus was actually addressed, using the transcript and metrics as evidence. Numeric improvement is verified separately — describe what you observe, do not invent numbers.';
  }
  return input;
}

function parseJSON(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function strList(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
    throw new Error(`Invalid "${name}": expected 1-5 items.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Invalid "${name}" item: must be a non-empty string.`);
    return item.trim().slice(0, 300);
  });
}

function validateFeedback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Feedback must be a JSON object.');
  const strengths = strList(raw.strengths, 'strengths');
  const areas_to_improve = strList(raw.areas_to_improve, 'areas_to_improve');
  const actionable_feedback = strList(raw.actionable_feedback, 'actionable_feedback');
  const rf = raw.retry_focus;
  if (!rf || typeof rf !== 'object' || Array.isArray(rf)) throw new Error('Invalid "retry_focus": expected an object.');
  if (typeof rf.focus !== 'string' || !rf.focus.trim()) throw new Error('Invalid "retry_focus.focus".');
  const targets = Array.isArray(rf.targets) ? rf.targets.filter((t) => typeof t === 'string') : [];
  const tip = typeof rf.tip === 'string' ? rf.tip.trim().slice(0, 300) : '';
  const observations = Array.isArray(raw.observations)
    ? raw.observations.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim().slice(0, 300))
    : [];
  return {
    strengths,
    areas_to_improve,
    actionable_feedback,
    retry_focus: { focus: rf.focus.trim().slice(0, 300), targets, tip },
    observations: observations.map((text) => ({ type: 'derived', text })),
  };
}

async function analyzeWithLLM({ prompt, transcript, metrics, previous }, opts) {
  const o = opts || {};
  const config = o.config || getProviderConfig(o.env);
  if (!config) throw new Error('No LLM provider configured.');
  if (config.error) throw new Error(config.error);
  const provider = (o.providers || PROVIDER_MODULES)[config.name];
  if (!provider) throw new Error(`No implementation for provider "${config.name}".`);
  const input = buildCoachInput({ prompt, transcript, metrics, previous });
  const text = await provider.complete({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    system: SYSTEM_PROMPT,
    user: JSON.stringify(input),
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
  });
  const validated = validateFeedback(parseJSON(text));
  return { ...validated, metrics, provider: config.name, model: config.model };
}

module.exports = { analyzeWithLLM, buildCoachInput, validateFeedback, parseJSON, SYSTEM_PROMPT };
