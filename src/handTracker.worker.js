import { FaceDetector, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { getPalmCenter, MAX_HANDS } from "./handTrackingMath.js";

let landmarker = null;
let faceDetector = null;
let faceDetectorInitialization = null;
let faceTrackingEnabled = false;
let faceModelUrl = "";
let wasmBaseUrl = "";
let visionFilesetPromise = null;
let lastFaceDetectionAt = -Infinity;
let backend = "CPU";
const FACE_INTERVAL_MS = 1000 / 8;

function getVisionFileset() {
  if (!visionFilesetPromise) {
    visionFilesetPromise = FilesetResolver.forVisionTasks(wasmBaseUrl, true);
  }
  return visionFilesetPromise;
}

async function fetchModel(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} model failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function createLandmarker(wasmBaseUrl, modelUrl) {
  const modelBuffer = await fetchModel(modelUrl, "Hand tracking");
  const vision = await getVisionFileset();

  async function create(delegate) {
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode: "VIDEO",
      numHands: MAX_HANDS,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.55,
    });
  }

  try {
    landmarker = await create("GPU");
    backend = "GPU";
  } catch (gpuError) {
    console.info("GPU hand tracking unavailable; using CPU.", gpuError);
    landmarker = await create("CPU");
    backend = "CPU";
  }
}

async function ensureFaceDetector() {
  if (faceDetector) return faceDetector;
  if (faceDetectorInitialization) return faceDetectorInitialization;
  faceDetectorInitialization = (async () => {
    const modelBuffer = await fetchModel(faceModelUrl, "Face tracking");
    const vision = await getVisionFileset();
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate: "CPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.4,
      minSuppressionThreshold: 0.3,
    });
    self.postMessage({ type: "FACE_READY" });
    return faceDetector;
  })().catch((error) => {
    faceDetectorInitialization = null;
    self.postMessage({ type: "FACE_INIT_ERROR", error: error?.message || "Face tracker could not load." });
    return null;
  });
  return faceDetectorInitialization;
}

function normalizeFaceDetections(result, bitmap) {
  return result.detections.map((detection) => {
    const box = detection.boundingBox;
    if (!box) return null;
    return {
      x: (box.originX + box.width / 2) / bitmap.width,
      y: (box.originY + box.height / 2) / bitmap.height,
      width: box.width / bitmap.width,
      height: box.height / bitmap.height,
      confidence: detection.categories?.[0]?.score ?? 1,
    };
  }).filter(Boolean);
}

self.addEventListener("message", async (event) => {
  const message = event.data;

  if (message.type === "INIT") {
    try {
      wasmBaseUrl = message.wasmBaseUrl;
      faceModelUrl = message.faceModelUrl;
      faceTrackingEnabled = Boolean(message.faceTrackingEnabled);
      visionFilesetPromise = null;
      const faceInitialization = faceTrackingEnabled ? ensureFaceDetector() : Promise.resolve(null);
      await createLandmarker(message.wasmBaseUrl, message.modelUrl);
      self.postMessage({ type: "READY", backend });
      void faceInitialization;
    } catch (error) {
      self.postMessage({ type: "INIT_ERROR", error: error?.message || "Hand tracker could not load." });
    }
    return;
  }


  if (message.type === "SET_FACE_TRACKING") {
    faceTrackingEnabled = Boolean(message.enabled);
    lastFaceDetectionAt = -Infinity;
    if (faceTrackingEnabled) void ensureFaceDetector();
    return;
  }

  if (message.type === "DETECT") {
    if (!landmarker) {
      message.bitmap.close();
      self.postMessage({ type: "DETECT_ERROR", generation: message.generation, error: "Hand tracker is not ready." });
      return;
    }

    const startedAt = performance.now();
    try {
      const result = landmarker.detectForVideo(message.bitmap, message.timestampMs);
      const hands = result.landmarks.map((landmarks, index) => {
        const palm = getPalmCenter(landmarks);
        const handedness = result.handedness[index]?.[0];
        return {
          ...palm,
          label: handedness?.categoryName || `hand-${index}`,
          confidence: handedness?.score ?? 1,
        };
      }).filter((hand) => Number.isFinite(hand.x) && Number.isFinite(hand.y));
      let faces;
      let faceInferenceMs = 0;
      if (faceTrackingEnabled && faceDetector && message.timestampMs - lastFaceDetectionAt >= FACE_INTERVAL_MS) {
        const faceStartedAt = performance.now();
        const faceResult = faceDetector.detectForVideo(message.bitmap, message.timestampMs);
        faces = normalizeFaceDetections(faceResult, message.bitmap);
        faceInferenceMs = performance.now() - faceStartedAt;
        lastFaceDetectionAt = message.timestampMs;
      }
      self.postMessage({
        type: "RESULT",
        hands,
        faces,
        generation: message.generation,
        timestampMs: message.timestampMs,
        inferenceMs: performance.now() - startedAt,
        faceInferenceMs,
        backend,
      });
    } catch (error) {
      self.postMessage({ type: "DETECT_ERROR", generation: message.generation, error: error?.message || "Hand detection failed." });
    } finally {
      message.bitmap.close();
    }
  }

  if (message.type === "CLOSE") {
    landmarker?.close();
    faceDetector?.close();
    landmarker = null;
    faceDetector = null;
    self.close();
  }
});
