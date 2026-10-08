"""Interpreted startup identity regressions; no native test compilation."""
import pytest

from scripts.verify_saved_fem_archive_roundtrip import check_stamp

COMMIT = "a" * 40
SNAPSHOT = "b" * 64
LEGACY = f"[fullmag] build: 2026-10-05T21:11:43Z | commit: {COMMIT} | dirty | source snapshot: {SNAPSHOT}"
CURRENT = LEGACY.replace("[fullmag] build:", "[fullmag] version: 0.1.0-dev.20261005.ga.dirty.sb+9774 | build:")


@pytest.mark.parametrize("stamp", [LEGACY, CURRENT])
@pytest.mark.parametrize("dirty", [False, True])
def test_accepts_only_exact_identity_in_both_supported_headers(stamp, dirty):
    if not dirty:
        stamp = stamp.replace(" | dirty | ", " | clean | ")
    check_stamp("unrelated diagnostic\n" + stamp + "\n", COMMIT, SNAPSHOT, dirty=dirty)


@pytest.mark.parametrize("stamp", [LEGACY, CURRENT])
@pytest.mark.parametrize("mutation", ["commit", "snapshot", "short_commit", "short_snapshot",
    "dirty", "extra", "duplicate", "mixed_duplicate", "missing_snapshot", "dirty_type"])
def test_rejects_changed_or_ambiguous_identity_in_either_header(stamp, mutation):
    dirty = True
    if mutation == "commit": stamp = stamp.replace(COMMIT, "c" * 40)
    elif mutation == "snapshot": stamp = stamp.replace(SNAPSHOT, "c" * 64)
    elif mutation == "short_commit": stamp = stamp.replace(COMMIT, COMMIT[:12])
    elif mutation == "short_snapshot": stamp = stamp.replace(SNAPSHOT, SNAPSHOT[:12])
    elif mutation == "dirty": stamp = stamp.replace(" | dirty | ", " | clean | ")
    elif mutation == "extra": stamp += " trailing"
    elif mutation == "duplicate": stamp += "\n" + stamp
    elif mutation == "mixed_duplicate": stamp += "\n" + (CURRENT if stamp == LEGACY else LEGACY)
    elif mutation == "missing_snapshot": stamp = stamp.split(" | source snapshot:")[0]
    elif mutation == "dirty_type": dirty = 1
    with pytest.raises(ValueError, match="startup identity"):
        check_stamp(stamp, COMMIT, SNAPSHOT, dirty=dirty)


@pytest.mark.parametrize("prefix", ["", "[fullmag] version: | ",
    "[fullmag] version: two words | ", "[fullmag] version: value | unrelated: x | "])
def test_rejects_missing_or_malformed_current_header(prefix):
    stamp = CURRENT.replace("[fullmag] version: 0.1.0-dev.20261005.ga.dirty.sb+9774 | ", prefix)
    with pytest.raises(ValueError, match="startup identity"):
        check_stamp(stamp, COMMIT, SNAPSHOT, dirty=True)
