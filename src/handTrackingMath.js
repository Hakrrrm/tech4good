import { clamp } from "./gameLogic.js";

const PALM_LANDMARKS = [0, 5, 9, 13, 17];
export const MAX_HANDS = 4;
const REACQUIRE_MS = 140;
const TRACKING_GRACE_MS = 140;
const CURSOR_HOLD_MS = 360;
const MIN_CUTOFF = 2.5;
const SPEED_COEFFICIENT = 1.4;
const DERIVATIVE_CUTOFF = 3;
const MAX_PREDICTION_MS = 45;
const MAX_PREDICTION_DISTANCE = 0.075;
const MAX_FACES = 2;
const FACE_TRACKING_GRACE_MS = 550;
const FACE_HOLD_MS = 1100;

export function getPalmCenter(landmarks) {
  const points = PALM_LANDMARKS.map((index) => landmarks[index]).filter(Boolean);
  if (!points.length) return null;
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function smoothingAlpha(cutoff, elapsedSeconds) {
  const timeConstant = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + timeConstant / elapsedSeconds);
}

function lowPass(previous, next, alpha) {
  return previous + (next - previous) * alpha;
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function limitSingleFrameJump(previous, next, elapsedMs) {
  const start = { x: previous.rawX ?? previous.x, y: previous.rawY ?? previous.y };
  const movement = distance(start, next);
  const maximum = 0.16 + 2.4 * (elapsedMs / 1000);
  if (movement <= maximum) return next;
  const scale = maximum / movement;
  return {
    x: start.x + (next.x - start.x) * scale,
    y: start.y + (next.y - start.y) * scale,
  };
}

export function adaptiveSmoothing(previous, next, elapsedMs) {
  if (!previous || elapsedMs > REACQUIRE_MS) return next;
  const distanceMoved = distance(previous, next);
  const alpha = distanceMoved > 0.12 ? 0.86 : distanceMoved > 0.045 ? 0.66 : 0.42;
  return {
    x: lowPass(previous.x, next.x, alpha),
    y: lowPass(previous.y, next.y, alpha),
  };
}

export function filterHandPosition(previous, next, timestamp) {
  const elapsedMs = previous ? timestamp - previous.lastSeen : Infinity;
  if (!previous || elapsedMs > REACQUIRE_MS) {
    return {
      x: next.x,
      y: next.y,
      rawX: next.x,
      rawY: next.y,
      velocityX: 0,
      velocityY: 0,
    };
  }

  const elapsedSeconds = clamp(elapsedMs / 1000, 1 / 120, 0.1);
  const gated = limitSingleFrameJump(previous, next, elapsedMs);
  const previousRawX = previous.rawX ?? previous.x;
  const previousRawY = previous.rawY ?? previous.y;
  const rawVelocityX = (gated.x - previousRawX) / elapsedSeconds;
  const rawVelocityY = (gated.y - previousRawY) / elapsedSeconds;
  const derivativeAlpha = smoothingAlpha(DERIVATIVE_CUTOFF, elapsedSeconds);
  const velocityX = lowPass(previous.velocityX ?? 0, rawVelocityX, derivativeAlpha);
  const velocityY = lowPass(previous.velocityY ?? 0, rawVelocityY, derivativeAlpha);
  const speed = Math.hypot(velocityX, velocityY);
  const positionAlpha = smoothingAlpha(MIN_CUTOFF + SPEED_COEFFICIENT * speed, elapsedSeconds);

  return {
    x: lowPass(previous.x, gated.x, positionAlpha),
    y: lowPass(previous.y, gated.y, positionAlpha),
    rawX: gated.x,
    rawY: gated.y,
    velocityX,
    velocityY,
  };
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

    let slotIndex = -1;
    let matchingDistance = Infinity;
    slots.forEach((slot, index) => {
      if (!slot || usedSlots.has(index) || slot.label !== detection.label || timestamp - slot.lastSeen >= 500) return;
      const candidateDistance = distance({ x: slot.rawX ?? slot.x, y: slot.rawY ?? slot.y }, mirrored);
      if (candidateDistance < matchingDistance && candidateDistance < 0.45) {
        matchingDistance = candidateDistance;
        slotIndex = index;
      }
    });

    if (slotIndex < 0) {
      let nearestDistance = Infinity;
      slots.forEach((slot, index) => {
        if (!slot || usedSlots.has(index) || timestamp - slot.lastSeen >= 500) return;
        const candidateDistance = distance({ x: slot.rawX ?? slot.x, y: slot.rawY ?? slot.y }, mirrored);
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
    const position = filterHandPosition(previous, mirrored, timestamp);
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
      visible: slot.visible || timestamp - slot.lastSeen < TRACKING_GRACE_MS,
    };
  });
}

export function presentHandSlots(slots, previousPresented, timestamp, elapsedMs) {
  const blendAlpha = 1 - Math.exp(-clamp(elapsedMs, 0, 50) / 18);

  return Array.from({ length: MAX_HANDS }, (_, index) => {
    const slot = slots[index];
    if (!slot || timestamp - slot.lastSeen > CURSOR_HOLD_MS) return null;

    const predictionSeconds = clamp(timestamp - slot.lastSeen + 12, 0, MAX_PREDICTION_MS) / 1000;
    let predictionX = (slot.velocityX ?? 0) * predictionSeconds;
    let predictionY = (slot.velocityY ?? 0) * predictionSeconds;
    const predictionDistance = Math.hypot(predictionX, predictionY);
    if (predictionDistance > MAX_PREDICTION_DISTANCE) {
      const scale = MAX_PREDICTION_DISTANCE / predictionDistance;
      predictionX *= scale;
      predictionY *= scale;
    }

    const target = {
      x: clamp(slot.x + predictionX, 0.03, 0.97),
      y: clamp(slot.y + predictionY, 0.04, 0.96),
    };
    const previous = previousPresented[index];
    const position = previous
      ? {
          x: lowPass(previous.x, target.x, blendAlpha),
          y: lowPass(previous.y, target.y, blendAlpha),
        }
      : target;

    return {
      ...slot,
      ...position,
      visible: true,
      interactive: timestamp - slot.lastSeen <= TRACKING_GRACE_MS,
    };
  });
}

function predictedFacePosition(face, timestamp) {
  const elapsedSeconds = clamp((timestamp - face.lastSeen) / 1000, 0, 0.3);
  return {
    x: clamp(face.x + (face.velocityX ?? 0) * elapsedSeconds, 0.02, 0.98),
    y: clamp(face.y + (face.velocityY ?? 0) * elapsedSeconds, 0.02, 0.98),
  };
}

function updateFaceSlot(previous, detection, timestamp) {
  if (!previous || timestamp - previous.lastSeen > FACE_HOLD_MS) {
    return {
      ...detection,
      velocityX: 0,
      velocityY: 0,
      lastSeen: timestamp,
      visible: true,
    };
  }

  const elapsedSeconds = clamp((timestamp - previous.lastSeen) / 1000, 1 / 30, 0.35);
  const velocityX = (detection.x - previous.x) / elapsedSeconds;
  const velocityY = (detection.y - previous.y) / elapsedSeconds;
  return {
    ...detection,
    x: lowPass(previous.x, detection.x, 0.46),
    y: lowPass(previous.y, detection.y, 0.46),
    width: lowPass(previous.width, detection.width, 0.4),
    height: lowPass(previous.height, detection.height, 0.4),
    velocityX: lowPass(previous.velocityX ?? 0, velocityX, 0.35),
    velocityY: lowPass(previous.velocityY ?? 0, velocityY, 0.35),
    lastSeen: timestamp,
    visible: true,
  };
}

export function updateFaceSlots(previousSlots = [], detections = [], timestamp) {
  const slots = Array.from({ length: MAX_FACES }, (_, index) => {
    const previous = previousSlots[index];
    return previous ? { ...previous, visible: false } : null;
  });
  const normalized = detections.slice(0, MAX_FACES).map((face) => ({
    ...face,
    x: clamp(1 - face.x, 0.02, 0.98),
    y: clamp(face.y, 0.02, 0.98),
    width: clamp(face.width, 0.04, 0.9),
    height: clamp(face.height, 0.04, 0.9),
  }));
  const activeSlots = slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot && timestamp - slot.lastSeen <= FACE_HOLD_MS);

  if (!activeSlots.length) {
    normalized.sort((first, second) => first.x - second.x).forEach((face, index) => {
      slots[index] = updateFaceSlot(null, face, timestamp);
    });
  } else if (normalized.length === 2 && activeSlots.length === 2) {
    const predicted = activeSlots.map(({ slot }) => predictedFacePosition(slot, timestamp));
    const directCost = distance(predicted[0], normalized[0]) + distance(predicted[1], normalized[1]);
    const swappedCost = distance(predicted[0], normalized[1]) + distance(predicted[1], normalized[0]);
    const ordered = directCost <= swappedCost ? normalized : [normalized[1], normalized[0]];
    activeSlots.forEach(({ slot, index }, orderIndex) => {
      slots[index] = updateFaceSlot(slot, ordered[orderIndex], timestamp);
    });
  } else {
    const availableSlots = new Set([0, 1]);
    normalized.forEach((face) => {
      let bestIndex = -1;
      let bestDistance = Infinity;
      slots.forEach((slot, index) => {
        if (!slot || !availableSlots.has(index) || timestamp - slot.lastSeen > FACE_HOLD_MS) return;
        const candidateDistance = distance(predictedFacePosition(slot, timestamp), face);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          bestIndex = index;
        }
      });
      if (bestIndex < 0) bestIndex = [...availableSlots][0];
      slots[bestIndex] = updateFaceSlot(slots[bestIndex], face, timestamp);
      availableSlots.delete(bestIndex);
    });
  }

  return slots.map((slot) => {
    if (!slot) return null;
    return {
      ...slot,
      visible: slot.visible || timestamp - slot.lastSeen < FACE_TRACKING_GRACE_MS,
    };
  });
}

export function presentFaceSlots(slots = [], timestamp) {
  return Array.from({ length: MAX_FACES }, (_, index) => {
    const slot = slots[index];
    if (!slot || timestamp - slot.lastSeen > FACE_HOLD_MS) return null;
    return {
      ...slot,
      visible: true,
      interactive: timestamp - slot.lastSeen <= FACE_TRACKING_GRACE_MS,
    };
  });
}
