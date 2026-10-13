import { describe, expect, it } from "vitest";
import {
  applyObjectScore,
  assignPvpHands,
  circlesOverlap,
  clamp,
  formatTime,
  getMissingPlayerIndices,
  getMatchResult,
  getOrderedHandEntries,
  getPlayerBoundary,
  getPaceConfig,
  getPvpSpawnX,
  getRequiredHandCount,
  getStreakMultiplier,
  getStableRecoveryStart,
  getZonePresence,
  HAND_FRESH_MS,
  FACE_FRESH_MS,
  isFreshDetection,
  isRaisedHandBesideFace,
  isRegistrationLocked,
  mapHandToPvpLane,
  PLAYER_MISSING_GRACE_MS,
  randomObjectType,
  RECOVERY_STABLE_MS,
  REGISTRATION_COUNTDOWN_MS,
  REGISTRATION_STABLE_MS,
} from "../src/gameLogic.js";
import {
  adaptiveSmoothing,
  filterHandPosition,
  getPalmCenter,
  presentFaceSlots,
  presentHandSlots,
  updateFaceSlots,
  updateHandSlots,
} from "../src/handTrackingMath.js";

describe("game helpers", () => {
  it("formats the session countdown", () => {
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(9.2)).toBe("0:10");
    expect(formatTime(-3)).toBe("0:00");
  });

  it("keeps positions inside the play area", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(0.4)).toBe(0.4);
    expect(clamp(2)).toBe(1);
  });

  it("detects circular catches", () => {
    expect(circlesOverlap({ x: 0, y: 0, radius: 10 }, { x: 15, y: 0, radius: 6 })).toBe(true);
    expect(circlesOverlap({ x: 0, y: 0, radius: 10 }, { x: 20, y: 0, radius: 6 })).toBe(false);
  });

  it("provides safe defaults and deterministic object selection", () => {
    expect(getPaceConfig("unknown")).toEqual(getPaceConfig("gentle"));
    expect(randomObjectType(() => 0).kind).toBe("leaf");
    expect(randomObjectType(() => 0.8).kind).toBe("star");
    expect(randomObjectType(() => 0.85).kind).toBe("bomb");
    expect(randomObjectType(() => 0.99).kind).toBe("virus");
  });

  it("builds a capped streak multiplier and resets it on hazards", () => {
    expect(getStreakMultiplier(0)).toBe(1);
    expect(getStreakMultiplier(3)).toBe(2);
    expect(getStreakMultiplier(9)).toBe(4);
    expect(getStreakMultiplier(99)).toBe(4);

    const thirdCatch = applyObjectScore({ score: 25, streak: 2 }, { points: 10, hazard: false });
    expect(thirdCatch).toEqual({ score: 45, streak: 3, multiplier: 2, delta: 20 });

    const hazard = applyObjectScore(thirdCatch, { points: -25, hazard: true });
    expect(hazard).toEqual({ score: 20, streak: 0, multiplier: 1, delta: -25 });
  });

  it("never lets a hazard reduce the score below zero", () => {
    expect(applyObjectScore({ score: 10, streak: 4 }, { points: -25, hazard: true }))
      .toEqual({ score: 0, streak: 0, multiplier: 1, delta: -10 });
  });

  it("requires two visible hands for local PvP and one for solo play", () => {
    expect(getRequiredHandCount("solo")).toBe(1);
    expect(getRequiredHandCount("pvp")).toBe(2);
    expect(REGISTRATION_COUNTDOWN_MS).toBe(3000);
  });

  it("freezes registration tracking for the full countdown", () => {
    expect(isRegistrationLocked("registering")).toBe(false);
    expect(isRegistrationLocked("countdown")).toBe(true);
    expect(isRegistrationLocked("playing")).toBe(false);
  });

  it("identifies missing players without reacting to held interactive cursors", () => {
    expect(getMissingPlayerIndices([
      { x: 0.2, interactive: true },
      { x: 0.8, interactive: false },
    ], 2)).toEqual([1]);
    expect(getMissingPlayerIndices([{ x: 0.5, interactive: true }], 1)).toEqual([]);
    expect(PLAYER_MISSING_GRACE_MS).toBeGreaterThan(500);
  });

  it("requires an uninterrupted stable recovery window", () => {
    expect(getStableRecoveryStart(null, true, 1000)).toBe(1000);
    expect(getStableRecoveryStart(1000, true, 1200)).toBe(1000);
    expect(getStableRecoveryStart(1000, false, 1200)).toBeNull();
    expect(RECOVERY_STABLE_MS).toBeGreaterThan(1000);
    expect(REGISTRATION_STABLE_MS).toBeGreaterThan(500);
  });

  it("rejects held or stale tracking results during registration and re-entry", () => {
    expect(isFreshDetection({ lastSeen: 1000, interactive: true }, 1100, HAND_FRESH_MS)).toBe(true);
    expect(isFreshDetection({ lastSeen: 1000, interactive: true }, 1300, HAND_FRESH_MS)).toBe(false);
    expect(isFreshDetection({ lastSeen: 1000, interactive: false }, 1050, FACE_FRESH_MS)).toBe(false);
    expect(isFreshDetection({ interactive: true }, 1050, HAND_FRESH_MS)).toBe(false);
  });

  it("requires a raised hand beside the face, not a face-shaped false hand", () => {
    const faces = [{ x: 0.25, y: 0.35, width: 0.2, height: 0.25 }];
    expect(isRaisedHandBesideFace({ x: 0.25, y: 0.35 }, faces)).toBe(false);
    expect(isRaisedHandBesideFace({ x: 0.4, y: 0.45 }, faces)).toBe(true);
    expect(isRaisedHandBesideFace({ x: 0.4, y: 0.9 }, faces)).toBe(false);
  });

  it("orders registered hands from the left side of the mirrored screen", () => {
    const hands = [
      { x: 0.78, y: 0.5 },
      null,
      { x: 0.21, y: 0.45 },
    ];
    expect(getOrderedHandEntries(hands)).toEqual([
      { hand: hands[2], index: 2 },
      { hand: hands[0], index: 0 },
    ]);
  });

  it("maps each PvP player into their own half of the split screen", () => {
    expect(mapHandToPvpLane(0, 0)).toBeCloseTo(0.035);
    expect(mapHandToPvpLane(0.5, 0)).toBeCloseTo(0.465);
    expect(mapHandToPvpLane(0.5, 1)).toBeCloseTo(0.535);
    expect(mapHandToPvpLane(1, 1)).toBeCloseTo(0.965);
    expect(mapHandToPvpLane(0.75, 1)).toBeCloseTo(0.75);
    expect(mapHandToPvpLane(0.4, 0, 0.4)).toBeCloseTo(0.465);
    expect(mapHandToPvpLane(0.7, 1, 0.4)).toBeCloseTo(0.75);
  });

  it("keeps PvP hands assigned by camera side when detector slots reorder", () => {
    const boundary = getPlayerBoundary([{ x: 0.22 }, { x: 0.78 }]);
    const left = { x: 0.24, y: 0.7, interactive: true };
    const right = { x: 0.76, y: 0.7, interactive: true };
    expect(assignPvpHands([right, left], boundary)).toEqual([left, right]);
    expect(assignPvpHands([left, right], boundary)).toEqual([left, right]);
    expect(assignPvpHands([null, right], boundary)).toEqual([null, right]);
  });

  it("does not accept two hands from one player as both PvP players", () => {
    const hands = [{ x: 0.18 }, { x: 0.36 }];
    const faces = [{ x: 0.22 }, { x: 0.78 }];
    expect(assignPvpHands(hands, 0.5)).toEqual([hands[0], null]);
    expect(getZonePresence(hands, faces, 0.5)).toEqual([
      { hand: true, face: true },
      { hand: false, face: true },
    ]);
    expect(getPlayerBoundary([{ x: 0.25 }, { x: 0.3 }])).toBeNull();
  });

  it("spawns PvP objects safely inside the assigned lane", () => {
    expect(getPvpSpawnX(0, 0)).toBeGreaterThan(0.035);
    expect(getPvpSpawnX(0, 1)).toBeLessThan(0.465);
    expect(getPvpSpawnX(1, 0)).toBeGreaterThan(0.535);
    expect(getPvpSpawnX(1, 1)).toBeLessThan(0.965);
  });

  it("announces a PvP winner or a friendly draw", () => {
    expect(getMatchResult(80, 55, "pvp")).toMatchObject({ winner: 1, title: "Player 1 wins!" });
    expect(getMatchResult(40, 40, "pvp")).toMatchObject({ winner: "tie", title: "A friendly draw!" });
    expect(getMatchResult(40, 0, "solo")).toMatchObject({ winner: "solo", title: "Lovely movement!" });
  });
});

