(function () {
  "use strict";
  var POLL_MS = 3000;
  var fmt = new Intl.NumberFormat("en-US");
  var shown = { total: 0, go: 0, land: 0, pace: 0, wait: 0, unknown: 0 };
  var first = true;

  function el(id) { return document.getElementById(id); }

  function tween(key, id, to) {
    var from = shown[key];
    shown[key] = to;
    if (first || from === to) { el(id).textContent = fmt.format(to); return; }
    var start = performance.now();
    var dur = 900;
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - t, 3);
      el(id).textContent = fmt.format(Math.round(from + (to - from) * e));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function setStatus(ok, text) {
    el("lc-dot").className = ok ? "dot" : "dot off";
    el("lc-status").textContent = text;
  }

  function render(data) {
    var a = data.actions || {};
    tween("total", "lc-total", data.invocations || 0);
    var keys = ["go", "land", "pace", "wait", "unknown"];
    keys.forEach(function (k) { tween(k, "lc-" + k, a[k] || 0); });
    var sum = keys.reduce(function (n, k) { return n + (a[k] || 0); }, 0);
    ["go", "land", "pace", "wait"].forEach(function (k) {
      el("lc-bar-" + k).style.width = sum ? ((a[k] || 0) / sum) * 100 + "%" : "0";
    });
    if (data.updated_at) {
      el("lc-updated").textContent = "Last check " + new Date(data.updated_at).toLocaleTimeString() + ". Counting since 25 Oct 2026. Anonymous counts only.";
    }
    first = false;
  }

  function poll() {
    fetch("/api/limitcheck", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (data) { render(data); setStatus(true, "live"); })
      .catch(function () { setStatus(false, "reconnecting…"); })
      .then(function () { setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS); });
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-copy]");
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
      b.textContent = "copied";
      setTimeout(function () { b.textContent = "copy"; }, 1500);
    });
  });

  poll();
})();
