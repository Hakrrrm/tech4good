import "./styles.css";
import {
  applyObjectScore,
  assignPvpHands,
  circlesOverlap,
  clamp,
  formatTime,
  getMatchResult,
  getMissingPlayerIndices,
  getPlayerBoundary,
  getOrderedHandEntries,
  getPaceConfig,
  getPvpSpawnX,
  getRequiredHandCount,
  getStableRecoveryStart,
  getZonePresence,
  HAND_FRESH_MS,
  FACE_FRESH_MS,
  isFreshDetection,
  isRaisedHandBesideFace,
  isRegistrationLocked,
  mapHandToPvpLane,
  PVP_LANES,
  PLAYER_MISSING_GRACE_MS,
  randomObjectType,
  RECOVERY_STABLE_MS,
  REGISTRATION_COUNTDOWN_MS,
  REGISTRATION_STABLE_MS,
} from "./gameLogic.js";
import { HandTracker } from "./handTracker.js";

const $ = (selector) => document.querySelector(selector);
const panels = [$("#landingPanel"), $("#setupPanel"), $("#registrationPanel"), $("#playPanel"), $("#resultsPanel")];
const elements = {
  landing: $("#landingPanel"),
  setup: $("#setupPanel"),
  registration: $("#registrationPanel"),
  play: $("#playPanel"),
  results: $("#resultsPanel"),
  enterGame: $("#enterGame"),
  backToWelcome: $("#backToWelcome"),
  cameraStart: $("#cameraStart"),
  keyboardStart: $("#keyboardStart"),
  cameraMessage: $("#cameraMessage"),
  cancelRegistration: $("#cancelRegistration"),
  registrationVideo: $("#registrationVideo"),
  registrationPlural: $("#registrationPlural"),
  registrationInstruction: $("#registrationInstruction"),
  registrationStatus: $("#registrationStatus"),
  registrationStatusText: $("#registrationStatus strong"),
  registrationTip: $(".registration-tip"),
  faceModelStatus: $("#faceModelStatus"),
  facePlayers: [$("#facePlayerOne"), $("#facePlayerTwo")],
  registrationCursors: [...document.querySelectorAll("#registrationCursors .player-cursor")],
  registrationFaces: [...document.querySelectorAll("#registrationFaces .face-anchor")],
  playerTwoKey: $("#playerTwoKey"),
  countdownBadge: $("#countdownBadge"),
  countdownValue: $("#countdownValue"),
  board: $("#gameBoard"),
  pvpArena: $("#pvpArena"),
  battleLanes: [...document.querySelectorAll("#pvpArena .battle-lane")],
  laneOneScore: $("#laneOneScore"),
  laneOneStreak: $("#laneOneStreak"),
  laneTwoScore: $("#laneTwoScore"),
  laneTwoStreak: $("#laneTwoStreak"),
  targets: $("#targets"),
  cursors: [...document.querySelectorAll("#playerCursors .player-cursor")],
  trackingStatus: $("#trackingStatus"),
  trackingStatusText: $("#trackingStatus strong"),
  trackingRecovery: $("#trackingRecovery"),
  recoveryTitle: $("#recoveryTitle"),
  recoveryMessage: $("#recoveryMessage"),
  recoveryFaceCheck: $("#recoveryFaceCheck"),
  recoveryHandCheck: $("#recoveryHandCheck"),
  video: $("#cameraVideo"),
  playerOneScore: $("#playerOneScore"),
  playerOneStreak: $("#playerOneStreak"),
  playerTwoScoreCard: $("#playerTwoScoreCard"),
  playerTwoScore: $("#playerTwoScore"),
  playerTwoStreak: $("#playerTwoStreak"),
  caught: $("#caughtValue"),
  missed: $("#missedValue"),
  missLimit: $("#missLimit"),
  time: $("#timeValue"),
  pause: $("#pauseButton"),
  end: $("#endButton"),
  pauseOverlay: $("#pauseOverlay"),
  inputHint: $("#inputHint"),
  resultsTitle: $("#resultsTitle"),
  finalPlayerOneLabel: $("#finalPlayerOneLabel"),
  finalPlayerOneScore: $("#finalPlayerOneScore"),
  finalPlayerTwoCard: $("#finalPlayerTwoCard"),
  finalPlayerTwoScore: $("#finalPlayerTwoScore"),
  finalCaught: $("#finalCaught"),
  resultMessage: $("#resultMessage"),
  playAgain: $("#playAgain"),
  backHome: $("#backHome"),
  statusLive: $("#statusLive"),
};

function emptyPlayerStats() {
  return { score: 0, streak: 0, multiplier: 1, bestStreak: 0, caught: 0 };
}

const state = {
  phase: "landing",
  running: false,
  paused: false,
  inputMode: "keyboard",
  playMode: "solo",
  playerStats: [emptyPlayerStats(), emptyPlayerStats()],
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
  faces: [],
  registrationHands: [],
  keys: new Set(),
  stream: null,
  animationId: null,
  countdownAnimationId: null,
  countdownEndsAt: 0,
  playerFaceSlots: [],
  playerBoundary: 0.5,
  faceTrackingReady: false,
  faceTrackingError: "",
  registrationStatusKey: "",
  lastRegistrationCheck: 0,
  registrationReadySince: null,
  missingPlayerSince: [null, null],
  recoveryActive: false,
  recoveryMissingPlayers: [],
  recoveryStartedAt: 0,
  recoveryReadySince: null,
};

