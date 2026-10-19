import "./styles.css";
import { applyObjectScore, circlesOverlap, clamp, formatTime, getPaceConfig, randomObjectType } from "./gameLogic.js";
import { HandTracker } from "./handTracker.js";
import { mapCameraPoint } from "./handTrackingMath.js";
import { createLeaderboardStore, normalizePlayerName } from "./leaderboard.js";

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
  playerName: $("#playerName"),
  leaderboard: $("#leaderboard"),
  leaderboardEntries: $("#leaderboardEntries"),
  leaderboardCategory: $("#leaderboardCategory"),
  leaderboardEmpty: $("#leaderboardEmpty"),
  leaderboardStorage: $("#leaderboardStorage"),
  leaderboardPrevious: $("#leaderboardPrevious"),
  leaderboardNext: $("#leaderboardNext"),
  leaderboardDuration: $("#leaderboardDuration"),
  setupLeaderboardSlot: $("#setupLeaderboardSlot"),
  resultsLeaderboardSlot: $("#resultsLeaderboardSlot"),
};

const leaderboardStore = createLeaderboardStore();
const paceLabels = { gentle: "Gentle", steady: "Steady", lively: "Lively" };
const leaderboardDurations = [20, 30, 60];
const leaderboardView = { pace: "gentle", durationSeconds: 30 };

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
  durationSeconds: 30,
  remainingSeconds: 30,
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
  starting: false,
  playerName: "Guest",
  sessionId: null,
};

const boardSize = { width: 1, height: 1 };
function measureBoard() {
  boardSize.width = Math.max(elements.board.clientWidth, 1);
  boardSize.height = Math.max(elements.board.clientHeight, 1);
}
const boardObserver = new ResizeObserver(measureBoard);
boardObserver.observe(elements.board);
const trackingOptions = new URLSearchParams(window.location.search);
const tracker = new HandTracker(elements.video, (hands) => {
  if (state.running && !state.paused && state.mode === "camera") {
    state.players = hands.map((hand) => hand ? {
      ...mapCameraPoint(hand, elements.video.videoWidth, elements.video.videoHeight, boardSize.width, boardSize.height),
      radius: 44,
    } : null);
  }
}, (status) => {
  if (!state.running || state.mode !== "camera") return;
  if (status.type === "tracking") updateTrackingStatus(status.count);
  if (status.type === "error") {
    trackingCount = -1;
    const message = status.fatal
      ? "Tracking stopped — end this session and start again."
      : "Tracking is recovering…";
    elements.trackingStatusText.textContent = message;
    elements.statusLive.textContent = message;
  }
}, {
  model: trackingOptions.get("tracker") === "hands" ? "hands" : "pose",
  backend: ["CPU", "GPU"].includes(trackingOptions.get("backend")) ? trackingOptions.get("backend") : null,
});

// Local, read-only diagnostics: no image data or network/telemetry.
window.gentleCatchDiagnostics = () => tracker.diagnostics.snapshot();
let trackingCount = -1;

function updateTrackingStatus(count) {
  if (count === trackingCount) return;
  trackingCount = count;
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

function renderLeaderboard(pace, durationSeconds, board = leaderboardStore.list(pace, durationSeconds)) {
  leaderboardView.pace = pace;
  leaderboardView.durationSeconds = durationSeconds;
  elements.leaderboardDuration.textContent = durationSeconds === 60 ? "1 min" : `${durationSeconds}s`;
  elements.leaderboardCategory.textContent = `${paceLabels[pace]} · ${durationSeconds === 60 ? "1 min" : `${durationSeconds} sec`}`;
  elements.leaderboardEntries.replaceChildren(...board.entries.map((entry) => {
    const row = document.createElement("li");
    row.className = "leaderboard-entry";
    row.classList.toggle("current-score", entry.id === state.sessionId);
    const player = document.createElement("span");
    player.className = "leaderboard-player";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const mode = document.createElement("small");
    mode.textContent = entry.mode === "camera" ? "Camera" : "Keyboard";
    player.append(name, mode);
    const score = document.createElement("strong");
    score.className = "leaderboard-score";
    score.textContent = String(entry.score);
    score.setAttribute("aria-label", `${entry.score} points`);
    row.append(player, score);
    return row;
  }));
  elements.leaderboardEmpty.hidden = board.entries.length > 0;
  elements.leaderboardStorage.textContent = board.persistent
    ? "Names and scores stay in this browser on this device."
    : "Browser storage is unavailable. Scores are temporary and may be lost on refresh.";
}

function renderSetupLeaderboard() {
  renderLeaderboard(selectedValue("pace"), Number(selectedValue("duration")));
}

function browseLeaderboard(direction) {
  const index = leaderboardDurations.indexOf(leaderboardView.durationSeconds);
  const nextIndex = (index + direction + leaderboardDurations.length) % leaderboardDurations.length;
  renderLeaderboard(leaderboardView.pace, leaderboardDurations[nextIndex]);
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access needs localhost or a secure HTTPS page.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 480 },
      facingMode: "user",
      frameRate: { ideal: 30, max: 30 },
    },
  });
  state.stream = stream;
  elements.video.srcObject = stream;
  await elements.video.play();
}

