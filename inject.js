// Instana Dashboard Fix — page hook (MAIN world)
//
// Runs in the page's MAIN world at document_start, before any WebSocket is
// opened. It wraps WebSocket.prototype.send once and, for Instana
// `getUnifiedMetrics` frames only, raises the `granularity` (rollup) of any
// time-series metric whose query would exceed the backend bucket limit. That
// lets such widgets render at short time ranges (e.g. Last hour) instead of
// returning the generic SERVER error.
//
// Instana detection is by FRAME PAYLOAD, not by hostname: a frame only matters
// if it is a SockJS `getUnifiedMetrics` command with a `metrics` map. On any
// non-Instana page (or any other frame) the wrapper returns immediately, so it
// works for SaaS or self-hosted Instana on any domain and adds no meaningful
// load anywhere else.
//
// Enable/disable is controlled from the toolbar popup. The current state is
// mirrored by the companion content script onto a documentElement attribute,
// which this script reads cheaply. Default = enabled.

(function () {
  "use strict";

  var CONFIG = {
    // Optional metric allow-list (substrings). Empty = every metric.
    metricMatch: [],
    // Coarsen a time-series query only when window/granularity exceeds this.
    // ~360 is the observed backend limit; 350 leaves a small margin.
    maxBuckets: 350,
    // When coarsening, never request a resolution finer than this (ms).
    minGranularityMs: 60000,
    // Also coarsen SINGLE_NUMBER widgets (clears the error; value may show "—").
    fixSingleNumber: false,
    // Console logging.
    verbose: true,
  };

  var ENABLED_ATTR = "data-instana-fix-enabled";

  var proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto || proto.__instanaFixPatched) return;
  proto.__instanaFixPatched = true;

  var origSend = proto.send;
  var LOG = "[Instana Dashboard Fix]";

  function isEnabled() {
    try {
      // Default ON: only an explicit "0" disables.
      return document.documentElement.getAttribute(ENABLED_ATTR) !== "0";
    } catch (e) {
      return true;
    }
  }

  function metricAllowed(metricId) {
    if (!CONFIG.metricMatch.length) return true;
    var s = String(metricId || "");
    for (var i = 0; i < CONFIG.metricMatch.length; i++) {
      if (s.indexOf(CONFIG.metricMatch[i]) !== -1) return true;
    }
    return false;
  }

  // Returns a possibly-rewritten SockJS frame string, or the original on any
  // uncertainty. Must never throw.
  function coarsen(data) {
    if (typeof data !== "string") return data;
    // Cheap fast-path guard: ignore everything that is not an Instana
    // getUnifiedMetrics frame. This is what keeps non-Instana pages free of load.
    if (data.indexOf("getUnifiedMetrics") === -1) return data;
    if (CONFIG.metricMatch.length) {
      var any = false;
      for (var k = 0; k < CONFIG.metricMatch.length; k++) {
        if (data.indexOf(CONFIG.metricMatch[k]) !== -1) { any = true; break; }
      }
      if (!any) return data;
    }

    var arr;
    try { arr = JSON.parse(data); } catch (e) { return data; }
    if (!Array.isArray(arr) || typeof arr[0] !== "string") return data;

    var s = arr[0];
    var comma = s.indexOf(",");
    if (comma === -1) return data;
    var cmd = s.slice(0, comma);
    if (cmd !== "getUnifiedMetrics") return data;

    var payload;
    try { payload = JSON.parse(s.slice(comma + 1)); } catch (e) { return data; }
    if (!payload || !payload.metrics || typeof payload.metrics !== "object") return data;

    var changed = false;
    var keys = Object.keys(payload.metrics);
    for (var i = 0; i < keys.length; i++) {
      var mm = payload.metrics[keys[i]];
      if (!mm || typeof mm !== "object") continue;
      if (!metricAllowed(mm.metric)) continue;

      var ws = mm.timeConfig && mm.timeConfig.windowSize;
      if (typeof ws !== "number" || ws <= 0) continue;

      var safe = Math.max(
        Math.ceil(ws / CONFIG.maxBuckets / 1000) * 1000,
        CONFIG.minGranularityMs
      );

      if (mm.resultType === "TIME_SERIES") {
        // Absent granularity => backend uses its finest => worst case (most buckets).
        var gran = (typeof mm.granularity === "number" && mm.granularity > 0)
          ? mm.granularity : 1;
        var buckets = ws / gran;
        if (buckets > CONFIG.maxBuckets && (mm.granularity == null || mm.granularity < safe)) {
          mm.granularity = safe;
          changed = true;
        }
      } else if (mm.resultType === "SINGLE_NUMBER" && CONFIG.fixSingleNumber) {
        if (mm.granularity == null || mm.granularity < safe) {
          mm.granularity = safe;
          changed = true;
        }
      }
    }

    if (!changed) return data;
    try {
      var out = JSON.stringify([cmd + "," + JSON.stringify(payload)]);
      if (CONFIG.verbose) {
        console.info(LOG, "coarsened getUnifiedMetrics for sub", payload.subscriptionId);
      }
      return out;
    } catch (e) {
      return data;
    }
  }

  proto.send = function (data) {
    // Toggle off => pure pass-through, no parsing.
    if (!isEnabled()) return origSend.call(this, data);
    var next = data;
    try { next = coarsen(data); } catch (e) { next = data; }
    return origSend.call(this, next);
  };

  if (CONFIG.verbose) {
    console.info(LOG, "installed (coarsens over-limit Instana time-series queries; maxBuckets=" + CONFIG.maxBuckets + ").");
  }
})();
