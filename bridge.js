// Instana Dashboard Fix — toggle bridge (ISOLATED world)
//
// Content scripts run in an isolated world and can use chrome.* APIs, but the
// page hook (inject.js) runs in the MAIN world and cannot. This tiny bridge
// reads the on/off state from chrome.storage and mirrors it onto a
// documentElement attribute that inject.js reads. It updates live when the
// toolbar popup flips the toggle, so no page reload is needed.
//
// It does no parsing, no polling, and no network work — one storage read plus a
// change listener — so it adds no meaningful load to any page.

(function () {
  "use strict";

  var ATTR = "data-instana-fix-enabled";

  function apply(enabled) {
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute(ATTR, enabled ? "1" : "0");
      }
    } catch (e) { /* ignore */ }
  }

  try {
    chrome.storage.local.get({ enabled: true }, function (res) {
      apply(!res || res.enabled !== false);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.enabled) {
        apply(changes.enabled.newValue !== false);
      }
    });
  } catch (e) {
    apply(true); // fail open (default enabled)
  }
})();
