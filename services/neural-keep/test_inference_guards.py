"""Pure-python guards for Neural Keep keep-policy (no torch required)."""

from inference import _expand_incident_tails


def test_critical_markers_always_kept():
    lines = [
        "noise header",
        "FAIL tests/x.js",
        "Root cause: boom",
        "Fix hint: patch it",
        "noise tail",
    ]
    kept = [False] * len(lines)
    probs = [0.0] * len(lines)
    _expand_incident_tails(lines, kept, probs)
    assert kept[2] is True
    assert kept[3] is True
    assert kept[0] is False
    assert kept[4] is False


def test_assertion_error_kept():
    lines = ["noise", "    AssertionError: expected 200", "noise2"]
    kept = [False, False, False]
    _expand_incident_tails(lines, kept, [0.0, 0.0, 0.0])
    assert kept[1] is True
