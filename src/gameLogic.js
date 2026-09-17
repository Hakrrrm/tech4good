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
