# Instana Dashboard Fix

A small Chrome/Edge extension that makes Instana custom-dashboard widgets render
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
inspects outgoing `getUnifiedMetrics` frames. The backend errors whenever a metric is queried
at a rollup **finer than ~30s** (this is what breaks the widgets at short time ranges — and
it is the rollup, not the number of buckets, that matters). So for any **chart (time-series)**
metric the extension raises the **`granularity`** to a 30s floor when the query asks for
something finer. The time range you selected is untouched — only the resolution is coarsened.
So *Last hour* (or *Last 10 minutes*) keeps its range, and the chart renders.

This was verified across 10m / 15m / 20m / 1h windows: requests finer than ~30s error;
forcing ≥30s renders.

### Instana-only, without hostname filtering

The extension does **not** match on a specific hostname (Instana can be SaaS or
self-hosted on any domain). Instead it activates by **frame payload**: a frame is only
touched if it is a SockJS `getUnifiedMetrics` command containing a `metrics` map. On every
other page — and every other WebSocket frame — the hook hits a one-line `indexOf` guard and
returns immediately. So it behaves as Instana-only and adds no meaningful load anywhere
else (no polling, no timers, no network calls).

## What it fixes

| Widget type | Status |
|---|---|
| Chart (TIME_SERIES) | ✅ Fixed — on by default |
| Big number (SINGLE_NUMBER) | ✅ Fixed — on by default |

### Big-number widgets

Big numbers use a separate server path that returns a single aggregated value and has no
granularity knob; at short windows that path errors. The fix is request-only: it **widens just
that query's window to 6h** (where the native single-value path works) and drops any
granularity, so the widget renders one value. There is no response interception.

**"Use last value" is supported.** The widget renders whether *Use last value* (`lastValue:
true`) is checked or not — verified at short windows.

**Trade-off:** because the big-number query uses a ~6h window, the number reflects roughly the
last 6 hours rather than the chart's exact selected range (configurable via
`singleNumberWindowMs`). For a slow-moving gauge this is usually fine; if you need the exact
selected range, disable the big-number fix.

To **disable** the big-number fix (and keep only the chart fix), set `fixSingleNumber: false`
in `inject.js` and reload the extension.

## Files

```
instana-dashboard-fix-extension/
├── manifest.json   # MV3 manifest (storage permission, toolbar popup, content scripts)
├── inject.js       # MAIN-world page hook: the WebSocket rewriter
├── bridge.js       # ISOLATED-world bridge: mirrors the on/off toggle to the page
├── popup.html      # toolbar popup UI (on/off switch)
├── popup.js        # popup logic (reads/writes the toggle in chrome.storage)
├── Makefile        # lint + package into a distributable .zip
└── README.md       # this file
```

## Install

> Chrome only installs `.crx` files that come from the Chrome Web Store, so there is no
> "double-click to install" for a self-distributed build. Use **Load unpacked** below — it
> works on any Chrome/Edge today, with no account and no review.

### From a release (recommended)

1. Go to the **Releases** page and download the latest
   `instana-dashboard-fix-extension-<version>.zip`.
2. **Unzip it** to a folder you'll keep (the extension loads from this folder, so don't
   delete it afterwards).
3. Open `chrome://extensions` (or `edge://extensions`).
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.
6. Confirm the card shows **Instana Dashboard Fix**. Click the puzzle-piece toolbar icon and
   **pin** it for quick access to the on/off switch.
7. Open an Instana dashboard, set the range to **Last hour**, and confirm the chart renders.
   (Optional) open DevTools console (F12) and look for `[Instana Dashboard Fix] installed`.

### From source

```bash
git clone https://github.com/kloia/instana-dashboard-fix.git
```
Then follow steps 3–7 above, selecting the cloned `instana-dashboard-fix` folder directly
(no unzip needed).

### Updating

After pulling new code or editing files, open `chrome://extensions` and click the **reload**
(↻) icon on the extension card, then reload your dashboard tab.

### Removing

Click **Remove** on the extension card (or just use the popup toggle to disable it). The
dashboard reverts to its original behavior on the next reload.

## Toggle (on/off)

Click the toolbar icon to open the popup and flip **Enabled / Disabled**. The state is stored
in `chrome.storage.local` and applied live; reload the dashboard tab to be sure it applies to
already-open queries. When disabled, the hook is a pure pass-through. Default is **Enabled**.

## Build / package with Make

From inside the extension folder:

```bash
make lint      # syntax-check the JS and validate manifest.json
make package   # produce dist/instana-dashboard-fix-extension-<version>.zip
make clean     # remove the dist/ folder
make           # lint + package (default target)
```

Requires `zip` and `python3`; `node` is optional (used for the JS syntax check). Pushing a
`vX.Y.Z` git tag also builds and attaches the zip to a GitHub Release automatically
(`.github/workflows/release.yml`).

## Configuration (`inject.js`)

- `sources` — which metric sources to touch (default `["INFRASTRUCTURE_METRICS"]`). This is
  what keeps APPLICATION / website / mobile widgets (e.g. an app error rate or latency) working
  natively and untouched. Empty = all sources.
- `singleNumberWindowMs` — the window the big-number query is widened to (default `21600000`
  = 6h). Lower it for a number closer to your selected range, but not so low that the
  single-value path errors again.
- `metricMatch` — optional substrings to scope the fix to specific metrics. Empty = every
  metric (default).
- `minGranularityMs` — the absolute minimum rollup, **always enforced** (default `30000` =
  30s). The backend errors when the rollup is finer than ~30s for the affected metrics —
  regardless of how many buckets that is — so this is the real fix and the finest
  verified-safe value (it renders at 10m, 15m, 20m and 1h windows). Raise it if a chart still
  errors; you can't go below ~30s without re-introducing the error.
- `maxBuckets` — backstop only (default `1500`): caps the bucket count on very long windows so
  responses don't get huge. It does not drive the fix; the rollup floor does.
- `fixSingleNumber` — the big-number fix (default `true`; set `false` to disable it).
- `verbose` — console logging (default `true`).

## Safety / scope

- Activates by frame payload, not hostname; no host permissions are requested.
- Only rewrites **outgoing** `getUnifiedMetrics` frames for the configured metric sources
  (default infrastructure metrics only). There is no response interception; every other frame
  and every other metric passes through unchanged. All rewrite logic is wrapped so it can never
  throw and break the socket.
- Changes nothing server-side and saves nothing to any dashboard. It is a per-browser,
  client-side mitigation, and is the right stop-gap while the platform-side fix is pursued
  with the vendor.
