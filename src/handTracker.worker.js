import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { getPalmCenter } from "./handTrackingMath.js";

let landmarker = null;
let backend = "CPU";

async function createLandmarker(wasmBaseUrl, modelUrl) {
  const modelBuffer = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());

  async function create(delegate) {
    const vision = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode: "VIDEO",
      numHands: 2,
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

self.addEventListener("message", async (event) => {
  const message = event.data;

  if (message.type === "INIT") {
    try {
      await createLandmarker(message.wasmBaseUrl, message.modelUrl);
      self.postMessage({ type: "READY", backend });
    } catch (error) {
      self.postMessage({ type: "INIT_ERROR", error: error?.message || "Hand tracker could not load." });
    }
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
      self.postMessage({
        type: "RESULT",
        hands,
        generation: message.generation,
        timestampMs: message.timestampMs,
        inferenceMs: performance.now() - startedAt,
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
    landmarker = null;
    self.close();
  }
});
