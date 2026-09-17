import { presentHandSlots, updateHandSlots } from "./handTrackingMath.js";

const TRACKING_WIDTH = 512;
const TRACKING_HEIGHT = 288;
const TARGET_FRAME_INTERVAL_MS = 1000 / 30;

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
    this.slots = [null, null];
    this.presentedSlots = [null, null];
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
    if (message.type === "RESULT") {
      if (message.generation !== this.generation) return;
      this.inFlight = false;
      this.slots = updateHandSlots(this.slots, message.hands, performance.now());
      const visibleHands = this.slots.filter((slot) => slot?.visible);
      this.onStatus({
        type: "tracking",
        count: visibleHands.length,
        inferenceMs: message.inferenceMs,
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
    this.slots = [null, null];
    this.presentedSlots = [null, null];
    this.lastCaptureTime = -Infinity;
    this.lastPresentationTime = performance.now();
    this.scheduleFrame();
    this.presentationAnimationId = requestAnimationFrame((now) => this.presentHands(now));
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
    this.slots = [null, null];
    this.presentedSlots = [null, null];
    this.onHands([]);
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
    this.onHands(this.presentedSlots);
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
