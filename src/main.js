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
  secondPlayerName: $("#secondPlayerName"),
  pvpScoreboard: $("#pvpScoreboard"),
  pvpResults: $("#pvpResults"),
  resultsTitle: $("#resultsTitle"),
  competitorStats: [1, 2].map((id) => ({ name: $(`#p${id}Name`), score: $(`#p${id}Score`), detail: $(`#p${id}Detail`) })),
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
  pvp: false,
  competitors: [],
  awaitingPlayers: false,
  readySince: null,
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
  if (state.pvp) return;
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

function renderGameMode() {
  const pvp = selectedValue("gameMode") === "pvp";
  $("#secondPlayerField").hidden = !pvp;
  $("#pvpGuide").hidden = !pvp;
  elements.setupLeaderboardSlot.hidden = pvp;
  elements.setup.classList.toggle("pvp-setup", pvp);
  $("#playerNameLabel").textContent = pvp ? "Player 1 · left" : "Your name";
  $("#playerNameHint").textContent = pvp ? "Leave blank for Player 1." : "Leave blank to play as Guest.";
  elements.keyboardStart.textContent = pvp ? "Two-player keyboard" : "Play with keyboard";
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
  document.querySelectorAll("#setupPanel input").forEach((input) => { input.disabled = true; });
  elements.cameraStart.disabled = true;
  elements.keyboardStart.disabled = true;
  elements.cameraStart.textContent = "Loading movement tracking…";
  elements.cameraMessage.textContent = "Allow camera access, then show your arms and hands while tracking prepares.";
  try {
    tracker.configure(selectedValue("gameMode") === "pvp" ? 2 : 1);
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
    document.querySelectorAll("#setupPanel input").forEach((input) => { input.disabled = false; });
    elements.cameraStart.disabled = false;
    elements.keyboardStart.disabled = false;
    elements.cameraStart.innerHTML = '<span aria-hidden="true">◉</span> Use camera &amp; start';
  }
}

function startSession(mode) {
  state.pvp = selectedValue("gameMode") === "pvp";
  state.competitors = [elements.playerName, elements.secondPlayerName].map((input, index) => ({
    name: input.value.trim() ? normalizePlayerName(input.value) : `Player ${index + 1}`,
    score: 0, streak: 0, multiplier: 1, bestStreak: 0, caught: 0, missed: 0,
  }));
  state.awaitingPlayers = state.pvp && mode === "camera";
  state.readySince = null;
  state.keys.clear();
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
  if (state.pvp && mode === "keyboard") {
    state.players = [{ x: 0.25, y: 0.72, radius: 44, playerId: 0 }, null,
      { x: 0.75, y: 0.72, radius: 44, playerId: 1 }, null];
  }

  elements.targets.replaceChildren();
  elements.setup.hidden = true;
  elements.results.hidden = true;
  elements.play.hidden = false;
  elements.play.classList.toggle("pvp-play", state.pvp);
  elements.pvpScoreboard.hidden = !state.pvp;
  $("#pvpLanes").hidden = !state.pvp;
  elements.board.classList.toggle("pvp-board", state.pvp);
  $("#playInstructions").textContent = state.pvp ? "Your side · your treats · avoid hazards" : "Catch treats · avoid hazards";
  for (let id = 0; id < 2; id++) setText(elements.competitorStats[id].name, `P${id + 1} · ${state.competitors[id].name}`);
  measureBoard();
  elements.video.hidden = mode !== "camera";
  elements.trackingStatus.hidden = mode !== "camera";
  trackingCount = -1;
  updateTrackingStatus(0);
  elements.board.classList.toggle("keyboard-mode", mode === "keyboard");
  elements.inputHint.textContent = mode === "camera"
    ? "Your hands control the circles. Keep your arms in view. Catch fruit and local treats; avoid bombs and germs."
    : "Use the arrow keys or W A S D. Catch fruit and local treats; avoid bombs and germs.";
  if (state.pvp) elements.inputHint.textContent = mode === "camera"
    ? "P1: left · P2: right. Stay on your starting sides, with both shoulders visible. Either hand can catch."
    : "P1 (left): W A S D · P2 (right): arrow keys. Catch on your own side. Highest score wins!";
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
  const full = state.pvp
    ? [0, 1].some((id) => state.objects.filter((object) => object.playerId === id).length >= config.maxObjects)
    : state.objects.length >= config.maxObjects;
  if (full || now - state.lastSpawn < config.spawnInterval) return;

  const type = randomObjectType();
  const position = Math.random();
  const drift = (Math.random() - 0.5) * 0.025;
  const phase = Math.random() * Math.PI * 2;
  for (const playerId of state.pvp ? [0, 1] : [null]) {
    const object = {
      id: `${now}-${playerId}-${Math.random()}`,
      type,
      playerId,
      x: state.pvp ? (playerId === 0 ? 0.08 + position * 0.34 : 0.92 - position * 0.34) : 0.1 + position * 0.8,
      y: -0.08,
      radius: 30,
      drift: playerId === 1 ? -drift : drift,
      phase,
    };
    const node = document.createElement("div");
    node.className = `falling-object ${type.kind}`;
    if (type.icon) {
      const icon = document.createElement("img");
      icon.src = type.icon;
      icon.alt = "";
      icon.width = 56;
      icon.height = 56;
      icon.draggable = false;
      node.append(icon);
    } else {
      node.textContent = type.symbol;
    }
    node.dataset.id = object.id;
    if (state.pvp) node.dataset.player = playerId + 1;
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", type.label);
    object.node = node;
    state.objects.push(object);
    elements.targets.append(node);
  }
  state.lastSpawn = now;
}

