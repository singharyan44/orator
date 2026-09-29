// On-device face measurement via MediaPipe Tasks Vision (no API key, no
// quota, works offline after first load). Only the FACE landmark model is
// used: it carries the coaching-relevant signals (gaze direction, eye
// openness); full-body pose adds failure surface for little coaching value.
//
// What this produces is MEASURED geometry, not model opinion:
//   per frame: { face, yaw: left|right|center, pitch: up|down|level, eyesOpen }
//   summary:   { frames, faces, lookingDown, headTurned, eyesClosed }
// Thresholds are approximate and documented as such; the analyzer treats
// them as training signals, never as diagnoses.
//
// MediaPipe pieces (window-only) are isolated in ensureEstimator() /
// estimateVideo(). The pure geometry (faceObservation, summarizeObservations)
// is unit-tested with synthetic landmarks. UMD for tests.

const MP = {
  VERSION: '0.10.20',
  BUNDLE_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs',
  WASM_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm',
  FACE_MODEL_URL: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

// MediaPipe face-mesh indices (478-point model, normalized 0..1 coords).
const IDX = {
  nose: 1,
  eyeLOuter: 33, eyeLInner: 133, eyeLTop: 159, eyeLBottom: 145,
  eyeROuter: 263, eyeRInner: 362, eyeRTop: 386, eyeRBottom: 374,
  mouthTop: 13, mouthBottom: 14,
};

// Approximate thresholds (documented, not scientific claims).
const YAW_T = 0.12;   // |nose.x - eyeCenter| / eyeWidth beyond this = turned
const PITCH_DOWN = 0.62; // nose.y fraction down eye->mouth line = looking down
const PITCH_UP = 0.38;   // ... = looking up
const EAR_T = 0.18;   // mean eye-aspect-ratio below this = eyes mostly closed

function faceObservation(lm) {
  if (!Array.isArray(lm) || lm.length < 468) return { face: false };
  const P = (i) => lm[i];
  for (const k of ['nose', 'eyeLOuter', 'eyeLInner', 'eyeROuter', 'eyeRInner', 'eyeLTop', 'eyeLBottom', 'eyeRTop', 'eyeRBottom', 'mouthTop', 'mouthBottom']) {
    const p = P(IDX[k]);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { face: false };
  }
  return faceObservationInner(P);
}

function faceObservationInner(P) {
  const eyeMidX = (P(IDX.eyeLOuter).x + P(IDX.eyeLInner).x + P(IDX.eyeROuter).x + P(IDX.eyeRInner).x) / 4;
  const eyeMidY = (P(IDX.eyeLOuter).y + P(IDX.eyeLInner).y + P(IDX.eyeROuter).y + P(IDX.eyeRInner).y) / 4;
  const eyeW = Math.hypot(P(IDX.eyeROuter).x - P(IDX.eyeLOuter).x, P(IDX.eyeROuter).y - P(IDX.eyeLOuter).y) || 1e-6;
  const yaw = (P(IDX.nose).x - eyeMidX) / eyeW;
  const mouthMidY = (P(IDX.mouthTop).y + P(IDX.mouthBottom).y) / 2;
  const pitch = (P(IDX.nose).y - eyeMidY) / ((mouthMidY - eyeMidY) || 1e-6);
  const earL = Math.abs(P(IDX.eyeLTop).y - P(IDX.eyeLBottom).y) / (Math.abs(P(IDX.eyeLInner).x - P(IDX.eyeLOuter).x) || 1e-6);
  const earR = Math.abs(P(IDX.eyeRTop).y - P(IDX.eyeRBottom).y) / (Math.abs(P(IDX.eyeRInner).x - P(IDX.eyeROuter).x) || 1e-6);
  const ear = (earL + earR) / 2;
  return {
    face: true,
    yaw: Math.abs(yaw) > YAW_T ? (yaw > 0 ? 'right' : 'left') : 'center',
    pitch: pitch > PITCH_DOWN ? 'down' : pitch < PITCH_UP ? 'up' : 'level',
    eyesOpen: ear >= EAR_T,
  };
}

function summarizeObservations(obs) {
  const list = Array.isArray(obs) ? obs : [];
  return {
    frames: list.length,
    faces: list.filter((o) => o && o.face).length,
    lookingDown: list.filter((o) => o && o.face && o.pitch === 'down').length,
    headTurned: list.filter((o) => o && o.face && o.yaw !== 'center').length,
    eyesClosed: list.filter((o) => o && o.face && !o.eyesOpen).length,
  };
}

let landmarkerPromise = null;

// Loads the MediaPipe bundle + face model from CDN (throws on failure so
// callers degrade to transcript-only coaching). Cached after first load.
async function ensureEstimator() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const mod = await import(/* webpackIgnore: true */ MP.BUNDLE_URL);
    const vision = await mod.FilesetResolver.forVisionTasks(MP.WASM_URL);
    const lm = await mod.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MP.FACE_MODEL_URL },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    return lm;
  })().catch((e) => {
    landmarkerPromise = null;
    throw e;
  });
  return landmarkerPromise;
}

// Detect on a <video> (or canvas/image). Returns landmarks array or null.
async function estimateVideo(source) {
  const lm = await ensureEstimator();
  const res = await lm.detect(source);
  const faces = res && res.faceLandmarks;
  if (!faces || !faces.length) return null;
  return faces[0];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { faceObservation, summarizeObservations, ensureEstimator, estimateVideo, MP, IDX };
}
