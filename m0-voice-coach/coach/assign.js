// Adaptive next-exercise assignment (Day 2).
//
// No mastery system, no scores: "what is currently weakest?" → the next
// exercise targeting it. Pure and deterministic, built on coach/profile.js.
//
// assignNext(attempts, excludePromptId?) ->
//   { prompt, reason, weakest, profile }
// - weakest: skill key ('pace'|'fillers'|'repeats'|'structure'|'substance') or null
// - reason: one plain sentence the UI shows next to the assignment.

const { PROMPTS, pickPrompt } = require('./prompts');
const { buildProfile, SKILLS } = require('./profile');

const SKILL_ISSUES = {
  pace: 'Pace control',
  fillers: 'Filler words',
  repeats: 'Restarts',
  structure: 'Sentence structure',
  substance: 'Answer fullness',
  pauses: 'Hesitation pauses',
  presence: 'Camera presence',
};

function promptsFor(skillKey, excludeId) {
  // Pause control has no dedicated drill: pace drills (land each ending
  // instead of stalling) train the same behavior.
  const tagKey = skillKey === 'pauses' ? 'pace' : skillKey;
  const tagged = PROMPTS.filter((p) => p.skills.includes(tagKey) && p.id !== excludeId);
  if (tagged.length === 0) return null;
  // Prefer focused drills (single-skill) over general exercises.
  const drills = tagged.filter((p) => p.skills.length === 1);
  const pool = drills.length > 0 ? drills : tagged;
  return pool[Math.floor(Math.random() * pool.length)];
}

function assignNext(attempts, excludePromptId) {
  const profile = buildProfile(attempts);
  if (profile.totalAttempts === 0) {
    const prompt = pickPrompt(excludePromptId);
    return {
      prompt,
      reason: 'Your first practice — a general exercise to establish a baseline.',
      weakest: null,
      profile,
    };
  }

  const ranked = profile.skills
    .filter((s) => s.total > 0)
    .map((s) => ({ ...s, rate: s.good / s.total }))
    .sort((a, b) => a.rate - b.rate || SKILLS.findIndex((s) => s.key === a.key) - SKILLS.findIndex((s) => s.key === b.key));

  const weakest = ranked.length > 0 ? ranked[0] : null;
  if (!weakest) {
    const prompt = pickPrompt(excludePromptId);
    return { prompt, reason: 'Not enough measurable data yet — a general exercise.', weakest: null, profile };
  }

  if (weakest.status === 'strength' && ranked.every((s) => s.status === 'strength')) {
    const prompt = promptsFor('substance', excludePromptId) || pickPrompt(excludePromptId);
    return {
      prompt,
      reason: `Solid mechanics across ${profile.totalAttempts} attempts — time to stretch with harder material.`,
      weakest: null,
      profile,
    };
  }

  const prompt = promptsFor(weakest.key, excludePromptId) || pickPrompt(excludePromptId);
  const bad = weakest.total - weakest.good;
  const verb = weakest.status === 'weakness' ? 'keeps showing up' : 'is worth sharpening';
  return {
    prompt,
    reason: `${SKILL_ISSUES[weakest.key]} ${verb} (${bad} of your last ${weakest.total} attempts) — this exercise targets it.`,
    weakest: weakest.key,
    profile,
  };
}

module.exports = { assignNext, SKILL_ISSUES };