function updateKeyboard(deltaSeconds) {
  if (state.mode !== "keyboard") return;
  if (state.pvp) {
    for (const [index, keys, minX, maxX] of [[0, ["a", "d", "w", "s"], 0.04, 0.46], [2, ["arrowleft", "arrowright", "arrowup", "arrowdown"], 0.54, 0.96]]) {
      const player = state.players[index];
      const speed = 0.52 * deltaSeconds;
      player.x = clamp(player.x + speed * (Number(state.keys.has(keys[1])) - Number(state.keys.has(keys[0]))), minX, maxX);
      player.y = clamp(player.y + speed * (Number(state.keys.has(keys[3])) - Number(state.keys.has(keys[2]))), 0.06, 0.94);
    }
    return;
  }
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
  if (state.mode === "camera") tracker.presentHands(now);
  if (state.pvp && state.mode === "camera") {
    const ready = [0, 1].map((id) => state.players.some((hand) => hand?.playerId === id && hand.interactive !== false));
    const bothReady = ready.every(Boolean);
    elements.trackingStatus.classList.toggle("two-hands", bothReady);
    setText(elements.trackingStatusText, bothReady
      ? (state.awaitingPlayers ? "Both players ready — hold position…" : "Both players ready")
      : `${ready[0] ? "P1 ready" : "Show P1 on the left"} · ${ready[1] ? "P2 ready" : "Show P2 on the right"}`);
    if (state.awaitingPlayers) {
      if (!bothReady) state.readySince = null;
      else state.readySince ??= now;
      if (state.readySince !== null && now - state.readySince >= 700) {
        state.awaitingPlayers = false;
        state.startedAt = now;
        state.pausedDuration = 0;
        state.lastSpawn = now - getPaceConfig(state.pace).spawnInterval * 0.55;
        elements.statusLive.textContent = "Both players ready. Match started!";
      } else {
        renderCursors();
        state.animationId = requestAnimationFrame(gameLoop);
        return;
      }
    }
  }
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
  const boardHeight = boardSize.height;
  const boardWidth = boardSize.width;
  const fallRate = getPaceConfig(state.pace).fallSpeed / Math.max(boardHeight, 1);

  for (const object of [...state.objects]) {
    if (!state.running) break;
    object.y += fallRate * deltaSeconds;
    const sway = Math.sin(now / 650 + object.phase) * object.drift;
    const displayX = clamp(object.x + sway, 0.05, 0.95);
    object.node.style.transform = `translate(${displayX * boardWidth}px, ${object.y * boardHeight}px)`;

    const caught = state.players.some((player) => player && player.interactive !== false
      && (!state.pvp || player.playerId === object.playerId) && circlesOverlap(
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
  const scorer = state.pvp ? state.competitors[object.playerId] : state;
  const result = applyObjectScore(scorer, object.type);
  scorer.score = result.score;
  scorer.streak = result.streak;
  scorer.multiplier = result.multiplier;
  scorer.bestStreak = Math.max(scorer.bestStreak, scorer.streak);
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

  scorer.caught += 1;
  if (scorer.multiplier > 1) {
    elements.statusLive.textContent = `${object.type.label} caught for ${result.delta} points. ${scorer.multiplier} times streak multiplier.`;
  } else if (scorer.caught === 1 || scorer.caught % 5 === 0) {
    elements.statusLive.textContent = `${scorer.caught} ${scorer.caught === 1 ? "treat" : "treats"} caught.`;
  }
}

function missObject(object) {
  removeObject(object);
  if (state.pvp) {
    state.competitors[object.playerId].missed += 1;
    return;
  }
  state.missed += 1;
  if (state.missed >= getPaceConfig(state.pace).missLimit) endSession("misses");
}

function renderCursors() {
  elements.cursors.forEach((cursor, index) => {
    const player = state.players[index];
    if (cursor.hidden !== !player) cursor.hidden = !player;
    if (!player) return;
    setText(cursor.firstElementChild, state.pvp ? player.playerId + 1 : "");
    cursor.style.transform = `translate3d(${player.x * boardSize.width}px, ${player.y * boardSize.height}px, 0) translate(-50%, -50%)`;
  });
}

function updateStats() {
  if (state.pvp) state.competitors.forEach((player, id) => {
    setText(elements.competitorStats[id].score, player.score);
    setText(elements.competitorStats[id].detail, `Streak ${player.streak} · ×${player.multiplier} · Caught ${player.caught}`);
  });
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
    state.readySince = null;
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
  elements.pvpResults.hidden = !state.pvp;
  elements.resultsLeaderboardSlot.hidden = state.pvp;
  $(".result-stats").hidden = state.pvp;
  elements.resultsTitle.textContent = "Lovely movement!";
  if (state.pvp) {
    const [first, second] = state.competitors;
    const winner = first.score === second.score ? null : first.score > second.score ? 0 : 1;
    elements.resultsTitle.textContent = state.awaitingPlayers ? "Match cancelled" : winner === null
      ? "It's a draw!" : `${state.competitors[winner].name} wins!`;
    elements.resultMessage.textContent = state.awaitingPlayers
      ? "Both players need to be visible before the match starts."
      : `${first.name}: ${first.score} · ${second.name}: ${second.score}. Thanks for playing together!`;
    elements.pvpResults.replaceChildren(...state.competitors.map((player, id) => {
      const card = document.createElement("section");
      card.className = `match-result player-${id === 0 ? "one" : "two"}`;
      const name = document.createElement("h3");
      name.textContent = `P${id + 1} · ${player.name}`;
      const score = document.createElement("strong");
      score.textContent = `${player.score} points`;
      const detail = document.createElement("p");
      detail.textContent = `${player.caught} caught · Best streak ${player.bestStreak} · ${player.missed} missed`;
      card.append(name, score, detail);
      return card;
    }));
    elements.statusLive.textContent = `${elements.resultsTitle.textContent} ${elements.resultMessage.textContent}`;
    elements.playAgain.focus({ preventScroll: true });
    return;
  }
  elements.finalScore.textContent = state.score;
  elements.finalCaught.textContent = state.caught;
  elements.finalStreak.textContent = state.bestStreak;
  elements.resultMessage.textContent = reason === "misses"
    ? `You caught ${state.caught} ${state.caught === 1 ? "treat" : "treats"}. Time for a gentle rest.`
    : `You caught ${state.caught} ${state.caught === 1 ? "treat" : "treats"}.`;
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
document.querySelectorAll('input[name="gameMode"]').forEach((input) => input.addEventListener("change", renderGameMode));
renderGameMode();
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => state.keys.clear());
window.addEventListener("beforeunload", () => {
  stopCamera();
  tracker.dispose();
  boardObserver.disconnect();
});
