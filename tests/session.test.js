// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ trackers: [] }));
vi.mock("../src/handTracker.js", () => ({
  HandTracker: class {
    constructor(video, onHands) {
      this.onHands = onHands;
      this.hands = [];
      this.diagnostics = { snapshot: () => ({}) };
      this.initialize = vi.fn(async () => {});
      this.warmUp = vi.fn(async () => {});
      this.start = vi.fn();
      this.stop = vi.fn(() => onHands([]));
      this.dispose = vi.fn();
      mocks.trackers.push(this);
    }
    presentHands() { this.onHands(this.hands); }
  },
}));

let now, callbacks, events, stopTrack;
const $ = (selector) => document.querySelector(selector);
const advance = (elapsed) => {
  now += elapsed;
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach((callback) => callback(now));
};
const click = (selector) => $(selector).click();

beforeEach(async () => {
  vi.resetModules();
  mocks.trackers.length = 0;
  now = 1000;
  callbacks = new Map();
  let id = 0;
  events = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal("requestAnimationFrame", (callback) => { callbacks.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key) => callbacks.delete(key));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const addWindowListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback) => {
    events.push([type, callback]);
    addWindowListener(type, callback);
  });
  const html = readFileSync("index.html", "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
  const board = $("#gameBoard");
  Object.defineProperty(board, "clientWidth", { configurable: true, value: 1000 });
  Object.defineProperty(board, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty($("#cameraVideo"), "videoWidth", { configurable: true, value: 640 });
  Object.defineProperty($("#cameraVideo"), "videoHeight", { configurable: true, value: 384 });
  Object.defineProperty($("#cameraVideo"), "srcObject", { configurable: true, writable: true, value: null });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  stopTrack = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
  } });
  await import("../src/main.js");
});

