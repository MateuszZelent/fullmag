"""Interpreted watcher behavior checks; no Rust compilation."""
from windows.watch_backend import BuildWatcher


def test_debounce_coalesces_edits_and_never_rebuilds_unchanged_inputs():
    current = ["a"]
    builds, states = [], []
    watcher = BuildWatcher(lambda: current[0], lambda: builds.append(current[0]) or 0, states.append, debounce=1)
    watcher.step(0)
    current[0] = "b"
    watcher.step(0.5)
    watcher.step(1.4)
    assert not builds
    watcher.step(1.5)
    watcher.step(3)
    assert builds == ["b"]
    assert states[-1]["state"] == "ready"
    assert states[-1]["runtime_restart"] == "manual_after_saving"


def test_failed_build_does_not_loop_or_restart_and_new_edit_retries():
    current = ["a"]
    builds, states = [], []
    watcher = BuildWatcher(lambda: current[0], lambda: builds.append(current[0]) or 1, states.append, 0)
    watcher.step(0)
    watcher.step(1)
    assert builds == ["a"]
    assert states[-1]["state"] == "failed"
    current[0] = "b"
    watcher.step(2)
    assert builds == ["a", "b"]


def test_edit_during_build_is_superseded_and_rebuilt(monkeypatch):
    current = ["a"]
    states = []
    def build():
        current[0] = "b"
        return 0
    monkeypatch.setattr("windows.watch_backend.time.monotonic", lambda: 2)
    watcher = BuildWatcher(lambda: current[0], build, states.append, 0)
    watcher.step(0)
    assert states[-1]["state"] == "superseded"
    watcher.step(2)
    assert states[-1]["state"] == "ready"


def test_stop_during_fingerprint_prevents_a_new_build():
    stopped, states = [False], []
    def digest():
        stopped[0] = True
        return "changed"
    watcher = BuildWatcher(digest, lambda: (_ for _ in ()).throw(AssertionError("Build after stop")),
                           states.append, debounce=0, may_build=lambda: not stopped[0])
    watcher.step(0)
    assert states[-1]["state"] == "stopped"
