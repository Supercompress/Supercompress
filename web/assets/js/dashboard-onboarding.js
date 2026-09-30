/**
 * Signup onboarding (full page) + power-user celebrate (dashboard overlay).
 * Skippable; dither branding; 10,000 free tokens per quest.
 */

const HEARD = [
  { id: "x", label: "X" },
  { id: "reddit", label: "Reddit" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
  { id: "word_of_mouth", label: "Word of mouth" },
];

const QUEST_COPY = {
  star: {
    title: "Star the repo",
    meta: "GitHub · Supercompress/Supercompress",
  },
  x_follow: {
    title: "Follow us on X",
    meta: "@arjunkshah21",
  },
  plugin: {
    title: "Install the coding agent plugin",
    meta: "One setup command for Cursor, Claude Code, Codex, Grok Build…",
  },
};

function fmtBonus(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CREDIT_RATE_USD_PER_M = 0.1;
const CREDIT_MIN_USD = 10;
const CREDIT_MAX_USD = 1000;

function tokensFromUsd(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / CREDIT_RATE_USD_PER_M) * 10) / 10;
}

export function createOnboardingController({
  apiFetch,
  onBonusChange,
  variant = "overlay",
  mountSelector = "#sc-onboard-mount",
  onComplete = null,
} = {}) {
  let root = null;
  let state = null;
  let step = 1; // 1 = heard, 2 = quests, 3 = paywall
  let selectedHeard = null;
  let mode = "onboard"; // onboard | celebrate | plugin
  let payPack = 10; // 10 | 20 | "custom"
  let customUsd = 25;
  let checkoutBusy = false;
  let checkoutError = "";
  const isPage = variant === "page";

  function ensureRoot() {
    if (root) return root;
    if (isPage) {
      root = document.querySelector(mountSelector);
      if (!root) {
        root = document.createElement("div");
        root.id = "sc-onboard-mount";
        document.body.appendChild(root);
      }
      root.classList.add("sc-onboard-page");
      root.innerHTML = `
        <div class="sc-onboard-page-shell">
          <div class="sc-onboard-page-dither" aria-hidden="true"></div>
          <header class="sc-onboard-page-brand">
            <a href="/" class="sc-onboard-page-logo">
              <img src="/assets/img/logo-chevrons.png" alt="" width="28" height="28" />
              <span>Super<em>Compress</em></span>
            </a>
          </header>
          <main class="sc-onboard-page-main">
            <div class="sc-onboard-page-card">
              <div class="sc-onboard-inner" id="sc-onboard-inner"></div>
            </div>
          </main>
        </div>
      `;
      paintDither();
      return root;
    }
    root = document.createElement("div");
    root.className = "sc-onboard";
    root.id = "sc-onboard";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="sc-onboard-card">
        <div class="sc-onboard-dither" aria-hidden="true"></div>
        <div class="sc-onboard-inner" id="sc-onboard-inner"></div>
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener("click", (e) => {
      if (e.target === root) skip();
    });
    paintDither();
    return root;
  }

  function ditherEl() {
    return root?.querySelector(isPage ? ".sc-onboard-page-dither" : ".sc-onboard-dither");
  }

  function paintDither() {
    try {
      const wash = ditherEl();
      if (!wash || !window.DitherKitLite) return;
      const opts = { color: "brand", intensity: isPage ? 0.62 : 0.55 };
      if (typeof window.DitherKitLite.startDitherWashLoop === "function") {
        window.DitherKitLite.startDitherWashLoop(wash, opts);
      } else if (typeof window.DitherKitLite.renderDitherWash === "function") {
        window.DitherKitLite.renderDitherWash(wash, opts);
      }
    } catch (_) {
      /* optional visual */
    }
  }

  function stopDither() {
    try {
      const wash = ditherEl();
      if (wash && typeof window.DitherKitLite?.stopDitherWashLoop === "function") {
        window.DitherKitLite.stopDitherWashLoop(wash);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function leaveToDashboard() {
    stopDither();
    if (typeof onComplete === "function") {
      onComplete();
      return;
    }
    window.location.replace("/dashboard");
  }

  function open() {
    ensureRoot();
    if (!isPage) {
      root.classList.add("is-open");
      document.body.style.overflow = "hidden";
    } else {
      root.classList.add("is-ready");
    }
    requestAnimationFrame(paintDither);
  }

  function close() {
    if (!root) return;
    if (isPage) {
      leaveToDashboard();
      return;
    }
    stopDither();
    root.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  async function skip() {
    try {
      if (mode === "celebrate") {
        await apiFetch("/api/account?op=power-celebrate-seen", { method: "POST", body: "{}" });
      } else if (mode === "plugin") {
        mode = "onboard";
        step = 2;
        render();
        return;
      } else if (mode === "onboard" && step === 2) {
        // After free-credit quests, soft-gate on the paywall (continue free lives there).
        goPaywall();
        return;
      } else if (mode === "onboard" && step === 3) {
        await continueFree();
        return;
      } else {
        await apiFetch("/api/account?op=onboarding-skip", { method: "POST", body: "{}" });
      }
    } catch (err) {
      console.warn("onboarding skip failed", err);
    }
    close();
  }

  function goPaywall() {
    mode = "onboard";
    step = 3;
    checkoutBusy = false;
    checkoutError = "";
    render();
  }

  function selectedCheckoutUsd() {
    if (payPack === "custom") return Math.round(Number(customUsd) * 100) / 100;
    return Number(payPack);
  }

  function renderHeard() {
    const choices = HEARD.map(
      (h) => `
      <button type="button" class="sc-onboard-choice${selectedHeard === h.id ? " is-selected" : ""}" data-heard="${h.id}">
        ${h.label}
      </button>`
    ).join("");
    return `
      <div class="sc-onboard-steps" aria-hidden="true">
        <span class="sc-onboard-step-dot is-on"></span>
        <span class="sc-onboard-step-dot"></span>
        <span class="sc-onboard-step-dot"></span>
      </div>
      <p class="sc-onboard-kicker">Welcome</p>
      <h1 class="sc-onboard-title" id="sc-onboard-title">Where did you hear about us?</h1>
      <p class="sc-onboard-lead">Helps us focus on the channels that actually work. Takes two seconds.</p>
      <div class="sc-onboard-grid">${choices}</div>
      <div class="sc-onboard-actions">
        <button type="button" class="sc-onboard-skip" data-act="skip">Skip for now</button>
        <button type="button" class="sc-onboard-btn" data-act="next-heard" ${selectedHeard ? "" : "disabled"}>Continue →</button>
      </div>
    `;
  }

  function renderQuests() {
    const actions = state?.actions || {};
    const bonus = state?.bonus_tokens || 0;
    const rows = ["star", "x_follow", "plugin"]
      .map((id) => {
        const done = !!actions[id];
        const copy = QUEST_COPY[id];
        return `
        <button type="button" class="sc-onboard-quest${done ? " is-done" : ""}" data-quest="${id}">
          <span class="sc-onboard-quest-copy">
            <p class="sc-onboard-quest-title">${copy.title}</p>
            <p class="sc-onboard-quest-meta">${copy.meta}</p>
          </span>
          <span class="sc-onboard-quest-badge">${done ? "Done" : "+10,000"}</span>
        </button>`;
      })
      .join("");
    return `
      <div class="sc-onboard-steps" aria-hidden="true">
        <span class="sc-onboard-step-dot is-on"></span>
        <span class="sc-onboard-step-dot is-on"></span>
        <span class="sc-onboard-step-dot"></span>
      </div>
      <p class="sc-onboard-kicker">Get free credits</p>
      <h1 class="sc-onboard-title" id="sc-onboard-title">Earn 10,000 free tokens each</h1>
      <p class="sc-onboard-lead">Stack up to <strong>30,000</strong> extra free tokens on top of your monthly 1M. Skip anytime.</p>
      <p class="sc-onboard-bonus">Bonus so far: <strong>${fmtBonus(bonus)}</strong> free tokens</p>
      <div class="sc-onboard-grid">${rows}</div>
      <div class="sc-onboard-actions">
        <button type="button" class="sc-onboard-skip" data-act="skip">Skip for now</button>
        <button type="button" class="sc-onboard-btn" data-act="to-paywall">Continue →</button>
      </div>
    `;
  }

  function renderPaywall() {
    const amount = selectedCheckoutUsd();
    const valid =
      Number.isFinite(amount) && amount >= CREDIT_MIN_USD && amount <= CREDIT_MAX_USD;
    const approx = valid ? tokensFromUsd(amount) : 0;
    const hint = valid
      ? `≈ ${approx}M tokens after free · $${CREDIT_RATE_USD_PER_M}/1M`
      : `Minimum $${CREDIT_MIN_USD} · up to $${CREDIT_MAX_USD}`;
    const packBtn = (id, label) => `
      <button type="button" class="sc-onboard-pack${payPack === id ? " is-selected" : ""}" data-pack="${id}">
        <span class="sc-onboard-pack-amount">${label}</span>
        <span class="sc-onboard-pack-meta">${
          id === "custom" ? "Your amount" : `≈ ${tokensFromUsd(id)}M tokens`
        }</span>
      </button>`;
    return `
      <div class="sc-onboard-steps" aria-hidden="true">
        <span class="sc-onboard-step-dot is-on"></span>
        <span class="sc-onboard-step-dot is-on"></span>
        <span class="sc-onboard-step-dot is-on"></span>
      </div>
      <p class="sc-onboard-kicker">Stay unlocked</p>
      <h1 class="sc-onboard-title" id="sc-onboard-title">Load credits so agents never hard-stop</h1>
      <p class="sc-onboard-lead">You still get <strong>5M free</strong> every month. Credits only kick in after that — <strong>$0.10 / 1M</strong>.</p>
      <div class="sc-onboard-packs" role="group" aria-label="Credit packs">
        ${packBtn(10, "$10")}
        ${packBtn(20, "$20")}
        ${packBtn("custom", "Custom")}
      </div>
      ${
        payPack === "custom"
          ? `<label class="sc-onboard-custom-label" for="sc-onboard-custom-usd">Custom amount (USD)</label>
      <div class="sc-onboard-custom-row">
        <span aria-hidden="true">$</span>
        <input id="sc-onboard-custom-usd" class="sc-onboard-custom-input" type="number" inputmode="decimal" min="${CREDIT_MIN_USD}" max="${CREDIT_MAX_USD}" step="1" value="${customUsd}" />
      </div>`
          : ""
      }
      <p class="sc-onboard-pay-hint">${hint}</p>
      ${checkoutError ? `<p class="sc-onboard-pay-error" role="alert">${escapeHtml(checkoutError)}</p>` : ""}
      <div class="sc-onboard-actions sc-onboard-actions--stack">
        <button type="button" class="sc-onboard-btn" data-act="checkout" ${
          !valid || checkoutBusy ? "disabled" : ""
        }>${checkoutBusy ? "Opening checkout…" : valid ? `Continue · $${amount}` : "Continue"}</button>
        <button type="button" class="sc-onboard-skip sc-onboard-skip--emph" data-act="continue-free">Continue with free</button>
      </div>
    `;
  }

  function renderPlugin() {
    const cmds = state?.plugin_commands || [
      "npx supercompress-proxy setup",
      "npm i -g supercompress-proxy && supercompress setup",
    ];
    const blocks = cmds
      .map(
        (c, i) => `
      <div class="sc-onboard-cmd">
        <code id="sc-cmd-${i}">${c}</code>
        <button type="button" data-copy="${i}">Copy</button>
      </div>`
      )
      .join("");
    return `
      <p class="sc-onboard-kicker">Coding agent plugin</p>
      <h1 class="sc-onboard-title" id="sc-onboard-title">Install in one command</h1>
      <p class="sc-onboard-lead">Run this in your terminal, then come back and claim <strong>10,000</strong> free tokens.</p>
      <div class="sc-onboard-cmds">${blocks}</div>
      <div class="sc-onboard-actions">
        <button type="button" class="sc-onboard-btn sc-onboard-btn--ghost" data-act="back-quests">Back</button>
        <button type="button" class="sc-onboard-btn" data-act="claim-plugin">I installed it — claim →</button>
      </div>
    `;
  }

  function renderCelebrate() {
    const share = String(state?.power_share_url || "https://twitter.com/intent/tweet?text=SuperCompress").replace(
      /"/g,
      "%22"
    );
    return `
      <p class="sc-onboard-kicker">Power user</p>
      <h2 class="sc-onboard-title" id="sc-onboard-title">You crossed 1M tokens</h2>
      <p class="sc-onboard-lead">Congrats — you're officially a SuperCompress power user. Tell the timeline.</p>
      <div class="sc-onboard-actions">
        <button type="button" class="sc-onboard-skip" data-act="skip">Not now</button>
        <a class="sc-onboard-btn" href="${share}" target="_blank" rel="noopener" data-act="share-x">Post on X →</a>
      </div>
    `;
  }

  function render() {
    ensureRoot();
    const inner = root.querySelector("#sc-onboard-inner");
    if (!inner) return;
    root.setAttribute("aria-labelledby", "sc-onboard-title");
    if (mode === "celebrate") inner.innerHTML = renderCelebrate();
    else if (mode === "plugin") inner.innerHTML = renderPlugin();
    else if (step === 3) inner.innerHTML = renderPaywall();
    else if (step === 2) inner.innerHTML = renderQuests();
    else inner.innerHTML = renderHeard();
    bind();
    paintDither();
  }

  function bind() {
    root.querySelectorAll("[data-heard]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedHeard = btn.getAttribute("data-heard");
        render();
      });
    });
    root.querySelectorAll("[data-quest]").forEach((btn) => {
      btn.addEventListener("click", () => onQuest(btn.getAttribute("data-quest")));
    });
    root.querySelectorAll("[data-pack]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.getAttribute("data-pack");
        payPack = raw === "custom" ? "custom" : Number(raw);
        checkoutError = "";
        render();
      });
    });
    const customInput = root.querySelector("#sc-onboard-custom-usd");
    customInput?.addEventListener("input", () => {
      customUsd = Number(customInput.value);
      checkoutError = "";
      // Soft re-render of CTA/hint without wiping focus: update in place
      const amount = selectedCheckoutUsd();
      const valid =
        Number.isFinite(amount) && amount >= CREDIT_MIN_USD && amount <= CREDIT_MAX_USD;
      const hint = root.querySelector(".sc-onboard-pay-hint");
      if (hint) {
        hint.textContent = valid
          ? `≈ ${tokensFromUsd(amount)}M tokens after free · $${CREDIT_RATE_USD_PER_M}/1M`
          : `Minimum $${CREDIT_MIN_USD} · up to $${CREDIT_MAX_USD}`;
      }
      const cta = root.querySelector('[data-act="checkout"]');
      if (cta) {
        cta.disabled = !valid || checkoutBusy;
        cta.textContent = checkoutBusy
          ? "Opening checkout…"
          : valid
            ? `Continue · $${amount}`
            : "Continue";
      }
    });
    root.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const act = el.getAttribute("data-act");
        if (act === "skip") {
          e.preventDefault();
          skip();
        } else if (act === "next-heard") onHeardNext();
        else if (act === "to-paywall") goPaywall();
        else if (act === "finish") goPaywall();
        else if (act === "continue-free") continueFree();
        else if (act === "checkout") startCheckout();
        else if (act === "back-quests") {
          mode = "onboard";
          step = 2;
          render();
        } else if (act === "claim-plugin") claimQuest("plugin");
        else if (act === "share-x") {
          setTimeout(() => skip(), 400);
        }
      });
    });
    root.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const i = btn.getAttribute("data-copy");
        const code = root.querySelector(`#sc-cmd-${i}`)?.textContent || "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1200);
        } catch (_) {
          btn.textContent = "Select & copy";
        }
      });
    });
  }

  async function onHeardNext() {
    if (!selectedHeard) return;
    try {
      state = await apiFetch("/api/account?op=onboarding-heard", {
        method: "POST",
        body: JSON.stringify({ source: selectedHeard }),
      });
      if (!state?.ok && !state?.heard) {
        throw new Error("Could not save where you heard about us");
      }
    } catch (err) {
      console.warn(err);
      const lead = document.getElementById("sc-onboard-title");
      if (lead) {
        const warn = document.createElement("p");
        warn.className = "sc-onboard-pay-error";
        warn.setAttribute("role", "alert");
        warn.textContent = err?.message || "Could not save that — try Continue again.";
        lead.insertAdjacentElement("afterend", warn);
      }
      return;
    }
    step = 2;
    render();
  }

  async function onQuest(id) {
    if (state?.actions?.[id]) return;
    if (id === "plugin") {
      mode = "plugin";
      render();
      return;
    }
    const url = id === "star" ? state?.links?.star : state?.links?.x_follow;
    if (url) window.open(url, "_blank", "noopener");
    await claimQuest(id);
  }

  async function claimQuest(id) {
    try {
      state = await apiFetch("/api/account?op=onboarding-claim", {
        method: "POST",
        body: JSON.stringify({ action: id }),
      });
      if (typeof onBonusChange === "function") onBonusChange(state);
      if (mode === "plugin") {
        mode = "onboard";
        step = 2;
      }
      render();
    } catch (err) {
      console.warn("claim failed", err);
    }
  }

  async function continueFree() {
    try {
      await apiFetch("/api/account?op=onboarding-done", { method: "POST", body: "{}" });
    } catch (_) {}
    close();
  }

  async function startCheckout() {
    const amount = selectedCheckoutUsd();
    if (!Number.isFinite(amount) || amount < CREDIT_MIN_USD || amount > CREDIT_MAX_USD) {
      checkoutError = `Enter an amount between $${CREDIT_MIN_USD} and $${CREDIT_MAX_USD}.`;
      render();
      return;
    }
    if (!apiFetch) return;
    checkoutBusy = true;
    checkoutError = "";
    render();
    try {
      // Mark done before Stripe so cancel/return lands on dashboard, not /onboard.
      try {
        await apiFetch("/api/account?op=onboarding-done", { method: "POST", body: "{}" });
      } catch (_) {}
      const data = await apiFetch("/api/billing", {
        method: "POST",
        body: JSON.stringify({
          action: "enable_payg",
          credit_limit_usd: amount,
          auto_recharge: true,
          source: "onboarding",
        }),
      });
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      checkoutError = "Checkout did not return a URL. Try again from the dashboard.";
    } catch (err) {
      checkoutError = err?.message || "Failed to start checkout";
    }
    checkoutBusy = false;
    render();
  }

  function evaluateShouldOnboard(nextState, { forceNew = false, forceOnboardQa = false } = {}) {
    const serverFinished =
      nextState &&
      nextState.needs_onboarding === false &&
      (Boolean(nextState.heard) ||
        Number(nextState.bonus_tokens) > 0 ||
        Boolean(nextState.completed_actions?.length));
    return (
      Boolean(nextState?.needs_onboarding) ||
      forceOnboardQa ||
      (forceNew && !serverFinished)
    );
  }

  /**
   * Dashboard entry:
   * - returns true when navigating to /onboard
   * - returns "celebrate" when power celebrate should open after dashboard paints
   * - returns false otherwise
   */
  async function maybeShow({ forceNew = false, phase = "gate" } = {}) {
    if (!apiFetch) return false;

    let forcePower = false;
    let forceOnboardQa = false;
    try {
      const params = new URLSearchParams(window.location.search);
      forcePower = params.get("power") === "1";
      forceOnboardQa = params.get("onboard") === "1";
      if ((forcePower || forceOnboardQa) && window.history?.replaceState) {
        params.delete("power");
        params.delete("onboard");
        const url = new URL(window.location.href);
        url.search = params.toString();
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}` || "/dashboard");
      }
    } catch (_) {
      /* ignore */
    }

    try {
      state = await apiFetch("/api/account?op=onboarding");
    } catch (err) {
      console.warn("onboarding status failed", err);
      if (!(forceNew || forceOnboardQa)) return false;
      state = { needs_onboarding: true, actions: {}, bonus_tokens: 0, links: {} };
    }

    if (state?.needs_power_celebrate || forcePower) {
      if (phase === "gate") return "celebrate";
      mode = "celebrate";
      open();
      render();
      return false;
    }

    const shouldShow = evaluateShouldOnboard(state, { forceNew, forceOnboardQa });
    if (!shouldShow) return false;

    // Full-page onboarding — leave dashboard before content paints.
    const q = new URLSearchParams();
    if (forceNew) q.set("new", "1");
    if (forceOnboardQa) q.set("onboard", "1");
    const qs = q.toString();
    window.location.replace(`/onboard${qs ? `?${qs}` : ""}`);
    return true;
  }

  function showCelebrate() {
    mode = "celebrate";
    open();
    render();
  }

  /** Standalone /onboard page runner (must be signed in). */
  async function runPage({ forceNew = false, forceOnboardQa = false } = {}) {
    if (!apiFetch) return;
    try {
      state = await apiFetch("/api/account?op=onboarding");
    } catch (err) {
      console.warn("onboarding status failed", err);
      state = { needs_onboarding: true, actions: {}, bonus_tokens: 0, links: {} };
    }

    const shouldShow = evaluateShouldOnboard(state, { forceNew, forceOnboardQa });
    if (!shouldShow) {
      leaveToDashboard();
      return;
    }

    mode = "onboard";
    step = state?.heard ? 2 : 1;
    selectedHeard = state?.heard || null;
    open();
    render();
  }

  return { maybeShow, runPage, showCelebrate, close, skip, evaluateShouldOnboard };
}
