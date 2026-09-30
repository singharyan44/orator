// Voice-opponent persona for the AssemblyAI Voice Agent API (spoken debate).
//
// The voice agent carries the CONVERSATION (it talks); measurement stays on
// the Realtime/analysis side. This module only builds the inline session
// config — no audio, no sockets. Pure and unit-tested.

const { languageLine, langEntry } = require('./language');

function buildVoiceOpponentPrompt(motion, userSide, language) {
  const opponentSide = userSide === 'for' ? 'AGAINST' : 'FOR';
  const entry = langEntry(language);
  const system_prompt =
    `You are a debate opponent in a live voice debate about: "${motion.motion}" (${motion.context}). ` +
    `The human argues ${userSide.toUpperCase()}; you argue ${opponentSide}. ` +
    `Listen to each argument, identify its actual claim and any evidence offered, then attack ONLY its weakest component: ` +
    `unsupported claims, missing or weak evidence, broken reasoning, vague definitions, or an unanswered rebuttal. ` +
    `Engage their specific words — never generic lines. Keep every reply to 1–3 short spoken sentences. ` +
    `Never comment on voice, accent, emotion, appearance, or personality. Never break character to explain the format. ` +
    languageLine(language) + ` (Your greeting below stays in English; every reply after it in ${entry.name}.)`;
  const greeting =
    `Let's debate. You are ${userSide}, I am ${opponentSide === 'FOR' ? 'for' : 'against'} "${motion.motion}". Make your opening case.`;
  return { system_prompt, greeting };
}

module.exports = { buildVoiceOpponentPrompt };
