// Instana Dashboard Fix — page hook (MAIN world)
//
// Runs in the page's MAIN world at document_start, before any WebSocket is
// opened, and wraps WebSocket.prototype so it can adjust Instana
// `getUnifiedMetrics` traffic. Two fixes:
//
//   1. Charts (TIME_SERIES) — DEFAULT ON. The backend errors when the requested
//      rollup is finer than ~30s (independent of bucket count). We enforce an
//      absolute minimum rollup so the chart renders at short time ranges instead
//      of returning the generic SERVER error.
//
//   2. Big numbers (SINGLE_NUMBER) — DEFAULT ON. The single-value path errors at
//      short windows and has no granularity knob. We make it return data by
//      sending a window-sized granularity (a short multi-bucket series), then
//      trim the INCOMING response to its most recent point — the shape the
//      renderer expects, and exactly what "Use last value" displays. Forward
//      compatible: the trim only fires when the series has MORE THAN ONE value.
//
// Instana detection is by FRAME PAYLOAD, not by hostname. Enable/disable is
// controlled from the toolbar popup (mirrored onto a documentElement attribute
// by the companion content script). Default = enabled.

(function () {
  "use strict";

  var CONFIG = {
    // Optional metric allow-list (substrings). Empty = every metric.
    metricMatch: [],
    // Absolute minimum rollup (ms) for time-series queries. The backend errors
    // below ~30s for the affected metrics regardless of bucket count, so this is
    // the finest verified-safe value. Raise if a chart still errors.
    minGranularityMs: 30000,
    // Backstop only: cap bucket count on very long windows so responses don't
    // get huge. Does not drive the fix (the rollup floor does).
    maxBuckets: 1500,
    // Big-number fix (request coarsening + response trim-to-one).
    fixSingleNumber: true,
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

  // ---- Outgoing: enforce a safe rollup ------------------------------------

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
        // Enforce the absolute minimum rollup; bucket cap is only a backstop.
        var target = CONFIG.minGranularityMs;
        var capByBuckets = Math.ceil(ws / CONFIG.maxBuckets / 1000) * 1000;
        if (capByBuckets > target) target = capByBuckets;
        if (mm.granularity == null || mm.granularity < target) {
          mm.granularity = target;
          changed = true;
        }
      } else if (mm.resultType === "SINGLE_NUMBER" && CONFIG.fixSingleNumber) {
        // No granularity => single-value path, which errors at short windows.
        // Send a window-sized granularity (>= the rollup floor for any real
        // window) so the query returns data; trimIncoming reduces it to one
        // value. Works whether or not the widget's "Use last value" is set.
        if (mm.granularity == null || mm.granularity < ws) {
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

  if (CONFIG.fixSingleNumber) {
    // Rebuild the event so the consumer (SockJS) sees the trimmed data but every
    // other MessageEvent field is preserved — otherwise a stripped-down event
    // (e.g. missing origin) can be dropped and the widget shows nothing.
    var rebuild = function (ev, fixed) {
      try {
        return new MessageEvent("message", {
          data: fixed,
          origin: ev.origin,
          lastEventId: ev.lastEventId,
          source: ev.source,
          ports: ev.ports,
        });
      } catch (e) {
        return null;
      }
    };

    var maybeTrim = function (ev, deliver) {
      if (!isEnabled()) return deliver(ev);
      var fixed;
      try { fixed = trimIncoming(ev.data); } catch (e) { fixed = ev.data; }
      if (fixed === ev.data) return deliver(ev);
      var rebuilt = rebuild(ev, fixed);
      return deliver(rebuilt || ev);
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
    console.info(LOG, "installed (min rollup " + (CONFIG.minGranularityMs / 1000) +
      "s; big-number fix " + (CONFIG.fixSingleNumber ? "on" : "off") + ").");
  }
})();
