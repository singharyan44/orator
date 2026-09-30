// LLM layer for Debate Coach. Same provider abstraction as speech coaching
// (OpenRouter/Groq, server-side only, single non-streamed request). Strict
// JSON contracts validated by coach/debate.js. Any failure throws and the
// caller falls back to rules sparring / deterministic diagnosis.

const { getProviderConfig } = require('./llm/provider');
const openrouter = require('./llm/openrouter');
const groq = require('./llm/groq');
const { validateOpponent, validateDiagnosis } = require('./debate');
const { languageLine } = require('./language');

const PROVIDER_MODULES = { openrouter, groq };

function parseJSON(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function short(text, max) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

async function callLLM({ system, user, opts }) {
  const o = opts || {};
  const config = o.config || getProviderConfig(o.env);
  if (!config) throw new Error('No LLM provider configured.');
  if (config.error) throw new Error(config.error);
  const provider = (o.providers || PROVIDER_MODULES)[config.name];
  if (!provider) throw new Error(`No implementation for provider "${config.name}".`);
  const text = await provider.complete({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    system,
    user,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
  });
  return { text, config };
}

const OPPONENT_SYSTEM = `You are a debate opponent AND argument analyst. You argue the side given in "your_side" against the user's position on the motion.

STRICT RULES:
- First identify the user's ACTUAL argument from their words: the claim, any evidence offered, and the reasoning link. Quote or closely paraphrase — never invent arguments they did not make.
- Then attack its WEAKEST component only: unsupported claims, missing/weak evidence, broken reasoning, vague definitions, or an unanswered rebuttal.
- Your "attack" is 2-4 sentences in spoken style, as if said aloud in the debate. Engage their specific words. No generic lines like "interesting point, but...".
- Never judge accent, intelligence, or personality. Never comment on voice, emotion, or body language.
- Respond with JSON ONLY, no markdown fences, exactly this shape:
{
  "argument": { "claim": "...", "evidence": ["..."], "reasoning": "..." },
  "weakest_component": "claim | evidence | reasoning | rebuttal | definitions",
  "attack": "..."
}
Use "evidence": [] when they offered none — say so in the attack.`;

async function opponentReply({ motion, userSide, userTranscript, history, language }, opts) {
  const yourSide = userSide === 'for' ? 'against' : 'for';
  const recent = (history || []).slice(-6).map((h) => ({
    speaker: h.speaker,
    text: short(h.text, 800),
  }));
  const user = JSON.stringify({
    motion: motion.motion,
    context: motion.context,
    your_side: yourSide,
    user_transcript: short(userTranscript, 1500),
    prior_exchanges: recent,
  });
  const { text, config } = await callLLM({ system: OPPONENT_SYSTEM + '\n' + languageLine(language), user, opts });
  const validated = validateOpponent(parseJSON(text));
  return { ...validated, provider: config.name, model: config.model };
}

const DIAGNOSIS_SYSTEM = `You are a debate coach diagnosing a completed practice debate. You receive the motion, the sides, the full exchange, and measured delivery metrics per user turn.

STRICT RULES:
- Ground every claim in the exchange or metrics. Never invent arguments, quotes, or numbers.
- "scorecard" counts must reflect what actually happened: claims_made (distinct claims the user stated), claims_supported (claims backed by evidence or example), rebuttals_addressed (opponent points the user directly answered), rounds (user turns — use the exact number given).
- Distinguish measured delivery facts from argument interpretation.
- Give ONE clear retry focus. Its "targets" may name speech metric keys (wpm, fillerRatePer100, repeatCount, wordCount) when delivery is the issue, or debate keys (claim, evidence, reasoning, rebuttal, definitions) when argumentation is.
- Never judge accent, intelligence, or personality. Never claim voice/emotion/body-language measurement.
- Respond with JSON ONLY, no markdown fences, exactly this shape:
{
  "strengths": ["..."],
  "areas_to_improve": ["..."],
  "actionable_feedback": ["..."],
  "retry_focus": { "focus": "...", "targets": ["..."], "tip": "..." },
  "scorecard": { "claims_made": 0, "claims_supported": 0, "rebuttals_addressed": 0, "rounds": 0 }
}
1-3 items per list. Each item under 200 characters.`;

async function diagnoseDebate({ motion, userSide, exchanges, delivery, language }, opts) {
  const user = JSON.stringify({
    motion: motion.motion,
    user_side: userSide,
    rounds: exchanges.filter((e) => e.speaker === 'user').length,
    exchanges: (exchanges || []).map((e) => ({ speaker: e.speaker, text: short(e.text, 800) })),
    delivery_per_user_turn: delivery || [],
  });
  const { text, config } = await callLLM({ system: DIAGNOSIS_SYSTEM + '\n' + languageLine(language), user, opts });
  const validated = validateDiagnosis(parseJSON(text));
  return { ...validated, provider: config.name, model: config.model };
}

module.exports = { opponentReply, diagnoseDebate };
