# Gentle Catch

Gentle Catch is a calm, camera-controlled movement game designed with older adults in mind. Mandarin oranges, watermelon slices, icing gem biscuits (the colourful sugar-swirl biscuits), and ondeh-ondeh drift down the screen; players collect them with one or both hands while avoiding bombs and germs. These original, locally bundled SVG icons look consistent across laptops and Raspberry Pi and require no internet downloads. The four collectible point tiers remain 10, 15, 20 and 25. Consecutive catches build a score multiplier, while touching a hazard deducts points and resets the streak. It uses its own name, visual language, rules, and artwork.

## Why it runs well on a Raspberry Pi

The browser requests a 640 × 360 camera stream (up to 480 pixels high for cameras that negotiate 4:3). A worker runs MediaPipe Pose Landmarker Lite to track the players' shoulders and wrists with arm context. Inference frames are resized to 384 pixels wide while preserving camera aspect ratio. Segmentation is disabled. Solo mode can detect up to two poses while looking for its player; PvP can detect up to four, including people in the background.

Before camera play, CPU and GPU delegates are warmed and timed on the same camera image. The faster working delegate is kept; the other instance is closed. The player then raises both hands to lock tracking before the game timer starts. Busy frames are skipped rather than queued, capture timestamps are preserved, and inference cadence adapts to processing time. One velocity-aware filter and bounded prediction feed the game's independent display loop. Camera coordinates account for the displayed video's crop, and stale cursors cannot score. Models and WASM are served locally with the application.

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
- Raise both hands briefly to calibrate before a camera session. After locking, one or both hands can be used simultaneously. Keep your shoulders, arms and hands in camera view; each visible wrist/hand gets its own cursor.
- It can be played seated or standing. The player should stop if movement is uncomfortable.

## Two-player PvP (experimental)

Select **Two players · PvP**, optionally enter both names, and choose a pace and length.

- Player 1 starts on the **left of the mirrored screen**; Player 2 starts on the **right**. Leave comfortable space and keep both shoulders, arms and hands visible. Stay on your starting sides.
- Camera mode asks each player to hold both hands above their shoulders for about a second. The tracker locks to each player's torso position and approximate body size. Their visible wrists control two numbered, colour-coded cursors. Background people who do not calibrate cannot score. If a torso disappears for more than about a second, its hands stop scoring until that player raises both hands again near the original spot. Briefly hidden wrists can return without relocking while the torso remains visible.
- The clock waits until both players are locked and have a usable hand cursor. It then starts one shared 20s, 30s or 1-minute timer, which continues if someone leaves the view. Pause stops the clock for both players.
- Matching waves spawn the same treats and hazards in mirrored positions. Each player can only collect their own side's objects. Points, hazard deductions and streak multipliers follow the solo rules independently. Misses are counted but do not end a PvP match.
- The higher final score wins; equal scores produce a draw. Ending before both people are ready cancels the match. **End session** after the match starts uses the current scores.
- Keyboard fallback supports two people: **W A S D** for Player 1, **arrow keys** for Player 2.

Both camera modes require pose tracking to associate wrists with a calibrated person. If pose cannot load, use keyboard play. Models remain local and inference stays in the worker. Detecting extra poses can cost more processing time, so test on your Pi 5 with its intended camera, lighting and cooling. This is position and body-size matching, not biometric identification: two people with similar size in nearly the same place can still be confused. Crossing sides or sustained occlusion also interrupts tracking; return to your original spot and raise both hands to relock. Real-world play and Pi performance still need hardware testing.

Developer check: `/tests/camera-smoke.html?pvp` draws two copies of the downloaded public pose fixture into a synthetic camera. Select PvP and start with camera to exercise the actual model, worker, and calibration prompt without webcam permission. The pictured person's arms are horizontal, so this fixture intentionally does not complete the raised-hands gesture. After a build, `/tests/browser-smoke.html?built&pvp` checks that the minified worker detects both poses and all four wrists. Automated session tests cover calibration, locking, loss and relocking; real-world movement accuracy still needs a camera check.

## Device-local leaderboard

The leaderboard below is for **solo sessions**. PvP results are shown at the end of the match and are not added to the solo rankings.

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

For controlled comparisons, use `?backend=CPU` or `?backend=GPU` to force a delegate. The default uses pose tracking with measured backend selection. Backend overrides are for diagnostics; GPU availability and performance depend on the browser/driver.

Developer browser checks are available under `/tests/browser-smoke.html` (actual models) and `/tests/camera-smoke.html` (the actual app with a synthetic camera) while running `npm run dev`. Download the public [MediaPipe pose test image](https://storage.googleapis.com/mediapipe-assets/pose.jpg) first:

```bash
mkdir -p tests/fixtures
curl -fL https://storage.googleapis.com/mediapipe-assets/pose.jpg -o tests/fixtures/pose.jpg
```

The fixture is deliberately not redistributed or included in production builds. Add the same model/backend query options to compare delegates. After building, `/tests/browser-smoke.html?built` exercises the minified worker and model/WASM copies from dist. The synthetic camera fixture requires no camera permission. See [the performance audit](docs/performance-audit.md) for verified behavior and the limits of those measurements.

## Privacy and limitations

Processing happens in browser memory. Frames are discarded immediately and are never stored or uploaded. The tracker estimates body landmarks and uses each visible wrist plus a small forearm-based palm offset as the cursor. It does not require finger gestures. Occlusion, very low light, motion blur, or hands outside the camera view can still interrupt tracking; a hidden wrist is not reconstructed from the elbow alone. It is a recreational wellbeing game, not a medical device, fall detector, or rehabilitation assessment.

## Commands

```bash
npm run dev       # development server
npm test          # unit tests
npm run build     # production bundle
npm run preview   # serve production bundle locally
```
