(function () {
  "use strict";

  const API_URL = "https://supercompress.dev/api/v1/compress";
  const KEY_STORE = "sc_live_demo_key";
  /** In-memory only for the page session — do not persist API keys in sessionStorage. */
  let memoryApiKey = "";
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
  const $ = (id) => document.getElementById(id);

  function noisyLines(prefix, count, details) {
    return Array.from({ length: count }, (_, i) => {
      const item = details[i % details.length];
      return `[${prefix} ${String(i + 1).padStart(3, "0")}] ${item}`;
    });
  }

  const scenarios = {
    incident: {
      query: "What caused the checkout outage, what is the exact rollback command, and how many customers were affected?",
      critical: [
        "ROOT CAUSE: checkout-api release 2026.06.13 changed REDIS_POOL_SIZE from 200 to 20; the pool saturated under normal traffic.",
        "ROLLBACK COMMAND: kubectl rollout undo deployment/checkout-api -n production --to-revision=184",
        "CUSTOMER IMPACT: 18,742 checkout attempts failed between 14:32 and 14:44 UTC.",
      ],
      context: [
        "# Production incident memory — INC-8842",
        "Service: checkout-api | Severity: SEV-1 | Region: us-east-1",
        "",
        ...noisyLines("timeline", 34, [
          "Grafana dashboard opened; aggregate CPU remained below 44%.",
          "On-call acknowledged duplicate PagerDuty notification.",
          "S3 receipt-worker queue depth remained within normal range.",
          "Search index lag measured 1.8 seconds; unrelated to checkout path.",
          "Customer support linked three reports with generic payment error copy.",
          "Synthetic probe retried POST /api/checkout and received HTTP 503.",
        ]),
        "",
        "## Confirmed findings",
        "ROOT CAUSE: checkout-api release 2026.06.13 changed REDIS_POOL_SIZE from 200 to 20; the pool saturated under normal traffic.",
        "Evidence: RedisPoolTimeout exceptions began 41 seconds after revision 185 reached 100% traffic.",
        "ROLLBACK COMMAND: kubectl rollout undo deployment/checkout-api -n production --to-revision=184",
        "CUSTOMER IMPACT: 18,742 checkout attempts failed between 14:32 and 14:44 UTC.",
        "Recovery: error rate returned below 0.2% three minutes after rollback.",
        "",
        ...noisyLines("tool", 46, [
          "kubectl get pods returned 24/24 Ready.",
          "Datadog trace sampled a healthy GET /api/catalog request.",
          "grep searched repository for connection_timeout; 19 files matched.",
          "Slack export contained repeated incident-room join notifications.",
          "CloudWatch listed normal memory utilization for receipt-worker.",
          "DNS health check passed from three regions.",
        ]),
        "",
        "Owner: platform-oncall | Follow-up: add pool saturation release guard.",
      ].join("\n"),
    },
    security: {
      query: "Which credential was exposed, where was it found, and what exact containment action is required?",
      critical: [
        "EXPOSED CREDENTIAL: production Stripe restricted key rk_live_7f...2Q with refunds:write permission.",
        "DISCOVERY LOCATION: plaintext in build artifact dist/config/debug.json from CI run 99184.",
        "CONTAINMENT: revoke key rk_live_7f...2Q in Stripe, rotate STRIPE_REFUND_KEY, then purge artifact 99184 from storage.",
      ],
      context: [
        "# Security investigation memory — SEC-219",
        "Classification: credential exposure | Status: active containment",
        "",
        ...noisyLines("scan", 42, [
          "Dependency audit reported zero critical package vulnerabilities.",
          "Container base image digest matched the approved release manifest.",
          "WAF sampled normal bot traffic against the documentation site.",
          "Git history search found test fixtures with redacted tokens.",
          "IAM analyzer listed an unrelated stale staging role.",
        ]),
        "",
        "## Verified exposure",
        "EXPOSED CREDENTIAL: production Stripe restricted key rk_live_7f...2Q with refunds:write permission.",
        "DISCOVERY LOCATION: plaintext in build artifact dist/config/debug.json from CI run 99184.",
        "CONTAINMENT: revoke key rk_live_7f...2Q in Stripe, rotate STRIPE_REFUND_KEY, then purge artifact 99184 from storage.",
        "Observed use: no unauthorized Stripe API calls found as of 16:20 UTC.",
        "",
        ...noisyLines("audit", 44, [
          "Reviewed SSO login from corporate device; expected behavior.",
          "Checked npm provenance metadata; signature valid.",
          "Queried VPC flow logs for staging NAT gateway.",
          "Reviewed historical false-positive secret scanner finding.",
          "Compared deployment checksums across healthy regions.",
        ]),
        "",
        "Incident owner: security-oncall | Legal notification threshold not met.",
      ].join("\n"),
    },
    research: {
      query: "What was the trial's primary endpoint result, confidence interval, and main safety signal?",
      critical: [
        "PRIMARY ENDPOINT: intervention reduced median recovery time by 2.8 days versus placebo.",
        "EFFECT ESTIMATE: hazard ratio 1.42 with 95% CI 1.18–1.71; p=0.0002.",
        "MAIN SAFETY SIGNAL: transient grade-2 liver enzyme elevation occurred in 6.1% versus 2.0% of placebo participants.",
      ],
      context: [
        "# Evidence review memory — randomized controlled trial",
        "Population: 612 adults | Blinded | Multicenter | Follow-up: 90 days",
        "",
        ...noisyLines("paper", 38, [
          "Introduction reviews prior observational studies.",
          "Appendix describes site investigator training procedures.",
          "Baseline demographic table reports balanced age distribution.",
          "Protocol amendment adjusted secondary survey timing.",
          "Recruitment flow diagram lists screened participants.",
        ]),
        "",
        "## Results required for decision",
        "PRIMARY ENDPOINT: intervention reduced median recovery time by 2.8 days versus placebo.",
        "EFFECT ESTIMATE: hazard ratio 1.42 with 95% CI 1.18–1.71; p=0.0002.",
        "MAIN SAFETY SIGNAL: transient grade-2 liver enzyme elevation occurred in 6.1% versus 2.0% of placebo participants.",
        "No treatment-related deaths were reported.",
        "",
        ...noisyLines("appendix", 46, [
          "Site monitoring schedule was completed as planned.",
          "Exploratory biomarker sample was unavailable for one participant.",
          "Questionnaire translation followed the standard process.",
          "Data lock occurred after final query resolution.",
          "Supplement lists investigator affiliations.",
        ]),
        "",
        "Review note: endpoint and safety figures should be checked against the final publication.",
      ].join("\n"),
    },
  };

  let activeScenario = "incident";
  let latestResult = null;
  let latestLatency = 0;

  function formatNumber(value, digits = 0) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function normalizeLine(line) {
    return line.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function lineRetention(context, compressed) {
    const kept = new Map();
    compressed.split("\n").forEach((line) => {
      const key = normalizeLine(line);
      if (key) kept.set(key, (kept.get(key) || 0) + 1);
    });
    return context.split("\n").map((line) => {
      const key = normalizeLine(line);
      const count = kept.get(key) || 0;
      if (key && count > 0) kept.set(key, count - 1);
      return { line, kept: Boolean(key && count > 0) };
    });
  }

  function renderContext(retention) {
    const scenario = scenarios[activeScenario];
    const lines = scenario.context.split("\n");
    $("line-count").textContent = formatNumber(lines.length);
    $("char-count").textContent = formatNumber(scenario.context.length);
    $("context-view").innerHTML = lines.map((line, index) => {
      const isCritical = scenario.critical.includes(line);
      const state = retention ? (retention[index].kept ? " is-kept" : " is-dropped") : "";
      return `<div class="context-line${isCritical ? " is-critical" : ""}${state}"><i>${index + 1}</i><span>${escapeHtml(line || " ")}</span></div>`;
    }).join("");
  }

  function renderScenario(name) {
    activeScenario = name;
    const scenario = scenarios[name];
    $("query").value = scenario.query;
    document.querySelectorAll("[data-scenario]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.scenario === name);
    });
    latestResult = null;
    $("telemetry-empty").hidden = false;
    $("telemetry-results").hidden = true;
    $("result-stage").hidden = true;
    renderContext();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setApiState(label, state) {
    $("api-state").textContent = label;
    $("api-dot").className = "state-dot" + (state ? ` is-${state}` : "");
  }

  function showError(message) {
    const el = $("demo-error");
    el.textContent = message;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 6000);
  }

  function renderScale() {
    if (!latestResult) return;
    const runs = Number($("daily-runs").value);
    const tokensSaved = Math.max(0, latestResult.original_tokens - latestResult.kept_tokens);
    const totalTokens = tokensSaved * runs;
    const gpuSeconds = totalTokens * 0.55 / 2500;
    const kwh = gpuSeconds * 150 / 3600 / 1000;
    const co2 = kwh * 0.417;

    $("daily-runs-label").textContent = formatNumber(runs);
    $("scale-tokens").textContent = compact(totalTokens);
    $("scale-kwh").textContent = formatNumber(kwh, kwh < 10 ? 2 : 1);
    $("scale-co2").textContent = formatNumber(co2, co2 < 10 ? 2 : 1);
  }

  function compact(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }

  function renderResult(data, latency) {
    latestResult = data;
    latestLatency = latency;
    const scenario = scenarios[activeScenario];
    const retention = lineRetention(scenario.context, data.compressed_text || "");
    const keptLines = retention.filter((item) => item.kept).length;
    const totalLines = retention.filter((item) => normalizeLine(item.line)).length;
    const criticalChecks = scenario.critical.map((line) => ({
      line,
      kept: (data.compressed_text || "").includes(line),
    }));
    const allCriticalKept = criticalChecks.every((item) => item.kept);

    renderContext(retention);
    $("telemetry-empty").hidden = true;
    $("telemetry-results").hidden = false;
    $("result-stage").hidden = false;

    $("saving-pct").textContent = `${formatNumber(data.tokens_saved_pct, 1)}%`;
    requestAnimationFrame(() => { $("saving-fill").style.width = `${Math.min(100, data.tokens_saved_pct)}%`; });
    $("tokens-before").textContent = formatNumber(data.original_tokens);
    $("tokens-after").textContent = formatNumber(data.kept_tokens);
    $("tokens-saved").textContent = formatNumber(data.original_tokens - data.kept_tokens);
    $("request-latency").textContent = `${formatNumber(latency)} ms`;
    $("policy-name").textContent = data.policy_name || "SuperCompress";

    $("retention-summary").textContent =
      `${formatNumber(keptLines)} of ${formatNumber(totalLines)} non-empty lines survived the real API response. Blue marks were retained; gray marks were removed.`;
    $("retention-map").innerHTML = retention
      .filter((item) => normalizeLine(item.line))
      .map((item) => {
        const critical = scenario.critical.includes(item.line);
        return `<i class="${critical ? "is-critical" : item.kept ? "is-kept" : ""}" title="${item.kept ? "Kept" : "Removed"}"></i>`;
      }).join("");

    $("proof-status").textContent = allCriticalKept ? "All critical evidence retained" : "Critical evidence missing";
    $("proof-status").style.color = allCriticalKept ? "var(--demo-green)" : "var(--demo-red)";
    $("proof-lines").innerHTML = criticalChecks.map((item) =>
      `<div class="proof-line${item.kept ? "" : " is-missing"}">${escapeHtml(item.line)}</div>`
    ).join("");
    $("compressed-output").textContent = data.compressed_text || "";
    renderScale();
    $("result-stage").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function runDemo() {
    const apiKey = $("api-key").value.trim();
    const scenario = scenarios[activeScenario];
    const query = $("query").value.trim();
    const budgetRatio = Number($("budget").value) / 100;
    const button = $("run-demo");

    if (!apiKey.startsWith("sc_live_")) {
      showError("Enter a valid SuperCompress API key beginning with sc_live_.");
      $("api-key").focus();
      return;
    }
    if (!query) {
      showError("Enter a question for the compressor.");
      $("query").focus();
      return;
    }

    memoryApiKey = apiKey;
    button.disabled = true;
    button.querySelector("span").textContent = "Calling production API...";
    setApiState("Live request in flight", "running");
    $("demo-error").hidden = true;

    const started = performance.now();
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          context: scenario.context,
          query,
          budget_ratio: budgetRatio,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `API request failed (${response.status})`);
      const latency = performance.now() - started;
      renderResult(data, latency);
      setApiState("Production response verified", "");
    } catch (error) {
      setApiState("Request failed", "error");
      showError(error.message || String(error));
    } finally {
      button.disabled = false;
      button.querySelector("span").textContent = "Run live compression";
    }
  }

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => renderScenario(button.dataset.scenario));
  });
  $("budget").addEventListener("input", () => {
    $("budget-value").textContent = `${$("budget").value}%`;
  });
  $("daily-runs").addEventListener("input", renderScale);
  $("run-demo").addEventListener("click", runDemo);
  $("toggle-key").addEventListener("click", () => {
    const input = $("api-key");
    input.type = input.type === "password" ? "text" : "password";
    $("toggle-key").setAttribute("aria-label", input.type === "password" ? "Show API key" : "Hide API key");
  });
  $("copy-output").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("compressed-output").textContent);
    $("copy-output").textContent = "Copied";
    setTimeout(() => { $("copy-output").textContent = "Copy"; }, 1200);
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runDemo();
  });

  if (memoryApiKey) $("api-key").value = memoryApiKey;
  renderScenario(activeScenario);
})();
