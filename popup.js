// Instana Dashboard Fix — popup toggle
"use strict";

(function () {
  var toggle = document.getElementById("toggle");
  var state = document.getElementById("state");

  function render(enabled) {
    toggle.checked = !!enabled;
    state.textContent = enabled ? "Enabled" : "Disabled";
  }

  chrome.storage.local.get({ enabled: true }, function (res) {
    render(!res || res.enabled !== false);
  });

  toggle.addEventListener("change", function () {
    var enabled = toggle.checked;
    chrome.storage.local.set({ enabled: enabled }, function () {
      render(enabled);
    });
  });
})();
