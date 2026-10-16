import { FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { TrackingEngine } from "./trackingEngine.js";

let engine = null;

self.addEventListener("message", async ({ data: message }) => {
  if (message.type === "INIT") {
    try {
      const vision = await FilesetResolver.forVisionTasks(message.wasmBaseUrl, true);
      let instance = 0;
      const buffers = new Map();
      engine = new TrackingEngine(async (model, delegate) => {
        if (!buffers.has(model)) {
          const response = await fetch(model === "pose" ? message.poseModelUrl : message.handModelUrl);
          if (!response.ok) throw new Error(`Could not load the ${model} model (${response.status}).`);
          buffers.set(model, new Uint8Array(await response.arrayBuffer()));
        }
        const common = {
          baseOptions: { modelAssetBuffer: buffers.get(model), delegate },
          runningMode: "VIDEO",
          minTrackingConfidence: 0.5,
        };
        // The ES-module loader exports ModuleFactory via a global which MediaPipe
        // consumes. A distinct loader URL reruns that module for each instance;
        // the large WASM binary URL remains shared and cacheable.
        const loaderUrl = new URL(vision.wasmLoaderPath);
        loaderUrl.searchParams.set("instance", String(++instance));
        const fileset = { ...vision, wasmLoaderPath: loaderUrl.href };
        return model === "pose"
          ? PoseLandmarker.createFromOptions(fileset, {
              ...common, numPoses: 1, outputSegmentationMasks: false,
              minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
            })
          : HandLandmarker.createFromOptions(fileset, {
              ...common, numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.45,
            });
      });
      const status = await engine.initialize(message.model, message.backend);
      self.postMessage({ type: "READY", ...status });
    } catch (error) {
      engine?.close();
      self.postMessage({ type: "INIT_ERROR", error: error?.message || "Tracker could not load." });
    }
    return;
  }

  if (message.type === "WARMUP" || message.type === "DETECT") {
    try {
      if (!engine) throw new Error("Tracker is not ready.");
      const result = message.type === "WARMUP"
        ? engine.calibrate(message.bitmap, message.timestampMs)
        : await engine.detect(message.bitmap, message.timestampMs);
      self.postMessage({
        type: message.type === "WARMUP" ? "PREPARED" : "RESULT",
        ...result,
        generation: message.generation,
        requestId: message.requestId,
        timestampMs: message.timestampMs,
      });
    } catch (error) {
      self.postMessage({
        type: message.type === "WARMUP" ? "WARMUP_ERROR" : "DETECT_ERROR",
        generation: message.generation,
        requestId: message.requestId,
        error: error?.message || "Tracking failed.",
      });
    } finally {
      message.bitmap.close();
    }
    return;
  }

  if (message.type === "CLOSE") {
    engine?.close();
    engine = null;
    self.close();
  }
});
