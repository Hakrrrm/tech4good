import {
  MAX_HANDS,
  presentFaceSlots,
  presentHandSlots,
  updateFaceSlots,
  updateHandSlots,
} from "./handTrackingMath.js";

const TRACKING_WIDTH = 384;
const TRACKING_HEIGHT = 216;
const TARGET_FRAME_INTERVAL_MS = 1000 / 24;

export class HandTracker {
  constructor(video, onHands, onStatus) {
    this.video = video;
    this.onHands = onHands;
    this.onStatus = onStatus;
    this.worker = null;
    this.initialization = null;
    this.resolveInitialization = null;
    this.rejectInitialization = null;
    this.running = false;
    this.inFlight = false;
    this.frameCallbackId = null;
    this.captureAnimationId = null;
    this.presentationAnimationId = null;
    this.lastPresentationTime = 0;
    this.lastCaptureTime = -Infinity;
    this.lastVideoTime = -1;
    this.slots = Array(MAX_HANDS).fill(null);
    this.presentedSlots = Array(MAX_HANDS).fill(null);
    this.faceSlots = [null, null];
    this.faceTrackingEnabled = false;
    this.faceTrackingReady = false;
    this.generation = 0;
  }

  initialize() {
    if (this.initialization) return this.initialization;
    this.worker = new Worker(new URL("./handTracker.worker.js", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.rejectInitialization?.(new Error(event.message || "Hand tracker worker failed."));
      this.onStatus({ type: "error", message: event.message || "Hand tracker stopped." });
    });

    this.initialization = new Promise((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
    });

    const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
    this.worker.postMessage({
      type: "INIT",
      wasmBaseUrl: new URL("wasm", baseUrl).href,
      modelUrl: new URL("models/hand_landmarker.task", baseUrl).href,
      faceModelUrl: new URL("models/blaze_face_short_range.tflite", baseUrl).href,
      faceTrackingEnabled: this.faceTrackingEnabled,
    });
    return this.initialization;
  }

  handleMessage(message) {
    if (message.type === "READY") {
      this.resolveInitialization?.(message.backend);
      this.onStatus({ type: "ready", backend: message.backend });
      return;
    }
    if (message.type === "INIT_ERROR") {
      this.rejectInitialization?.(new Error(message.error));
      return;
    }
    if (message.type === "FACE_READY") {
      this.faceTrackingReady = true;
      this.onStatus({ type: "face-ready" });
      return;
    }
    if (message.type === "FACE_INIT_ERROR") {
      this.faceTrackingReady = false;
      this.onStatus({ type: "face-error", message: message.error });
      return;
    }
    if (message.type === "RESULT") {
      if (message.generation !== this.generation) return;
      this.inFlight = false;
      const now = performance.now();
      this.slots = updateHandSlots(this.slots, message.hands, now);
      if (message.faces) this.faceSlots = updateFaceSlots(this.faceSlots, message.faces, now);
      const visibleHands = this.slots.filter((slot) => slot?.visible);
      this.onStatus({
        type: "tracking",
        count: visibleHands.length,
        inferenceMs: message.inferenceMs,
        faceInferenceMs: message.faceInferenceMs,
        faceCount: this.faceSlots.filter((slot) => slot?.visible).length,
        backend: message.backend,
      });
      return;
    }
    if (message.type === "DETECT_ERROR") {
      if (message.generation !== this.generation) return;
      this.inFlight = false;
      this.onStatus({ type: "error", message: message.error });
    }
  }

  start() {
    this.generation += 1;
    this.running = true;
    this.inFlight = false;
    this.lastVideoTime = -1;
    this.slots = Array(MAX_HANDS).fill(null);
    this.presentedSlots = Array(MAX_HANDS).fill(null);
    this.faceSlots = [null, null];
    this.lastCaptureTime = -Infinity;
    this.lastPresentationTime = performance.now();
    this.scheduleFrame();
    this.presentationAnimationId = requestAnimationFrame((now) => this.presentHands(now));
  }

  setFaceTrackingEnabled(enabled) {
    this.faceTrackingEnabled = Boolean(enabled);
    if (!this.faceTrackingEnabled) this.faceSlots = [null, null];
    this.worker?.postMessage({ type: "SET_FACE_TRACKING", enabled: this.faceTrackingEnabled });
  }

  setVideo(video) {
    if (this.video === video) return;
    const wasRunning = this.running;
    if (wasRunning) {
      if (this.frameCallbackId !== null && this.video.cancelVideoFrameCallback) {
        this.video.cancelVideoFrameCallback(this.frameCallbackId);
      }
      cancelAnimationFrame(this.captureAnimationId);
      this.frameCallbackId = null;
      this.captureAnimationId = null;
    }
    this.video = video;
    this.lastVideoTime = -1;
    this.lastCaptureTime = -Infinity;
    this.inFlight = false;
    if (wasRunning) this.scheduleFrame();
  }

  stop() {
    this.generation += 1;
    this.running = false;
    this.inFlight = false;
    if (this.frameCallbackId !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    cancelAnimationFrame(this.captureAnimationId);
    cancelAnimationFrame(this.presentationAnimationId);
    this.frameCallbackId = null;
    this.captureAnimationId = null;
    this.presentationAnimationId = null;
    this.slots = Array(MAX_HANDS).fill(null);
    this.presentedSlots = Array(MAX_HANDS).fill(null);
    this.faceSlots = [null, null];
    this.onHands([], []);
  }

  scheduleFrame() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) {
      this.frameCallbackId = this.video.requestVideoFrameCallback((now) => this.captureFrame(now));
    } else {
      this.captureAnimationId = requestAnimationFrame((now) => this.captureFrame(now));
    }
  }

  presentHands(timestampMs) {
    if (!this.running) return;
    const elapsedMs = timestampMs - this.lastPresentationTime;
    this.lastPresentationTime = timestampMs;
    this.presentedSlots = presentHandSlots(this.slots, this.presentedSlots, timestampMs, elapsedMs);
    const presentedFaces = this.faceTrackingEnabled ? presentFaceSlots(this.faceSlots, timestampMs) : [];
    this.onHands(this.presentedSlots, presentedFaces);
    this.presentationAnimationId = requestAnimationFrame((now) => this.presentHands(now));
  }

  async captureFrame(timestampMs) {
    this.scheduleFrame();
    if (
      !this.running
      || this.inFlight
      || this.video.readyState < 2
      || this.video.currentTime === this.lastVideoTime
      || timestampMs - this.lastCaptureTime < TARGET_FRAME_INTERVAL_MS - 2
    ) return;

    this.inFlight = true;
    this.lastVideoTime = this.video.currentTime;
    this.lastCaptureTime = timestampMs;
    try {
      const bitmap = await createImageBitmap(this.video, {
        resizeWidth: TRACKING_WIDTH,
        resizeHeight: TRACKING_HEIGHT,
        resizeQuality: "low",
      });
      if (!this.running) {
        bitmap.close();
        this.inFlight = false;
        return;
      }
      this.worker.postMessage({ type: "DETECT", bitmap, timestampMs, generation: this.generation }, [bitmap]);
    } catch (error) {
      this.inFlight = false;
      this.onStatus({ type: "error", message: error?.message || "Could not read the camera frame." });
    }
  }

  dispose() {
    this.stop();
    this.worker?.postMessage({ type: "CLOSE" });
    this.worker = null;
    this.initialization = null;
  }
}
