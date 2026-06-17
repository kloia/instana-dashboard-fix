// Instana Dashboard Fix — page hook (MAIN world)
//
// Runs in the page's MAIN world at document_start, before any WebSocket is
// opened, and wraps WebSocket.prototype so it can adjust Instana
// `getUnifiedMetrics` traffic. Two fixes:
//
//   1. Charts (TIME_SERIES) — DEFAULT ON. For any time-series metric whose
//      query would exceed the backend bucket limit, raise its `granularity`
//      (rollup) so the query stays under the limit. The chart then renders at
//      short time ranges instead of returning the generic SERVER error.
//
//   2. Big numbers (SINGLE_NUMBER) — OPT-IN (CONFIG.fixSingleNumber). The
//      single-value query path errors at short windows and has no granularity
//      knob. We make it return data by sending a coarse granularity, which
//      yields a short multi-bucket series; the renderer expects exactly one
//      value, so we trim the INCOMING response to its most recent point. This
//      is forward compatible: the trim only fires when the series has MORE THAN
//      ONE value, so if Instana ever returns a single value again (or fixes the
//      backend), the response is passed through untouched.
//
// Instana detection is by FRAME PAYLOAD, not by hostname, so it works on any
// Instana deployment and adds no meaningful load to other pages. Enable/disable
// is controlled from the toolbar popup (mirrored onto a documentElement
// attribute by the companion content script). Default = enabled.

(function () {
  "use strict";

  var CONFIG = {
    // Optional metric allow-list (substrings). Empty = every metric.
    metricMatch: [],
    // Coarsen a time-series query only when window/granularity exceeds this.
    maxBuckets: 350,
    // When coarsening, never request a resolution finer than this (ms).
    minGranularityMs: 60000,
    // Opt-in big-number fix (request coarsening + response trim-to-one).
    // EXPERIMENTAL: validate on your dashboard before relying on it.
    fixSingleNumber: false,
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

  function metricAllowed(metricId) {
    if (!CONFIG.metricMatch.length) return true;
    var s = String(metricId || "");
    for (var i = 0; i < CONFIG.metricMatch.length; i++) {
      if (s.indexOf(CONFIG.metricMatch[i]) !== -1) return true;
    }
    return false;
  }

  // ---- Outgoing: coarsen over-limit queries -------------------------------

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
      if (!metricAllowed(mm.metric)) continue;

      var ws = mm.timeConfig && mm.timeConfig.windowSize;
      if (typeof ws !== "number" || ws <= 0) continue;

      if (mm.resultType === "TIME_SERIES") {
        var safe = Math.max(
          Math.ceil(ws / CONFIG.maxBuckets / 1000) * 1000,
          CONFIG.minGranularityMs
        );
        var gran = (typeof mm.granularity === "number" && mm.granularity > 0) ? mm.granularity : 1;
        if (ws / gran > CONFIG.maxBuckets && (mm.granularity == null || mm.granularity < safe)) {
          mm.granularity = safe;
          changed = true;
        }
      } else if (mm.resultType === "SINGLE_NUMBER" && CONFIG.fixSingleNumber) {
        // No granularity => server single-value path, which errors at short
        // windows. Send the coarsest granularity (one window-sized bucket) so
        // the query succeeds; the few buckets it returns get trimmed on the way
        // back in (see trimIncoming).
        if (mm.granularity == null) {
          mm.granularity = ws;
          changed = true;
        }
      }
    }

    if (!changed) return data;
    try {
      var out = JSON.stringify([cmd + "," + JSON.stringify(payload)]);
      if (CONFIG.verbose) console.info(LOG, "coarsened getUnifiedMetrics for sub", payload.subscriptionId);
      return out;
    } catch (e) {
      return data;
    }
  }

  // ---- Incoming: trim big-number responses to a single value --------------
  // Forward compatible: only fires when values.length > 1.

  function trimIncoming(data) {
    if (typeof data !== "string" || data.indexOf("bigNumber") === -1) return data;
    var prefixed = data.charAt(0) === "a";
    var arr;
    try { arr = JSON.parse(prefixed ? data.slice(1) : data); } catch (e) { return data; }
    if (!Array.isArray(arr)) return data;

    var changed = false;
    var next = arr.map(function (sv) {
      if (typeof sv !== "string") return sv;
      var comma = sv.indexOf(",");
      if (comma === -1) return sv;
      var id = sv.slice(0, comma);
      var body;
      try { body = JSON.parse(sv.slice(comma + 1)); } catch (e) { return sv; }
      if (!body || !Array.isArray(body.data)) return sv;
      var touched = false;
      body.data.forEach(function (series) {
        if (series && series.id === "bigNumber" &&
            Array.isArray(series.values) && series.values.length > 1) {
          series.values = [series.values[series.values.length - 1]]; // keep most recent
          touched = true;
          changed = true;
        }
      });
      return touched ? id + "," + JSON.stringify(body) : sv;
    });

    if (!changed) return data;
    try { return (prefixed ? "a" : "") + JSON.stringify(next); } catch (e) { return data; }
  }

  // ---- Install ------------------------------------------------------------

  var origSend = proto.send;
  proto.send = function (data) {
    if (!isEnabled()) return origSend.call(this, data);
    var next = data;
    try { next = coarsenSend(data); } catch (e) { next = data; }
    return origSend.call(this, next);
  };

  // Incoming interception is only installed when the opt-in big-number fix is
  // on, so the default (chart-only) path has zero message-path overhead.
  if (CONFIG.fixSingleNumber) {
    var maybeTrim = function (ev, deliver) {
      if (!isEnabled()) return deliver(ev);
      var fixed;
      try { fixed = trimIncoming(ev.data); } catch (e) { fixed = ev.data; }
      if (fixed === ev.data) return deliver(ev);
      try { return deliver(new MessageEvent("message", { data: fixed })); }
      catch (e) { return deliver(ev); }
    };

    var origAdd = proto.addEventListener;
    proto.addEventListener = function (type, listener, opts) {
      if (type === "message" && typeof listener === "function") {
        var self = this;
        var wrapped = function (ev) { return maybeTrim(ev, function (e) { return listener.call(self, e); }); };
        return origAdd.call(this, type, wrapped, opts);
      }
      return origAdd.call(this, type, listener, opts);
    };

    var desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
    if (desc && desc.set) {
      Object.defineProperty(proto, "onmessage", {
        configurable: true,
        enumerable: true,
        get: function () { return this.__instanaOnMessage || null; },
        set: function (fn) {
          this.__instanaOnMessage = fn;
          var self = this;
          desc.set.call(this, function (ev) { return maybeTrim(ev, function (e) { return fn.call(self, e); }); });
        },
      });
    }
  }

  if (CONFIG.verbose) {
    console.info(LOG, "installed (charts auto; big-number fix " +
      (CONFIG.fixSingleNumber ? "ON" : "off") + "; maxBuckets=" + CONFIG.maxBuckets + ").");
  }
})();
