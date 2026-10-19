# Gentle Catch

Gentle Catch is a calm, camera-controlled movement game designed with older adults in mind. Leaves, flowers, hearts, and stars drift down the screen; players collect them with one or both hands while avoiding bombs and germs. Consecutive catches build a score multiplier, while touching a hazard deducts points and resets the streak. It uses its own name, visual language, rules, and artwork.

## Why it runs well on a Raspberry Pi

The browser requests a 640 × 360 camera stream (up to 480 pixels high for cameras that negotiate 4:3). A worker runs MediaPipe Pose Landmarker Lite to track both wrists of one player with arm context, instead of requiring a recognizable open palm. Inference frames are resized to 384 pixels wide while preserving camera aspect ratio. Segmentation is disabled.

Before the session timer starts, CPU and GPU delegates are warmed and timed on the same camera image. The faster working delegate is kept; the other instance is closed. A bundled Hand Landmarker is available if pose initialization fails. Busy frames are skipped rather than queued, capture timestamps are preserved, and inference cadence adapts to processing time. One velocity-aware filter and bounded prediction feed the game's independent display loop. Camera coordinates account for the displayed video's crop, and stale cursors cannot score. Models and WASM are served locally with the application.

No image or video leaves the device. Hand landmark inference happens locally in browser memory.

## Laptop quick start

Requirements: Node.js 22.12+ (22.x), 24.x, or 26+ and a current Chrome, Edge, or Firefox browser. Node 22 is recommended for the Pi.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, select a pace, and allow camera access. Camera access requires `localhost` or HTTPS. An evenly lit room and uncluttered background give the most stable tracking. Keyboard play is available with the arrow keys or W, A, S, and D.

## Controls and accessibility

- **Gentle, Steady, Lively** adjust fall speed, spawn interval, object count, and missed-object allowance.
- Sessions can be 20 seconds, 30 seconds, or 1 minute.
- Pause or end a session at any time. Space or Escape also pauses when playing with the keyboard.
- The game supports keyboard navigation, large controls, semantic labels, reduced motion, high contrast preferences, and responsive layouts.
- One or both hands can be used simultaneously. Keep your shoulders, arms and hands in camera view; each wrist/hand gets its own cursor.
- It can be played seated or standing. The player should stop if movement is uncomfortable.

## Device-local leaderboard

Enter an optional name before starting a camera or keyboard session, or leave it blank to play as Guest. Each finished session (including End session or reaching the missed-shape limit) updates the top five for its selected pace and session length. Earlier sessions win score ties; camera/keyboard input is labelled on each row. The leaderboard appears before play and on the results screen, with the current session highlighted if it makes the top five. Small arrow buttons at the bottom cycle through the 20s, 30s and 1 min leaderboards for the displayed pace without changing the next game's selected session length. Game scoring, streaks, timing and hazards are unchanged.

Names and scores are saved only in this browser's `localStorage`, with no account, server database or internet connection needed. They survive refreshes and browser/device restarts in a regular persistent browser profile. Keep the same browser profile and address, including the port: `localhost:4173`, `127.0.0.1:4173` and `localhost:5173` have separate storage. Private/incognito sessions, clearing site data, or deleting the browser profile can erase the leaderboard. Do not use incognito mode for the Pi kiosk. If storage is blocked or full, the game remains playable and shows a warning that scores are temporary. The name field itself is not restored after refresh, so the next kiosk player can enter their own name.

## Raspberry Pi 5 kiosk deployment

Install Raspberry Pi OS 64-bit with Desktop, Node.js 22, and Chromium. Attach a UVC-compatible 1080p webcam, then:

```bash
npm ci
npm run build
npm run preview -- --port 4173
```

For a kiosk session, launch Chromium after the server starts:

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4173
```

The site is entirely static after `npm run build`. Use `npm run preview` to check the optimized build locally, and nginx, Caddy, or another static server serving `dist/` for permanent deployment. `npm run dev` includes development tooling and should not be used as the kiosk server. If your OS names Chromium `chromium-browser`, use that command instead. The first camera permission must be accepted by a caregiver. For automatic kiosk startup, save the server and Chromium commands in a systemd user service or the desktop autostart configuration. Use adequate power and active cooling for sustained Pi sessions.

After pulling an update, run `npm ci` and `npm run build` again before restarting the server; preview serves the existing `dist/` build.

## Local performance diagnostics

Run `window.gentleCatchDiagnostics()` in the browser console for the selected model/delegate, calibration timings, capture/processing latency percentiles, render cadence and dropout counts. These statistics stay in memory and are never uploaded. An empty camera view during calibration may favor a different backend than a visible player, so show your upper body during startup.

For controlled comparisons, use `?tracker=hands` to select the previous detailed hand model, and `?backend=CPU` or `?backend=GPU` to force a delegate. The default is pose tracking with measured backend selection. Backend overrides are for diagnostics; GPU availability and performance depend on the browser/driver.

Developer browser checks are available under `/tests/browser-smoke.html` (actual models) and `/tests/camera-smoke.html` (the actual app with a synthetic camera) while running `npm run dev`. Download the public [MediaPipe pose test image](https://storage.googleapis.com/mediapipe-assets/pose.jpg) first:

```bash
mkdir -p tests/fixtures
curl -fL https://storage.googleapis.com/mediapipe-assets/pose.jpg -o tests/fixtures/pose.jpg
```

The fixture is deliberately not redistributed or included in production builds. Add the same model/backend query options to compare delegates. After building, `/tests/browser-smoke.html?built` exercises the minified worker and model/WASM copies from dist. The synthetic camera fixture requires no camera permission. See [the performance audit](docs/performance-audit.md) for verified behavior and the limits of those measurements.

## Privacy and limitations

Processing happens in browser memory. Frames are discarded immediately and are never stored or uploaded. The default tracker estimates body landmarks for one player and uses each visible wrist plus a small forearm-based palm offset as the cursor. It does not require finger gestures. The hand-model fallback estimates 21 landmarks per visible hand. Occlusion, very low light, motion blur, or hands outside the camera view can still interrupt tracking; a hidden wrist is not reconstructed from the elbow alone. It is a recreational wellbeing game, not a medical device, fall detector, or rehabilitation assessment.

## Commands

```bash
npm run dev       # development server
npm test          # unit tests
npm run build     # production bundle
npm run preview   # serve production bundle locally
```
