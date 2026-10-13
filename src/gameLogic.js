export const PACE_CONFIG = Object.freeze({
  gentle: { fallSpeed: 42, spawnInterval: 1800, maxObjects: 3, missLimit: 10 },
  steady: { fallSpeed: 58, spawnInterval: 1350, maxObjects: 4, missLimit: 8 },
  lively: { fallSpeed: 76, spawnInterval: 1000, maxObjects: 5, missLimit: 6 },
});

export const OBJECT_TYPES = Object.freeze([
  { kind: "leaf", symbol: "🍃", label: "leaf", points: 10, hazard: false },
  { kind: "flower", symbol: "✿", label: "flower", points: 15, hazard: false },
  { kind: "heart", symbol: "♥", label: "heart", points: 20, hazard: false },
  { kind: "star", symbol: "★", label: "star", points: 25, hazard: false },
]);

export const HAZARD_TYPES = Object.freeze([
  { kind: "bomb", symbol: "💣", label: "TNT bomb", points: -25, hazard: true },
  { kind: "virus", symbol: "🦠", label: "germ", points: -15, hazard: true },
]);

export const MAX_MULTIPLIER = 4;
export const REGISTRATION_COUNTDOWN_MS = 3000;
export const REGISTRATION_STABLE_MS = 900;
export const PLAYER_MISSING_GRACE_MS = 900;
export const RECOVERY_STABLE_MS = 1200;
export const HAND_FRESH_MS = 200;
export const FACE_FRESH_MS = 350;

export const PVP_LANES = Object.freeze([
  Object.freeze({ minX: 0.035, maxX: 0.465 }),
  Object.freeze({ minX: 0.535, maxX: 0.965 }),
]);

export function getRequiredHandCount(playMode) {
  return playMode === "pvp" ? 2 : 1;
}

export function isRegistrationLocked(phase) {
  return phase === "countdown";
}

export function getMissingPlayerIndices(players = [], playerCount = 1) {
  return Array.from({ length: playerCount }, (_, index) => index)
    .filter((index) => !players[index] || players[index].interactive === false);
}

export function getStableRecoveryStart(previousStart, ready, timestamp) {
  if (!ready) return null;
  return previousStart ?? timestamp;
}

export function isFreshDetection(detection, timestamp, maxAgeMs) {
  if (!detection || detection.interactive === false || !Number.isFinite(detection.lastSeen)) return false;
  const age = timestamp - detection.lastSeen;
  return age >= 0 && age <= maxAgeMs;
}

export function isRaisedHandBesideFace(hand, faces = []) {
  if (!hand || hand.y > 0.82) return false;
  return faces.every((face) =>
    Math.abs(hand.x - face.x) > (face.width ?? 0.18) / 2 + 0.015
    || Math.abs(hand.y - face.y) > (face.height ?? 0.24) / 2 + 0.015,
  );
}

export function getOrderedHandEntries(hands = []) {
  return hands
    .map((hand, index) => ({ hand, index }))
    .filter(({ hand }) => Boolean(hand))
    .sort((first, second) => first.hand.x - second.hand.x);
}

export function getPlayerBoundary(faces = []) {
  const ordered = faces.filter((face) => face && face.interactive !== false).sort((a, b) => a.x - b.x);
  if (ordered.length < 2) return null;
  if (ordered[1].x - ordered[0].x < 0.18) return null;
  return clamp((ordered[0].x + ordered[1].x) / 2, 0.25, 0.75);
}

export function assignPvpHands(hands = [], boundary = 0.5, previousPlayers = []) {
  const visible = hands.filter((hand) => hand && hand.interactive !== false);
  return [0, 1].map((ownerIndex) => {
    const candidates = visible.filter((hand) => ownerIndex === 0 ? hand.x < boundary : hand.x >= boundary);
    if (!candidates.length) return null;
    const referenceX = previousPlayers[ownerIndex]?.cameraX ?? (ownerIndex === 0 ? boundary / 2 : (1 + boundary) / 2);
    return candidates.reduce((closest, hand) =>
      Math.abs(hand.x - referenceX) < Math.abs(closest.x - referenceX) ? hand : closest,
    );
  });
}

export function getZonePresence(hands = [], faces = [], boundary = 0.5, playerCount = 2) {
  const visibleHands = hands.filter((hand) => hand && hand.interactive !== false);
  const visibleFaces = faces.filter((face) => face && face.interactive !== false);
  if (playerCount === 1) return [{ hand: visibleHands.length > 0, face: visibleFaces.length > 0 }];
  return [0, 1].map((ownerIndex) => ({
    hand: visibleHands.some((hand) => ownerIndex === 0 ? hand.x < boundary : hand.x >= boundary),
    face: visibleFaces.some((face) => ownerIndex === 0 ? face.x < boundary : face.x >= boundary),
  }));
}

export function mapHandToPvpLane(x, ownerIndex, boundary = 0.5) {
  const laneIndex = ownerIndex === 1 ? 1 : 0;
  const lane = PVP_LANES[laneIndex];
  const positionWithinHalf = laneIndex === 0
    ? clamp(x / boundary)
    : clamp((x - boundary) / (1 - boundary));
  return lane.minX + positionWithinHalf * (lane.maxX - lane.minX);
}

export function getPvpSpawnX(ownerIndex, localPosition = Math.random()) {
  const lane = PVP_LANES[ownerIndex === 1 ? 1 : 0];
  const safePosition = 0.12 + clamp(localPosition) * 0.76;
  return lane.minX + safePosition * (lane.maxX - lane.minX);
}

export function getMatchResult(playerOneScore, playerTwoScore, playMode = "solo") {
  if (playMode !== "pvp") {
    return {
      winner: "solo",
      title: "Lovely movement!",
      message: "A joyful round of reaching, moving and catching.",
    };
  }
  if (playerOneScore === playerTwoScore) {
    return {
      winner: "tie",
      title: "A friendly draw!",
      message: `Both players finished with ${playerOneScore} points.`,
    };
  }
  const winner = playerOneScore > playerTwoScore ? 1 : 2;
  return {
    winner,
    title: `Player ${winner} wins!`,
    message: `Player ${winner} caught the most points this round.`,
  };
}

export function getPaceConfig(pace) {
  return PACE_CONFIG[pace] ?? PACE_CONFIG.gentle;
}

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function circlesOverlap(first, second) {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  const radius = first.radius + second.radius;
  return dx * dx + dy * dy <= radius * radius;
}

export function randomObjectType(random = Math.random) {
  const roll = clamp(random());
  const collectibleChance = 0.82;
  if (roll < collectibleChance) {
    return OBJECT_TYPES[Math.floor((roll / collectibleChance) * OBJECT_TYPES.length)] ?? OBJECT_TYPES[0];
  }
  return HAZARD_TYPES[
    Math.min(Math.floor(((roll - collectibleChance) / (1 - collectibleChance)) * HAZARD_TYPES.length), HAZARD_TYPES.length - 1)
  ];
}

export function getStreakMultiplier(streak) {
  return Math.min(1 + Math.floor(Math.max(0, streak) / 3), MAX_MULTIPLIER);
}

export function applyObjectScore(current, objectType) {
  if (objectType.hazard) {
    const score = Math.max(0, current.score + objectType.points);
    return {
      score,
      streak: 0,
      multiplier: 1,
      delta: score - current.score,
    };
  }

  const streak = current.streak + 1;
  const multiplier = getStreakMultiplier(streak);
  const delta = objectType.points * multiplier;
  return {
    score: current.score + delta,
    streak,
    multiplier,
    delta,
  };
}
