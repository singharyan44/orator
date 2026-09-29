// Orator vision worker: runs MediaPipe face inference OFF the main thread.
// Loaded via `new Worker('vision-worker.js', { type: 'module' })` from script.js.
// Same models/endpoints as the main-thread path in pose-est.js; this file only
// moves the blocking detect() calls off the UI thread. Falls back to the
// main-thread path automatically when workers are unavailable, so the page
// keeps working everywhere. Main thread sends { id, bitmap } (transferred
// ImageBitmap of a video frame or test canvas) and receives
// { id, ok, landmarks|null, box|null, ms, error? }.
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const FACE_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const BLAZE_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let visionNs = null;
let landmarker = null;
let blaze = null;
// GPU-first like the main thread (WebGL delegate; CUDA/ROCm do not exist
// inside a web page). If the worker's GL context fails, we silently fall
// back to WASM CPU — inference stays correct, just slower. The active
// delegate rides back on every response so the UI can report it.
let workerDelegate = 'CPU';

async function ensureAll() {
  if (!visionNs) visionNs = await import(VISION_URL);
  const fileset = await visionNs.FilesetResolver.forVisionTasks(WASM_URL);
  if (!landmarker) {
    const makeOpts = (delegate) => ({
      baseOptions: { modelAssetPath: FACE_URL, delegate },
      runningMode: 'IMAGE',
      numFaces: 1,
      minFaceDetectionConfidence: 0.3,
    });
    try {
      landmarker = await visionNs.FaceLandmarker.createFromOptions(fileset, makeOpts('GPU'));
      workerDelegate = 'GPU';
    } catch (e) {
      landmarker = await visionNs.FaceLandmarker.createFromOptions(fileset, makeOpts('CPU'));
      workerDelegate = 'CPU';
    }
  }
  if (!blaze) {
    try {
      blaze = await visionNs.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: BLAZE_URL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.3,
      });
    } catch (e) {
      blaze = await visionNs.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: BLAZE_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.3,
      });
    }
  }
}

onmessage = async (e) => {
  const msg = e.data || {};
  const id = msg.id;
  const bitmap = msg.bitmap;
  if (id == null || !bitmap) return;
  const started = Date.now();
  try {
    await ensureAll();
    let landmarks = null;
    let box = null;
    try {
      const lr = landmarker.detect(bitmap);
      landmarks = (lr.faceLandmarks && lr.faceLandmarks[0]) || null;
    } catch (_) {
      landmarks = null;
    }
    if (!landmarks) {
      try {
        const br = blaze.detect(bitmap);
        const det = br.detections && br.detections[0];
        const b = det && det.boundingBox;
        if (b) {
          // BlazeFace boxes are in input-image pixels; main thread normalizes.
          box = {
            x: b.originX || 0,
            y: b.originY || 0,
            width: b.width || 0,
            height: b.height || 0,
            bw: bitmap.width || 1,
            bh: bitmap.height || 1,
          };
        }
      } catch (_) {
        box = null;
      }
    }
    postMessage({ id, ok: true, landmarks, box, ms: Date.now() - started, delegate: workerDelegate });
  } catch (err) {
    postMessage({ id, ok: false, landmarks: null, box: null, ms: Date.now() - started, delegate: workerDelegate, error: String((err && err.message) || err) });
  } finally {
    try {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    } catch (_) { /* noop */ }
  }
};
