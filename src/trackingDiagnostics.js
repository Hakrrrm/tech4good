import { median } from "./trackingEngine.js";

function summarize(values) {
  if (!values.length) return { median: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { median: median(sorted), p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export class TrackingDiagnostics {
  constructor() {
    this.samples = { inferenceMs: [], captureMs: [], frameAgeMs: [], renderMs: [] };
    this.model = null;
    this.backend = null;
    this.benchmark = [];
    this.unavailableBackends = [];
    this.frames = 0;
    this.detections = 0;
    this.dropouts = 0;
  }

  record(name, value) {
    if (!Number.isFinite(value)) return;
    const samples = this.samples[name];
    samples.push(value);
    if (samples.length > 180) samples.shift();
  }

  snapshot() {
    return {
      model: this.model, backend: this.backend, benchmark: this.benchmark,
      unavailableBackends: this.unavailableBackends,
      frames: this.frames, detections: this.detections, dropouts: this.dropouts,
      renderFps: this.samples.renderMs.length ? 1000 / median(this.samples.renderMs) : 0,
      ...Object.fromEntries(Object.entries(this.samples).map(([name, values]) => [name, summarize(values)])),
    };
  }
}
