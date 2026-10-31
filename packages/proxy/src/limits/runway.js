/**
 * Runway planner — turns a usage snapshot (+ history) into a decision an
 * agent can act on.
 *
 * Why this differs from limitcheck's fixed thresholds ("split below 25%, stop
 * at 10%"): a 5h window resets on its own, so every percent left unused at
 * reset is quota thrown away. Stopping at 90% of a 5h window wastes ~10% of
 * every block. The `max` policy (default) therefore:
 *
 *   - drains short windows (≤ 24h) all the way to the provider's real cutoff;
 *   - near the end it switches to "land": checkpoint (commit / write notes)
 *     before each step so a hard cutoff never loses work — but keeps working;
 *   - only says "wait" when a window is actually exhausted, and then points
 *     at the reset time (or another provider with headroom);
 *   - judges long windows (weekly / monthly) by pace — remaining% vs
 *     time-left% — and reports the projected lockout instead of refusing.
 *
 * Policies:
 *   max          (default) as above.
 *   balanced     like max, but an over-pace long window throttles scope.
 *   conservative limitcheck's original 25% / 10% thresholds.
 */

const POLICIES = new Set(["max", "balanced", "conservative"]);
const BURST_WINDOW_MAX_MINUTES = 5;
const SHORT_WINDOW_MAX_MINUTES = 24 * 60;
const RECENT_LOOKBACK_MIN = { short: 90, long: 24 * 60 };
const DEFAULT_STEP_COST = { short: 1.5, long: 0.3 };
const STALE_AFTER_MIN = 30;
const EXHAUSTED_EPSILON = 0.05;

function minutesBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function windowKind(w) {
  const minutes = w.windowMinutes;
  if (minutes && minutes <= BURST_WINDOW_MAX_MINUTES) return "burst";
  if (minutes && minutes > SHORT_WINDOW_MAX_MINUTES) return "long";
  if (!minutes && /week|month|secondary/i.test(w.name)) return "long";
  return "short";
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Points for one window, restricted to the current reset epoch: walk back
 * from the newest point while usage is non-increasing and resetAt matches.
 */
function currentSegment(points, name, resetAt) {
  const series = [];
  for (const point of points) {
    const w = point.w.find((x) => x.n === name);
    if (w && typeof w.u === "number") series.push({ t: point.t, u: w.u, r: w.r ?? null });
  }
  series.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  const segment = [];
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const p = series[i];
    const next = segment[0];
    if (next) {
      if (p.u > next.u + 0.05) break; // usage dropped going forward → reset boundary
      if (p.r && next.r && Math.abs(minutesBetween(p.r, next.r)) > 2) break;
    }
    if (resetAt && p.r && Math.abs(minutesBetween(p.r, resetAt)) > 2 && !segment.length) continue;
    segment.unshift(p);
  }
  return segment;
}

/**
 * Burn rate (%/min) and per-step cost for one window.
 *
 * Providers often report whole percents, so a single 1% tick over two
 * minutes would extrapolate to 30%/h. Short windows trust the recent rate
 * only with ≥ 2 percent of movement or ≥ 15 min of span; long windows use the
 * window-wide average (it includes idle nights, which is what the week
 * actually looks like). Either falls back to used / elapsed-window-time.
 */
