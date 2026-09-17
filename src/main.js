import "./styles.css";
import { applyObjectScore, circlesOverlap, clamp, formatTime, getPaceConfig, randomObjectType } from "./gameLogic.js";
import { HandTracker } from "./handTracker.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  setup: $("#setupPanel"),
  play: $("#playPanel"),
  results: $("#resultsPanel"),
  cameraStart: $("#cameraStart"),
  keyboardStart: $("#keyboardStart"),
  cameraMessage: $("#cameraMessage"),
  board: $("#gameBoard"),
  targets: $("#targets"),
  cursors: [...document.querySelectorAll(".player-cursor")],
  trackingStatus: $("#trackingStatus"),
  trackingStatusText: $("#trackingStatus strong"),
  video: $("#cameraVideo"),
  score: $("#scoreValue"),
  streak: $("#streakValue"),
  multiplier: $("#multiplierValue"),
  caught: $("#caughtValue"),
  missed: $("#missedValue"),
  missLimit: $("#missLimit"),
  time: $("#timeValue"),
  pause: $("#pauseButton"),
  end: $("#endButton"),
  pauseOverlay: $("#pauseOverlay"),
  inputHint: $("#inputHint"),
  finalScore: $("#finalScore"),
  finalCaught: $("#finalCaught"),
  finalStreak: $("#finalStreak"),
  resultMessage: $("#resultMessage"),
  playAgain: $("#playAgain"),
  statusLive: $("#statusLive"),
};

const state = {
  running: false,
  paused: false,
  mode: "keyboard",
  score: 0,
  streak: 0,
  multiplier: 1,
  bestStreak: 0,
  caught: 0,
  missed: 0,
  pace: "gentle",
  durationSeconds: 60,
  remainingSeconds: 60,
  startedAt: 0,
  pausedAt: 0,
  pausedDuration: 0,
  lastFrame: 0,
  lastSpawn: 0,
  objects: [],
  players: [],
  keys: new Set(),
  stream: null,
  animationId: null,
};

const tracker = new HandTracker(elements.video, (hands) => {
  if (state.running && !state.paused && state.mode === "camera") {
    state.players = hands.map((hand) => hand ? { ...hand, radius: 44 } : null);
  }
}, (status) => {
  if (!state.running || state.mode !== "camera") return;
  if (status.type === "tracking") updateTrackingStatus(status.count);
  if (status.type === "error") {
    elements.trackingStatusText.textContent = "Tracking is recovering…";
    elements.statusLive.textContent = "Hand tracking is recovering.";
  }
});

function updateTrackingStatus(count) {
  if (count >= 2) {
    elements.trackingStatus.classList.add("two-hands");
    elements.trackingStatusText.textContent = "Two hands ready";
  } else if (count === 1) {
    elements.trackingStatus.classList.remove("two-hands");
    elements.trackingStatusText.textContent = "One hand ready — show your other hand to use both";
  } else {
    elements.trackingStatus.classList.remove("two-hands");
    elements.trackingStatusText.textContent = "Show one or both hands to the camera";
  }
}

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access needs localhost or a secure HTTPS page.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      facingMode: "user",
      frameRate: { ideal: 30, max: 30 },
    },
  });
  elements.video.srcObject = stream;
  await elements.video.play();
  state.stream = stream;
}

function stopCamera() {
  tracker.stop();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
}

async function startWithCamera() {
  elements.cameraStart.disabled = true;
  elements.cameraStart.textContent = "Loading hand tracking…";
  elements.cameraMessage.textContent = "Your browser may ask for camera permission. The hand model stays on this device.";
  try {
    await Promise.all([requestCamera(), tracker.initialize()]);
    tracker.start();
    startSession("camera");
  } catch (error) {
    stopCamera();
    elements.cameraMessage.textContent = `${error.message || "The camera could not start."} You can still play with the keyboard.`;
    elements.keyboardStart.focus();
  } finally {
    elements.cameraStart.disabled = false;
    elements.cameraStart.innerHTML = '<span aria-hidden="true">◉</span> Use camera &amp; start';
  }
}

