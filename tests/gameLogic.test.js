import { describe, expect, it } from "vitest";
import { circlesOverlap, clamp, formatTime, getPaceConfig, randomObjectType } from "../src/gameLogic.js";
import { adaptiveSmoothing, getPalmCenter, updateHandSlots } from "../src/handTrackingMath.js";

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
});