afterEach(() => {
  events.forEach(([type, callback]) => window.removeEventListener(type, callback));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function startCamera() {
  click("#cameraStart");
  await vi.waitFor(() => expect($("#playPanel").hidden).toBe(false));
  return mocks.trackers[0];
}

describe("game session regression", () => {
  it.each([20, 30, 60])("ends a %s-second session at its selected duration", (duration) => {
    $(`input[name="duration"][value="${duration}"]`).checked = true;
    click("#keyboardStart");
    expect($("#timeValue").textContent).toBe(duration === 60 ? "1:00" : `0:${duration}`);
    advance(duration * 1000 - 1);
    expect($("#playPanel").hidden).toBe(false);
    advance(1);
    expect($("#resultsPanel").hidden).toBe(false);
  });

  it("excludes paused time and retains keyboard controls", () => {
    click("#keyboardStart");
    advance(5000);
    const before = $(".player-cursor").style.transform;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    advance(16);
    expect($(".player-cursor").style.transform).not.toBe(before);
    click("#pauseButton");
    advance(60000);
    expect($("#resultsPanel").hidden).toBe(true);
    click("#pauseButton");
    advance(24983);
    expect($("#playPanel").hidden).toBe(false);
    advance(1);
    expect($("#resultsPanel").hidden).toBe(false);
  });

  it("preserves streak scoring, single catches with two hands, and fixed hazard deductions", async () => {
    const tracker = await startCamera();
    tracker.hands = [{ x: 0.5, y: 0.04, interactive: true }, { x: 0.5, y: 0.04, interactive: true }];
    advance(1000);
    advance(1800);
    advance(1800);
    expect($("#caughtValue").textContent).toBe("3");
    expect($("#scoreValue").textContent).toBe("80");
    expect($("#multiplierValue").textContent).toBe("×2");
    Math.random.mockReturnValueOnce(0.85);
    advance(1800);
    expect($("#scoreValue").textContent).toBe("55");
    expect($("#streakValue").textContent).toBe("0");
    expect($("#caughtValue").textContent).toBe("3");
    expect($("#missedValue").textContent).toBe("0");
    click("#endButton");
    expect($("#finalStreak").textContent).toBe("3");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("does not allow held, stale cursors to collide", async () => {
    const tracker = await startCamera();
    tracker.hands = [{ x: 0.5, y: 0.04, interactive: false }];
    advance(1000);
    expect($("#scoreValue").textContent).toBe("0");
  });

  it("does not charge a miss for avoiding a hazard", () => {
    Math.random.mockReturnValue(0.85);
    click("#keyboardStart");
    for (let frame = 0; frame < 350; frame++) advance(50);
    expect($("#missedValue").textContent).toBe("0");
  });

  it("charges collectible misses and ends at the existing allowance", () => {
    $("input[name='pace'][value='lively']").checked = true;
    click("#keyboardStart");
    // Put collectibles away from the stationary keyboard cursor.
    Math.random.mockReturnValue(0);
    for (let frame = 0; frame < 590 && $("#resultsPanel").hidden; frame++) advance(50);
    expect($("#resultsPanel").hidden).toBe(false);
    expect($("#missedValue").textContent).toBe("6");
  });

  it("cleans up a camera stream when model initialization fails", async () => {
    mocks.trackers[0].initialize.mockRejectedValue(new Error("Model load failed"));
    click("#cameraStart");
    await vi.waitFor(() => expect($("#cameraStart").disabled).toBe(false));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect($("#cameraMessage").textContent).toContain("Model load failed");
    expect($("#setupPanel").hidden).toBe(false);
    expect($("#keyboardStart").disabled).toBe(false);
  });

  it("cleans up tracks when video playback fails", async () => {
    HTMLMediaElement.prototype.play.mockRejectedValue(new Error("Playback failed"));
    click("#cameraStart");
    await vi.waitFor(() => expect($("#cameraStart").disabled).toBe(false));
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("closes a late camera stream after model startup has already failed", async () => {
    let resolveCamera;
    navigator.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => { resolveCamera = resolve; }));
    mocks.trackers[0].initialize.mockRejectedValue(new Error("Model load failed"));
    click("#cameraStart");
    expect($("#keyboardStart").disabled).toBe(true);
    await Promise.resolve();
    resolveCamera({ getTracks: () => [{ stop: stopTrack }] });
    await vi.waitFor(() => expect($("#cameraStart").disabled).toBe(false));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect($("#setupPanel").hidden).toBe(false);
  });

  it("starts the session clock only after backend calibration completes", async () => {
    let finishWarmup;
    mocks.trackers[0].warmUp.mockImplementation(() => new Promise((resolve) => { finishWarmup = resolve; }));
    click("#cameraStart");
    await vi.waitFor(() => expect(mocks.trackers[0].warmUp).toHaveBeenCalledOnce());
    advance(60000);
    expect($("#playPanel").hidden).toBe(true);
    finishWarmup();
    await vi.waitFor(() => expect($("#playPanel").hidden).toBe(false));
    expect($("#timeValue").textContent).toBe("0:30");
    advance(29999);
    expect($("#resultsPanel").hidden).toBe(true);
    advance(1);
    expect($("#resultsPanel").hidden).toBe(false);
  });

  it("pauses/resumes tracking and resets a replayed session", async () => {
    const tracker = await startCamera();
    expect(tracker.start).toHaveBeenCalledOnce();
    click("#pauseButton");
    expect(tracker.stop).toHaveBeenCalledOnce();
    click("#pauseButton");
    expect(tracker.start).toHaveBeenCalledTimes(2);
    click("#endButton");
    expect($("#resultsPanel").hidden).toBe(false);
    click("#playAgain");
    expect($("#setupPanel").hidden).toBe(false);
    click("#keyboardStart");
    expect($("#scoreValue").textContent).toBe("0");
    expect($("#streakValue").textContent).toBe("0");
    expect($("#timeValue").textContent).toBe("0:30");
  });
});