describe("hand tracking helpers", () => {
  it("uses the stable palm landmarks as the cursor anchor", () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    [0, 5, 9, 13, 17].forEach((index) => { landmarks[index] = { x: 0.4, y: 0.6 }; });
    expect(getPalmCenter(landmarks)).toEqual({ x: 0.4, y: 0.6 });
  });

  it("responds faster to large movement and immediately reacquires a lost hand", () => {
    const previous = { x: 0.2, y: 0.2 };
    const quickMove = adaptiveSmoothing(previous, { x: 0.8, y: 0.2 }, 30);
    expect(quickMove.x).toBeGreaterThan(0.7);
    expect(adaptiveSmoothing(previous, { x: 0.8, y: 0.2 }, 250)).toEqual({ x: 0.8, y: 0.2 });
  });

  it("tracks two mirrored hands independently", () => {
    const slots = updateHandSlots([], [
      { x: 0.2, y: 0.4, label: "Left", confidence: 0.9 },
      { x: 0.8, y: 0.5, label: "Right", confidence: 0.9 },
    ], 1000);
    expect(slots.filter((slot) => slot?.visible)).toHaveLength(2);
    expect(slots[0].x).toBeCloseTo(0.8);
    expect(slots[1].x).toBeCloseTo(0.2);
  });

  it("keeps four visible hands so both PvP players can be found", () => {
    const detections = [0.9, 0.7, 0.3, 0.1].map((x) => ({ x, y: 0.5, label: "Right", confidence: 0.9 }));
    const first = updateHandSlots([], detections, 1000);
    expect(first.filter((slot) => slot?.visible)).toHaveLength(4);
    const reordered = updateHandSlots(first, [...detections].reverse(), 1033);
    expect(reordered.filter((slot) => slot?.visible)).toHaveLength(4);
    expect(reordered.map((slot) => slot.x)).toEqual(expect.arrayContaining([
      expect.closeTo(0.1, 1),
      expect.closeTo(0.3, 1),
      expect.closeTo(0.7, 1),
      expect.closeTo(0.9, 1),
    ]));
  });

  it("dampens tiny landmark jitter without freezing deliberate movement", () => {
    const previous = {
      x: 0.5,
      y: 0.5,
      rawX: 0.5,
      rawY: 0.5,
      velocityX: 0,
      velocityY: 0,
      lastSeen: 1000,
    };
    const jitter = filterHandPosition(previous, { x: 0.51, y: 0.495 }, 1033);
    const movement = filterHandPosition(previous, { x: 0.7, y: 0.5 }, 1033);
    expect(jitter.x).toBeGreaterThan(0.5);
    expect(jitter.x).toBeLessThan(0.51);
    expect(movement.x - previous.x).toBeGreaterThan(jitter.x - previous.x);
  });

  it("resets immediately when a hand is reacquired", () => {
    const previous = { x: 0.2, y: 0.2, rawX: 0.2, rawY: 0.2, lastSeen: 1000 };
    expect(filterHandPosition(previous, { x: 0.8, y: 0.7 }, 1250)).toMatchObject({ x: 0.8, y: 0.7 });
  });

  it("presents smooth bounded motion between inference results", () => {
    const slots = [{
      x: 0.5,
      y: 0.5,
      velocityX: 4,
      velocityY: 0,
      lastSeen: 1000,
      visible: true,
    }, null];
    const presented = presentHandSlots(slots, [{ x: 0.5, y: 0.5 }, null], 1030, 16);
    expect(presented[0].x).toBeGreaterThan(0.5);
    expect(presented[0].x).toBeLessThanOrEqual(0.575);
  });

  it("holds a cursor through a brief detection dropout to prevent flicker", () => {
    const slots = [{ x: 0.5, y: 0.5, lastSeen: 1000, visible: false }, null];
    const heldCursor = presentHandSlots(slots, [{ x: 0.5, y: 0.5 }, null], 1280, 16)[0];
    expect(heldCursor).not.toBeNull();
    expect(heldCursor.interactive).toBe(false);
    expect(presentHandSlots(slots, [{ x: 0.5, y: 0.5 }, null], 1400, 16)[0]).toBeNull();
  });

  it("locks two face slots left-to-right and survives reordered detections", () => {
    const initial = updateFaceSlots([], [
      { x: 0.2, y: 0.3, width: 0.2, height: 0.3 },
      { x: 0.8, y: 0.3, width: 0.2, height: 0.3 },
    ], 1000);
    expect(initial[0].x).toBeCloseTo(0.2);
    expect(initial[1].x).toBeCloseTo(0.8);

    const reordered = updateFaceSlots(initial, [
      { x: 0.18, y: 0.3, width: 0.2, height: 0.3 },
      { x: 0.82, y: 0.3, width: 0.2, height: 0.3 },
    ], 1180);
    expect(reordered[0].x).toBeLessThan(0.3);
    expect(reordered[1].x).toBeGreaterThan(0.7);
  });

  it("holds a face identity through a short detector dropout", () => {
    const slots = [{ x: 0.25, y: 0.3, width: 0.2, height: 0.3, lastSeen: 1000, visible: false }, null];
    expect(presentFaceSlots(slots, 1450)[0]).toMatchObject({ x: 0.25, interactive: true });
    expect(presentFaceSlots(slots, 1650)[0]).toMatchObject({ x: 0.25, interactive: false });
    expect(presentFaceSlots(slots, 2200)[0]).toBeNull();
  });
});
