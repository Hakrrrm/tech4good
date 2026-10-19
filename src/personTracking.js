import { getPoseHands, updateHandSlots } from "./handTrackingMath.js";

const HOLD_IDENTITY_MS = 1200;
const confident = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  && (point.visibility ?? 0) >= 0.5 && (point.presence ?? 1) >= 0.5;

// Associate hands with a visible torso, never with the model's detection order.
export function getPosePeople(poses) {
  return poses.flatMap((landmarks) => {
    const left = landmarks[11];
    const right = landmarks[12];
    if (!confident(left) || !confident(right)) return [];
    return [{
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
      hands: getPoseHands(landmarks),
    }];
  });
}

export class PersonTracker {
  constructor() { this.reset(); }
  reset() { this.tracks = [null, null]; }

  update(people, timestamp) {
    const detections = people.filter((person) => Number.isFinite(person.x) && Number.isFinite(person.y))
      .slice(0, 2).map((person) => ({ ...person, x: 1 - person.x }));
    // Overlapping torsos are ambiguous. Expire cursors instead of awarding guessed hits.
    if (detections.length === 2 && Math.hypot(detections[0].x - detections[1].x, detections[0].y - detections[1].y) < 0.12) {
      return [null, null];
    }
    const cost = (id, index) => {
      if (index < 0) return 1;
      const person = detections[index];
      const old = this.tracks[id];
      if (old && timestamp - old.lastSeen < HOLD_IDENTITY_MS) {
        const distance = Math.hypot(person.x - old.x, person.y - old.y);
        return distance <= 0.18 + Math.min(0.2, (timestamp - old.lastSeen) / 3000)
          ? distance : Infinity;
      }
      // First registration and long-loss reacquisition happen on the named screen side.
      return (id === 0 ? person.x < 0.45 : person.x > 0.55) ? 0.4 : Infinity;
    };
    let best = [-1, -1], bestCost = Infinity;
    for (let a = -1; a < detections.length; a++) {
      for (let b = -1; b < detections.length; b++) {
        if (a >= 0 && a === b) continue;
        const total = cost(0, a) + cost(1, b);
        if (total < bestCost) { best = [a, b]; bestCost = total; }
      }
    }
    return best.map((index, playerId) => {
      if (index < 0) return null;
      const person = detections[index];
      this.tracks[playerId] = { x: person.x, y: person.y, lastSeen: timestamp };
      return { ...person, playerId };
    });
  }
}

export function updatePersonHandSlots(slots, people, timestamp) {
  return [0, 1].flatMap((playerId) =>
    updateHandSlots(slots.slice(playerId * 2, playerId * 2 + 2), people[playerId]?.hands ?? [], timestamp)
      .map((hand) => hand ? { ...hand, playerId } : null));
}
