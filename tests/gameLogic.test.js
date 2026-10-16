import { describe, expect, it } from "vitest";
import {
  applyObjectScore,
  circlesOverlap,
  clamp,
  formatTime,
  getPaceConfig,
  getStreakMultiplier,
  randomObjectType,
} from "../src/gameLogic.js";
import {
  filterHandPosition,
  getPalmCenter,
  getPoseHands,
  mapCameraPoint,
  presentHandSlots,
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
});

describe("hand tracking helpers", () => {
  it("uses both anatomical wrists and rejects occluded wrists instead of inventing hands", () => {
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1, presence: 1 }));
    landmarks[15] = { x: 0.3, y: 0.4, visibility: 0.9, presence: 1 };
    landmarks[16] = { x: 0.7, y: 0.4, visibility: 0.9, presence: 1 };
    const hands = getPoseHands(landmarks);
    expect(hands.map((hand) => hand.label)).toEqual(["Left", "Right"]);
    expect(hands.every((hand) => hand.stableSide)).toBe(true);
    landmarks[15].visibility = 0.1;
    expect(getPoseHands(landmarks).map((hand) => hand.label)).toEqual(["Right"]);
  });

  it("keeps pose sides in fixed slots through dropout and changed result order", () => {
    const right = { x: 0.7, y: 0.4, label: "Right", stableSide: true };
    const left = { x: 0.3, y: 0.4, label: "Left", stableSide: true };
    let slots = updateHandSlots([], [right], 1000);
    expect(slots[0]).toBeNull();
    expect(slots[1].label).toBe("Right");
    slots = updateHandSlots(slots, [right, left], 1040);
    expect(slots.map((slot) => slot.label)).toEqual(["Left", "Right"]);
  });

  it("maps tracking onto the same crop as object-fit cover", () => {
    const point = { x: 0.6, y: 0.6 };
    expect(mapCameraPoint(point, 640, 360, 1280, 720)).toEqual(point);
    // A 16:9 camera covering a 4:3 board crops the horizontal edges.
    expect(mapCameraPoint(point, 640, 360, 800, 600).x).toBeCloseTo(0.6333333);
    expect(mapCameraPoint({ x: 0.5, y: 0.5 }, 640, 360, 800, 600)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("uses capture age to disable stale collisions and caps prediction at camera edges", () => {
    const slots = [{ x: 0.95, y: 0.95, velocityX: 10, velocityY: 10, lastSeen: 1000 }];
    const fresh = presentHandSlots(slots, [], 1040)[0];
    expect(fresh.x).toBeLessThanOrEqual(0.97);
    expect(fresh.y).toBeLessThanOrEqual(0.96);
    expect(fresh.interactive).toBe(true);
    expect(presentHandSlots(slots, [], 1200)[0].interactive).toBe(false);
    expect(presentHandSlots(slots, [], 1400)[0]).toBeNull();
  });

  it("uses the stable palm landmarks as the cursor anchor", () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    [0, 5, 9, 13, 17].forEach((index) => { landmarks[index] = { x: 0.4, y: 0.6 }; });
    expect(getPalmCenter(landmarks)).toEqual({ x: 0.4, y: 0.6 });
  });

  it("ignores invalid palm points without producing a NaN cursor", () => {
    expect(getPalmCenter([{ x: NaN, y: 0.5 }])).toBeNull();
    expect(getPalmCenter([{ x: 0.4, y: 0.6 }])).toEqual({ x: 0.4, y: 0.6 });
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
});
