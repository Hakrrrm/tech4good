import { describe, expect, it } from "vitest";
import { getPosePeople, PersonTracker, updatePersonHandSlots } from "../src/personTracking.js";
import { presentHandSlots } from "../src/handTrackingMath.js";

const person = (screenX, options = {}) => ({
  x: 1 - screenX, y: options.y ?? 0.4, tag: options.tag ?? screenX,
  shoulderWidth: options.width ?? 0.12, torsoLength: options.torso ?? 0.18,
  handsRaised: options.raised ?? true,
  hands: ["Left", "Right"].map((label) => ({
    x: 1 - screenX, y: 0.6, label, stableSide: true,
  })),
});
const hold = (tracker, people) => {
  for (let time = 100; time <= 1000; time += 100) tracker.update(people, time);
};

describe("calibrated person ownership", () => {
  it("waits for a continuous two hand gesture and ignores an unraised bystander", () => {
    const tracker = new PersonTracker(1);
    const player = person(0.4, { tag: "player" });
    const background = person(0.7, { tag: "background", raised: false, width: 0.06 });
    expect(tracker.update([background, player], 100)).toEqual([null]);
    expect(tracker.status(100).progress[0]).toBe(0);
    tracker.update([background, player], 500);
    expect(tracker.status(500).locked).toEqual([false]);
    tracker.update([background, player], 1200); // Long gap resets the hold.
    expect(tracker.status(1200).locked).toEqual([false]);
    for (let time = 1300; time <= 2100; time += 100) tracker.update([background, player], time);
    expect(tracker.status(2100).locked).toEqual([true]);
    expect(tracker.update([background, { ...player, handsRaised: false }], 2200)[0].tag).toBe("player");
  });

  it("needs both PvP players and preserves their identities when pose order reverses", () => {
    const tracker = new PersonTracker(2);
    const left = person(0.25, { tag: "left" });
    const right = person(0.75, { tag: "right" });
    hold(tracker, [right, left]);
    expect(tracker.status(1000).locked).toEqual([true, true]);
    expect(tracker.update([person(0.3, { tag: "left", raised: false }),
      person(0.7, { tag: "right", raised: false })], 1100).map((p) => p.tag)).toEqual(["left", "right"]);
  });

  it("won't replace a briefly lost player with a smaller background person", () => {
    const tracker = new PersonTracker(2);
    hold(tracker, [person(0.25), person(0.75)]);
    const background = person(0.26, { width: 0.05, raised: false });
    expect(tracker.update([background, person(0.72)], 1100).map((p) => p?.playerId ?? null))
      .toEqual([null, 1]);
    expect(tracker.update([background, person(0.7)], 1200).map((p) => p?.playerId ?? null))
      .toEqual([null, 1]);
    expect(tracker.update([person(0.27, { raised: false }), person(0.7)], 1300)
      .map((p) => p?.playerId)).toEqual([0, 1]);
  });

  it("requires a new raised hand gesture near the original spot after a long loss", () => {
    const tracker = new PersonTracker(1);
    hold(tracker, [person(0.3)]);
    tracker.update([], 2100);
    expect(tracker.status(2100).needsRaise).toEqual([true]);
    expect(tracker.update([person(0.3, { raised: false })], 2200)).toEqual([null]);
    expect(tracker.update([person(0.3, { raised: true, width: 0.05 })], 2300)).toEqual([null]);
    expect(tracker.update([person(0.3, { raised: true })], 2400)[0].playerId).toBe(0);
    tracker.invalidate();
    expect(tracker.status(2500).locked).toEqual([true]);
    expect(tracker.update([person(0.3, { raised: false })], 2500)).toEqual([null]);
  });

  it("keeps the start gate ready between slow pose frames but drops it on an actual miss", () => {
    const tracker = new PersonTracker(1);
    hold(tracker, [person(0.3)]);
    expect(tracker.status(1650).recent).toEqual([true]);
    tracker.update([], 1700);
    expect(tracker.status(1700).recent).toEqual([false]);
    expect(tracker.status(2100).needsRaise).toEqual([true]);
  });

  it("refuses an ambiguous pair on one side and never awards stale hands", () => {
    const tracker = new PersonTracker(2);
    for (let time = 100; time <= 1000; time += 100) {
      tracker.update([person(0.22), person(0.29), person(0.75)], time);
    }
    expect(tracker.status(1000).locked).toEqual([false, true]);
    for (let time = 1100; time <= 2000; time += 100) tracker.update([person(0.25), person(0.75)], time);
    const slots = updatePersonHandSlots([], tracker.update([person(0.25), person(0.75)], 2100), 2100);
    expect(presentHandSlots(slots, [], 2150).map((hand) => hand.playerId)).toEqual([0, 0, 1, 1]);
    const missing = updatePersonHandSlots(slots, tracker.update([person(0.75)], 2250), 2250);
    expect(presentHandSlots(missing, [], 2260).map((hand) => hand.interactive))
      .toEqual([false, false, true, true]);
  });

  it("accepts only confident shoulders and raises both wrists above them", () => {
    const pose = [];
    pose[11] = { x: 0.3, y: 0.5, visibility: 0.9 };
    pose[12] = { x: 0.5, y: 0.5, visibility: 0.9 };
    pose[15] = { x: 0.25, y: 0.4, visibility: 0.9 };
    pose[16] = { x: 0.55, y: 0.4, visibility: 0.9 };
    expect(getPosePeople([pose])[0].handsRaised).toBe(true);
    pose[16].y = 0.51;
    expect(getPosePeople([pose])[0].handsRaised).toBe(false);
    pose[12].visibility = 0.1;
    expect(getPosePeople([pose])).toEqual([]);
  });
});
