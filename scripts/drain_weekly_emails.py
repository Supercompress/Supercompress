#!/usr/bin/env python3
"""Drain pending SuperCompress weekly emails via gog Gmail.

Mirrors scripts/drain_welcome_emails.py:
1) POST weekly-enqueue
2) GET weekly-pending
3) send each via gog gmail send
4) POST weekly-mark with status sent

Env:
  WELCOME_DRAIN_SECRET   or outreach/.welcome_drain_secret
  WELCOME_API_BASE       default https://www.supercompress.dev
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

API_BASE = os.environ.get("WELCOME_API_BASE", "https://www.supercompress.dev").rstrip("/")
ACCOUNT = os.environ.get("GOG_ACCOUNT", "arjunkshah21@gmail.com")
ROOT = Path(__file__).resolve().parents[1]
SECRET_FILE = ROOT / "outreach" / ".welcome_drain_secret"


def load_secret() -> str:
    env = (os.environ.get("WELCOME_DRAIN_SECRET") or "").strip()
    if env:
        return env
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text().strip()
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
        "120",
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

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    if result.returncode:
        raise RuntimeError(f"curl failed {path}: {(result.stderr or result.stdout)[:400]}")
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError as err:
        raise RuntimeError(f"bad JSON from {path}: {result.stdout[:400]}") from err


def send_gmail(to: str, subject: str, body: str, html: str | None = None) -> bool:
    """Send multipart email. HTML is required for branded product mail."""
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
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode:
            print(f"FAIL send {to}: {(result.stderr or result.stdout)[:240]}", flush=True)
            return False
        print(f"OK send {to} html_len={len(html)}", flush=True)
        return True
    finally:
        Path(path).unlink(missing_ok=True)


def main() -> int:
    secret = load_secret()
    if not secret:
        raise SystemExit("WELCOME_DRAIN_SECRET missing (env or outreach/.welcome_drain_secret)")

    print("1) enqueue this week's campaign…", flush=True)
    try:
        enq = api("POST", "/api/account?op=weekly-enqueue", {})
        print(json.dumps(enq, indent=2)[:1500], flush=True)
        if not enq.get("ok") and enq.get("error"):
            print(f"WARN enqueue: {enq.get('error')}", flush=True)
    except Exception as exc:
        print(f"enqueue note: {exc}", flush=True)

    sent = failed = 0
    for loop in range(40):
        pending = api("GET", f"/api/account?op=weekly-pending&secret={secret}").get("pending") or []
        print(f"loop {loop + 1}: pending={len(pending)}", flush=True)
        if not pending:
            print(json.dumps({"sent": sent, "failed": failed, "pending": 0}), flush=True)
            return 0 if failed == 0 else 1

        for item in pending[:20]:
            key = item.get("key")
            email = item.get("email")
            subject = item.get("subject") or "SuperCompress weekly"
            body = item.get("body") or ""
            html = item.get("html") or None
            if not key or not email:
                continue
            print(f"SEND {email}", flush=True)
            ok = send_gmail(email, subject, body, html)
            resp = api(
                "POST",
                "/api/account?op=weekly-mark",
                {
                    "key": key,
                    "status": "sent" if ok else "failed",
                    "provider": "gog",
                    "error": None if ok else "gog_send_failed",
                },
            )
            if not resp.get("ok"):
                print(f"WARN mark {key}: {resp}", flush=True)
            if ok:
                sent += 1
            else:
                failed += 1
            time.sleep(2)

    print(json.dumps({"sent": sent, "failed": failed, "stopped": True}), flush=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