function startSession(mode) {
  state.running = true;
  state.paused = false;
  state.mode = mode;
  state.score = 0;
  state.streak = 0;
  state.multiplier = 1;
  state.bestStreak = 0;
  state.caught = 0;
  state.missed = 0;
  state.pace = selectedValue("pace");
  state.durationSeconds = Number(selectedValue("duration")) * 60;
  state.remainingSeconds = state.durationSeconds;
  state.startedAt = performance.now();
  state.pausedDuration = 0;
  state.lastFrame = state.startedAt;
  state.lastSpawn = state.startedAt - getPaceConfig(state.pace).spawnInterval * 0.55;
  state.objects = [];
  state.players = mode === "keyboard" ? [{ x: 0.5, y: 0.72, radius: 44 }] : [];

  elements.targets.replaceChildren();
  elements.setup.hidden = true;
  elements.results.hidden = true;
  elements.play.hidden = false;
  elements.video.hidden = mode !== "camera";
  elements.trackingStatus.hidden = mode !== "camera";
  updateTrackingStatus(0);
  elements.board.classList.toggle("keyboard-mode", mode === "keyboard");
  elements.inputHint.textContent = mode === "camera"
    ? "Your palms control the circles. Catch garden shapes and avoid bombs and germs."
    : "Use the arrow keys or W A S D. Catch garden shapes and avoid bombs and germs.";
  elements.pause.textContent = "Pause";
  elements.pauseOverlay.hidden = true;
  updateStats();
  renderCursors();
  elements.play.scrollIntoView({ block: "start" });
  elements.board.focus({ preventScroll: true });
  elements.statusLive.textContent = "Session started.";
  cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(gameLoop);
}

function spawnObject(now) {
  const config = getPaceConfig(state.pace);
  if (state.objects.length >= config.maxObjects || now - state.lastSpawn < config.spawnInterval) return;

  const type = randomObjectType();
  const object = {
    id: `${now}-${Math.random()}`,
    type,
    x: 0.1 + Math.random() * 0.8,
    y: -0.08,
    radius: 30,
    drift: (Math.random() - 0.5) * 0.025,
    phase: Math.random() * Math.PI * 2,
  };
  const node = document.createElement("div");
  node.className = `falling-object ${type.kind}`;
  node.textContent = type.symbol;
  node.dataset.id = object.id;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", type.label);
  object.node = node;
  state.objects.push(object);
  elements.targets.append(node);
  state.lastSpawn = now;
}

function updateKeyboard(deltaSeconds) {
  if (state.mode !== "keyboard") return;
  const player = state.players[0];
  if (!player) return;
  const speed = 0.52 * deltaSeconds;
  if (state.keys.has("arrowleft") || state.keys.has("a")) player.x -= speed;
  if (state.keys.has("arrowright") || state.keys.has("d")) player.x += speed;
  if (state.keys.has("arrowup") || state.keys.has("w")) player.y -= speed;
  if (state.keys.has("arrowdown") || state.keys.has("s")) player.y += speed;
  player.x = clamp(player.x, 0.04, 0.96);
  player.y = clamp(player.y, 0.06, 0.94);
}

function gameLoop(now) {
  if (!state.running) return;
  if (state.paused) {
    state.lastFrame = now;
    state.animationId = requestAnimationFrame(gameLoop);
    return;
  }

  const deltaSeconds = Math.min((now - state.lastFrame) / 1000, 0.05);
  state.lastFrame = now;
  state.remainingSeconds = state.durationSeconds - (now - state.startedAt - state.pausedDuration) / 1000;
  if (state.remainingSeconds <= 0) {
    endSession("time");
    return;
  }

  updateKeyboard(deltaSeconds);
  spawnObject(now);
  updateObjects(deltaSeconds, now);
  updateStats();
  renderCursors();
  state.animationId = requestAnimationFrame(gameLoop);
}

function updateObjects(deltaSeconds, now) {
  const boardHeight = elements.board.clientHeight;
  const boardWidth = elements.board.clientWidth;
  const fallRate = getPaceConfig(state.pace).fallSpeed / Math.max(boardHeight, 1);

  for (const object of [...state.objects]) {
    object.y += fallRate * deltaSeconds;
    const sway = Math.sin(now / 650 + object.phase) * object.drift;
    const displayX = clamp(object.x + sway, 0.05, 0.95);
    object.node.style.transform = `translate(${displayX * boardWidth}px, ${object.y * boardHeight}px)`;

    const caught = state.players.some((player) => player && player.interactive !== false && circlesOverlap(
      { x: displayX * boardWidth, y: object.y * boardHeight, radius: object.radius },
      { x: player.x * boardWidth, y: player.y * boardHeight, radius: player.radius },
    ));
    if (caught) {
      resolveObject(object);
    } else if (object.y > 1.08) {
      if (object.type.hazard) removeObject(object);
      else missObject(object);
    }
  }
}

function removeObject(object) {
  object.node.remove();
  state.objects = state.objects.filter((candidate) => candidate.id !== object.id);
}

