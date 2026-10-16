import { clamp } from "./gameLogic.js";

const PALM_LANDMARKS = [0, 5, 9, 13, 17];
const MAX_HANDS = 2;
const REACQUIRE_MS = 140;
const TRACKING_GRACE_MS = 140;
const CURSOR_HOLD_MS = 360;
const MIN_CUTOFF = 5;
const SPEED_COEFFICIENT = 2.8;
const DERIVATIVE_CUTOFF = 6;
const MAX_PREDICTION_MS = 45;
const MAX_PREDICTION_DISTANCE = 0.075;

export function getPalmCenter(landmarks) {
  const points = PALM_LANDMARKS.map((index) => landmarks[index])
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return null;
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

export function getPoseHands(landmarks) {
  return [
    { wrist: 15, elbow: 13, label: "Left" },
    { wrist: 16, elbow: 14, label: "Right" },
  ].flatMap(({ wrist: wristIndex, elbow: elbowIndex, label }) => {
    const wrist = landmarks[wristIndex];
    if (
      !wrist || !Number.isFinite(wrist.x) || !Number.isFinite(wrist.y)
      || wrist.x < 0 || wrist.x > 1 || wrist.y < 0 || wrist.y > 1
      || (wrist.visibility ?? 0) < 0.5 || (wrist.presence ?? 1) < 0.5
    ) return [];
    const elbow = landmarks[elbowIndex];
    let x = wrist.x;
    let y = wrist.y;
    if (elbow && Number.isFinite(elbow.x) && Number.isFinite(elbow.y) && (elbow.visibility ?? 0) >= 0.5) {
      // Shift slightly along the visible forearm toward the palm, never inventing an occluded wrist.
      const dx = (wrist.x - elbow.x) * 0.12;
      const dy = (wrist.y - elbow.y) * 0.12;
      const scale = Math.min(1, 0.035 / (Math.hypot(dx, dy) || 1));
      x += dx * scale;
      y += dy * scale;
    }
    return [{ x, y, label, confidence: Math.min(wrist.visibility, wrist.presence ?? 1), stableSide: true }];
  });
}

// The video uses object-fit: cover. Cursor and collision coordinates must share its crop.
export function mapCameraPoint(point, videoWidth, videoHeight, boardWidth, boardHeight) {
  if (!videoWidth || !videoHeight || !boardWidth || !boardHeight) return point;
  const scale = Math.max(boardWidth / videoWidth, boardHeight / videoHeight);
  return {
    ...point,
    x: clamp((point.x * videoWidth * scale - (videoWidth * scale - boardWidth) / 2) / boardWidth, 0.03, 0.97),
    y: clamp((point.y * videoHeight * scale - (videoHeight * scale - boardHeight) / 2) / boardHeight, 0.04, 0.96),
  };
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

  for (const detection of detections.filter((hand) => Number.isFinite(hand.x) && Number.isFinite(hand.y)).slice(0, MAX_HANDS)) {
    const mirrored = {
      x: clamp(1 - detection.x, 0.03, 0.97),
      y: clamp(detection.y, 0.04, 0.96),
    };

    let slotIndex = detection.stableSide
      ? (detection.label === "Left" ? 0 : 1)
      : slots.findIndex((slot, index) =>
      !usedSlots.has(index)
      && slot?.label === detection.label
      && timestamp - slot.lastSeen < 1000
      && distance({ x: slot.rawX ?? slot.x, y: slot.rawY ?? slot.y }, mirrored) < 0.65,
    );

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

export function presentHandSlots(slots, previousPresented, timestamp) {
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
    return {
      ...slot,
      ...target,
      visible: true,
      interactive: timestamp - slot.lastSeen <= TRACKING_GRACE_MS,
    };
  });
}
