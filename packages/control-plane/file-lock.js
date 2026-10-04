"use strict";

/**
 * Cross-process exclusive lock via atomic mkdir (works on local SSDs / most NFS).
 * Used by durable money/ledger so two Node processes cannot oversubscribe a wallet.
 */

const fs = require("fs");
const path = require("path");

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin — short waits only */
  }
}

/**
 * @param {string} lockDir absolute path for the lock directory
 * @param {() => any} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 */
function withDirLock(lockDir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale lock recovery (crashed holder).
      try {
        const owner = fs.readFileSync(path.join(lockDir, "owner"), "utf8");
        const ts = Number(String(owner).split("\n")[1]);
        if (Number.isFinite(ts) && Date.now() - ts > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) {
        const e = new Error("durable_lock_timeout");
        e.code = "durable_lock_timeout";
        throw e;
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { withDirLock };
