// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEADERBOARD_KEY } from "../src/leaderboard.js";

const mocks = vi.hoisted(() => ({ trackers: [] }));
vi.mock("../src/handTracker.js", () => ({
  HandTracker: class {
    constructor(video, onHands) {
      this.onHands = onHands;
      this.hands = [];
      this.diagnostics = { snapshot: () => ({}) };
      this.initialize = vi.fn(async () => {});
      this.configure = vi.fn();
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
  localStorage.clear();
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

function selectPvP() {
  const input = $('input[name="gameMode"][value="pvp"]');
  input.checked = true;
  input.dispatchEvent(new Event("change"));
}

async function startPvPCamera() {
  selectPvP();
  const tracker = await startCamera();
  tracker.hands = [
    { x: 0.25, y: 0.04, playerId: 0, interactive: true },
    { x: 0.25, y: 0.04, playerId: 0, interactive: true },
    { x: 0.75, y: 0.04, playerId: 1, interactive: true },
    { x: 0.75, y: 0.04, playerId: 1, interactive: true },
  ];
  advance(16);
  advance(700);
  return tracker;
}

describe("PvP sessions", () => {
  it("waits for both people without consuming match time or spawning treats", async () => {
    selectPvP();
    const tracker = await startCamera();
    tracker.hands = [{ x: 0.25, y: 0.04, playerId: 0, interactive: true }];
    advance(60000);
    expect($("#timeValue").textContent).toBe("0:30");
    expect($("#targets").children).toHaveLength(0);
    expect($("#resultsPanel").hidden).toBe(true);
    click("#endButton");
    expect($("#resultsTitle").textContent).toBe("Match cancelled");
    expect(localStorage.getItem(LEADERBOARD_KEY)).toBeNull();
  });

  it("awards each player's paired catch once, isolates hazards/streaks, and announces the winner", async () => {
    $("#playerName").value = "Alice";
    $("#secondPlayerName").value = "Bob";
    const tracker = await startPvPCamera();
    expect(tracker.configure).toHaveBeenCalledWith(2);
    advance(1000); advance(1800); advance(1800);
    expect($("#p1Score").textContent).toBe("80");
    expect($("#p2Score").textContent).toBe("80");
    tracker.hands[2].y = tracker.hands[3].y = 0.9;
    Math.random.mockReturnValueOnce(0.85);
    advance(1800);
    expect($("#p1Score").textContent).toBe("55");
    expect($("#p2Score").textContent).toBe("80");
    expect($("#p1Detail").textContent).toContain("Streak 0");
    expect($("#p2Detail").textContent).toContain("Streak 3");
    advance(30000);
    expect($("#resultsTitle").textContent).toBe("Bob wins!");
    expect($("#statusLive").textContent).toContain("Bob wins!");
    expect($("#pvpResults").textContent).toContain("Alice");
    expect(localStorage.getItem(LEADERBOARD_KEY)).toBeNull();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("prevents an opponent's hand from stealing a lane's target", async () => {
    const tracker = await startPvPCamera();
    tracker.hands.forEach((hand) => { hand.x = hand.playerId === 0 ? 0.75 : 0.25; });
    advance(1000);
    expect($("#p1Score").textContent).toBe("0");
    expect($("#p2Score").textContent).toBe("0");
    expect($("#targets").children).toHaveLength(2);
    const targets = [...$("#targets").children];
    expect(targets.map((node) => node.dataset.player)).toEqual(["1", "2"]);
    expect(targets[0].getAttribute("aria-label")).toBe(targets[1].getAttribute("aria-label"));
  });

  it("ends a tied match as a draw and restores solo leaderboard behavior on replay", () => {
    selectPvP();
    click("#keyboardStart");
    advance(30000);
    expect($("#resultsTitle").textContent).toBe("It's a draw!");
    expect(localStorage.getItem(LEADERBOARD_KEY)).toBeNull();
    click("#playAgain");
    const solo = $('input[name="gameMode"][value="solo"]');
    solo.checked = true;
    solo.dispatchEvent(new Event("change"));
    click("#keyboardStart");
    click("#endButton");
    expect($("#resultsTitle").textContent).toBe("Lovely movement!");
    expect($("#pvpResults").hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries).toHaveLength(1);
  });

  it("gives keyboard players independent controls and excludes pauses from the shared timer", () => {
    selectPvP();
    click("#keyboardStart");
    const cursors = [...document.querySelectorAll(".player-cursor")];
    const originalP2 = cursors[2].style.transform;
    const originalP1 = cursors[0].style.transform;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    advance(50);
    expect(cursors[0].style.transform).not.toBe(originalP1);
    expect(cursors[2].style.transform).toBe(originalP2);
    click("#pauseButton"); advance(60000); click("#pauseButton");
    advance(29949);
    expect($("#resultsPanel").hidden).toBe(true);
    advance(1);
    expect($("#resultsPanel").hidden).toBe(false);
  });

  it("keeps the timed match running beyond the solo miss allowance", () => {
    selectPvP();
    $('input[name="pace"][value="lively"]').checked = true;
    $('input[name="duration"][value="60"]').checked = true;
    Math.random.mockReturnValue(0);
    click("#keyboardStart");
    for (let frame = 0; frame < 1000; frame++) advance(50);
    expect($("#resultsPanel").hidden).toBe(true);
    advance(10000);
    expect($("#resultsPanel").hidden).toBe(false);
    for (const card of $("#pvpResults").children) {
      expect(Number(card.textContent.match(/(\d+) missed/)[1])).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("game session regression", () => {
  it.each([
    [0, "mandarin", "mandarin orange"],
    [0.21, "watermelon", "watermelon"],
    [0.42, "icing-gem", "icing gem biscuit"],
    [0.62, "ondeh-ondeh", "ondeh-ondeh"],
  ])("renders a local SVG collectible for roll %s", (roll, kind, label) => {
    Math.random.mockReturnValue(roll);
    click("#keyboardStart");
    advance(1000);
    const object = $(`.falling-object.${kind}`);
    expect(object.getAttribute("aria-label")).toBe(label);
    expect(object.querySelector("img").getAttribute("src")).toBeTruthy();
    expect(object.querySelector("img").getAttribute("alt")).toBe("");
    expect(object.querySelector("img").draggable).toBe(false);
  });

  it("keeps hazard symbols distinct from the new collectible artwork", () => {
    Math.random.mockReturnValue(0.85);
    click("#keyboardStart");
    advance(1000);
    expect($(".falling-object.bomb").textContent).toBe("💣");
    expect($(".falling-object.bomb img")).toBeNull();
  });

  it("cycles leaderboard durations in both directions without changing game settings or stored scores", () => {
    const entries = [20, 30, 60].map((durationSeconds) => ({
      id: `duration-${durationSeconds}`, name: `Player ${durationSeconds}`, score: durationSeconds,
      pace: "gentle", durationSeconds, mode: "keyboard", endedAt: 1000,
    }));
    const saved = JSON.stringify({ version: 1, entries });
    localStorage.setItem(LEADERBOARD_KEY, saved);
    window.dispatchEvent(new StorageEvent("storage", { key: LEADERBOARD_KEY }));
    expect($(".leaderboard-player strong").textContent).toBe("Player 30");
    click("#leaderboardPrevious");
    expect($("#leaderboardDuration").textContent).toBe("20s");
    expect($(".leaderboard-player strong").textContent).toBe("Player 20");
    click("#leaderboardPrevious");
    expect($("#leaderboardDuration").textContent).toBe("1 min");
    expect($(".leaderboard-player strong").textContent).toBe("Player 60");
    click("#leaderboardNext");
    expect($("#leaderboardDuration").textContent).toBe("20s");
    click("#leaderboardNext");
    expect($("#leaderboardDuration").textContent).toBe("30s");
    click("#leaderboardNext");
    expect($("#leaderboardDuration").textContent).toBe("1 min");
    expect($('input[name="duration"]:checked').value).toBe("30");
    expect(localStorage.getItem(LEADERBOARD_KEY)).toBe(saved);
    click("#keyboardStart");
    expect($("#timeValue").textContent).toBe("0:30");
  });

  it("preserves the browsed view on storage updates and uses the selected pace", () => {
    const pace = $('input[name="pace"][value="steady"]');
    pace.checked = true;
    pace.dispatchEvent(new Event("change", { bubbles: true }));
    click("#leaderboardNext");
    expect($("#leaderboardCategory").textContent).toBe("Steady · 1 min");
    expect($("#leaderboardEmpty").hidden).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key: LEADERBOARD_KEY }));
    expect($("#leaderboardCategory").textContent).toBe("Steady · 1 min");
    const duration = $('input[name="duration"][value="20"]');
    duration.checked = true;
    duration.dispatchEvent(new Event("change", { bubbles: true }));
    expect($("#leaderboardDuration").textContent).toBe("20s");
  });

  it("shows the completed session's board and supports browsing from results without saving duplicate scores", () => {
    click("#leaderboardNext");
    click("#keyboardStart");
    click("#endButton");
    expect($("#leaderboardDuration").textContent).toBe("30s");
    click("#leaderboardNext");
    expect($("#leaderboardCategory").textContent).toBe("Gentle · 1 min");
    expect($("#leaderboardEmpty").hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries).toHaveLength(1);
    click("#playAgain");
    expect($("#leaderboardDuration").textContent).toBe("30s");
    expect($("#leaderboardEmpty").hidden).toBe(true);
  });

  it("saves the entered name and final score once, then restores them after an app reload", async () => {
    $("#playerName").value = "  Alice   Tan  ";
    const tracker = await startCamera();
    tracker.hands = [{ x: 0.5, y: 0.04, interactive: true }];
    advance(1000);
    click("#endButton");
    click("#endButton");
    const rows = JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Alice Tan", score: 20, mode: "camera", pace: "gentle", durationSeconds: 30 });
    expect($("#resultsLeaderboardSlot #leaderboard")).not.toBeNull();
    expect($(".leaderboard-entry.current-score").textContent).toContain("Alice Tan");
    events.forEach(([type, callback]) => window.removeEventListener(type, callback));
    events = [];
    vi.resetModules();
    const html = readFileSync("index.html", "utf8");
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.js");
    expect($("#setupLeaderboardSlot .leaderboard-entry").textContent).toContain("Alice Tan");
    expect($(".leaderboard-score").textContent).toBe("20");
  });

  it("allows unnamed keyboard play, keeps categories separate, and moves the board back on replay", () => {
    click("#keyboardStart");
    click("#endButton");
    expect($(".leaderboard-entry").textContent).toContain("Guest");
    expect($(".leaderboard-entry").textContent).toContain("Keyboard");
    click("#playAgain");
    expect($("#setupLeaderboardSlot #leaderboard")).not.toBeNull();
    const duration = $('input[name="duration"][value="20"]');
    duration.checked = true;
    duration.dispatchEvent(new Event("change", { bubbles: true }));
    expect($("#leaderboardCategory").textContent).toBe("Gentle · 20 sec");
    expect($("#leaderboardEmpty").hidden).toBe(false);
    const defaultDuration = $('input[name="duration"][value="30"]');
    defaultDuration.checked = true;
    defaultDuration.dispatchEvent(new Event("change", { bubbles: true }));
    expect($("#leaderboardEmpty").hidden).toBe(true);
  });

  it("keeps keyboard play working when randomUUID is unavailable on an insecure origin", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(undefined);
    click("#keyboardStart");
    click("#endButton");
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries[0].id).toBeTruthy();
  });

  it("uses the name captured at session start, not later edits", () => {
    $("#playerName").value = "Alice";
    click("#keyboardStart");
    $("#playerName").value = "Bob";
    click("#endButton");
    expect($(".leaderboard-player strong").textContent).toBe("Alice");
  });

  it("renders names as text rather than executable markup", () => {
    $("#playerName").value = "<img src=x onerror=x>";
    click("#keyboardStart");
    click("#endButton");
    expect($("#leaderboardEntries img")).toBeNull();
    expect($(".leaderboard-player strong").textContent).toBe("<img src=x onerror=x>");
  });

  it("still finishes a session and warns when browser storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    click("#keyboardStart");
    click("#endButton");
    expect($("#resultsPanel").hidden).toBe(false);
    expect($("#leaderboardStorage").textContent).toContain("temporary");
    expect($(".leaderboard-entry").textContent).toContain("Guest");
  });

  it("refreshes the visible board when another tab changes stored scores", () => {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify({ version: 1, entries: [{
      id: "other-tab", name: "Bob", score: 150, pace: "gentle", durationSeconds: 30, mode: "keyboard", endedAt: 1000,
    }] }));
    window.dispatchEvent(new StorageEvent("storage", { key: LEADERBOARD_KEY }));
    expect($(".leaderboard-entry").textContent).toContain("Bob");
  });

  it.each([20, 30, 60])("ends a %s-second session at its selected duration", (duration) => {
    $(`input[name="duration"][value="${duration}"]`).checked = true;
    click("#keyboardStart");
    expect($("#timeValue").textContent).toBe(duration === 60 ? "1:00" : `0:${duration}`);
    advance(duration * 1000 - 1);
    expect($("#playPanel").hidden).toBe(false);
    advance(1);
    expect($("#resultsPanel").hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries[0].durationSeconds).toBe(duration);
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
    expect(JSON.parse(localStorage.getItem(LEADERBOARD_KEY)).entries).toHaveLength(1);
  });

  it("cleans up a camera stream when model initialization fails", async () => {
    mocks.trackers[0].initialize.mockRejectedValue(new Error("Model load failed"));
    click("#cameraStart");
    await vi.waitFor(() => expect($("#cameraStart").disabled).toBe(false));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect($("#cameraMessage").textContent).toContain("Model load failed");
    expect($("#setupPanel").hidden).toBe(false);
    expect($("#keyboardStart").disabled).toBe(false);
    expect(localStorage.getItem(LEADERBOARD_KEY)).toBeNull();
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
