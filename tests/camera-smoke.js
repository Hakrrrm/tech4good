// Exercise the real application, worker and video pipeline without camera permissions.
import "../src/styles.css";

const html = await (await fetch("../index.html")).text();
const parsed = new DOMParser().parseFromString(html, "text/html");
parsed.querySelectorAll("script").forEach((script) => script.remove());
document.body.replaceChildren(...parsed.body.childNodes);
const bitmap = await createImageBitmap(await (await fetch("./fixtures/pose.jpg")).blob());
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 360;
const context = canvas.getContext("2d");
const twoPeople = new URLSearchParams(location.search).has("pvp");
const paint = () => {
  if (twoPeople) {
    context.fillStyle = "#ddd";
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Two copies of the public test pose; validates multi-person inference, not real-world identity.
    const height = canvas.width / 2 * bitmap.height / bitmap.width;
    context.drawImage(bitmap, 0, (canvas.height - height) / 2, canvas.width / 2, height);
    context.drawImage(bitmap, canvas.width / 2, (canvas.height - height) / 2, canvas.width / 2, height);
  } else context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  requestAnimationFrame(paint);
};
paint();
const streams = [];
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async () => {
    const stream = canvas.captureStream(30);
    streams.push(stream);
    return stream;
  },
} });
await import("../src/main.js");
const report = document.createElement("pre");
report.id = "cameraFixtureReport";
report.style.cssText = "position:fixed;bottom:0;right:0;z-index:20;font-size:10px;background:white;max-width:34rem;max-height:8rem;overflow:hidden;pointer-events:none";
document.body.append(report);
setInterval(() => {
  report.textContent = JSON.stringify({
    ...window.gentleCatchDiagnostics(),
    visibleCursors: [...document.querySelectorAll(".player-cursor")].filter((cursor) => !cursor.hidden).length,
    activeCameraTracks: streams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === "live").length,
  }, null, 1);
}, 1000);
