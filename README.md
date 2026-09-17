# Gentle Catch

Gentle Catch is a calm, camera-controlled movement game designed with older adults in mind. Leaves, flowers, hearts, and stars drift down the screen; players collect them with one or both hands. It uses its own name, visual language, rules, and artwork.

## Why it runs well on a Raspberry Pi

The browser requests a 720p camera stream for a clear display. A worker downsamples frames to 512 × 288 and runs MediaPipe Hand Landmarker away from the game animation, tracking up to two palms at once. Busy inference frames are skipped instead of queued. A lightweight velocity-aware filter limits sudden landmark spikes, while bounded prediction updates the cursor at the display refresh rate between camera results. The hand model and WebAssembly runtime are included in the project, so there is no model download during play.

No image or video leaves the device. Hand landmark inference happens locally in browser memory.

## Laptop quick start

Requirements: Node.js 20.19+ or 22.12+ and a current Chrome, Edge, or Firefox browser.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, select a pace, and allow camera access. Camera access requires `localhost` or HTTPS. An evenly lit room and uncluttered background give the most stable tracking. Keyboard play is available with the arrow keys or W, A, S, and D.

## Controls and accessibility

- **Gentle, Steady, Lively** adjust fall speed, spawn interval, object count, and missed-object allowance.
- Sessions can be 1, 2, 3, or 5 minutes.
- Pause or end a session at any time. Space or Escape also pauses when playing with the keyboard.
- The game supports keyboard navigation, large controls, semantic labels, reduced motion, high contrast preferences, and responsive layouts.
- One or both hands can be used simultaneously. Each palm gets its own cursor.
- It can be played seated or standing. The player should stop if movement is uncomfortable.

## Raspberry Pi 5 kiosk deployment

Install Raspberry Pi OS 64-bit with Desktop, Node.js 22, and Chromium. Attach a UVC-compatible 1080p webcam, then:

```bash
npm ci
npm run build
npm run preview -- --port 4173
```

For a kiosk session, launch Chromium after the server starts:

```bash
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4173
```

The site is entirely static after `npm run build`; `vite preview` can be replaced by nginx, Caddy, or any local static server serving `dist/`. The first camera permission must be accepted by a caregiver. For automatic kiosk startup, save the server and Chromium commands in a systemd user service or the desktop autostart configuration.

## Privacy and limitations

Processing happens in browser memory. Frames are discarded immediately and are never stored or uploaded. The tracker estimates 21 landmarks on each visible hand and uses the palm center as the cursor. Occlusion, very low light, motion blur, or hands outside the camera view can briefly interrupt tracking. It is a recreational wellbeing game, not a medical device, fall detector, or rehabilitation assessment.

## Commands

```bash
npm run dev       # development server
npm test          # unit tests
npm run build     # production bundle
npm run preview   # serve production bundle locally
```
