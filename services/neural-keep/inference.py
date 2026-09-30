"""Query-conditioned line-keep compression (ModernBERT cross-encoder).

Product inference path — matches scripts/scneural/eval_usecases.py bench winners.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_DEFAULT_THRESHOLD = 0.12


def rough_tokens(text: str) -> int:
    return max(1, len(str(text or "").split()))


def _query_token_boost(query: str, line: str) -> float:
    stop = {
        "what", "where", "when", "which", "how", "why", "who", "the", "did", "show",
        "find", "crash", "happened", "analysis", "checkout", "interim", "about",
    }
    qt = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9@._:/+-]{2,}", query)}
    qt -= stop
    if not qt:
        return 0.0
    lt = line.lower()
    hits = sum(1 for t in qt if t in lt)
    return min(0.10 * hits, 0.28)


def _query_drop_penalty(query: str, line: str) -> float:
    ql = query.lower()
    ll = line.lower()
    if any(w in ql for w in ("fail", "failed", "error", "crash", "bug")):
        if "passed" in ll or ll.startswith("passed "):
            return 0.40
    return 0.0


def _expand_incident_tails(lines: list[str], kept: list[bool], probs: list[float]) -> None:
    tail_markers = (
        "Action:", "DSMB", "Mitigation:", "Fix hint:", "Recommendation:",
        "Broker:", "AssertionError:", "ETA delayed",
    )
    head_markers = ("pytest failed:", "INCIDENT:", "Shipping:", "Sentry:", "Root cause:")
    for i in range(len(lines)):
        if not kept[i]:
            continue
        head = lines[i].strip()
        if any(head.startswith(m) for m in head_markers):
            for j in range(i + 1, min(i + 3, len(lines))):
                if kept[j]:
                    continue
                nxt = lines[j].strip()
                if probs[j] >= 0.005 or any(nxt.startswith(m) for m in tail_markers):
                    kept[j] = True
        if probs[i] >= 0.95:
            for j in range(i + 1, min(i + 3, len(lines))):
                if kept[j]:
                    continue
                nxt = lines[j].strip()
                if probs[j] >= 0.01 or any(nxt.startswith(m) for m in tail_markers):
                    kept[j] = True
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if i + 1 < len(lines) and not kept[i + 1] and any(nxt.startswith(m) for m in tail_markers):
            kept[i + 1] = True


def read_inference_threshold(model_dir: Path) -> float:
    meta_p = model_dir / "sc_meta.json"
    if not meta_p.exists():
        return _DEFAULT_THRESHOLD
    try:
        meta = json.loads(meta_p.read_text())
        if meta.get("inference_threshold") is not None:
            return float(meta["inference_threshold"])
    except Exception:
        pass
    return _DEFAULT_THRESHOLD


class NeuralKeepModel:
    def __init__(self, model_dir: str, device: str = "cpu") -> None:
        import torch
        from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer

        self.device = device
        self.root = Path(model_dir)
        if not (self.root / "config.json").exists():
            raise FileNotFoundError(f"checkpoint missing config.json: {self.root}")
        self.threshold = read_inference_threshold(self.root)
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.root))
        linear = self.root / "linear_head.npz"
        if linear.exists():
            enc_dir = self.root / "encoder" if (self.root / "encoder").exists() else self.root
            self.model = AutoModel.from_pretrained(str(enc_dir))
            z = __import__("numpy").load(linear)
            w = torch.from_numpy(z["w"]).float()
            b = torch.tensor(float(z["b"])).float()
            self.model._sc_linear = (w, b)  # type: ignore[attr-defined]
            self.model.to(device)
            self._mode = "linear"
        else:
            self.model = AutoModelForSequenceClassification.from_pretrained(str(self.root))
            self.model.to(device)
            self._mode = "classifier"

    def compress(self, context: str, query: str, threshold: float | None = None) -> dict[str, Any]:
        import torch

        thr = float(threshold if threshold is not None else self.threshold)
        # Hard caps keep shared-CPU latency bounded (line-at-a-time was wedging Fly).
        max_lines = int(__import__("os").environ.get("SC_NEURAL_MAX_LINES", "128"))
        batch_size = max(1, int(__import__("os").environ.get("SC_NEURAL_BATCH", "32")))
        max_length = max(64, int(__import__("os").environ.get("SC_NEURAL_MAX_LENGTH", "128")))
        raw_lines = [ln for ln in str(context or "").splitlines() if ln.strip()]
        truncated = False
        if len(raw_lines) > max_lines:
            # Keep head + tail so incidents near either end survive.
            head_n = max_lines * 2 // 3
            tail_n = max_lines - head_n
            lines = raw_lines[:head_n] + raw_lines[-tail_n:]
            truncated = True
        else:
            lines = raw_lines
        if not lines:
            return {
                "compressed_text": str(context or ""),
                "original_tokens": 0,
                "kept_tokens": 0,
                "tokens_saved_pct": 0.0,
                "lines_in": 0,
                "lines_kept": 0,
                "threshold": thr,
                "policy_name": "SuperCompress Neural Keep",
                "mode": "neural-keep",
                "truncated": False,
            }

        kept = [False] * len(lines)
        probs: list[float] = [0.0] * len(lines)
        q = str(query or "")
        self.model.eval()
        with torch.no_grad():
            for start in range(0, len(lines), batch_size):
                chunk = lines[start : start + batch_size]
                enc = self.tokenizer(
                    [q] * len(chunk),
                    chunk,
                    truncation=True,
                    max_length=max_length,
                    padding=True,
                    return_tensors="pt",
                )
                enc = {k: v.to(self.device) for k, v in enc.items()}
                out = self.model(**enc)
                if self._mode == "classifier" and hasattr(out, "logits"):
                    logits = out.logits
                    batch_probs = torch.softmax(logits, dim=-1)[:, 1].tolist()
                else:
                    cls = out.last_hidden_state[:, 0, :].float()
                    w, b = self.model._sc_linear
                    batch_probs = torch.sigmoid(cls @ w.to(self.device) + b.to(self.device)).view(-1).tolist()
                for i, (ln, prob) in enumerate(zip(chunk, batch_probs)):
                    idx = start + i
                    probs[idx] = float(prob)
                    boost = _query_token_boost(q, ln)
                    penalty = _query_drop_penalty(q, ln)
                    kept[idx] = float(prob) + boost - penalty >= thr

        _expand_incident_tails(lines, kept, probs)
        out_lines = [ln for ln, k in zip(lines, kept) if k]
        if not out_lines:
            out_lines = lines[:3]

        compressed = "\n".join(out_lines)
        tin = rough_tokens(context)
        tout = rough_tokens(compressed)
        saved = max(0.0, (1.0 - tout / max(tin, 1)) * 100.0)
        return {
            "compressed_text": compressed,
            "original_tokens": tin,
            "kept_tokens": tout,
            "tokens_saved_pct": round(saved, 2),
            "lines_in": len(raw_lines),
            "lines_kept": len(out_lines),
            "threshold": thr,
            "policy_name": "SuperCompress Neural Keep",
            "mode": "neural-keep",
            "truncated": truncated,
        }
