import { describe, expect, it } from "vitest";
import { circlesOverlap, clamp, formatTime, getPaceConfig, randomObjectType } from "../src/gameLogic.js";

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