function showPanel(panel, phase) {
  panels.forEach((candidate) => { candidate.hidden = candidate !== panel; });
  state.phase = phase;
  panel.scrollIntoView({ block: "start" });
}

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function configureFromSetup() {
  state.playMode = selectedValue("playMode");
  state.pace = selectedValue("pace");
  state.durationSeconds = Number(selectedValue("duration"));
  state.remainingSeconds = state.durationSeconds;
}

function visibleHandEntries(hands) {
  return getOrderedHandEntries(hands).filter(({ hand }) => hand.interactive !== false);
}

function visibleFaceEntries(faces) {
  return getOrderedHandEntries(faces).filter(({ hand: face }) => face.interactive !== false);
}

function freshTracking(hands, faces, now) {
  const freshFaces = faces.filter((face) => isFreshDetection(face, now, FACE_FRESH_MS));
  return {
    hands: hands.filter((hand) => isFreshDetection(hand, now, HAND_FRESH_MS)
      && isRaisedHandBesideFace(hand, freshFaces)),
    faces: freshFaces,
  };
}

function registrationPlayers(hands) {
  const entries = visibleHandEntries(hands);
  if (state.playMode === "pvp") {
    const boundary = getPlayerBoundary(state.faces) ?? state.playerBoundary;
    return assignPvpHands(hands, boundary).map((hand, ownerIndex) =>
      hand ? { ...hand, radius: 44, ownerIndex } : null,
    );
  }
  return entries.slice(0, 2).map(({ hand }) => ({ ...hand, radius: 44, ownerIndex: 0 }));
}

function gameplayPlayers(hands) {
  if (state.playMode === "pvp") {
    const assigned = assignPvpHands(hands, state.playerBoundary, state.players);
    return assigned.map((hand, ownerIndex) => {
      return hand ? {
        ...hand,
        cameraX: hand.x,
        x: mapHandToPvpLane(hand.x, ownerIndex, state.playerBoundary),
        radius: 44,
        ownerIndex,
      } : null;
    });
  }
  return hands.filter(Boolean).slice(0, 2).map((hand) => ({ ...hand, radius: 44, ownerIndex: 0 }));
}

function activePlayerCount() {
  return state.playMode === "pvp" ? 2 : 1;
}

function updateRecoveryOverlay(hands = [], faces = [], now = performance.now()) {
  const playerCount = activePlayerCount();
  const fresh = freshTracking(hands, faces, now);
  const zones = getZonePresence(fresh.hands, fresh.faces, state.playerBoundary, playerCount);
  const handsReady = zones.every((zone) => zone.hand);
  const facesReady = zones.every((zone) => zone.face);
  const missing = state.recoveryMissingPlayers;
  elements.recoveryTitle.textContent = state.playMode === "pvp" && missing.length === 1
    ? `Player ${missing[0] + 1}, come back into frame`
    : state.playMode === "pvp" ? "Players, come back into frame" : "Come back into frame";
  elements.recoveryMessage.textContent = facesReady && handsReady
    ? "Keep both faces and hands in view while we reconnect…"
    : "Each player: look at the camera and raise one hand beside your face, on your side.";
  if (playerCount === 2) {
    elements.recoveryFaceCheck.textContent = `${zones[0].face && zones[0].hand ? "✓" : "○"} Player 1`;
    elements.recoveryHandCheck.textContent = `${zones[1].face && zones[1].hand ? "✓" : "○"} Player 2`;
    elements.recoveryFaceCheck.classList.toggle("is-ready", zones[0].face && zones[0].hand);
    elements.recoveryHandCheck.classList.toggle("is-ready", zones[1].face && zones[1].hand);
  } else {
    elements.recoveryFaceCheck.textContent = `${facesReady ? "✓" : "○"} Face`;
    elements.recoveryHandCheck.textContent = `${handsReady ? "✓" : "○"} Hand`;
    elements.recoveryFaceCheck.classList.toggle("is-ready", facesReady);
    elements.recoveryHandCheck.classList.toggle("is-ready", handsReady);
  }
  return facesReady && handsReady;
}

function startTrackingRecovery(missingPlayers, now) {
  if (state.recoveryActive) return;
  state.recoveryActive = true;
  state.recoveryMissingPlayers = [...missingPlayers];
  state.recoveryStartedAt = now;
  state.recoveryReadySince = null;
  state.faces = [];
  elements.trackingRecovery.hidden = false;
  elements.pause.disabled = true;
  tracker.setFaceTrackingEnabled(true);
  updateRecoveryOverlay([], []);
  elements.statusLive.textContent = "The round is paused while player tracking reconnects.";
}

function finishTrackingRecovery(hands, faces, now) {
  state.players = gameplayPlayers(hands);
  state.pausedDuration += Math.max(0, now - state.recoveryStartedAt);
  state.lastFrame = now;
  state.recoveryActive = false;
  state.recoveryMissingPlayers = [];
  state.recoveryStartedAt = 0;
  state.recoveryReadySince = null;
  state.missingPlayerSince = [null, null];
  state.faces = [];
  elements.trackingRecovery.hidden = true;
  elements.pause.disabled = false;
  tracker.setFaceTrackingEnabled(false);
  updateTrackingStatus(state.players.filter((player) => player?.interactive !== false).length);
  elements.statusLive.textContent = "Player controls reconnected. The round continues.";
}