function burnStats(segment, now, kind, { used, elapsedMin } = {}) {
  const windowAverage = elapsedMin && elapsedMin >= 10 && used !== undefined ? Math.max(0, used / elapsedMin) : null;
  let ratePerMin = null;
  let rateSource = null;
  if (kind === "long") {
    if (windowAverage !== null) {
      ratePerMin = windowAverage;
      rateSource = "window-average";
    }
  } else {
    const recent = segment.filter((p) => minutesBetween(p.t, now) <= RECENT_LOOKBACK_MIN.short);
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const dt = minutesBetween(first.t, last.t);
      const du = last.u - first.u;
      if (dt >= 2 && (du >= 2 || dt >= 15)) {
        ratePerMin = Math.max(0, du / dt);
        rateSource = "recent";
      }
    }
    if (ratePerMin === null && windowAverage !== null) {
      ratePerMin = windowAverage;
      rateSource = "window-average";
    }
  }
  const deltas = [];
  for (let i = 1; i < segment.length; i += 1) {
    const d = segment[i].u - segment[i - 1].u;
    if (d > 0) deltas.push(d);
  }
  const integral = segment.length > 0 && segment.every((p) => Number.isInteger(p.u));
  return { ratePerMin, rateSource, stepCost: median(deltas), stepMax: deltas.length ? Math.max(...deltas) : null, integral, samples: segment.length };
}

function analyzeWindow(raw, { points, now, checkedAt, policy }) {
  const w = { ...raw };
  const kind = windowKind(w);
  const notes = [];
  let resetAt = w.resetAt ?? null;
  let used = w.usedPercent;
  let remaining = w.remainingPercent;
  let exhausted = Boolean(w.exhausted) || remaining <= EXHAUSTED_EPSILON;
  let rolled = false;

  // A stale snapshot whose window has since reset is still informative.
  if (resetAt && new Date(resetAt).getTime() <= new Date(now).getTime()) {
    used = 0;
    remaining = 100;
    exhausted = false;
    rolled = true;
    if (w.windowMinutes) {
      let next = new Date(resetAt).getTime();
      const step = w.windowMinutes * 60000;
      while (next <= new Date(now).getTime()) next += step;
      resetAt = new Date(next).toISOString();
    } else {
      resetAt = null;
    }
    notes.push("window reset since last reading");
  }

  const resetsInMin = resetAt ? Math.max(0, minutesBetween(now, resetAt)) : null;
  const segment = rolled ? [] : currentSegment(points, w.name, w.resetAt);
  const elapsedMin = w.windowMinutes && resetsInMin !== null ? w.windowMinutes - resetsInMin : null;
  const stats = burnStats(segment, now, kind, { used, elapsedMin: rolled ? null : elapsedMin });
  const stepCost = stats.stepCost ?? DEFAULT_STEP_COST[kind === "long" ? "long" : "short"];
  // Landing reserve: the point from which every step is preceded by a
  // checkpoint. Landing never stops work, so err generous: the largest step
  // seen this window (with margin), plus 1% when the provider only reports
  // whole percents.
  const bigStep = Math.max(stats.stepMax ?? 0, stepCost * 1.5);
  const reserve = Math.min(10, Math.max(0.5, bigStep * 1.1 + (stats.integral ? 1 : 0)));

  const out = {
    name: w.name,
    kind,
    usedPercent: round1(used),
    remainingPercent: round1(remaining),
    ...(w.windowMinutes ? { windowMinutes: w.windowMinutes } : {}),
    ...(resetAt ? { resetAt, resetsInMinutes: Math.round(resetsInMin) } : {}),
    ...(w.limit !== undefined ? { limit: w.limit } : {}),
    ...(w.unit && w.unit !== "percent" ? { unit: w.unit } : {}),
  };

  if (stats.ratePerMin !== null) {
    out.burnPerHour = round1(stats.ratePerMin * 60);
    out.burnSource = stats.rateSource;
  }
  out.stepCost = round1(stepCost);

  if (stats.ratePerMin !== null && stats.ratePerMin > 0) {
    const exhaustIn = remaining / stats.ratePerMin;
    out.projectedExhaustMinutes = Math.round(exhaustIn);
    if (resetsInMin !== null) out.headroomAtResetPercent = round1(Math.max(0, remaining - stats.ratePerMin * resetsInMin));
  } else if (stats.ratePerMin === 0 && resetsInMin !== null) {
    out.headroomAtResetPercent = round1(remaining);
  }

  if (w.windowMinutes && resetsInMin !== null) {
    const timeLeftPct = Math.max(0.1, (resetsInMin / w.windowMinutes) * 100);
    out.paceRatio = round1(remaining / timeLeftPct);
  }

  // Classify.
  let state;
  if (exhausted && !rolled) {
    state = "blocked";
  } else if (kind === "burst") {
    state = "ok"; // per-minute buckets refill continuously; only matter when blocked
  } else if (policy === "conservative") {
    state = remaining <= 10 ? "low" : remaining <= 25 ? "tight" : "ok";
  } else if (remaining <= reserve) {
    state = "landing";
  } else if (kind === "short") {
    if (out.projectedExhaustMinutes !== undefined && resetsInMin !== null && out.projectedExhaustMinutes < resetsInMin) {
      state = "draining";
    } else if (out.headroomAtResetPercent !== undefined && out.headroomAtResetPercent >= 20) {
      state = "headroom";
    } else if (out.headroomAtResetPercent === undefined && remaining >= 50) {
      state = "headroom";
    } else {
      state = "ok";
    }
  } else {
    // long window: pace, not a floor
    if (out.paceRatio !== undefined && out.paceRatio < 0.85) state = "over-pace";
    else if (out.paceRatio !== undefined && out.paceRatio > 1.25) state = "headroom";
    else state = "ok";
  }
  out.state = state;

  if (state === "over-pace" && out.projectedExhaustMinutes !== undefined && resetsInMin !== null) {
    out.projectedLockoutMinutes = Math.max(0, Math.round(resetsInMin - out.projectedExhaustMinutes));
  }
  if (notes.length) out.notes = notes;
  out._reserve = reserve;
  return out;
}

