import { median } from "../src/trackingEngine.js";

const output = document.querySelector("#results");
const options = new URLSearchParams(location.search);
const model = options.get("tracker") === "hands" ? "hands" : "pose";
const backend = ["CPU", "GPU"].includes(options.get("backend")) ? options.get("backend") : null;
let workerUrl = new URL("../src/handTracker.worker.js", import.meta.url);
const assetRoot = options.has("built") ? new URL("../dist/", location.href) : new URL("../", location.href);
if (options.has("built")) {
  const index = await (await fetch(new URL("index.html", assetRoot))).text();
  const entry = new DOMParser().parseFromString(index, "text/html").querySelector('script[type="module"][src^="/assets/"]').getAttribute("src");
  const code = await (await fetch(new URL(entry.replace(/^\//, ""), assetRoot))).text();
  const bundledWorker = code.match(/\/assets\/handTracker\.worker-[a-zA-Z0-9_-]+\.js/)?.[0];
  if (!bundledWorker) throw new Error("Built tracking worker was not found.");
  workerUrl = new URL(bundledWorker.replace(/^\//, ""), assetRoot);
}
const worker = new Worker(workerUrl, { type: "module" });
let sequence = 0;

function exchange(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Worker timed out")), 60000);
    const listener = ({ data }) => finish(data.type.endsWith("ERROR") ? new Error(data.error) : null, data);
    const errorListener = (event) => finish(new Error(event.message));
    function finish(error, result) {
      clearTimeout(timeout);
      worker.removeEventListener("message", listener);
      worker.removeEventListener("error", errorListener);
      if (error) reject(error);
      else resolve(result);
    }
    worker.addEventListener("message", listener);
    worker.addEventListener("error", errorListener);
    worker.postMessage(message, transfer);
  });
}

try {
  const startedAt = performance.now();
  const ready = await exchange({
    type: "INIT", model, backend,
    wasmBaseUrl: new URL("wasm", assetRoot).href,
    poseModelUrl: new URL("models/pose_landmarker_lite.task", assetRoot).href,
    handModelUrl: new URL("models/hand_landmarker.task", assetRoot).href,
  });
  const image = await createImageBitmap(await (await fetch(new URL("./fixtures/pose.jpg", import.meta.url))).blob());
  const makeBitmap = () => createImageBitmap(image, {
    resizeWidth: model === "hands" ? 512 : 384,
    resizeHeight: Math.round((model === "hands" ? 512 : 384) * image.height / image.width),
  });
  const warmupBitmap = await makeBitmap();
  const prepared = await exchange({ type: "WARMUP", bitmap: warmupBitmap, timestampMs: performance.now() }, [warmupBitmap]);
  const startupMs = performance.now() - startedAt;
  const samples = [];
  let lastHands = [];
  for (let i = 0; i < 30; i++) {
    const timestampMs = performance.now();
    const bitmap = await makeBitmap();
    const result = await exchange({
      type: "DETECT", bitmap, timestampMs, requestId: ++sequence, generation: 1,
    }, [bitmap]);
    samples.push({ inferenceMs: result.inferenceMs, frameAgeMs: performance.now() - timestampMs });
    lastHands = result.hands;
  }
  image.close();
  output.textContent = JSON.stringify({
    passed: ready.model === model && (model !== "pose" || lastHands.length === 2),
    model: ready.model,
    bundledWorker: options.has("built"),
    backend: prepared.backend,
    startupMs,
    benchmark: prepared.benchmark,
    unavailableBackends: prepared.unavailableBackends,
    medianInferenceMs: median(samples.map((sample) => sample.inferenceMs)),
    medianFrameAgeMs: median(samples.map((sample) => sample.frameAgeMs)),
    hands: lastHands,
    sampleCount: samples.length,
  }, null, 2);
} catch (error) {
  output.textContent = JSON.stringify({ passed: false, error: error.message });
} finally {
  worker.terminate();
}