function handleRecoveryTracking(hands, faces, now) {
  state.faces = faces;
  const ready = updateRecoveryOverlay(hands, faces, now);
  state.recoveryReadySince = getStableRecoveryStart(state.recoveryReadySince, ready, now);
  if (state.recoveryReadySince !== null && now - state.recoveryReadySince >= RECOVERY_STABLE_MS) {
    finishTrackingRecovery(hands, faces, now);
  }
}

function monitorGameplayPresence(now) {
  const playerCount = activePlayerCount();
  const missingPlayers = getMissingPlayerIndices(state.players, playerCount);
  for (let index = 0; index < playerCount; index += 1) {
    if (missingPlayers.includes(index)) {
      state.missingPlayerSince[index] ??= now;
    } else {
      state.missingPlayerSince[index] = null;
    }
  }
  const sustainedMissingPlayers = missingPlayers.filter((index) =>
    now - state.missingPlayerSince[index] >= PLAYER_MISSING_GRACE_MS,
  );
  if (sustainedMissingPlayers.length) startTrackingRecovery(sustainedMissingPlayers, now);
}

const tracker = new HandTracker(elements.registrationVideo, (hands, faces) => {
  if (state.inputMode !== "camera") return;
  if (isRegistrationLocked(state.phase)) {
    // Registration is immutable once the countdown starts. Brief detector
    // dropouts or reordered results must not move players or restart the timer.
    return;
  }
  state.faces = faces;
  if (state.phase === "registering") {
    state.registrationHands = hands;
    state.players = registrationPlayers(hands);
    renderCursors(elements.registrationCursors);
    renderFaceAnchors(elements.registrationFaces);
    const now = performance.now();
    updateFaceLockProgress(faces, hands, now);
    if (now - state.lastRegistrationCheck >= 80) {
      state.lastRegistrationCheck = now;
      handleRegistration(hands, faces, now);
    }
  } else if (state.phase === "playing" && state.running && !state.paused) {
    const now = performance.now();
    if (state.recoveryActive) {
      handleRecoveryTracking(hands, faces, now);
      return;
    }
    state.faces = [];
    state.players = gameplayPlayers(hands);
    monitorGameplayPresence(now);
  }
}, (status) => {
  if (state.inputMode !== "camera") return;
  if (isRegistrationLocked(state.phase)) return;
  if (status.type === "face-ready") {
    state.faceTrackingReady = true;
    state.faceTrackingError = "";
    if (state.phase === "registering") {
      updateFaceLockProgress(state.faces, state.registrationHands);
      elements.statusLive.textContent = "Face position tracking is ready.";
    } else if (state.recoveryActive) {
      elements.statusLive.textContent = "Face scanner ready. Waiting to reconnect player controls.";
    }
  }
  if (status.type === "face-error") {
    state.faceTrackingReady = false;
    state.faceTrackingError = status.message || "Face tracker could not load.";
    if (state.recoveryActive) {
      elements.recoveryMessage.textContent = "Face scanner could not reconnect. Stay in view and keep your hands raised.";
    } else {
      updateFaceLockProgress(state.faces, state.registrationHands);
      setRegistrationStatus("face-error", "Face scanner could not start. Please change setup and try again.", false);
    }
  }
  if (status.type === "tracking" && state.phase === "playing" && !state.recoveryActive) {
    updateTrackingStatus(state.players.filter((player) => player?.interactive !== false).length);
  }
  if (status.type === "error") {
    if (state.phase === "registering" || state.phase === "countdown") {
      elements.registrationStatusText.textContent = "Tracking is recovering…";
    } else if (state.recoveryActive) {
      elements.recoveryMessage.textContent = "Tracking is reconnecting… keep your face and hands visible.";
    } else if (state.phase === "playing") {
      elements.trackingStatusText.textContent = "Tracking is recovering…";
    }
    elements.statusLive.textContent = "Hand tracking is recovering.";
  }
});

function updateTrackingStatus(count) {
  const needed = getRequiredHandCount(state.playMode);
  const ready = count >= needed;
  elements.trackingStatus.classList.toggle("hands-ready", ready);
  if (state.playMode === "pvp") {
    elements.trackingStatusText.textContent = ready ? "Both player controls connected" : "Tracking player hands…";
  } else {
    elements.trackingStatusText.textContent = count ? "Hand tracking is ready" : "Show a hand to the camera";
  }
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access needs localhost or a secure HTTPS page.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 960, max: 1280 },
      height: { ideal: 540, max: 720 },
      facingMode: "user",
      frameRate: { ideal: 24, max: 30 },
    },
  });
  tracker.setVideo(elements.registrationVideo);
  elements.registrationVideo.srcObject = stream;
  elements.video.srcObject = stream;
  await elements.registrationVideo.play();
  elements.video.pause();
  state.stream = stream;
}

function stopCamera() {
  cancelRegistrationCountdown();
  tracker.stop();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.registrationVideo.pause();
  elements.video.pause();
  elements.registrationVideo.srcObject = null;
  elements.video.srcObject = null;
}

