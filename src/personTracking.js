import { getPoseHands, updateHandSlots } from "./handTrackingMath.js";

const CALIBRATION_HOLD_MS = 850;
const CALIBRATION_GAP_MS = 650;
const LOST_TRACK_MS = 1000;
const MIN_MATCH_MARGIN = 0.055;

const confident = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  && (point.visibility ?? 0) >= 0.5 && (point.presence ?? 1) >= 0.5;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const relativeDifference = (a, b) => a && b ? Math.abs(a / b - 1) : 0;

// Keep a small, local body signature. No face data, image pixels, or stored biometrics.
export function getPosePeople(poses) {
  return poses.flatMap((landmarks) => {
    const left = landmarks[11];
    const right = landmarks[12];
    if (!confident(left) || !confident(right)) return [];
    const shoulder = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const wristLeft = landmarks[15];
    const wristRight = landmarks[16];
    const handsRaised = confident(wristLeft) && confident(wristRight)
      && wristLeft.y < left.y - 0.045 && wristRight.y < right.y - 0.045;
    const hipLeft = landmarks[23];
    const hipRight = landmarks[24];
    const hip = confident(hipLeft) && confident(hipRight)
      ? { x: (hipLeft.x + hipRight.x) / 2, y: (hipLeft.y + hipRight.y) / 2 } : null;
    return [{
      ...shoulder,
      shoulderWidth: distance(left, right),
      torsoLength: hip ? distance(shoulder, hip) : null,
      handsRaised,
      hands: getPoseHands(landmarks),
    }];
  });
}

export class PersonTracker {
  constructor(numPeople = 2) {
    this.numPeople = numPeople;
    this.reset();
  }
  reset() {
    this.tracks = Array(this.numPeople).fill(null);
    this.candidates = Array(this.numPeople).fill(null);
    this.active = Array(this.numPeople).fill(false);
  }
  invalidate() {
    this.active = [false, false];
    this.candidates = [null, null];
    this.tracks.forEach((track) => {
      if (track) track.lastSeen = -Infinity;
    });
  }
  status(timestamp) {
    return {
      locked: this.tracks.map(Boolean),
      progress: this.candidates.map((candidate, id) =>
        this.tracks[id] ? 1 : candidate
          && timestamp - candidate.lastSeen <= CALIBRATION_GAP_MS
          ? Math.min(1, (timestamp - candidate.since) / CALIBRATION_HOLD_MS) : 0),
      active: [...this.active],
      recent: this.tracks.map((track, id) => Boolean(track && this.active[id]
        && track.lastHands && timestamp - track.lastSeen <= LOST_TRACK_MS)),
      needsRaise: this.tracks.map((track) => Boolean(track
        && timestamp - track.lastSeen > LOST_TRACK_MS)),
    };
  }
  onSide(person, id) {
    if (this.numPeople === 1) return true;
    return id === 0 ? person.x < 0.46 : person.x > 0.54;
  }
  similar(track, person) {
    return relativeDifference(person.shoulderWidth, track.shoulderWidth) <= 0.32
      && relativeDifference(person.torsoLength, track.torsoLength) <= 0.38;
  }
  matchCost(track, person, id, timestamp) {
    if (!this.onSide(person, id) || !this.similar(track, person)
      || distance(person, { x: track.originX, y: track.originY }) > 0.25) return Infinity;
    const lost = timestamp - track.lastSeen > LOST_TRACK_MS;
    // A torso that remained visible can temporarily lose a wrist without losing its lock.
    // Once the torso is lost, only a fresh raised-hands gesture near the original spot relocks it.
    if (lost && (!person.handsRaised
      || distance(person, { x: track.originX, y: track.originY }) > 0.16)) return Infinity;
    const movement = distance(person, track);
    if (!lost && movement > 0.12 + Math.min(0.1, (timestamp - track.lastSeen) / 3000)) return Infinity;
    return movement
      + relativeDifference(person.shoulderWidth, track.shoulderWidth) * 0.1
      + relativeDifference(person.torsoLength, track.torsoLength) * 0.06;
  }
  update(people, timestamp) {
    const detections = people.filter((person) => Number.isFinite(person.x) && Number.isFinite(person.y))
      .map((person) => ({ ...person, x: 1 - person.x }));
    this.active = Array(this.numPeople).fill(false);
    const assigned = Array(this.numPeople).fill(null);
    const used = new Set();

    // Match locked players first; a new raised-hands candidate cannot take their slot.
    for (let id = 0; id < this.numPeople; id++) {
      const track = this.tracks[id];
      if (!track) continue;
      const ranked = detections.map((person, index) => ({
        index, cost: used.has(index) ? Infinity : this.matchCost(track, person, id, timestamp),
      })).sort((a, b) => a.cost - b.cost);
      if (!Number.isFinite(ranked[0]?.cost)
        || (Number.isFinite(ranked[1]?.cost) && ranked[1].cost - ranked[0].cost < MIN_MATCH_MARGIN)) continue;
      const { index } = ranked[0];
      const person = detections[index];
      used.add(index);
      track.x = person.x;
      track.y = person.y;
      track.lastSeen = timestamp;
      track.lastHands = person.hands.length > 0;
      this.active[id] = true;
      assigned[id] = { ...person, playerId: id };
    }

    for (let id = 0; id < this.numPeople; id++) {
      if (this.tracks[id]) continue;
      const eligible = detections.map((person, index) => ({ person, index }))
        .filter(({ person, index }) => !used.has(index) && this.onSide(person, id) && person.handsRaised
          && person.shoulderWidth > 0.025);
      // Two raised people on one side are ambiguous; wait for a clear view.
      if (eligible.length !== 1) {
        this.candidates[id] = null;
        continue;
      }
      const { person, index } = eligible[0];
      let candidate = this.candidates[id];
      if (!candidate || timestamp - candidate.lastSeen > CALIBRATION_GAP_MS
        || distance(candidate, person) > 0.10 || !this.similar(candidate, person)) {
        candidate = { ...person, since: timestamp, samples: 0 };
      }
      candidate.lastSeen = timestamp;
      candidate.samples += 1;
      this.candidates[id] = candidate;
      if (timestamp - candidate.since < CALIBRATION_HOLD_MS || candidate.samples < 3) continue;
      this.tracks[id] = {
        x: person.x, y: person.y, originX: person.x, originY: person.y,
        shoulderWidth: person.shoulderWidth, torsoLength: person.torsoLength,
        lastSeen: timestamp, lastHands: person.hands.length > 0,
      };
      this.candidates[id] = null;
      this.active[id] = true;
      used.add(index);
      assigned[id] = { ...person, playerId: id };
    }
    return assigned;
  }
}

export function updatePersonHandSlots(slots, people, timestamp) {
  return Array.from({ length: people.length }, (_, playerId) =>
    updateHandSlots(slots.slice(playerId * 2, playerId * 2 + 2), people[playerId]?.hands ?? [], timestamp)
      .map((hand) => hand ? { ...hand, playerId } : null)).flat();
}
