/**
 * Sodium WebMCP bootstrap for SuperCompress (static site).
 * Bundled to /assets/js/sodium.js for the browser; this source is what sodiumtools validates.
 */
import { installSodium } from "sodium-webmcp-sdk";
import config from "../../../sodium.json";
import project from "../../../.sodium/project.json";

let handle = null;

export async function mountSodium() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (handle) {
    handle.dispose();
    handle = null;
  }
  handle = await installSodium({
    config,
    project,
    debug: Boolean(window.__SODIUM_DEBUG__),
  });
  return handle;
}

if (typeof window !== "undefined") {
  const boot = () => {
    mountSodium().catch((err) => {
      if (window.__SODIUM_DEBUG__) console.warn("[sodium]", err);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      handle?.dispose();
      handle = null;
    });
  }
}
