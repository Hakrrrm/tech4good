# Performance and regression audit — 16 October 2026

Baseline: `5e98020` on `main`. All application source, markup, styling, tests, package manifests/lockfile, deployment documentation and bundled asset references were inspected. This audit documents code review, automated regression tests, real browser checks and the remaining hardware validation.

## Result and scope

The default input pipeline now uses MediaPipe Pose Landmarker Lite for the two wrists of one participant, with visible forearm direction providing a small bounded palm offset. Both anatomical sides have stable cursor slots. The previous Hand Landmarker remains bundled as an initialization fallback and as the explicit `?tracker=hands` diagnostic option. Two separate pose/hand models are not run together during play.

No code was copied from the comparison game. Its use of body-pose wrist tracking informed the model choice. MoveNet was researched as an alternative but is not included in this revision; no claim is made that Pose Lite is universally faster than MoveNet.

## Game rules preserved

`src/gameLogic.js` is unchanged from the baseline, verified by Git diff.

| Contract | Preserved behavior |
| --- | --- |
| Pace | Gentle / Steady / Lively: 42 / 58 / 76 px per second; spawn intervals 1800 / 1350 / 1000 ms; maximum objects 3 / 4 / 5; miss allowances 10 / 8 / 6 |
| Duration | 20, 30, 60 seconds; 30-second default; elapsed wall-clock session time excludes pauses |
| Collectibles | Leaf +10, flower +15, heart +20, star +25 |
| Hazards | Bomb −25, germ −15; fixed deductions; score floor of zero |
| Spawn mix | 82% collectibles, 9% bombs, 9% germs |
| Streak | Multiplier rises at catches 3, 6 and 9 to ×2, ×3 and ×4; hazards reset streak; misses retain their existing behavior |
| Collisions | Object radius 30 and cursor radius 44; an object awards/deducts only once even when touched by two cursors |
| Misses | Only uncaught collectibles count as misses; safely avoided hazards are removed |
| Sessions | Pause, continue, manual end, countdown expiry, miss-limit end and replay remain available |
| Controls | Arrow keys/WASD, keyboard focus, Space/Escape pause and two camera cursors retained |
| Presentation | Existing shapes, hazards, score/streak feedback, best streak, results and viewport layout retained |

The input anchor and camera-to-board mapping deliberately change as part of the requested tracking improvement. This preserves scoring rules, not identical cursor trajectories from the previous model.

## Findings and changes

| Area | Finding | Change and verification |
| --- | --- | --- |
| Camera/inference | 720p capture plus per-frame bitmap scaling added work | Request 640×360, permit negotiated 4:3 height up to 480, preserve actual camera aspect ratio, use 384-pixel-wide pose inference |
| Tracking | Detailed hand recognition can lose a rotated/small palm | Pose Lite tracks wrists with body context; low-confidence/occluded wrists are not reconstructed from elbows alone |
| Backend | GPU was selected without measurement | Warm CPU and GPU on the same camera image, compare three post-warmup samples, keep the faster available delegate and close the other instance |
| MediaPipe loader | A second ES-module task failed with “ModuleFactory not set” in a real browser | Per-instance WASM loader URLs rerun the factory module while retaining the same cacheable WASM binary URL; both delegates verified in the browser |
| Time | Capture timestamps were replaced with result receipt time | Retain original capture timestamps for filtering, bounded prediction, age diagnostics and collision freshness |
| Filtering | Presentation added a second smoothing stage and its own display loop | One adaptive filter; bounded prediction sampled from the game display loop; old unused smoothing helper removed |
| Frame scheduling | Pause/resume could retag an unfinished capture as belonging to a new session | Per-request identity and generation checks; stale bitmaps closed; old results may free a request but cannot move new-session cursors |
| Rendering | Repeated text/layout updates and video filtering | Transform-based cursors, dimensions cached by ResizeObserver, text/status updates only when values change, camera color filter removed |
| Camera mapping | Normalized coordinates ignored object-fit cover cropping | Apply the same center crop to cursor and collision coordinates |
| Startup | A late camera grant or failed video playback could leave tracks open | Await both startup outcomes, own tracks before playback, stop on failure, disable competing starts, calibrate before the session clock begins |
| Failure handling | A crashed worker could remain cached and appear to keep recovering | Retire the worker, clear cursors and initialization state, provide a restart instruction; transient detection errors remain retryable and selected GPU inference failure falls back to a fresh CPU task |
| End conditions | Ending on a miss could leave the current object iteration running | Stop processing additional objects after session end |
| Dependencies | npm audit identified a high-severity transitive source-map-js advisory | Compatible lockfile patch applied; final npm audit reports zero vulnerabilities |

