/**
 * /onboard — full-page signup onboarding (auth required).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { createOnboardingController } from "./dashboard-onboarding.js?v=4";

const API_BASE = window.SC_API_BASE || "";

function cleanConfigValue(value) {
  return (
    String(value || "")
      .replace(/\\[nr]/gi, "")
      .replace(/[\r\n\t]/g, "")
      .trim()
      .split(/\s+/)[0] || ""
  );
}

function normalizeFirebaseConfig(source = {}) {
  return {
    apiKey: cleanConfigValue(source.apiKey),
    authDomain: cleanConfigValue(source.authDomain),
    projectId: cleanConfigValue(source.projectId),
    storageBucket: cleanConfigValue(source.storageBucket),
    messagingSenderId: cleanConfigValue(source.messagingSenderId),
    appId: cleanConfigValue(source.appId),
  };
}

let idToken = null;

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText || "Request failed");
  return data;
}

async function loadFirebaseConfig() {
  if (window.SC_FIREBASE_CONFIG?.apiKey) return normalizeFirebaseConfig(window.SC_FIREBASE_CONFIG);
  const res = await fetch(`${API_BASE}/api/firebase-config`, { cache: "no-store" });
  if (!res.ok) return null;
  return normalizeFirebaseConfig(await res.json());
}

const onboarding = createOnboardingController({
  apiFetch,
  variant: "page",
  mountSelector: "#sc-onboard-mount",
  onComplete: () => {
    window.location.replace("/dashboard");
  },
});

async function start() {
  const status = document.getElementById("sc-onboard-status");
  const cfg = await loadFirebaseConfig();
  if (!cfg?.apiKey) {
    if (status) status.textContent = "Could not load auth. Open the dashboard and sign in.";
    return;
  }
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("/dashboard?login=1");
      return;
    }
    try {
      idToken = await user.getIdToken();
      const params = new URLSearchParams(window.location.search);
      await onboarding.runPage({
        forceNew: params.get("new") === "1",
        forceOnboardQa: params.get("onboard") === "1",
      });
      if (status) status.remove();
    } catch (err) {
      console.error(err);
      if (status) status.textContent = err.message || "Could not load onboarding.";
    }
  });
}

start().catch((err) => {
  console.error(err);
  const status = document.getElementById("sc-onboard-status");
  if (status) status.textContent = err.message || "Could not start onboarding.";
});
