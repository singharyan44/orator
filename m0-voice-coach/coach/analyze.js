// Coaching analyzer for M1.
//
// Public interface (this is the seam an LLM provider can implement later):
//
//   analyzeAttempt({ metrics }) -> {
//     metrics,
//     observations,        // transcript-derived notes, each tagged measured/derived
//     strengths,           // specific, number-grounded
//     areas_to_improve,    // specific, number-grounded
//     actionable_feedback, // concrete things to do next attempt
//     retry_focus          // { focus, targets:[metricKeys], tip } — single priority
//   }
//
// M1 implementation is rule-based and deterministic: it only reports what the
// measured metrics support. It never claims vocal confidence, pitch quality,
// emotion, or body language.

const WPM_LOW = 100;
const WPM_HIGH = 170;

function analyzeAttempt({ metrics }) {
  const m = metrics;
  const strengths = [];
  const areas = [];
  const actions = [];
  const observations = [];

  const push = (list, text) => { if (text && !list.includes(text)) list.push(text); };

  // ---- Pace (needs a valid duration; otherwise say so honestly) ----
  if (m.wpm == null) {
    observations.push({ type: 'derived', text: 'No timing data, so pace could not be measured this attempt.' });
  } else if (m.wpm < WPM_LOW) {
    push(areas, `Slow pace at ${m.wpm} words per minute (conversational range is roughly ${WPM_LOW}–${WPM_HIGH}). Short pauses between ideas will sound more natural than stretching each word.`);
    push(actions, 'Aim for a steadier pace: finish each sentence, take one short breath, then start the next.');
  } else if (m.wpm <= WPM_HIGH) {
    push(strengths, `Steady, easy-to-follow pace at ${m.wpm} words per minute.`);
  } else if (m.wpm <= 200) {
    push(areas, `Brisk pace at ${m.wpm} words per minute — listeners may struggle to keep up.`);
    push(actions, 'Slow down deliberately: pause for a beat at each comma and period.');
  } else {
    push(areas, `Rushed delivery at ${m.wpm} words per minute — well above conversational pace.`);
    push(actions, 'Cut your speed by about a third: land each sentence ending before starting the next thought.');
  }

  // ---- Fillers ----
  if (m.fillerCount === 0 && m.wordCount > 0) {
    push(strengths, 'Clean delivery with zero filler words detected.');
  } else if (m.fillerRatePer100 <= 3) {
    observations.push({ type: 'measured', text: `Only ${m.fillerCount} filler word${m.fillerCount === 1 ? '' : 's'} in ${m.wordCount} words — within a normal range.` });
  } else {
    const top = m.fillersFound.slice(0, 2).map((f) => `"${f.phrase}" ×${f.count}`).join(', ');
    push(areas, `${m.fillerCount} filler words (${m.fillerRatePer100} per 100 words), mostly ${top}.`);
    push(actions, `Replace fillers with silence: when you feel "${m.fillersFound[0].phrase}" coming, just pause instead.`);
  }

  // ---- Repeats / restarts ----
  if (m.repeatCount === 0 && m.wordCount > 0) {
    push(strengths, 'No repeated or restarted words — each word came out once, cleanly.');
  } else if (m.repeatCount <= 2) {
    push(areas, `${m.repeatCount} small repeat${m.repeatCount === 1 ? '' : 's'} (${m.repeatExamples.join(', ')}) — barely noticeable, but worth smoothing out.`);
    push(actions, 'If you stumble on a word, keep going forward instead of repeating it.');
  } else {
    push(areas, `${m.repeatCount} repeated words (${m.repeatExamples.join(', ')}). Restarts make delivery sound uncertain.`);
    push(actions, 'Rule for the retry: never say a word twice — push through mistakes without going back.');
  }

  // ---- Structure ----
  if (m.longSentenceCount > 0) {
    push(areas, `${m.longSentenceCount} overlong sentence${m.longSentenceCount === 1 ? '' : 's'} (over 25 words). Long sentences run out of breath and lose the listener.`);
    push(actions, 'Break long thoughts in two: say the point, stop, then add the detail as a new sentence.');
  }
  if (m.fragmentCount >= 2) {
    push(areas, `${m.fragmentCount} unfinished fragments — thoughts that trailed off without an ending.`);
    push(actions, 'Finish every thought: each sentence needs an ending, even a short one.');
  }
  if (m.sentenceCount > 0 && m.longSentenceCount === 0 && m.fragmentCount === 0) {
    push(strengths, `${m.sentenceCount} complete, well-sized sentence${m.sentenceCount === 1 ? '' : 's'} (average ${m.avgSentenceLen} words).`);
  }

  // ---- Substance / delivery shape ----
  if (m.wordCount === 0) {
    push(areas, 'No speech detected in this attempt.');
  } else if (m.wordCount < 8) {
    push(areas, `Very short attempt (${m.wordCount} words) — too little material to coach on.`);
    push(actions, 'Say at least 2–3 full sentences so there is something real to work with.');
  }
  if (m.turnCount >= 4 && m.avgWordsPerTurn > 0 && m.avgWordsPerTurn < 8) {
    push(areas, `Fragmented delivery: speech arrived in ${m.turnCount} short bursts averaging ${m.avgWordsPerTurn} words.`);
    push(actions, 'Speak in fuller stretches — finish a whole idea before pausing long enough to split it.');
  } else if (m.turnCount > 0 && m.turnCount <= 3 && m.wordCount >= 20) {
    push(strengths, 'Sustained delivery — ideas came out in complete stretches, not scattered bursts.');
  }
  if (m.hesitationCount > 0) {
    observations.push({ type: 'measured', text: `${m.hesitationCount} hesitation marker${m.hesitationCount === 1 ? '' : 's'} ("--" / "...") in the transcript.` });
  }

  // ---- Pauses (measured from AssemblyAI word timings, not guessed) ----
  if (m.wordCount > 0 && m.pausesMeasured) {
    if ((m.pauseCount || 0) === 0) {
      push(strengths, 'No hesitation pauses — steady flow from start to finish (measured from word timings).');
    } else if (m.pauseCount >= 3) {
      const longest = m.longestPauseMs >= 1000 ? `, longest ${(m.longestPauseMs / 1000).toFixed(1)}s` : '';
      push(areas, `${m.pauseCount} hesitation pauses over 0.7s${longest} — the delivery stalls mid-thought.`);
      push(actions, 'When you feel a stall coming, land the sentence you are on instead of holding silence, then start fresh.');
    } else {
      observations.push({ type: 'measured', text: `${m.pauseCount} brief hesitation pause${m.pauseCount === 1 ? '' : 's'} — within a normal range.` });
    }
  }

  // ---- Camera presence (measured landmark geometry, not guessed) ----
  const vis = m.visualMeasured ? m.visual : null;
  if (vis) {
    if (vis.faces < vis.frames) {
      observations.push({ type: 'measured', text: `Your face was visible in ${vis.faces} of ${vis.frames} camera frames — check framing so the coach can see you.` });
    } else if (vis.frames >= 2 && vis.lookingDown === 0 && vis.headTurned === 0) {
      push(strengths, 'Steady camera presence — facing forward in every frame.');
    }
    if (vis.lookingDown >= 2) {
      push(areas, `Looking down in ${vis.lookingDown} of ${vis.frames} frames — notes or screen? Lift your gaze to the camera.`);
      push(actions, 'Put notes at camera height and glance, don’t read — return your eyes to the lens each sentence.');
    } else if (vis.eyesClosed >= 2) {
      observations.push({ type: 'measured', text: `Eyes mostly closed in ${vis.eyesClosed} of ${vis.frames} frames — often means reading down, not blinking.` });
    }
  }

  // ---- Retry focus: single priority, highest-signal issue first ----
  let retryFocus;
  if (m.wordCount < 8) {
    retryFocus = {
      focus: 'Say more — at least 2–3 full sentences.',
      targets: ['wordCount'],
      tip: 'More material gives the coach something real to respond to.',
    };
  } else if (m.fillerRatePer100 > 3) {
    retryFocus = {
      focus: `Cut filler words (currently ${m.fillerRatePer100} per 100 words).`,
      targets: ['fillerRatePer100'],
      tip: `Pause silently instead of saying "${m.fillersFound[0].phrase}".`,
    };
  } else if (m.wpm != null && (m.wpm < WPM_LOW || m.wpm > WPM_HIGH)) {
    retryFocus = {
      focus: m.wpm < WPM_LOW ? 'Pick up the pace slightly.' : 'Slow down and land your endings.',
      targets: ['wpm'],
      tip: `Conversational pace is roughly ${WPM_LOW}–${WPM_HIGH} wpm; you were at ${m.wpm}.`,
    };
  } else if (m.repeatCount > 0) {
    retryFocus = {
      focus: 'Zero repeated words — push forward through stumbles.',
      targets: ['repeatCount'],
      tip: 'Never go back to re-say a word; keep moving to the next one.',
    };
  } else if (m.visualMeasured && m.visual.lookingDown >= 2) {
    retryFocus = {
      focus: 'Eyes up — stop reading down mid-speech.',
      targets: [],
      tip: 'Notes at camera height; return your gaze to the lens every sentence.',
    };
  } else if (m.pausesMeasured && (m.pauseCount || 0) >= 3) {
    retryFocus = {
      focus: `Fewer mid-thought stalls (currently ${m.pauseCount} hesitation pauses).`,
      targets: ['pauses'],
      tip: 'End the sentence you are on instead of holding silence, then start fresh.',
    };
  } else if (m.longSentenceCount > 0 || m.fragmentCount >= 2) {
    retryFocus = {
      focus: 'Complete, medium-sized sentences.',
      targets: ['longSentenceCount', 'fragmentCount'],
      tip: 'One idea per sentence, and finish every sentence you start.',
    };
  } else {
    retryFocus = {
      focus: 'Stretch further — add one more idea or example.',
      targets: ['wordCount'],
      tip: 'The mechanics are solid; now add substance and variety.',
    };
  }

  return {
    metrics: m,
    observations,
    strengths: strengths.slice(0, 3),
    areas_to_improve: areas.slice(0, 3),
    actionable_feedback: actions.slice(0, 3),
    retry_focus: retryFocus,
  };
}

module.exports = { analyzeAttempt, WPM_LOW, WPM_HIGH };
