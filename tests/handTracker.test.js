import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandTracker } from "../src/handTracker.js";

let tracker;
let video;
let worker;
let now;

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
  video = { readyState: 2, videoWidth: 640, videoHeight: 480, currentTime: 1 };
  worker = { postMessage: vi.fn(), terminate: vi.fn() };
  tracker = new HandTracker(video, vi.fn(), vi.fn());
  tracker.worker = worker;
});

afterEach(() => { tracker.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("camera capture lifecycle", () => {
  it("preserves the camera aspect ratio in inference bitmaps", async () => {
    await tracker.createBitmap();
    expect(createImageBitmap).toHaveBeenCalledWith(video, { resizeWidth: 384, resizeHeight: 288, resizeQuality: "low" });
  });

  it("allows only one in-flight frame and retains its capture timestamp", async () => {
    tracker.start();
    await tracker.captureFrame(1000);
    video.currentTime = 2;
    await tracker.captureFrame(1040);
    expect(worker.postMessage).toHaveBeenCalledOnce();
    now = 1080;
    tracker.handleMessage({ type: "RESULT", hands: [{ x: 0.2, y: 0.4, label: "Left" }],
      requestId: 1, generation: tracker.generation, timestampMs: 1000, inferenceMs: 60, backend: "CPU" });
    expect(tracker.slots[0].lastSeen).toBe(1000);
    expect(tracker.diagnostics.snapshot().frameAgeMs.median).toBe(80);
  });

  it("closes a bitmap that finishes capture after stop/resume", async () => {
    let complete;
    const bitmap = { close: vi.fn() };
    createImageBitmap.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    tracker.start();
    const capture = tracker.captureFrame(1000);
    tracker.stop();
    tracker.start();
    complete(bitmap);
    await capture;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(tracker.inFlight).toBeNull();
  });

  it("releases an old request without applying it to the resumed session", async () => {
    tracker.start();
    await tracker.captureFrame(1000);
    const generation = tracker.generation;
    tracker.stop();
    tracker.start();
    expect(tracker.inFlight).not.toBeNull();
    tracker.handleMessage({ type: "RESULT", generation, requestId: 1, timestampMs: 1000,
      hands: [{ x: 0.5, y: 0.5, label: "Left" }] });
    expect(tracker.inFlight).toBeNull();
    expect(tracker.slots).toEqual([null, null]);
  });

  it("does not start duplicate capture loops", () => {
    tracker.start();
    tracker.start();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it("retires a crashed worker and leaves initialization retryable", () => {
    tracker.start();
    tracker.handleWorkerError(new Error("Worker crashed"));
    expect(tracker.running).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tracker.initialization).toBeNull();
    expect(tracker.preparation).toBeNull();
    expect(tracker.onHands).toHaveBeenLastCalledWith([]);
    expect(tracker.onStatus).toHaveBeenLastCalledWith({ type: "error", fatal: true, message: "Worker crashed" });
  });

  it("cleans up a failed warmup so initialization can be retried", async () => {
    tracker.initialize = vi.fn(async () => {});
    tracker.createBitmap = vi.fn(async () => { throw new Error("Frame unavailable"); });
    await expect(tracker.warmUp()).rejects.toThrow("Frame unavailable");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tracker.initialization).toBeNull();
    expect(tracker.preparation).toBeNull();
  });
});
