// Coach-engine routing for M1.
//
// The UI lets the user pick 'ai' or 'rules' per attempt. This module routes
// accordingly and keeps the source truthful:
//
//   engine 'rules' → deterministic analyzer only, nothing else invoked.
//   engine 'ai', no frames → text LLM; any failure → rules fallback.
//   engine 'ai' + frames → vision SCREENER and text coach run IN PARALLEL;
//     visual notes merge into the text analysis; each side fails independently.
//
// Returns { analysis, coachSource: 'llm'|'rules'|'vision', requested,
//           fallback: true|false }. Coach functions are injected so tests can
// spy on them without network access.

async function analyzeAttemptForSession({ engine, prompt, transcript, metrics, previous, llmAnalyze, rulesAnalyze, visionAnalyze, visionScreen, frames }) {
  const requested = engine === 'rules' ? 'rules' : 'ai';
  if (requested === 'rules') {
    return { analysis: rulesAnalyze({ metrics }), coachSource: 'rules', requested, fallback: false };
  }
  // With camera frames, the vision SCREENER and the text coach run IN
  // PARALLEL: the screener reviews frames (best_frames + observable notes),
  // the text coach reasons over transcript+metrics. Notes merge into the
  // final analysis. Either side may fail independently:
  //   both ok      → text analysis + visual_notes (source vision/llm)
  //   vision fails → text analysis alone (source llm, silent)
  //   text fails   → rules analysis + visual_notes if any (fallback, truthful)
  //   both fail    → rules analysis (fallback, truthful)
  const usableFrames = Array.isArray(frames)
    ? frames.filter((f) => typeof f === 'string' && f.startsWith('data:image/')).slice(0, 4)
    : [];
  const runVision = usableFrames.length > 0 && visionScreen
    ? visionScreen({ frames: usableFrames }).then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: e && e.message ? e.message : String(e) })
    )
    : Promise.resolve({ ok: false, error: 'no frames' });
  const runText = llmAnalyze({ prompt, transcript, metrics, previous }).then(
    (a) => ({ ok: true, value: a }),
    (e) => ({ ok: false, error: e && e.message ? e.message : String(e) })
  );
  const [visionRes, textRes] = await Promise.all([runVision, runText]);
  const visualNotes = visionRes.ok && Array.isArray(visionRes.value.notes) ? visionRes.value.notes : [];
  if (textRes.ok) {
    return {
      analysis: { ...textRes.value, visual_notes: visualNotes },
      coachSource: visualNotes.length > 0 ? 'vision' : 'llm',
      requested,
      fallback: false,
    };
  }
  if (visionRes.ok && visualNotes.length > 0) {
    return {
      analysis: { ...rulesAnalyze({ metrics }), visual_notes: visualNotes },
      coachSource: 'vision',
      requested,
      fallback: true,
      fallbackReason: textRes.error,
    };
  }
  return {
    analysis: rulesAnalyze({ metrics }),
    coachSource: 'rules',
    requested,
    fallback: true,
    fallbackReason: textRes.error,
  };
}

module.exports = { analyzeAttemptForSession };
