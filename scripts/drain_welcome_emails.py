#!/usr/bin/env python3
"""Drain pending SuperCompress signup welcome emails via gog Gmail.

Polls production /api/account?op=welcome-pending and sends each email
exactly once, then marks them sent.

Env:
  WELCOME_DRAIN_SECRET   optional if outreach/.welcome_drain_secret exists
  WELCOME_API_BASE       default https://supercompress.dev
  GOG_ACCOUNT            default arjunkshah21@gmail.com
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

API_BASE = os.environ.get("WELCOME_API_BASE", "https://supercompress.dev").rstrip("/")
ACCOUNT = os.environ.get("GOG_ACCOUNT", "arjunkshah21@gmail.com")
ROOT = Path(__file__).resolve().parents[1]
SECRET_FILE = ROOT / "outreach" / ".welcome_drain_secret"


def load_secret() -> str:
    env = (os.environ.get("WELCOME_DRAIN_SECRET") or "").strip()
    if env:
        return env
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text().strip()
    # Fallback: Downloads checkout secret (interactive shells)
    alt = Path("/Users/arjunkshah21/Downloads/supercompress/outreach/.welcome_drain_secret")
    if alt.exists():
        return alt.read_text().strip()
    return ""


def api(method: str, path: str, payload: dict | None = None) -> dict:
    secret = load_secret()
    if not secret:
        raise SystemExit("WELCOME_DRAIN_SECRET missing (env or outreach/.welcome_drain_secret)")

    url = f"{API_BASE}{path}"
    cmd = [
        "curl",
        "-sS",
        "-L",
        "--max-time",
        "45",
        "-H",
        "Accept: application/json",
        "-H",
        f"X-Welcome-Secret: {secret}",
        "-X",
        method,
    ]
    if payload is not None:
        body = dict(payload)
        body["secret"] = secret
        cmd.extend(["-H", "Content-Type: application/json", "--data-binary", json.dumps(body)])
    elif method == "GET" and "secret=" not in path:
        sep = "&" if "?" in path else "?"
        url = f"{url}{sep}secret={secret}"
    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"curl failed {path}: {(result.stderr or result.stdout)[:300]}")
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError as err:
        raise RuntimeError(f"bad JSON from {path}: {result.stdout[:300]}") from err


def send_gmail(to: str, subject: str, body: str, html: str | None = None) -> bool:
    """Send multipart email. HTML is required for branded product welcomes."""
    if not html or not str(html).strip():
        print(f"FAIL send {to}: missing branded html (refusing plain-only)", flush=True)
        return False
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write(body)
        path = handle.name
    try:
        cmd = [
            "gog",
            "gmail",
            "send",
            "-a",
            ACCOUNT,
            "--to",
            to,
            "--subject",
            subject,
            "--body-file",
            path,
            "--body-html",
            html,
            "--no-input",
            "--reply-to",
            ACCOUNT,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode:
            print(f"FAIL send {to}: {(result.stderr or result.stdout)[:200]}", flush=True)
            return False
        # Confirm gog actually attached HTML (dry-run style fields aren't returned,
        # but empty success with plain-only was the prior bug — log length).
        print(f"OK send {to} html_len={len(html)}", flush=True)
        return True
    finally:
        Path(path).unlink(missing_ok=True)


def main() -> int:
    secret = load_secret()
    pending = api("GET", f"/api/account?op=welcome-pending&secret={secret}").get("pending") or []
    print(f"pending={len(pending)}", flush=True)
    sent = failed = 0
    for item in pending:
        uid = item.get("uid")
        email = item.get("email")
        subject = item.get("subject") or "Thanks for signing up — quick note from the founder"
        body = item.get("body") or ""
        html = item.get("html") or None
        if not html:
            print(f"SKIP {email}: API returned no html field — check welcomeCopy deploy", flush=True)
            failed += 1
            continue
        print(f"SEND {email} html_len={len(html)}", flush=True)
        ok = send_gmail(email, subject, body, html)
        resp = api(
            "POST",
            "/api/account?op=welcome-mark",
            {
                "uid": uid,
                "status": "sent" if ok else "failed",
                "provider": "gog",
                "error": None if ok else "gog_send_failed",
            },
        )
        if not resp.get("ok"):
            print(f"WARN mark {uid}: {resp}", flush=True)
        if ok:
            sent += 1
        else:
            failed += 1
        time.sleep(2)
    print(json.dumps({"sent": sent, "failed": failed, "pending": len(pending)}))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
