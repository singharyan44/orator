# Orator — Architecture

## The loop (the product)
```text
Challenge → Speak → Observe → Diagnose → Coach → Retry → Compare → Adapt
```

## TrainingEngine (shared by all three coaches)
```text
                    ┌─────────────── AssemblyAI ───────────────┐
                    │ Streaming STT · temp tokens · Turn events │
                    │ word timings · Terminate lifecycle        │
                    └───────────────┬──────────────────────────┘
                                    │ transcripts + timings
                    ┌───────────────┴──────────────────────────┐
                    │ Observation: AttemptRecorder (turn       │
                    │ boundaries) · metrics (pace, fillers,    │
                    │ repeats, structure, pauses)               │
                    └───────────────┬──────────────────────────┘
                                    │ structured attempt data
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
        SpeechCoach           DebateCoach          InterviewCoach
        rule/LLM/vision    opponent + diagnose   interviewer + diagnose
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │ { strengths, areas,
                                    │   actions, retry_focus }
                    ┌───────────────┴──────────────────────────┐
                    │ Diagnosis: deterministic compare (numbers│
                    │ never from LLM) · profile aggregation ·  │
                    │ weakest-link assignment                  │
                    └──────────────────────────────────────────┘
```

## Key invariants (enforced by tests)
1. **LLM never overrides numbers.** Metrics and comparisons are deterministic;
   the LLM only words the feedback. (`coach/__tests__` assert this.)
2. **No fake measurements.** Every claim traces to transcript/metrics/frames;
   missing data yields silence, never invention (`pausesMeasured` pattern).
3. **Truthful sourcing.** UI badges (`AI Coach` / `Rules Coach` / fallbacks)
   always reflect what actually produced the output.
4. **Stateless API.** Every request carries its context (`previous`,
   history); server memory is a local-dev convenience. Safe on serverless.
5. **Secrets stay server-side.** Browser receives temporary tokens only.

## Module map (`m0-voice-coach/`)
- `server/index.js` — Express: static + `/token`, `/api/voice-token`,
  coaching/debate/interview endpoints, health. Exports `app` for serverless.
- `coach/metrics.js` — measured speech metrics (incl. word-timing pauses).
- `coach/analyze.js` — deterministic rules analyzer (swappable interface).
- `coach/llm-analyze.js` + `coach/llm/` — OpenRouter/Groq chat layer.
- `coach/vision.js` — opt-in camera frames → visual notes (fallback chain).
- `coach/coach-engine.js` — routing: rules / AI / vision → fallback.
- `coach/compare.js` — deterministic verdicts with noise bands.
- `coach/profile.js` + `coach/assign.js` — personal profile, next exercise.
- `coach/session.js` — in-memory store (capped; M2 persistence hook).
- `coach/debate*.js`, `coach/interview*.js`, `coach/voice-opponent.js` —
  mode logic, contracts, fallbacks.
- `coach/health.js`, `coach/prompts.js`, `coach/sample-text.js`.
- `public/` — `script.js` (speech), `debate.js`, `voice-debate.js`,
  `interview.js` (modes); `attempt-recorder.js`, `stats.js`,
  `export-text.js` (tested shared modules); `pcm-processor.js` (16 kHz
  chunked capture); `style.css`, `manifest.json`, PWA icons.
- `coach/tests.js` (159 unit tests), `coach/dom-check.js` (UI structure),
  `coach/fuzz.js` (hostile-input robustness).

## Data flow: one speech attempt
Browser mic → 16 kHz PCM16 binary frames (100 ms, real-time paced) →
AssemblyAI Streaming → interim/final Turns → recorder waits for the
end-of-turn boundary → POST attempt (+previous, +frames) → metrics →
vision→LLM→rules chain → analysis + inline comparison → feedback render →
history/profile/assignment refresh.