function setRegistrationStatus(key, text, ready) {
  if (state.registrationStatusKey === key) return;
  state.registrationStatusKey = key;
  elements.registrationStatus.classList.toggle("is-ready", ready);
  elements.registrationStatusText.textContent = text;
}

function updateFaceLockProgress(faces = [], hands = [], now = performance.now()) {
  const requiredFaces = state.playMode === "pvp" ? 2 : 1;
  const fresh = freshTracking(hands, faces, now);
  const boundary = state.playMode === "pvp" ? getPlayerBoundary(fresh.faces) ?? state.playerBoundary : 0.5;
  const zones = getZonePresence(fresh.hands, fresh.faces, boundary, requiredFaces);
  elements.faceModelStatus.classList.toggle("is-ready", state.faceTrackingReady);
  elements.faceModelStatus.classList.toggle("is-error", Boolean(state.faceTrackingError));
  elements.faceModelStatus.textContent = state.faceTrackingError
    ? "Scanner unavailable"
    : state.faceTrackingReady ? "Scanner ready" : "Starting scanner…";
  elements.facePlayers.forEach((row, index) => {
    row.hidden = index >= requiredFaces;
    if (row.hidden) return;
    const zone = zones[index];
    const locked = zone.face && zone.hand;
    row.classList.toggle("is-locked", locked);
    row.querySelector("small").textContent = `Face ${zone.face ? "✓" : "○"} · Hand ${zone.hand ? "✓" : "○"}`;
    row.querySelector("i").textContent = locked ? "✓" : "○";
  });
}

function setRegistrationCopy() {
  const isPvp = state.playMode === "pvp";
  elements.registration.classList.toggle("solo-mode", !isPvp);
  elements.registration.classList.toggle("pvp-mode", isPvp);
  elements.registrationPlural.textContent = isPvp ? "s" : "";
  elements.registrationInstruction.textContent = isPvp
    ? "Stand side by side and raise one hand each beside your face. Keep your hand on your own side of the camera view."
    : "Look at the camera and raise one hand beside your face. Keep your face and hand visible for the full countdown.";
  elements.playerTwoKey.hidden = !isPvp;
  elements.registrationTip.hidden = !isPvp;
  state.registrationStatusKey = "";
  updateFaceLockProgress([]);
  setRegistrationStatus(
    isPvp ? "waiting-pvp" : "waiting-solo",
    isPvp ? "Looking for two players…" : "Looking for your face and hand…",
    false,
  );
}

async function startWithCamera() {
  configureFromSetup();
  state.inputMode = "camera";
  state.playerFaceSlots = [];
  state.playerBoundary = 0.5;
  state.faces = [];
  state.registrationHands = [];
  state.registrationReadySince = null;
  state.faceTrackingReady = tracker.faceTrackingReady;
  state.faceTrackingError = "";
  state.lastRegistrationCheck = 0;
  elements.cameraStart.disabled = true;
  elements.cameraStart.textContent = "Preparing camera…";
  elements.cameraMessage.textContent = "Your browser may ask for camera permission. Images never leave this device.";
  setRegistrationCopy();
  tracker.setFaceTrackingEnabled(true);
  try {
    await Promise.all([requestCamera(), tracker.initialize()]);
    showPanel(elements.registration, "registering");
    tracker.start();
    elements.statusLive.textContent = "Camera ready. Raise your hands to register.";
  } catch (error) {
    stopCamera();
    showPanel(elements.setup, "setup");
    elements.cameraMessage.textContent = `${error.message || "The camera could not start."} You can still try solo mode with the keyboard.`;
    elements.keyboardStart.focus({ preventScroll: true });
  } finally {
    elements.cameraStart.disabled = false;
    elements.cameraStart.textContent = "Continue with camera";
  }
}

function lockPlayerSlots(faces) {
  const playerCount = state.playMode === "pvp" ? 2 : 1;
  if (playerCount === 2) state.playerBoundary = getPlayerBoundary(faces) ?? state.playerBoundary;
  state.playerFaceSlots = visibleFaceEntries(faces).slice(0, playerCount).map(({ index }) => index);
}

