# Instana Dashboard Fix

A small Chrome/Edge extension that makes Instana custom-dashboard **chart** widgets render
at short time ranges (e.g. *Last hour*) when they would otherwise fail with
*"Something went wrong... Please try again later."*

## The problem it solves

At short time windows Instana can request a metric at a very fine resolution (rollup). For
some metrics this produces more time buckets (`window / granularity`) than the backend will
serve, and instead of automatically coarsening the resolution it returns a generic `SERVER`
error. The widget then shows the "Something went wrong" message. Widening the time range
works around it, but forces you off the range you actually want.

This extension fixes that without changing your selected time range.

## How it works

It hooks the dashboard's WebSocket **in the page's main world, at document start**, and
inspects outgoing `getUnifiedMetrics` frames. For any **time-series** metric whose query
would exceed the bucket limit, it raises that metric's **`granularity`** (rollup) just
enough to stay under the limit. The time range you selected is untouched — only the
resolution of the at-risk query is coarsened. So *Last hour* stays *Last hour*, and the
chart renders.

This is the lever verified in testing: coarsening `granularity` from 10s to 60s made a
failing chart render at a 1-hour window.

### Instana-only, without hostname filtering

The extension does **not** match on a specific hostname (Instana can be SaaS or
self-hosted on any domain). Instead it activates by **frame payload**: a frame is only
touched if it is a SockJS `getUnifiedMetrics` command containing a `metrics` map. On every
other page — and every other WebSocket frame — the hook hits a one-line `indexOf` guard and
returns immediately. So it behaves as Instana-only and adds no meaningful load anywhere
else (no polling, no timers, no network calls).

## What it fixes (and what it doesn't)

| Widget type | Result |
|---|---|
| Chart (TIME_SERIES) | ✅ Fixed — renders at short ranges |
| Big number (SINGLE_NUMBER) | ⚠️ Not changed by default |

Big-number widgets are left alone by default. Coarsening their frame clears the error but
the widget can render `—`, because its renderer expects Instana's native single-value
response shape. For those, keep using a wider range, or wait for the platform-side fix. You
can opt in with `fixSingleNumber: true` in `inject.js`.

## Files

```
instana-dashboard-fix-extension/
├── manifest.json   # MV3 manifest (storage permission, toolbar popup, content scripts)
├── inject.js       # MAIN-world page hook: the WebSocket granularity rewriter
├── bridge.js       # ISOLATED-world bridge: mirrors the on/off toggle to the page
├── popup.html      # toolbar popup UI (on/off switch)
├── popup.js        # popup logic (reads/writes the toggle in chrome.storage)
├── Makefile        # lint + package into a distributable .zip
└── README.md       # this file
```

## Toggle (on/off)

Click the extension's toolbar icon to open the popup and flip **Enabled / Disabled**. The
state is stored in `chrome.storage.local` and applied live; reload the dashboard tab to be
sure the change takes effect on already-open queries. When disabled, the hook is a pure
pass-through (it does not parse or modify any frame). Default is **Enabled**.

## Install (unpacked — recommended)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `instana-dashboard-fix-extension` folder.
4. Confirm the card shows **Instana Dashboard Fix** and is enabled. Pin its toolbar icon if
   you want quick access to the toggle.
5. Open an Instana dashboard, set the range to **Last hour**, and confirm the affected chart
   renders. Open DevTools console (F12) to see `[Instana Dashboard Fix] installed...` and
   `coarsened getUnifiedMetrics...` log lines.

To **update** after editing files: click the refresh icon on the extension card in
`chrome://extensions`, then reload the dashboard tab.

To **remove**: use **Remove** (or just toggle it off) on the extensions page.

## Install from a packaged .zip

Built with `make package` (see below):

1. Unzip `dist/instana-dashboard-fix-extension-<version>.zip` into a folder.
2. Follow the **Load unpacked** steps above, selecting the unzipped folder.

(Chrome's *Load unpacked* needs an unpacked folder, so unzip first. The same `.zip` is the
format the Chrome Web Store / Edge Add-ons accept for private publishing.)

## Build / package with Make

From inside this folder:

```bash
make lint      # syntax-check the JS and validate manifest.json
make package   # produce dist/instana-dashboard-fix-extension-<version>.zip
make clean     # remove the dist/ folder
make           # lint + package (default target)
```

Requires `zip` and `python3`; `node` is optional (used for the JS syntax check).

## Configuration (`inject.js`)

- `metricMatch` — optional substrings to scope the fix to specific metrics. Empty = every
  metric (default).
- `maxBuckets` — coarsen a time-series query only when `window / granularity` exceeds this
  (default `350`; observed backend limit ≈ 360).
- `minGranularityMs` — never request a resolution finer than this when coarsening
  (default `60000` = 60s, a known-good value).
- `fixSingleNumber` — also coarsen big-number widgets (default `false`).
- `verbose` — console logging (default `true`).

## Safety / scope

- Activates by frame payload, not hostname; no host permissions are requested.
- Only rewrites outgoing `getUnifiedMetrics` frames that would exceed the bucket limit;
  every other frame passes through unchanged. All rewrite logic is wrapped so it can never
  throw and break the socket.
- Changes nothing server-side and saves nothing to any dashboard. It is a per-browser,
  client-side mitigation, and is the right stop-gap while the platform-side fix is pursued
  with the vendor.
