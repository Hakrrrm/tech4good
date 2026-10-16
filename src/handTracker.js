import { presentHandSlots, updateHandSlots } from "./handTrackingMath.js";
import { TrackingDiagnostics } from "./trackingDiagnostics.js";
import { clamp } from "./gameLogic.js";

export class HandTracker {
  constructor(video, onHands, onStatus, options = {}) {
    this.video = video;
    this.onHands = onHands;
    this.onStatus = onStatus;
    this.options = options;
    this.worker = null;
    this.initialization = null;
    this.preparation = null;
    this.running = false;
    this.inFlight = null;
    this.frameCallbackId = null;
    this.captureAnimationId = null;
    this.lastPresentationTime = 0;
    this.lastCaptureTime = -Infinity;
    this.lastVideoTime = -1;
    this.captureIntervalMs = 1000 / 30;
    this.averageProcessingMs = 0;
    this.slots = [null, null];
    this.presentedSlots = [null, null];
    this.generation = 0;
    this.requestId = 0;
    this.diagnostics = new TrackingDiagnostics();
  }

  initialize() {
    if (this.initialization) return this.initialization;
    this.worker = new Worker(new URL("./handTracker.worker.js", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", ({ data }) => this.handleMessage(data));
    this.worker.addEventListener("error", (event) => {
      this.handleWorkerError(new Error(event.message || "Tracking worker stopped."));
    });
    this.initialization = new Promise((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
      this.initializationTimeout = setTimeout(() => reject(new Error("Tracker loading timed out. Please try again.")), 90000);
    }).catch((error) => {
      clearTimeout(this.initializationTimeout);
      this.worker?.terminate();
      this.worker = null;
      this.initialization = null;
      throw error;
    });

    const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
    this.worker.postMessage({
      type: "INIT",
      wasmBaseUrl: new URL("wasm", baseUrl).href,
      poseModelUrl: new URL("models/pose_landmarker_lite.task", baseUrl).href,
      handModelUrl: new URL("models/hand_landmarker.task", baseUrl).href,
      model: this.options.model ?? "pose",
      backend: this.options.backend ?? null,
    });
    return this.initialization;
  }

  handleWorkerError(error) {
    this.rejectInitialization?.(error);
    this.rejectPreparation?.(error);
    clearTimeout(this.initializationTimeout);
    clearTimeout(this.preparationTimeout);
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.initialization = null;
    this.preparation = null;
    this.inFlight = null;
    this.onStatus({ type: "error", fatal: true, message: error.message });
  }

  async warmUp() {
    if (this.preparation) return this.preparation;
    await this.initialize();
    this.preparation = new Promise((resolve, reject) => {
      this.resolvePreparation = resolve;
      this.rejectPreparation = reject;
      this.preparationTimeout = setTimeout(() => reject(new Error("Tracker calibration timed out. Please try again.")), 60000);
    });
    const pendingPreparation = this.preparation;
    try {
      const timestampMs = performance.now();
      const bitmap = await this.createBitmap();
      if (!this.worker) {
        bitmap.close();
        throw new Error("Tracker was closed.");
      }
      this.worker.postMessage({ type: "WARMUP", bitmap, timestampMs }, [bitmap]);
      await pendingPreparation;
    } catch (error) {
      this.rejectPreparation?.(error);
      // Retire all state after a failed warmup, so the start button can retry.
      await pendingPreparation.catch(() => {});
      this.worker?.terminate();
      this.worker = null;
      this.initialization = null;
      this.preparation = null;
      throw error;
    } finally {
      clearTimeout(this.preparationTimeout);
    }
  }

  handleMessage(message) {
    if (message.type === "READY") {
      clearTimeout(this.initializationTimeout);
      this.diagnostics.model = message.model;
      this.diagnostics.backend = message.backend;
      this.resolveInitialization?.(message.backend);
      return;
    }
    if (message.type === "INIT_ERROR") {
      this.rejectInitialization?.(new Error(message.error));
      return;
    }
    if (message.type === "PREPARED") {
      this.diagnostics.backend = message.backend;
      this.diagnostics.benchmark = message.benchmark;
      this.diagnostics.unavailableBackends = message.unavailableBackends ?? [];
      this.resolvePreparation?.();
      return;
    }
    if (message.type === "WARMUP_ERROR") {
      this.rejectPreparation?.(new Error(message.error));
      return;
    }
    if (message.type === "RESULT" || message.type === "DETECT_ERROR") {
      // An old result may free the worker, but must never move a new session's cursors.
      if (this.inFlight?.id === message.requestId) this.inFlight = null;
      if (message.generation !== this.generation || !this.running) return;
      if (message.type === "DETECT_ERROR") {
        this.onStatus({ type: "error", message: message.error });
        return;
      }
      const now = performance.now();
      const frameAgeMs = Math.max(0, now - message.timestampMs);
      this.slots = updateHandSlots(this.slots, message.hands, message.timestampMs);
      this.averageProcessingMs = this.averageProcessingMs
        ? this.averageProcessingMs * 0.85 + frameAgeMs * 0.15 : frameAgeMs;
      this.captureIntervalMs = clamp(this.averageProcessingMs * 1.1, 1000 / 30, 1000 / 15);
      this.diagnostics.frames += 1;
      this.diagnostics.detections += message.hands.length;
      if (!message.hands.length) this.diagnostics.dropouts += 1;
      this.diagnostics.backend = message.backend;
      this.diagnostics.record("inferenceMs", message.inferenceMs);
      this.diagnostics.record("frameAgeMs", frameAgeMs);
      this.onStatus({ type: "tracking", count: message.hands.length, inferenceMs: message.inferenceMs, backend: message.backend });
    }
  }

  start() {
    if (this.running) return;
    this.generation += 1;
    this.running = true;
    this.lastVideoTime = -1;
    this.slots = [null, null];
    this.presentedSlots = [null, null];
    this.lastCaptureTime = -Infinity;
    this.lastPresentationTime = performance.now();
    this.scheduleFrame();
  }

  stop() {
    this.generation += 1;
    this.running = false;
    if (this.frameCallbackId !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    cancelAnimationFrame(this.captureAnimationId);
    this.frameCallbackId = null;
    this.captureAnimationId = null;
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

  // Called by the game's one display loop; inference never controls game speed.
  presentHands(timestampMs) {
    if (!this.running) return;
    this.diagnostics.record("renderMs", timestampMs - this.lastPresentationTime);
    this.lastPresentationTime = timestampMs;
    this.presentedSlots = presentHandSlots(this.slots, this.presentedSlots, timestampMs);
    this.onHands(this.presentedSlots);
  }

  createBitmap() {
    const width = (this.diagnostics.model ?? this.options.model) === "hands" ? 512 : 384;
    const height = Math.max(1, Math.round(width * this.video.videoHeight / this.video.videoWidth));
    return createImageBitmap(this.video, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" });
  }

  async captureFrame(timestampMs) {
    this.scheduleFrame();
    if (
      !this.running || this.inFlight || this.video.readyState < 2
      || this.video.currentTime === this.lastVideoTime
      || timestampMs - this.lastCaptureTime < this.captureIntervalMs - 2
    ) return;

    const request = { id: ++this.requestId, generation: this.generation };
    this.inFlight = request;
    this.lastVideoTime = this.video.currentTime;
    this.lastCaptureTime = timestampMs;
    try {
      const bitmap = await this.createBitmap();
      if (!this.running || request.generation !== this.generation || !this.worker) {
        bitmap.close();
        if (this.inFlight === request) this.inFlight = null;
        return;
      }
      this.diagnostics.record("captureMs", performance.now() - timestampMs);
      this.worker.postMessage({
        type: "DETECT", bitmap, timestampMs, generation: request.generation, requestId: request.id,
      }, [bitmap]);
    } catch (error) {
      if (this.inFlight === request) this.inFlight = null;
      if (request.generation === this.generation && this.running) {
        this.onStatus({ type: "error", message: error?.message || "Could not read the camera frame." });
      }
    }
  }

  dispose() {
    this.stop();
    clearTimeout(this.initializationTimeout);
    clearTimeout(this.preparationTimeout);
    this.rejectInitialization?.(new Error("Tracker closed."));
    this.rejectPreparation?.(new Error("Tracker closed."));
    this.worker?.terminate();
    this.worker = null;
    this.initialization = null;
    this.preparation = null;
  }
}