function handleRegistration(hands, faces, now) {
  if (isRegistrationLocked(state.phase)) return;
  const fresh = freshTracking(hands, faces, now);
  const visibleEntries = visibleHandEntries(fresh.hands);
  const needed = getRequiredHandCount(state.playMode);
  const visibleFaces = visibleFaceEntries(fresh.faces);
  const neededFaces = state.playMode === "pvp" ? 2 : 1;
  const candidateBoundary = state.playMode === "pvp" ? getPlayerBoundary(fresh.faces) : null;
  const zones = getZonePresence(fresh.hands, fresh.faces, candidateBoundary ?? state.playerBoundary, neededFaces);
  const handsReady = state.playMode === "pvp"
    ? Boolean(candidateBoundary) && zones.every((zone) => zone.hand)
    : visibleEntries.length >= needed;
  const facesReady = state.faceTrackingReady && (state.playMode === "pvp"
    ? Boolean(candidateBoundary) && zones.every((zone) => zone.face)
    : visibleFaces.length >= neededFaces);
  const ready = handsReady && facesReady;
  if (!ready) {
    state.registrationReadySince = null;
    const missingHands = Math.max(0, needed - visibleEntries.length);
    const missingFaces = Math.max(0, neededFaces - visibleFaces.length);
    let key = `missing-hands-${missingHands}`;
    let message = state.playMode === "pvp"
      ? "One face and one raised hand beside it needed on each side"
      : "Raise a hand beside your face to continue";
    if (state.faceTrackingError) {
      key = "face-error";
      message = "Face scanner unavailable. Change setup and try again.";
    } else if (!state.faceTrackingReady) {
      key = "face-loading";
      message = "Starting face scanner…";
    } else if (missingFaces > 0) {
      key = `missing-faces-${missingFaces}`;
      message = missingFaces === 2 ? "Keep both faces in view" : state.playMode === "pvp" ? "One more face needed" : "Look at the camera";
    }
    setRegistrationStatus(key, message, false);
    return;
  }

  state.registrationReadySince = getStableRecoveryStart(state.registrationReadySince, true, now);
  if (now - state.registrationReadySince < REGISTRATION_STABLE_MS) {
    setRegistrationStatus("hold-steady", "Faces and hands found — hold for a moment…", false);
    return;
  }

  setRegistrationStatus(
    state.playMode === "pvp" ? "ready-pvp" : "ready-solo",
    state.playMode === "pvp" ? "Both players ready" : "Face and hand ready",
    true,
  );
  if (state.phase === "registering") {
    lockPlayerSlots(fresh.faces);
    startRegistrationCountdown();
  }
}

function startRegistrationCountdown() {
  state.phase = "countdown";
  state.countdownEndsAt = performance.now() + REGISTRATION_COUNTDOWN_MS;
  elements.countdownBadge.hidden = false;
  elements.statusLive.textContent = state.playMode === "pvp"
    ? "Both players confirmed. Starting in three seconds."
    : "Face and hand confirmed. Starting in three seconds.";
  cancelAnimationFrame(state.countdownAnimationId);
  state.countdownAnimationId = requestAnimationFrame(updateRegistrationCountdown);
}

function updateRegistrationCountdown(now) {
  if (state.phase !== "countdown") return;
  const remaining = Math.max(0, state.countdownEndsAt - now);
  elements.countdownValue.textContent = Math.max(1, Math.ceil(remaining / 1000));
  if (remaining <= 0) {
    elements.countdownBadge.hidden = true;
    startSession("camera");
    return;
  }
  state.countdownAnimationId = requestAnimationFrame(updateRegistrationCountdown);
}

function cancelRegistrationCountdown() {
  cancelAnimationFrame(state.countdownAnimationId);
  state.countdownAnimationId = null;
  elements.countdownBadge.hidden = true;
  elements.countdownValue.textContent = "3";
}

function cancelRegistration() {
  stopCamera();
  state.players = [];
  state.faces = [];
  renderCursors(elements.registrationCursors);
  renderFaceAnchors(elements.registrationFaces);
  showPanel(elements.setup, "setup");
  elements.cameraMessage.textContent = "";
  elements.cameraStart.focus({ preventScroll: true });
}

function startSession(inputMode) {
  configureFromSetup();
  state.running = true;
  state.paused = false;
  state.phase = "playing";
  state.inputMode = inputMode;
  state.playerStats = [emptyPlayerStats(), emptyPlayerStats()];
  state.caught = 0;
  state.missed = 0;
  state.remainingSeconds = state.durationSeconds;
  state.startedAt = performance.now();
  state.pausedDuration = 0;
  state.lastFrame = state.startedAt;
  state.lastSpawn = state.startedAt - getPaceConfig(state.pace).spawnInterval * 0.55;
  state.objects = [];
  state.missingPlayerSince = [null, null];
  state.recoveryActive = false;
  state.recoveryMissingPlayers = [];
  state.recoveryStartedAt = 0;
  state.recoveryReadySince = null;
  state.faces = [];
  elements.trackingRecovery.hidden = true;
  elements.pause.disabled = false;
  if (inputMode === "keyboard") {
    state.playMode = "solo";
    state.players = [{ x: 0.5, y: 0.72, radius: 44, ownerIndex: 0 }];
  } else {
    elements.video.play().catch(() => {});
    tracker.setVideo(elements.video);
    tracker.setFaceTrackingEnabled(false);
    elements.registrationVideo.pause();
  }

  elements.targets.replaceChildren();
  showPanel(elements.play, "playing");
  elements.video.hidden = inputMode !== "camera";
  elements.trackingStatus.hidden = inputMode !== "camera";
  elements.board.classList.toggle("keyboard-mode", inputMode === "keyboard");
  elements.board.classList.toggle("pvp-mode", state.playMode === "pvp");
  elements.play.classList.toggle("pvp-mode", state.playMode === "pvp");
  elements.pvpArena.hidden = state.playMode !== "pvp";
  elements.battleLanes.forEach((lane) => lane.classList.remove("lane-scored", "lane-hazard"));
  elements.playerTwoScoreCard.hidden = state.playMode !== "pvp";
  updateTrackingStatus(state.players.filter(Boolean).length);
  elements.inputHint.textContent = inputMode === "camera"
    ? state.playMode === "pvp"
      ? "Stay on your side of the camera. Raise one hand to control your lane, catch shapes and avoid hazards."
      : "Your palms control the circles. Catch garden shapes and avoid hazards."
    : "Use the arrow keys or W A S D. Catch garden shapes and avoid hazards.";
  elements.pause.textContent = "Pause";
  elements.pauseOverlay.hidden = true;
  updateStats();
  renderCursors(elements.cursors);
  elements.board.focus({ preventScroll: true });
  elements.statusLive.textContent = state.playMode === "pvp" ? "Split-screen battle started." : "Session started.";
  cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(gameLoop);
}