function resolveObject(object) {
  const result = applyObjectScore(state, object.type);
  state.score = result.score;
  state.streak = result.streak;
  state.multiplier = result.multiplier;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  object.node.classList.add(object.type.hazard ? "hazard-hit" : "collected");
  setTimeout(() => object.node.remove(), 260);
  state.objects = state.objects.filter((candidate) => candidate.id !== object.id);

  if (object.type.hazard) {
    elements.board.classList.remove("hazard-flash");
    void elements.board.offsetWidth;
    elements.board.classList.add("hazard-flash");
    setTimeout(() => elements.board.classList.remove("hazard-flash"), 300);
    const pointsLost = Math.abs(result.delta);
    elements.statusLive.textContent = pointsLost
      ? `${object.type.label} hit. ${pointsLost} points lost. Streak reset.`
      : `${object.type.label} hit. Streak reset.`;
    return;
  }

  state.caught += 1;
  if (state.multiplier > 1) {
    elements.statusLive.textContent = `${object.type.label} caught for ${result.delta} points. ${state.multiplier} times streak multiplier.`;
  } else if (state.caught === 1 || state.caught % 5 === 0) {
    elements.statusLive.textContent = `${state.caught} shapes caught.`;
  }
}

function missObject(object) {
  removeObject(object);
  state.missed += 1;
  if (state.missed >= getPaceConfig(state.pace).missLimit) endSession("misses");
}

function renderCursors() {
  elements.cursors.forEach((cursor, index) => {
    const player = state.players[index];
    cursor.hidden = !player;
    if (!player) return;
    cursor.style.left = `${player.x * 100}%`;
    cursor.style.top = `${player.y * 100}%`;
  });
}

function updateStats() {
  const config = getPaceConfig(state.pace);
  elements.score.textContent = state.score;
  elements.streak.textContent = state.streak;
  elements.multiplier.textContent = `×${state.multiplier}`;
  elements.multiplier.classList.toggle("active", state.multiplier > 1);
  elements.caught.textContent = state.caught;
  elements.missed.textContent = state.missed;
  elements.missLimit.textContent = config.missLimit;
  elements.time.textContent = formatTime(state.remainingSeconds);
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  if (state.paused) {
    state.pausedAt = performance.now();
    if (state.mode === "camera") tracker.stop();
    elements.pause.textContent = "Continue";
    elements.pauseOverlay.hidden = false;
    elements.statusLive.textContent = "Session paused.";
  } else {
    state.pausedDuration += performance.now() - state.pausedAt;
    state.lastFrame = performance.now();
    if (state.mode === "camera") tracker.start();
    elements.pause.textContent = "Pause";
    elements.pauseOverlay.hidden = true;
    elements.statusLive.textContent = "Session continued.";
    elements.board.focus({ preventScroll: true });
  }
}

function endSession(reason = "ended") {
  if (!state.running) return;
  state.running = false;
  state.paused = false;
  cancelAnimationFrame(state.animationId);
  stopCamera();
  state.objects.forEach((object) => object.node.remove());
  state.objects = [];
  state.players = [];
  renderCursors();

  elements.play.hidden = true;
  elements.results.hidden = false;
  elements.finalScore.textContent = state.score;
  elements.finalCaught.textContent = state.caught;
  elements.finalStreak.textContent = state.bestStreak;
  elements.resultMessage.textContent = reason === "misses"
    ? `You caught ${state.caught} garden ${state.caught === 1 ? "shape" : "shapes"}. Time for a gentle rest.`
    : `You caught ${state.caught} garden ${state.caught === 1 ? "shape" : "shapes"}.`;
  elements.statusLive.textContent = "Session complete.";
  elements.results.scrollIntoView({ block: "start" });
  elements.playAgain.focus({ preventScroll: true });
}

function resetToSetup() {
  elements.results.hidden = true;
  elements.setup.hidden = false;
  elements.cameraMessage.textContent = "";
  elements.setup.scrollIntoView({ block: "start" });
  elements.cameraStart.focus({ preventScroll: true });
}

function handleKeyDown(event) {
  const key = event.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"].includes(key)) {
    if (state.running && state.mode === "keyboard") event.preventDefault();
    state.keys.add(key);
  }
  if (key === " " && state.running && event.target === elements.board) {
    event.preventDefault();
    togglePause();
  }
  if (key === "escape" && state.running) togglePause();
}

elements.cameraStart.addEventListener("click", startWithCamera);
elements.keyboardStart.addEventListener("click", () => startSession("keyboard"));
elements.pause.addEventListener("click", togglePause);
elements.end.addEventListener("click", () => endSession("ended"));
elements.playAgain.addEventListener("click", resetToSetup);
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => state.keys.clear());
window.addEventListener("beforeunload", () => {
  stopCamera();
  tracker.dispose();
});
