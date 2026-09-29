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
  BLAZE_URL: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
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
  // Coarse observations (native box fallback) prove presence only — gaze
  // fields on them are defaults, never measurements, so gaze counts skip them.
  const fine = list.filter((o) => o && o.face && !o.coarse);
  return {
    frames: list.length,
    faces: list.filter((o) => o && o.face).length,
    lookingDown: fine.filter((o) => o.pitch === 'down').length,
    headTurned: fine.filter((o) => o.yaw !== 'center').length,
    eyesClosed: fine.filter((o) => !o.eyesOpen).length,
  };
}

let landmarkerPromise = null;

// Loads the MediaPipe bundle + face model from CDN (throws on failure so
// callers degrade to transcript-only coaching). Cached after first load.
// IMAGE running mode + canvas snapshots: the single path that works for live
// video, stills, and test patterns alike (calling VIDEO-mode methods fails
// on some bundle builds with "must be set to IMAGE").
async function ensureEstimator() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const mod = await import(/* webpackIgnore: true */ MP.BUNDLE_URL);
    const vision = await mod.FilesetResolver.forVisionTasks(MP.WASM_URL);
    const lm = await mod.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MP.FACE_MODEL_URL },
      runningMode: 'IMAGE',
      numFaces: 1,
      // Lowered from the 0.5 default: dim rooms, small faces, and glasses
      // sit near the default cutoff. False positives are cheap here (a
      // stray box is visible on the overlay); misses are expensive.
      minFaceDetectionConfidence: 0.3,
    });
    return lm;
  })().catch((e) => {
    landmarkerPromise = null;
    throw e;
  });
  return landmarkerPromise;
}

function extractFaces(res) {
  const faces = res && res.faceLandmarks;
  if (!faces || !faces.length) return null;
  return faces[0];
}

// Detect on a <video>, canvas, or image. Video elements are snapshotted to
// an offscreen canvas first (capped at 480px wide): IMAGE-mode detect() on
// a canvas is the well-trodden path, direct video detection is not.
// Returns landmarks array or null. Never throws for bad input (null);
// model-load failures DO throw so callers can report them.
async function estimateVideo(source) {
  const lm = await ensureEstimator();
  let target = source;
  try {
    if (source && source.tagName === 'VIDEO') {
      const snap = snapshotVideo(source, 640);
      if (!snap) return null;
      target = snap;
    }
    return extractFaces(await lm.detect(target));
  } catch (e) {
    if (source && source.tagName === 'VIDEO') return null;
    throw e;
  }
}

// ---- BlazeFace short-range: independent second opinion ----
// A different model answering the same question isolates landmarker-file
// issues from environmental ones: if BlazeFace sees a face the landmarker
// misses, the landmarker setup is at fault; if both miss, suspect the
// input/lighting. Bounding box only (presence + rough position).
let blazePromise = null;

async function ensureBlaze() {
  if (blazePromise) return blazePromise;
  blazePromise = (async () => {
    const mod = await import(/* webpackIgnore: true */ MP.BUNDLE_URL);
    const vision = await mod.FilesetResolver.forVisionTasks(MP.WASM_URL);
    const det = await mod.FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MP.BLAZE_URL },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.3,
    });
    return det;
  })().catch((e) => {
    blazePromise = null;
    throw e;
  });
  return blazePromise;
}

// Returns a normalized {x,y,width,height} box (0..1) or null. Throws on
// load failure so callers can report it; returns null when simply empty.
async function detectBlaze(canvas) {
  const det = await ensureBlaze();
  const res = await det.detect(canvas);
  const list = res && res.detections;
  if (!list || !list.length || !list[0].boundingBox) return null;
  const b = list[0].boundingBox;
  const w = canvas.width || 1, h = canvas.height || 1;
  return {
    x: (b.originX || 0) / w,
    y: (b.originY || 0) / h,
    width: (b.width || 0) / w,
    height: (b.height || 0) / h,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { faceObservation, summarizeObservations, ensureEstimator, estimateVideo, estimateBox, nativeFaceAvailable, snapshotVideo, ensureBlaze, detectBlaze, MP, IDX };
}

// Snapshot a <video> to an offscreen canvas (capped width). Returns the
// canvas, or null when the video has no current frame. Exported so the UI
// can SHOW the exact pixels the detector receives (decisive debugging).
function snapshotVideo(source, maxW) {
  try {
    if (!source || source.tagName !== 'VIDEO') return null;
    if (!source.videoWidth || (typeof source.readyState === 'number' && source.readyState < 2)) return null;
    const scale = Math.min(1, (maxW || 640) / source.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(source.videoWidth * scale));
    c.height = Math.max(2, Math.round(source.videoHeight * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  } catch (e) {
    return null;
  }
}

// ---- Native OS face detection (Chrome/Edge Shape Detection API) ----
// Zero downloads, zero models to fetch: the browser asks the OS. Output is
// a bounding box only — enough for PRESENCE, never gaze/eyes. Used as the
// fallback when MediaPipe yields nothing, and reported as such.

function nativeFaceAvailable() {
  try {
    return typeof FaceDetector !== 'undefined';
  } catch (e) {
    return false;
  }
}

let nativeDetector = null;

async function estimateBox(source) {
  if (!nativeFaceAvailable()) return null;
  try {
    if (!nativeDetector) nativeDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await nativeDetector.detect(source);
    if (!faces || !faces.length || !faces[0].boundingBox) return null;
    const b = faces[0].boundingBox;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch (e) {
    return null;
  }
}
