import { getPalmCenter, getPoseHands } from "./handTrackingMath.js";
import { getPosePeople } from "./personTracking.js";

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Owns model resources; only one model/backend remains after calibration.
export class TrackingEngine {
  constructor(createModel, now = () => performance.now()) {
    this.createModel = createModel;
    this.now = now;
    this.candidates = [];
    this.selected = null;
    this.lastTimestamp = -1;
    this.model = null;
  }

  async initialize(preferred = "pose", forcedBackend = null, numPeople = 1) {
    this.forcedBackend = forcedBackend;
    this.numPeople = numPeople;
    const errors = [];
    for (const model of numPeople === 2 ? ["pose"] : preferred === "hands" ? ["hands"] : ["pose", "hands"]) {
      for (const backend of forcedBackend ? [forcedBackend] : ["GPU", "CPU"]) {
        try {
          const task = await this.createModel(model, backend);
          this.candidates.push({ task, model, backend });
        } catch (error) {
          errors.push(`${model}/${backend}: ${error.message}`);
        }
      }
      if (this.candidates.length) {
        this.model = model;
        this.initializationErrors = [...errors];
        return { model, backend: this.candidates[0].backend };
      }
    }
    throw new Error(errors.join("; ") || "No tracking backend is available.");
  }

  timestamp(timestampMs) {
    this.lastTimestamp = Math.max(timestampMs, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  detectWith(candidate, bitmap, timestampMs) {
    const startedAt = this.now();
    const result = candidate.task.detectForVideo(bitmap, this.timestamp(timestampMs));
    return { result, inferenceMs: this.now() - startedAt };
  }

  calibrate(bitmap, timestampMs) {
    const scores = [];
    const errors = [...(this.initializationErrors ?? [])];
    for (const candidate of this.candidates) {
      try {
        // Discard initialization cost; compare delegates on the same camera image.
        this.detectWith(candidate, bitmap, timestampMs);
        const samples = Array.from({ length: 3 }, () =>
          this.detectWith(candidate, bitmap, timestampMs).inferenceMs);
        scores.push({ candidate, inferenceMs: median(samples) });
      } catch (error) {
        errors.push(`${candidate.model}/${candidate.backend}: ${error.message}`);
        // A delegate that cannot process frames must not be selected.
      }
    }
    scores.sort((a, b) => a.inferenceMs - b.inferenceMs);
    this.selected = scores[0]?.candidate ?? null;
    for (const candidate of this.candidates) {
      if (candidate !== this.selected) candidate.task.close();
    }
    this.candidates = this.selected ? [this.selected] : [];
    if (!this.selected) throw new Error("The camera frame could not be processed by any tracking backend.");
    return {
      model: this.model,
      backend: this.selected.backend,
      benchmark: scores.map(({ candidate, inferenceMs }) => ({ backend: candidate.backend, inferenceMs })),
      unavailableBackends: errors,
    };
  }

  async detect(bitmap, timestampMs) {
    if (!this.selected) this.calibrate(bitmap, timestampMs);
    let detection;
    try {
      detection = this.detectWith(this.selected, bitmap, timestampMs);
    } catch (error) {
      if (this.selected.backend !== "GPU" || this.forcedBackend) throw error;
      this.selected.task.close();
      this.selected = null;
      this.candidates = [];
      const task = await this.createModel(this.model, "CPU");
      this.selected = { task, model: this.model, backend: "CPU" };
      this.candidates = [this.selected];
      detection = this.detectWith(this.selected, bitmap, timestampMs);
    }

    const hands = this.model === "pose"
      ? getPoseHands(detection.result.landmarks[0] ?? [])
      : detection.result.landmarks.flatMap((landmarks, index) => {
          const palm = getPalmCenter(landmarks);
          if (!palm) return [];
          const category = detection.result.handedness[index]?.[0];
          return [{ ...palm, label: category?.categoryName ?? `hand-${index}`, confidence: category?.score ?? 1 }];
        });
    const people = this.numPeople === 2 ? getPosePeople(detection.result.landmarks) : [];
    return { hands, people, inferenceMs: detection.inferenceMs, backend: this.selected.backend, model: this.model };
  }

  close() {
    for (const candidate of this.candidates) candidate.task.close();
    this.candidates = [];
    this.selected = null;
  }
}
