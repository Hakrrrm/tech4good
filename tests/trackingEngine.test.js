import { describe, expect, it, vi } from "vitest";
import { TrackingEngine } from "../src/trackingEngine.js";

function factory({ gpuMs = 20, cpuMs = 10, failGpu = false, failPose = false } = {}) {
  let clock = 0;
  const tasks = [];
  const create = vi.fn(async (model, backend) => {
    if (failPose && model === "pose") throw new Error("Pose unavailable");
    if (failGpu && backend === "GPU") throw new Error("GPU unavailable");
    const task = {
      model, backend, close: vi.fn(),
      detectForVideo: vi.fn(() => {
        clock += backend === "GPU" ? gpuMs : cpuMs;
        return { landmarks: [], handedness: [] };
      }),
    };
    tasks.push(task);
    return task;
  });
  return { engine: new TrackingEngine(create, () => clock), tasks, create };
}

describe("tracking backend selection and recovery", () => {
  it("measures both warmed backends and closes the slower one", async () => {
    const { engine, tasks } = factory();
    await engine.initialize();
    const result = engine.calibrate({}, 100);
    expect(result.backend).toBe("CPU");
    expect(result.benchmark).toEqual([{ backend: "CPU", inferenceMs: 10 }, { backend: "GPU", inferenceMs: 20 }]);
    expect(tasks.find((task) => task.backend === "GPU").close).toHaveBeenCalledOnce();
    expect((await engine.detect({}, 110)).backend).toBe("CPU");
    engine.close();
    expect(tasks.every((task) => task.close.mock.calls.length === 1)).toBe(true);
  });

  it("keeps a faster GPU and maintains strictly increasing model timestamps", async () => {
    const { engine, tasks } = factory({ gpuMs: 5 });
    await engine.initialize();
    expect(engine.calibrate({}, 100).backend).toBe("GPU");
    await engine.detect({}, 100);
    const timestamps = tasks.find((task) => task.backend === "GPU").detectForVideo.mock.calls.map((call) => call[1]);
    expect(timestamps.every((timestamp, index) => !index || timestamp > timestamps[index - 1])).toBe(true);
  });

  it("runs on CPU when GPU initialization fails", async () => {
    const { engine } = factory({ failGpu: true });
    await engine.initialize();
    expect(engine.calibrate({}, 100).backend).toBe("CPU");
  });

  it("falls back to the bundled hand model when pose initialization fails", async () => {
    const { engine } = factory({ failPose: true });
    expect((await engine.initialize()).model).toBe("hands");
    expect(engine.calibrate({}, 100).model).toBe("hands");
  });

  it("honors a forced backend for reproducible hardware comparisons", async () => {
    const { engine, create } = factory();
    await engine.initialize("hands", "CPU");
    engine.calibrate({}, 100);
    expect(create).toHaveBeenCalledExactlyOnceWith("hands", "CPU");
  });

  it("rejects a backend that initializes but fails during calibration", async () => {
    const { engine, tasks } = factory({ gpuMs: 1 });
    await engine.initialize();
    tasks[0].detectForVideo.mockImplementation(() => { throw new Error("GPU context failed"); });
    expect(engine.calibrate({}, 100).backend).toBe("CPU");
    expect(tasks[0].close).toHaveBeenCalledOnce();
  });

  it("recovers a selected GPU failure by creating a fresh CPU tracker", async () => {
    const { engine, tasks } = factory({ gpuMs: 1 });
    await engine.initialize();
    engine.calibrate({}, 100);
    tasks[0].detectForVideo.mockImplementation(() => { throw new Error("Context lost"); });
    expect((await engine.detect({}, 200)).backend).toBe("CPU");
    expect(tasks[0].close).toHaveBeenCalledOnce();
  });
});