function stopCamera() {
  tracker.stop();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
}

async function startWithCamera() {
  if (state.starting || state.running) return;
  state.starting = true;
  elements.cameraStart.disabled = true;
  elements.keyboardStart.disabled = true;
  elements.cameraStart.textContent = "Loading hand tracking…";
  elements.cameraMessage.textContent = "Allow camera access, then show your arms and hands while tracking prepares.";
  try {
    const startup = await Promise.allSettled([requestCamera(), tracker.initialize()]);
    const failure = startup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    elements.cameraStart.textContent = "Preparing movement tracking…";
    await tracker.warmUp();
    startSession("camera");
    tracker.start();
  } catch (error) {
    stopCamera();
    elements.cameraMessage.textContent = `${error.message || "The camera could not start."} You can still play with the keyboard.`;
    elements.keyboardStart.focus();
  } finally {
    state.starting = false;
    elements.cameraStart.disabled = false;
    elements.keyboardStart.disabled = false;
    elements.cameraStart.innerHTML = '<span aria-hidden="true">◉</span> Use camera &amp; start';
  }
}

function startSession(mode) {
  state.playerName = normalizePlayerName(elements.playerName.value);
  state.sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${performance.now()}-${Math.random().toString(36).slice(2)}`;
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
  state.durationSeconds = Number(selectedValue("duration"));
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
  measureBoard();
  elements.video.hidden = mode !== "camera";
  elements.trackingStatus.hidden = mode !== "camera";
  updateTrackingStatus(0);
  elements.board.classList.toggle("keyboard-mode", mode === "keyboard");
  elements.inputHint.textContent = mode === "camera"
    ? "Your hands control the circles. Keep your arms in view. Catch garden shapes and avoid bombs and germs."
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
  if (state.mode === "camera") tracker.presentHands(now);
  spawnObject(now);
  updateObjects(deltaSeconds, now);
  updateStats();
  renderCursors();
  state.animationId = requestAnimationFrame(gameLoop);
}

function updateObjects(deltaSeconds, now) {
  const boardHeight = boardSize.height;
  const boardWidth = boardSize.width;
  const fallRate = getPaceConfig(state.pace).fallSpeed / Math.max(boardHeight, 1);

  for (const object of [...state.objects]) {
    if (!state.running) break;
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
    if (cursor.hidden !== !player) cursor.hidden = !player;
    if (!player) return;
    cursor.style.transform = `translate3d(${player.x * boardSize.width}px, ${player.y * boardSize.height}px, 0) translate(-50%, -50%)`;
  });
}

function updateStats() {
  const config = getPaceConfig(state.pace);
  setText(elements.score, state.score);
  setText(elements.streak, state.streak);
  setText(elements.multiplier, `×${state.multiplier}`);
  elements.multiplier.classList.toggle("active", state.multiplier > 1);
  setText(elements.caught, state.caught);
  setText(elements.missed, state.missed);
  setText(elements.missLimit, config.missLimit);
  setText(elements.time, formatTime(state.remainingSeconds));
}

function setText(element, value) {
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
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
  if (state.playerName !== "Guest") {
    elements.resultMessage.textContent = `${state.playerName}, ${elements.resultMessage.textContent.replace(/^You/, "you")}`;
  }
  const board = leaderboardStore.save({
    id: state.sessionId, name: state.playerName, score: state.score,
    pace: state.pace, durationSeconds: state.durationSeconds, mode: state.mode, endedAt: Date.now(),
  });
  elements.resultsLeaderboardSlot.append(elements.leaderboard);
  renderLeaderboard(state.pace, state.durationSeconds, board);
  elements.statusLive.textContent = "Session complete.";
  elements.results.scrollIntoView({ block: "start" });
  elements.playAgain.focus({ preventScroll: true });
}

function resetToSetup() {
  elements.results.hidden = true;
  elements.setup.hidden = false;
  elements.cameraMessage.textContent = "";
  elements.setupLeaderboardSlot.append(elements.leaderboard);
  renderSetupLeaderboard();
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
elements.leaderboardPrevious.addEventListener("click", () => browseLeaderboard(-1));
elements.leaderboardNext.addEventListener("click", () => browseLeaderboard(1));
document.querySelectorAll('input[name="pace"], input[name="duration"]').forEach((input) => {
  input.addEventListener("change", renderSetupLeaderboard);
});
window.addEventListener("storage", () => {
  if (!state.running) {
    renderLeaderboard(leaderboardView.pace, leaderboardView.durationSeconds);
  }
});
renderSetupLeaderboard();
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => state.keys.clear());
window.addEventListener("beforeunload", () => {
  stopCamera();
  tracker.dispose();
  boardObserver.disconnect();
});
