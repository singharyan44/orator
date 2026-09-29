# Orator — 9-Day Milestone Plan (v3)

Context: **lablab AssemblyAI hackathon**. Thesis (the product): **the training
loop itself** — Challenge → Speak → Observe → Diagnose → Coach → Retry →
Measure improvement → Adapt the next challenge. Not "AI analyzes your voice."

Target, precisely: **not the whole AI communication platform — enough of the
adaptive training engine that someone experiences why the larger platform
should exist.** (The practice→feedback→retry→adapt loop already appears in
products like Debatable/LogiCoach, so the differentiator must be the
*adaptation over sessions*, not merely having an AI debate mode.)

Budget honesty: M1 cost ~10–12 focused hours. The remaining days are NOT 8×
that — context switching, debugging, deployment, and complexity eat time.
Plan for ~25–30 focused hours total: enough for a serious jump to a
convincing adaptive prototype.

Day 0 (done): M1 Speech Coach loop + deployment + profile-lite memory.
We have 9 days total (Day 0 banked + 8 ahead).

## Shared architecture (the real product)
```text
TrainingEngine  (Challenge → Respond → Observe → Diagnose →
                 Coach → Retry → Compare → Next challenge)
├── SpeechCoach   ✅ live
├── DebateCoach   ← Days 3–5
└── InterviewCoach ← stretch only (possible, not built)
```
Every mode reuses: AssemblyAI streaming transport, AttemptRecorder boundary
semantics, metrics, coach-engine routing (AI/Rules), deterministic compare,
profile aggregation.

## Day 1 — Memory ✅ DONE
History (localStorage) + `coach/profile.js` (strengths / recurring
weaknesses / top focus / trends) + History + Profile panels.

## Day 2 — Adaptation ✅ DONE (no mastery system, just weakest-link)
- `coach/assign.js`: weakest skill → targeted prompt (drills preferred) +
  one-sentence reason citing the counts. 12-prompt library tagged by skill.
- `POST /api/assign` (stateless) + sessions accept `promptId`.
- UI: "Up next — assigned for you" card + Practice-this flow.
- Validated: 97/97 unit tests, DOM check, live assign + promptId session.

## Days 3–5 — Debate Coach v1 ✅ DONE (training partner, NOT sparring bot)
- Loop: argue (voice) → opponent identifies the argument → attacks weakest
  component → respond → diagnose → rematch with swapped sides.
- Reuses TrainingEngine: recorder boundaries, speech metrics per turn, AI/Rules
  routing, truthful fallback (stock challenges), deterministic rules diagnosis.
- UI: Speech/Debate mode tabs, motion picker + side picker, thread, scorecard.
- Validated: 111/111 unit tests (contracts, fallback, mocked LLM), DOM check,
  live motions/opponent/diagnose + 400 guards.

## Day 6 — Integration + demo path ✅ DONE (not mobile polish)
- Journey strip under the header; comparison → "Continue in Debate";
  diagnosis → "Train this in Speech Coach" (shown when retry targets
  delivery skills); assignment refreshes after diagnosis (debate turns feed
  the profile). Validated: 111/111 tests, DOM check.

## Day 7 — Demo prep + hardening
90-second script following the Day 6 journey, dry runs, every fallback path.

## Day 8 — Buffer (the +1 day)
Whatever is on fire. If nothing is: Interview Coach spike (engine is ready)
or visual polish. Submit at end of day. 🎉

## Explicitly OUT
Full curriculum math, native apps, auth/payments, hand-rolled audio DSP.

## Multimodal ✅ SHIPPED as on-device measurement (better than planned)
- Replaced the OpenRouter vision screener (free quota permanently dry)
  with MediaPipe face landmarks running 100% in-browser: gaze direction,
  eye openness, presence — measured geometry, not model opinion.
- No key, no quota, no uploads; mic/camera device pickers; vision
  self-test button; presence skill in profile; drill fallback routing.

## Standing rules
I build, you test + paste logs. Deterministic metrics/compare stay; LLM
never overrides numbers. Scope creep waits. AssemblyAI stays the
speech layer in every mode (hackathon track alignment).
