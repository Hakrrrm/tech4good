import { updateHandSlots } from "./handTrackingMath.js";

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
    this.animationId = null;
    this.lastVideoTime = -1;
    this.slots = [null, null];
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
      this.onHands(this.slots.map((slot) => slot?.visible ? slot : null));
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
    this.scheduleFrame();
  }

  stop() {
    this.generation += 1;
    this.running = false;
    this.inFlight = false;
    if (this.frameCallbackId !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    cancelAnimationFrame(this.animationId);
    this.frameCallbackId = null;
    this.animationId = null;
    this.slots = [null, null];
    this.onHands([]);
  }

  scheduleFrame() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) {
      this.frameCallbackId = this.video.requestVideoFrameCallback((now) => this.captureFrame(now));
    } else {
      this.animationId = requestAnimationFrame((now) => this.captureFrame(now));
    }
  }

  async captureFrame(timestampMs) {
    this.scheduleFrame();
    if (!this.running || this.inFlight || this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;

    this.inFlight = true;
    this.lastVideoTime = this.video.currentTime;
    try {
      const bitmap = await createImageBitmap(this.video, {
        resizeWidth: 640,
        resizeHeight: 360,
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