## Verification

- **44 automated tests across four files passed.** Coverage includes scoring and streak thresholds, deductions and zero floor, simultaneous cursor catches, avoided hazards, collectible misses and miss-limit termination, all durations, keyboard movement, pause-time exclusion, replay, model/video startup failure, late camera grants, calibration timing, stale collisions, pose identity, crop mapping, backend selection/fallback, frame backpressure, stop/resume races and failed/crashed worker cleanup.
- Production build and whitespace/diff checks passed.
- Production UI checked at 1920×1080, 2560×1600 and 1366×768. Document dimensions matched each viewport; compact and 16:10 setup content fit its panel. Keyboard start and pause checked in the real browser. Production UI console had no warnings/errors in the checked session.
- Actual Pose Lite model and local WASM initialized in a browser worker; forced CPU and automatic CPU/GPU selection both passed.
- The minified production worker and copied dist model/WASM assets also passed 30 fixed-image detections with both wrists returned. Both delegates initialized; GPU was selected. That run measured median inference 14.15 ms and capture-to-result 15.25 ms.
- A **30-second synthetic-camera session** exercised the actual app, video, worker, rendering, collision and session-end path at 2560×1600. It processed 815 inference frames, returned 1630 wrist detections with zero empty-result frames, and released its camera track at session end.
- Synthetic-camera session measurements: median render cadence 59.88 FPS; inference median 22.45 ms / p95 28.60 ms; bitmap capture median 1.90 ms / p95 3.00 ms; capture-to-result median 25.10 ms / p95 31.40 ms. Calibration selected GPU (23.50 ms versus CPU 40.20 ms on that image).
- Separate fixed-image worker check: forced CPU median inference 37.30 ms; automatic selected GPU median inference 15.15 ms. These runs are different workloads/contexts and should not be combined into a before/after speedup.
- The synthetic source is Google's public MediaPipe pose sample image painted into a canvas stream. It contains no user camera data. The image is downloaded separately, ignored by Git, and excluded from the production build.

## Privacy, assets and deployment

All model, WASM and application assets are served by the same local/static host; camera processing and timing statistics stay in browser memory. No upload, analytics or remote inference endpoint was added. Received ImageBitmaps are closed in the worker's finally block. Disposing the tracker terminates the worker and its model resources.

The existing MediaPipe package remains pinned to 1.0.1. Pose Lite is downloaded from Google's official model URL; its SHA-256 is recorded in THIRD_PARTY_NOTICES.md. The original hand model remains available. happy-dom is a test-only dependency.

Use `npm run build` after each update. `npm run preview -- --port 4173` tests the existing optimized dist build; a permanent kiosk should serve dist through a static server. Node 22.12+ on the 22.x line, 24.x or 26+ supports the complete build/test toolchain.

## Remaining validation

No physical Raspberry Pi 5 or live human camera session was accessible during this audit. No hardware speedup percentage or guarantee of 60 FPS on the Pi is claimed. A fixed image cannot establish tracking quality under changing hand angles, seated occlusion, motion blur, lighting changes or multi-person distractions.

Show the upper body during calibration, then compare the same movement sequence on the Pi with default tracking and `?tracker=hands`. Read `window.gentleCatchDiagnostics()` for model/delegate, both calibration scores, inference/capture age percentiles and dropouts. Startup adds calibration work before the timer begins. A single visible-player calibration image is a short benchmark, not a sustained thermal test.

Prediction remains capped at 45 ms and 7.5% of normalized frame size. Collision eligibility expires after 140 ms of capture age and visibility holding after 360 ms. Slow inference, out-of-frame hands and prolonged occlusion can still interrupt input. Hidden wrists are not guessed indefinitely.

Validate long sessions with active cooling, the intended TV resolution, webcam and Chromium driver. Consider native inference or a separate MoveNet experiment only if these measurements show that the optimized browser pipeline still misses the device's latency budget.