function spawnObject(now) {
  const config = getPaceConfig(state.pace);
  const isPvp = state.playMode === "pvp";
  if (now - state.lastSpawn < config.spawnInterval) return;

  if (isPvp) {
    const laneCounts = [0, 1].map((ownerIndex) =>
      state.objects.filter((object) => object.ownerIndex === ownerIndex).length,
    );
    if (laneCounts.every((count) => count >= config.maxObjects)) return;
    const type = randomObjectType();
    const localPosition = Math.random();
    if (laneCounts[0] < config.maxObjects) {
      createFallingObject(now, type, getPvpSpawnX(0, localPosition), 0);
    }
    if (laneCounts[1] < config.maxObjects) {
      createFallingObject(now + 0.01, type, getPvpSpawnX(1, localPosition), 1);
    }
  } else {
    if (state.objects.length >= config.maxObjects) return;
    createFallingObject(now, randomObjectType(), 0.1 + Math.random() * 0.8, null);
  }
  state.lastSpawn = now;
}

function createFallingObject(now, type, x, ownerIndex) {
  const object = {
    id: `${now}-${Math.random()}`,
    type,
    ownerIndex,
    x,
    y: -0.08,
    radius: 30,
    drift: (Math.random() - 0.5) * (ownerIndex === null ? 0.025 : 0.012),
    phase: Math.random() * Math.PI * 2,
  };
  const node = document.createElement("div");
  node.className = `falling-object ${type.kind}${ownerIndex === null ? "" : ` player-${ownerIndex + 1}-target`}`;
  node.textContent = type.symbol;
  node.dataset.id = object.id;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", type.label);
  object.node = node;
  state.objects.push(object);
  elements.targets.append(node);
}

