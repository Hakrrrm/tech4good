import { describe, expect, it } from "vitest";
import { circlesOverlap, clamp, formatTime, getPaceConfig, randomObjectType } from "../src/gameLogic.js";
import {
  adaptiveSmoothing,
  filterHandPosition,
  getPalmCenter,
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
    expect(randomObjectType(() => 0.99).kind).toBe("star");
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
});
