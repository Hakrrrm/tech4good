import { clamp } from "./gameLogic.js";

const PALM_LANDMARKS = [0, 5, 9, 13, 17];
const MAX_HANDS = 2;

export function getPalmCenter(landmarks) {
  const points = PALM_LANDMARKS.map((index) => landmarks[index]).filter(Boolean);
  if (!points.length) return null;
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

export function adaptiveSmoothing(previous, next, elapsedMs) {
  if (!previous || elapsedMs > 180) return next;
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  const alpha = distance > 0.12 ? 0.86 : distance > 0.045 ? 0.66 : 0.42;
  return {
    x: previous.x + (next.x - previous.x) * alpha,
    y: previous.y + (next.y - previous.y) * alpha,
  };
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function updateHandSlots(previousSlots, detections, timestamp) {
  const slots = Array.from({ length: MAX_HANDS }, (_, index) => {
    const previous = previousSlots[index];
    return previous ? { ...previous, visible: false } : null;
  });
  const usedSlots = new Set();

  for (const detection of detections.slice(0, MAX_HANDS)) {
    const mirrored = {
      x: clamp(1 - detection.x, 0.03, 0.97),
      y: clamp(detection.y, 0.04, 0.96),
    };

    let slotIndex = slots.findIndex((slot, index) =>
      !usedSlots.has(index)
      && slot?.label === detection.label
      && timestamp - slot.lastSeen < 1000
      && distance(slot, mirrored) < 0.65,
    );

    if (slotIndex < 0) {
      let nearestDistance = Infinity;
      slots.forEach((slot, index) => {
        if (!slot || usedSlots.has(index) || timestamp - slot.lastSeen >= 500) return;
        const candidateDistance = distance(slot, mirrored);
        if (candidateDistance < nearestDistance && candidateDistance < 0.45) {
          nearestDistance = candidateDistance;
          slotIndex = index;
        }
      });
    }

    if (slotIndex < 0) slotIndex = slots.findIndex((slot, index) => !slot && !usedSlots.has(index));
    if (slotIndex < 0) {
      slotIndex = slots
        .map((slot, index) => ({ index, lastSeen: usedSlots.has(index) ? Infinity : slot.lastSeen }))
        .sort((first, second) => first.lastSeen - second.lastSeen)[0].index;
    }

    const previous = slots[slotIndex];
    const position = adaptiveSmoothing(previous, mirrored, previous ? timestamp - previous.lastSeen : Infinity);
    slots[slotIndex] = {
      ...position,
      label: detection.label,
      confidence: detection.confidence,
      lastSeen: timestamp,
      visible: true,
    };
    usedSlots.add(slotIndex);
  }

  return slots.map((slot) => {
    if (!slot) return null;
    return {
      ...slot,
      visible: slot.visible || timestamp - slot.lastSeen < 110,
    };
  });
}