function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined) return "unknown";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function describe(w) {
  const left = `${w.name} ${w.remainingPercent}% left`;
  const reset = w.resetsInMinutes !== undefined ? `, resets in ${fmtDuration(w.resetsInMinutes)}` : "";
  return `${left}${reset}`;
}

/**
 * Plan for one provider snapshot.
 * @returns {{ action, proceed, scope, binding, summary, guidance, windows, stale, ageMinutes }}
 */
function planRunway(snapshot, { points = [], now = new Date(), policy = "max" } = {}) {
  if (!POLICIES.has(policy)) throw new Error(`Unknown policy: ${policy}. Use max, balanced, or conservative.`);
  const ageMinutes = Math.max(0, minutesBetween(snapshot.checkedAt, now));
  const stale = ageMinutes > STALE_AFTER_MIN;
  const windows = snapshot.windows.map((w) => analyzeWindow(w, { points, now, checkedAt: snapshot.checkedAt, policy }));
  const real = windows.filter((w) => w.kind !== "burst");
  const blocked = windows.filter((w) => w.state === "blocked");
  const landing = windows.filter((w) => w.state === "landing");
  const overPace = windows.filter((w) => w.state === "over-pace");

  // Binding window: the one that would stop us first.
  const ranked = [...(real.length ? real : windows)].sort((a, b) => {
    const ea = a.state === "blocked" ? -1 : a.projectedExhaustMinutes ?? Infinity;
    const eb = b.state === "blocked" ? -1 : b.projectedExhaustMinutes ?? Infinity;
    if (ea !== eb) return ea - eb;
    return a.remainingPercent - b.remainingPercent;
  });
  const binding = blocked[0] ?? landing[0] ?? ranked[0];

  let action;
  let scope;
  const guidance = [];

  if (blocked.length) {
    const longest = blocked.reduce((a, b) => ((a.resetsInMinutes ?? Infinity) >= (b.resetsInMinutes ?? Infinity) ? a : b));
    action = "wait";
    scope = "none";
    guidance.push(`${longest.name} is exhausted${longest.resetsInMinutes !== undefined ? ` until reset in ${fmtDuration(longest.resetsInMinutes)}` : ""}.`);
    guidance.push("Checkpoint now (commit, write a handoff note). Resume after reset or continue on another provider with headroom.");
  } else if (policy === "conservative") {
    const low = windows.some((w) => w.state === "low");
    const tight = windows.some((w) => w.state === "tight");
    action = low ? "wait" : tight ? "pace" : "go";
    scope = low ? "none" : tight ? "small" : "normal";
    guidance.push(low ? "At or below 10% remaining: avoid starting large work." : tight ? "Below 25%: split work and checkpoint." : "Proceed; checkpoint before long operations.");
  } else if (landing.length) {
    action = "land";
    scope = "small";
    const w = landing[0];
    guidance.push(`${w.name} is nearly spent (${w.remainingPercent}% ≈ ${Math.max(1, Math.round(w.remainingPercent / Math.max(w.stepCost, 0.1)))} step(s)).`);
    guidance.push("Keep working — do not stop early. Checkpoint before each step (commit / handoff note) so the hard cutoff loses nothing.");
  } else {
    action = "go";
    const shortHeadroom = real.filter((w) => w.kind === "short").every((w) => w.state === "headroom");
    scope = shortHeadroom && !overPace.length ? "large" : "normal";
    const draining = windows.find((w) => w.state === "draining");
    if (draining) {
      guidance.push(`${draining.name} will run out ~${fmtDuration(draining.resetsInMinutes - draining.projectedExhaustMinutes)} before its reset — that is full use, not waste. Keep going; land near the end.`);
    }
    const unused = real.find((w) => w.kind === "short" && w.state === "headroom" && w.resetsInMinutes !== undefined);
    if (unused) {
      guidance.push(
        unused.headroomAtResetPercent !== undefined
          ? `${unused.name} will reset with ~${unused.headroomAtResetPercent}% unused at the current pace — unused quota is lost at reset, so take on bigger or parallel work.`
          : `${unused.name} has ${unused.remainingPercent}% left and resets in ${fmtDuration(unused.resetsInMinutes)} — room for large or parallel work.`
      );
    }
    if (overPace.length) {
      const w = overPace[0];
      if (policy === "balanced") {
        action = "pace";
        scope = "small";
        guidance.push(`${w.name} is ahead of pace (${w.remainingPercent}% left with ${fmtDuration(w.resetsInMinutes)} to go). Prefer cheaper steps until it catches up.`);
      } else {
        guidance.push(`${w.name} is ahead of pace (${w.remainingPercent}% left, resets in ${fmtDuration(w.resetsInMinutes)})${w.projectedLockoutMinutes ? `; at this burn expect a ~${fmtDuration(w.projectedLockoutMinutes)} lockout before reset` : ""}. Spending now is still full use.`);
      }
    }
    if (!guidance.length) guidance.push("Plenty of runway. Proceed; checkpoint before long multi-step operations.");
  }

  if (overPace.length && (action === "land" || action === "wait")) {
    const w = overPace[0];
    guidance.push(`${w.name} is also ahead of pace (${w.remainingPercent}% left, resets in ${fmtDuration(w.resetsInMinutes)}).`);
  }
  if (stale) guidance.push(`Reading is ${fmtDuration(ageMinutes)} old; real usage may be higher.`);

  const proceed = action !== "wait";
  const parts = real.length ? real : windows;
  const summary = `${action} · ${parts.map(describe).join(" · ")}`;

  for (const w of windows) delete w._reserve;
  return {
    action,
    proceed,
    scope,
    policy,
    binding: binding ? binding.name : null,
    ...(action === "wait" && blocked.length
      ? { waitMinutes: Math.max(...blocked.map((w) => w.resetsInMinutes ?? 0)) }
      : {}),
    stale,
    ageMinutes: Math.round(ageMinutes),
    summary,
    guidance,
    windows,
  };
}

module.exports = { planRunway, fmtDuration, windowKind, currentSegment, burnStats, POLICIES };
