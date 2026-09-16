import { clamp } from "./gameLogic.js";

export class MotionTracker {
  constructor(video, canvas, onMove) {
    this.video = video;
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { willReadFrequently: true });
    this.onMove = onMove;
    this.previous = null;
    this.frameId = null;
    this.lastSample = 0;
    this.smoothed = { x: 0.5, y: 0.62 };
  }

  start() {
    this.previous = null;
    this.lastSample = 0;
    this.frameId = requestAnimationFrame((time) => this.sample(time));
  }

  stop() {
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.previous = null;
  }

  sample(time) {
    if (time - this.lastSample >= 70 && this.video.readyState >= 2) {
      this.lastSample = time;
      this.processFrame();
    }
    this.frameId = requestAnimationFrame((nextTime) => this.sample(nextTime));
  }

  processFrame() {
    const { width, height } = this.canvas;
    this.context.drawImage(this.video, 0, 0, width, height);
    const pixels = this.context.getImageData(0, 0, width, height).data;
    const grayscale = new Uint8Array(width * height);
    let sumX = 0;
    let sumY = 0;
    let motionCount = 0;

    for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
      const gray = (pixels[index] * 3 + pixels[index + 1] * 6 + pixels[index + 2]) / 10;
      grayscale[pixel] = gray;
      if (this.previous && Math.abs(gray - this.previous[pixel]) > 28) {
        sumX += pixel % width;
        sumY += Math.floor(pixel / width);
        motionCount += 1;
      }
    }

    this.previous = grayscale;
    const ratio = motionCount / (width * height);
    if (ratio < 0.006 || ratio > 0.45) return;

    // The video is mirrored visually, so reverse the source-frame x coordinate.
    const measuredX = 1 - sumX / motionCount / width;
    const measuredY = sumY / motionCount / height;
    const smoothing = 0.28;
    this.smoothed.x += (measuredX - this.smoothed.x) * smoothing;
    this.smoothed.y += (measuredY - this.smoothed.y) * smoothing;
    this.onMove({
      x: clamp(this.smoothed.x, 0.04, 0.96),
      y: clamp(this.smoothed.y, 0.06, 0.94),
      confidence: ratio,
    });
  }
}
