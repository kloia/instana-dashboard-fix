// Instana Dashboard Fix — page hook (MAIN world)
//
// Runs in the page's MAIN world at document_start and wraps WebSocket.send to
// adjust outgoing Instana `getUnifiedMetrics` frames so custom-infrastructure
// widgets render at short time ranges instead of failing with a SERVER error.
// It only rewrites outgoing requests — there is no response interception.
//
// Scope: by default only metrics with source INFRASTRUCTURE_METRICS (e.g. custom
// Prometheus gauges) are touched. APPLICATION / website / mobile metrics work
// natively and are left completely alone, so widgets like an application error
// rate or latency are never affected.
//
// Two fixes (both request-only):
//   1. Charts (TIME_SERIES): the backend errors when the rollup is finer than
//      ~30s (regardless of bucket count), so we raise `granularity` to a 30s
//      floor. The selected time range is unchanged.
//   2. Big numbers (SINGLE_NUMBER): the single-value path errors at short
//      windows and has no granularity knob, so we widen ONLY that query's window
//      to >= 6h (where the native single-value path works) and drop any
//      granularity. The widget then renders one value — including when "Use last
//      value" is checked. Trade-off: the big number reflects a ~6h window, so it
//      may differ slightly from the chart's selected range.
//
// Enable/disable is controlled from the toolbar popup (mirrored onto a
// documentElement attribute by the companion content script). Default = enabled.

(function () {
  "use strict";

  var CONFIG = {
    // Metric sources to apply fixes to. Empty = all sources. Default scopes the
    // fix to custom-infrastructure metrics, which are the ones that break.
    sources: ["INFRASTRUCTURE_METRICS"],
    // Optional metric allow-list (substrings). Empty = every metric.
    metricMatch: [],
    // Absolute minimum rollup (ms) for time-series queries (the real chart fix).
    minGranularityMs: 30000,
    // Backstop: cap bucket count on very long windows. Does not drive the fix.
    maxBuckets: 1500,
    // Big-number fix: widen the single-value query to at least this window (ms)
    // so the native single-value path succeeds. 6h is comfortably safe.
    fixSingleNumber: true,
    singleNumberWindowMs: 21600000,
    // Console logging.
    verbose: true,
  };

  var ENABLED_ATTR = "data-instana-fix-enabled";
  var proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto || proto.__instanaFixPatched) return;
  proto.__instanaFixPatched = true;

  var LOG = "[Instana Dashboard Fix]";

  function isEnabled() {
    try {
      return document.documentElement.getAttribute(ENABLED_ATTR) !== "0";
    } catch (e) {
      return true;
    }
  }

  function listed(list, value) {
    if (!list.length) return true;
    var s = String(value || "");
    for (var i = 0; i < list.length; i++) {
      if (s.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  function coarsenSend(data) {
    if (typeof data !== "string") return data;
    if (data.indexOf("getUnifiedMetrics") === -1) return data;

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
      // Scope: only touch the configured metric sources (and optional metric
      // allow-list). Everything else passes through unchanged.
      if (!listed(CONFIG.sources, mm.source)) continue;
      if (!listed(CONFIG.metricMatch, mm.metric)) continue;

      var ws = mm.timeConfig && mm.timeConfig.windowSize;
      if (typeof ws !== "number" || ws <= 0) continue;

      if (mm.resultType === "TIME_SERIES") {
        var target = CONFIG.minGranularityMs;
        var capByBuckets = Math.ceil(ws / CONFIG.maxBuckets / 1000) * 1000;
        if (capByBuckets > target) target = capByBuckets;
        if (mm.granularity == null || mm.granularity < target) {
          mm.granularity = target;
          changed = true;
        }
      } else if (mm.resultType === "SINGLE_NUMBER" && CONFIG.fixSingleNumber) {
        // Widen this query's window to where the native single-value path works,
        // and drop any granularity so we stay on that single-value path.
        if (mm.timeConfig && mm.timeConfig.windowSize < CONFIG.singleNumberWindowMs) {
          mm.timeConfig.windowSize = CONFIG.singleNumberWindowMs;
          changed = true;
        }
        if (mm.granularity != null) {
          delete mm.granularity;
          changed = true;
        }
      }
    }

    if (!changed) return data;
    try {
      var out = JSON.stringify([cmd + "," + JSON.stringify(payload)]);
      if (CONFIG.verbose) console.info(LOG, "adjusted getUnifiedMetrics for sub", payload.subscriptionId);
      return out;
    } catch (e) {
      return data;
    }
  }

  var origSend = proto.send;
  proto.send = function (data) {
    if (!isEnabled()) return origSend.call(this, data);
    var next = data;
    try { next = coarsenSend(data); } catch (e) { next = data; }
    return origSend.call(this, next);
  };

  if (CONFIG.verbose) {
    console.info(LOG, "installed (sources=" + (CONFIG.sources.join(",") || "all") +
      "; min rollup " + (CONFIG.minGranularityMs / 1000) + "s; big-number fix " +
      (CONFIG.fixSingleNumber ? "on" : "off") + ").");
  }
})();