function updateKeyboard(deltaSeconds) {
  if (state.inputMode !== "keyboard") return;
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
  if (state.recoveryActive) {
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
  renderCursors(elements.cursors);
  state.animationId = requestAnimationFrame(gameLoop);
}

function closestCollidingPlayer(objectPosition, players, requiredOwnerIndex = null) {
  let closest = null;
  players.forEach((player) => {
    if (requiredOwnerIndex !== null && player?.ownerIndex !== requiredOwnerIndex) return;
    if (!player || player.interactive === false || !circlesOverlap(objectPosition, player)) return;
    const distance = Math.hypot(objectPosition.x - player.x, objectPosition.y - player.y);
    if (!closest || distance < closest.distance) closest = { ownerIndex: player.ownerIndex ?? 0, distance };
  });
  return closest?.ownerIndex ?? -1;
}

function updateObjects(deltaSeconds, now) {
  const boardHeight = elements.board.clientHeight;
  const boardWidth = elements.board.clientWidth;
  const fallRate = getPaceConfig(state.pace).fallSpeed / Math.max(boardHeight, 1);
  const boardPlayers = state.players.map((player) => player ? {
    ...player,
    x: player.x * boardWidth,
    y: player.y * boardHeight,
  } : null);

  for (const object of [...state.objects]) {
    object.y += fallRate * deltaSeconds;
    const sway = Math.sin(now / 650 + object.phase) * object.drift;
    const lane = object.ownerIndex === null ? null : PVP_LANES[object.ownerIndex];
    const displayX = clamp(
      object.x + sway,
      lane ? lane.minX + 0.025 : 0.05,
      lane ? lane.maxX - 0.025 : 0.95,
    );
    object.node.style.transform = `translate(${displayX * boardWidth}px, ${object.y * boardHeight}px)`;
    const objectPosition = { x: displayX * boardWidth, y: object.y * boardHeight, radius: object.radius };
    const ownerIndex = closestCollidingPlayer(objectPosition, boardPlayers, object.ownerIndex);
    if (ownerIndex >= 0) {
      resolveObject(object, ownerIndex);
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

function resolveObject(object, ownerIndex) {
  const current = state.playerStats[ownerIndex] ?? state.playerStats[0];
  const result = applyObjectScore(current, object.type);
  Object.assign(current, result);
  current.bestStreak = Math.max(current.bestStreak, current.streak);
  object.node.classList.add(object.type.hazard ? "hazard-hit" : "collected");
  setTimeout(() => object.node.remove(), 260);
  state.objects = state.objects.filter((candidate) => candidate.id !== object.id);
  const playerName = state.playMode === "pvp" ? `Player ${ownerIndex + 1}` : "You";
  const battleLane = state.playMode === "pvp" ? elements.battleLanes[ownerIndex] : null;

  if (object.type.hazard) {
    const flashTarget = battleLane ?? elements.board;
    const flashClass = battleLane ? "lane-hazard" : "hazard-flash";
    flashTarget.classList.remove(flashClass);
    void flashTarget.offsetWidth;
    flashTarget.classList.add(flashClass);
    setTimeout(() => flashTarget.classList.remove(flashClass), 300);
    const pointsLost = Math.abs(result.delta);
    elements.statusLive.textContent = `${playerName} hit a ${object.type.label}. ${pointsLost ? `${pointsLost} points lost. ` : ""}Streak reset.`;
    return;
  }

  current.caught += 1;
  state.caught += 1;
  if (battleLane) {
    battleLane.classList.remove("lane-scored");
    void battleLane.offsetWidth;
    battleLane.classList.add("lane-scored");
    setTimeout(() => battleLane.classList.remove("lane-scored"), 320);
  }
  elements.statusLive.textContent = `${playerName} caught a ${object.type.label} for ${result.delta} points.`;
}

function missObject(object) {
  removeObject(object);
  state.missed += 1;
  const missLimit = getPaceConfig(state.pace).missLimit * (state.playMode === "pvp" ? 2 : 1);
  if (state.missed >= missLimit) endSession("misses");
}

function renderCursors(cursorElements) {
  cursorElements.forEach((cursor, index) => {
    const player = state.players[index];
    cursor.hidden = !player;
    if (!player) return;
    cursor.style.left = `${player.x * 100}%`;
    cursor.style.top = `${player.y * 100}%`;
  });
}

function renderFaceAnchors(anchorElements) {
  anchorElements.forEach((anchor, index) => {
    const faceSlotIndex = state.playerFaceSlots[index] ?? index;
    const face = state.faces[faceSlotIndex];
    anchor.hidden = !face;
    if (!face) return;
    anchor.style.left = `${face.x * 100}%`;
    anchor.style.top = `${face.y * 100}%`;
    anchor.style.width = `${face.width * 100}%`;
    anchor.style.height = `${face.height * 100}%`;
    anchor.classList.toggle("face-searching", face.interactive === false);
  });
}

function streakLabel(stats) {
  if (!stats.streak) return "Ready";
  return stats.multiplier > 1 ? `${stats.streak} streak · ×${stats.multiplier}` : `${stats.streak} streak`;
}

function updateStats() {
  const config = getPaceConfig(state.pace);
  elements.playerOneScore.textContent = state.playerStats[0].score;
  elements.playerOneStreak.textContent = streakLabel(state.playerStats[0]);
  elements.playerTwoScore.textContent = state.playerStats[1].score;
  elements.playerTwoStreak.textContent = streakLabel(state.playerStats[1]);
  elements.laneOneScore.textContent = state.playerStats[0].score;
  elements.laneOneStreak.textContent = streakLabel(state.playerStats[0]);
  elements.laneTwoScore.textContent = state.playerStats[1].score;
  elements.laneTwoStreak.textContent = streakLabel(state.playerStats[1]);
  elements.caught.textContent = state.caught;
  elements.missed.textContent = state.missed;
  elements.missLimit.textContent = config.missLimit * (state.playMode === "pvp" ? 2 : 1);
  elements.time.textContent = formatTime(state.remainingSeconds);
}

function togglePause() {
  if (!state.running || state.recoveryActive) return;
  state.paused = !state.paused;
  if (state.paused) {
    state.pausedAt = performance.now();
    if (state.inputMode === "camera") {
      tracker.stop();
      state.players = [];
      renderCursors(elements.cursors);
    }
    elements.pause.textContent = "Continue";
    elements.pauseOverlay.hidden = false;
    elements.statusLive.textContent = "Session paused.";
  } else {
    state.pausedDuration += performance.now() - state.pausedAt;
    state.lastFrame = performance.now();
    if (state.inputMode === "camera") tracker.start();
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
  if (state.inputMode === "camera") stopCamera();
  state.objects.forEach((object) => object.node.remove());
  state.objects = [];
  state.players = [];
  state.faces = [];
  state.recoveryActive = false;
  state.recoveryMissingPlayers = [];
  state.recoveryReadySince = null;
  elements.trackingRecovery.hidden = true;
  elements.pause.disabled = false;
  renderCursors(elements.cursors);

  showPanel(elements.results, "results");
  const scores = state.playerStats.map((player) => player.score);
  const matchResult = getMatchResult(scores[0], scores[1], state.playMode);
  elements.resultsTitle.textContent = matchResult.title;
  elements.resultMessage.textContent = reason === "misses"
    ? `${state.caught} shapes caught. Time for a gentle rest.`
    : matchResult.message;
  elements.finalPlayerOneLabel.textContent = state.playMode === "pvp" ? "Player 1" : "Score";
  elements.finalPlayerOneScore.textContent = scores[0];
  elements.finalPlayerTwoCard.hidden = state.playMode !== "pvp";
  elements.finalPlayerTwoScore.textContent = scores[1];
  elements.finalCaught.textContent = state.caught;
  elements.statusLive.textContent = `Session complete. ${matchResult.title}`;
  elements.playAgain.focus({ preventScroll: true });
}

function resetToSetup() {
  elements.cameraMessage.textContent = "";
  showPanel(elements.setup, "setup");
  elements.cameraStart.focus({ preventScroll: true });
}

function resetToWelcome() {
  elements.cameraMessage.textContent = "";
  showPanel(elements.landing, "landing");
  elements.enterGame.focus({ preventScroll: true });
}

function handleKeyDown(event) {
  const key = event.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"].includes(key)) {
    if (state.running && state.inputMode === "keyboard") event.preventDefault();
    state.keys.add(key);
  }
  if (key === " " && state.running && event.target === elements.board) {
    event.preventDefault();
    togglePause();
  }
  if (key === "escape" && state.running) togglePause();
}

elements.enterGame.addEventListener("click", () => {
  showPanel(elements.setup, "setup");
  elements.cameraStart.focus({ preventScroll: true });
});
elements.backToWelcome.addEventListener("click", resetToWelcome);
elements.cameraStart.addEventListener("click", startWithCamera);
elements.keyboardStart.addEventListener("click", () => startSession("keyboard"));
elements.cancelRegistration.addEventListener("click", cancelRegistration);
elements.pause.addEventListener("click", togglePause);
elements.end.addEventListener("click", () => endSession("ended"));
elements.playAgain.addEventListener("click", resetToSetup);
elements.backHome.addEventListener("click", resetToWelcome);
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => state.keys.clear());
window.addEventListener("beforeunload", () => {
  stopCamera();
  tracker.dispose();
});

if (import.meta.env.DEV) {
  window.__gentleCatch = {
    getState: () => ({
      phase: state.phase,
      playMode: state.playMode,
      running: state.running,
      recoveryActive: state.recoveryActive,
    }),
    simulateTracking: (hands = [], faces = []) => tracker.onHands(hands, faces),
  };
  const preview = new URLSearchParams(window.location.search).get("preview");
  if (preview === "face-init") {
    document.querySelector('input[name="playMode"][value="pvp"]').checked = true;
    configureFromSetup();
    state.inputMode = "camera";
    setRegistrationCopy();
    showPanel(elements.registration, "registering");
    tracker.setFaceTrackingEnabled(true);
    tracker.initialize().catch((error) => {
      state.faceTrackingError = error?.message || "Tracking could not load.";
      updateFaceLockProgress([]);
    });
  } else if (preview === "pvp-registration") {
    document.querySelector('input[name="playMode"][value="pvp"]').checked = true;
    configureFromSetup();
    state.inputMode = "camera";
    state.faceTrackingReady = true;
    const previewTime = performance.now();
    state.registrationHands = [
      { x: 0.3, y: 0.55, lastSeen: previewTime, interactive: true },
      { x: 0.7, y: 0.55, lastSeen: previewTime, interactive: true },
    ];
    state.players = [
      { x: 0.3, y: 0.55, radius: 44, ownerIndex: 0 },
      { x: 0.7, y: 0.55, radius: 44, ownerIndex: 1 },
    ];
    state.faces = [
      { x: 0.3, y: 0.26, width: 0.15, height: 0.22, lastSeen: previewTime, interactive: true },
      { x: 0.7, y: 0.26, width: 0.15, height: 0.22, lastSeen: previewTime, interactive: true },
    ];
    state.playerFaceSlots = [0, 1];
    setRegistrationCopy();
    showPanel(elements.registration, "countdown");
    elements.registrationStatus.classList.add("is-ready");
    elements.registrationStatusText.textContent = "Both players ready";
    elements.countdownBadge.hidden = false;
    renderCursors(elements.registrationCursors);
    renderFaceAnchors(elements.registrationFaces);
    updateFaceLockProgress(state.faces, state.registrationHands, previewTime);
  } else if (preview === "pvp-game") {
    document.querySelector('input[name="playMode"][value="pvp"]').checked = true;
    configureFromSetup();
    state.inputMode = "camera";
    state.playerStats = [
      { ...emptyPlayerStats(), score: 55, streak: 4, multiplier: 2, caught: 4 },
      { ...emptyPlayerStats(), score: 40, streak: 2, caught: 3 },
    ];
    state.caught = 7;
    state.players = [
      { x: 0.3, y: 0.62, radius: 44, ownerIndex: 0 },
      { x: 0.7, y: 0.56, radius: 44, ownerIndex: 1 },
    ];
    state.faces = [];
    state.playerFaceSlots = [0, 1];
    showPanel(elements.play, "playing");
    elements.video.hidden = true;
    elements.trackingStatus.hidden = false;
    elements.board.classList.add("keyboard-mode", "pvp-mode");
    elements.play.classList.add("pvp-mode");
    elements.pvpArena.hidden = false;
    elements.playerTwoScoreCard.hidden = false;
    elements.inputHint.textContent = "Split-screen score battle: each player controls one side. Catch your shapes and avoid hazards.";
    updateTrackingStatus(2);
    updateStats();
    renderCursors(elements.cursors);
  } else if (preview === "pvp-recovery") {
    document.querySelector('input[name="playMode"][value="pvp"]').checked = true;
    configureFromSetup();
    state.inputMode = "camera";
    state.running = true;
    state.recoveryActive = true;
    state.recoveryMissingPlayers = [1];
    state.players = [
      { x: 0.3, y: 0.62, radius: 44, ownerIndex: 0 },
      null,
    ];
    showPanel(elements.play, "playing");
    elements.video.hidden = true;
    elements.trackingStatus.hidden = false;
    elements.board.classList.add("keyboard-mode", "pvp-mode");
    elements.play.classList.add("pvp-mode");
    elements.pvpArena.hidden = false;
    elements.playerTwoScoreCard.hidden = false;
    elements.pause.disabled = true;
    elements.trackingRecovery.hidden = false;
    updateRecoveryOverlay([], []);
    updateStats();
    renderCursors(elements.cursors);
  }
}
