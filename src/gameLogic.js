export const PACE_CONFIG = Object.freeze({
  gentle: { fallSpeed: 42, spawnInterval: 1800, maxObjects: 3, missLimit: 10 },
  steady: { fallSpeed: 58, spawnInterval: 1350, maxObjects: 4, missLimit: 8 },
  lively: { fallSpeed: 76, spawnInterval: 1000, maxObjects: 5, missLimit: 6 },
});

export const OBJECT_TYPES = Object.freeze([
  { kind: "leaf", symbol: "🍃", label: "leaf", points: 10 },
  { kind: "flower", symbol: "✿", label: "flower", points: 15 },
  { kind: "heart", symbol: "♥", label: "heart", points: 20 },
  { kind: "star", symbol: "★", label: "star", points: 25 },
]);

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
  return OBJECT_TYPES[Math.floor(random() * OBJECT_TYPES.length)] ?? OBJECT_TYPES[0];
}
