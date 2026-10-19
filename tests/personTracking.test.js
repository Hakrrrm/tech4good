import { describe, expect, it } from "vitest";
import { getPosePeople, PersonTracker, updatePersonHandSlots } from "../src/personTracking.js";
import { presentHandSlots } from "../src/handTrackingMath.js";

const person = (screenX, tag = screenX) => ({ x: 1 - screenX, y: 0.4, tag,
  hands: ["Left", "Right"].map((label) => ({ x: 1 - screenX, y: 0.6, label, stableSide: true })) });

describe("two-person ownership", () => {
  it("registers screen sides and preserves identities when model order changes", () => {
    const tracker = new PersonTracker();
    expect(tracker.update([person(0.75, "B"), person(0.25, "A")], 100).map((p) => p.tag)).toEqual(["A", "B"]);
    expect(tracker.update([person(0.3, "A"), person(0.7, "B")], 150).map((p) => p.tag)).toEqual(["A", "B"]);
  });
  it("does not give a missing person's hands to the remaining player", () => {
    const tracker = new PersonTracker();
    tracker.update([person(0.25), person(0.75)], 100);
    expect(tracker.update([person(0.72)], 150).map((p) => p?.playerId ?? null)).toEqual([null, 1]);
    expect(tracker.update([person(0.28), person(0.7)], 300).map((p) => p?.playerId)).toEqual([0, 1]);
  });
  it("rejects ambiguous overlapping torsos and reacquires on starting sides after long loss", () => {
    const tracker = new PersonTracker();
    tracker.update([person(0.25), person(0.75)], 100);
    expect(tracker.update([person(0.48), person(0.52)], 200)).toEqual([null, null]);
    expect(tracker.update([person(0.2), person(0.8)], 2000).map((p) => p.playerId)).toEqual([0, 1]);
  });
  it("keeps four independent hand slots and retires lost-player collision eligibility", () => {
    const tracker = new PersonTracker();
    const people = tracker.update([person(0.25), person(0.75)], 100);
    let slots = updatePersonHandSlots([], people, 100);
    expect(presentHandSlots(slots, [], 110).map((hand) => [hand.playerId, hand.x]))
      .toEqual([[0, 0.25], [0, 0.25], [1, 0.75], [1, 0.75]]);
    slots = updatePersonHandSlots(slots, tracker.update([person(0.75)], 250), 250);
    const shown = presentHandSlots(slots, [], 260);
    expect(shown.map((hand) => hand.interactive)).toEqual([false, false, true, true]);
    expect(presentHandSlots(slots, [], 500).slice(0, 2)).toEqual([null, null]);
  });
  it("requires a confident torso, and never fabricates an occluded wrist", () => {
    const landmarks = [];
    landmarks[11] = { x: 0.2, y: 0.3, visibility: 0.9 };
    landmarks[12] = { x: 0.4, y: 0.3, visibility: 0.9 };
    landmarks[15] = { x: 0.1, y: 0.5, visibility: 0.9 };
    landmarks[16] = { x: 0.5, y: 0.5, visibility: 0.1 };
    expect(getPosePeople([landmarks])[0].hands).toHaveLength(1);
    landmarks[12].visibility = 0.1;
    expect(getPosePeople([landmarks])).toEqual([]);
  });
});
