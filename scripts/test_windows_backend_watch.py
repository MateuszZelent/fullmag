"""Interpreted watcher behavior checks; no Rust compilation."""
from windows.watch_backend import BuildWatcher, ExplicitBuildObserver


REQUEST_A = "12345678-1234-4234-8234-123456789abc"
REQUEST_B = "22345678-1234-4234-8234-123456789abc"


def test_idle_source_edits_never_digest_or_build_without_a_request():
    current = ["a"]
    digests, builds, states = [], [], []

    def digest():
        digests.append(current[0])
        return current[0]

    watcher = BuildWatcher(digest, lambda request_id: builds.append(current[0]) or 0, states.append)
    watcher.step(0)
    current[0] = "edited"
    watcher.step(1000)

    assert digests == []
    assert builds == []
    assert states == []


def test_each_explicit_request_is_consumed_once_and_build_identity_is_frozen():
    current = ["source-a"]
    digests, builds, states, verifications = [], [], [], []

    def digest():
        digests.append(current[0])
        return current[0]

    def build(request_id):
        assert request_id in {REQUEST_A, REQUEST_B}
        builds.append(current[0])
        if len(builds) == 1:
            current[0] = "source-b-edited-during-build"
        return 0

    def verify_ready(expected_manifest_sha256):
        assert expected_manifest_sha256 == "c" * 64
        verifications.append(expected_manifest_sha256)
        return {"ready_build_id": "b" * 64, "ready_source_sha256": "a" * 64}

    watcher = BuildWatcher(
        digest, build, states.append, verify_ready=verify_ready,
        read_build_manifest_sha256=lambda request_id: "c" * 64,
    )
    watcher.step(0, REQUEST_A)
    assert states[-1]["state"] == "ready"
    assert states[-1]["source_sha256"] == "a" * 64
    assert digests == ["source-a"]
    assert builds == ["source-a"]
    assert verifications == ["c" * 64]

    # Polling the same intent and editing files remain idle. Only another
    # explicit user request may capture and build the newer checkout.
    watcher.step(1, REQUEST_A)
    current[0] = "source-b"
    watcher.step(2)
    assert digests == ["source-a"]
    assert builds == ["source-a"]

    watcher.step(3, REQUEST_B)
    assert digests == ["source-a", "source-b"]
    assert builds == ["source-a", "source-b"]
    assert states[-1]["state"] == "ready"


def test_failed_request_does_not_loop_and_a_new_request_retries():
    current = ["a"]
    digests, builds, states = [], [], []

    def digest():
        digests.append(current[0])
        return current[0]

    def build(request_id):
        assert request_id in {REQUEST_A, REQUEST_B}
        builds.append(current[0])
        return 1 if len(builds) == 1 else 0

    watcher = BuildWatcher(digest, build, states.append)
    watcher.step(0, REQUEST_A)
    current[0] = "b"
    watcher.step(1, REQUEST_A)
    assert states[-1]["state"] == "failed"
    assert digests == ["a"]
    assert builds == ["a"]

    watcher.step(2, REQUEST_B)
    assert digests == ["a", "b"]
    assert builds == ["a", "b"]
    assert states[-1]["state"] == "ready"


def test_stop_after_digest_prevents_build_until_a_new_request():
    stopped = [False]
    digests, builds, states = [], [], []

    def digest():
        digests.append("source")
        if len(digests) == 1:
            stopped[0] = True
        return "source"

    watcher = BuildWatcher(
        digest,
        lambda request_id: builds.append(("build", request_id)) or 0,
        states.append,
        may_build=lambda: not stopped[0],
    )
    watcher.step(0, REQUEST_A)
    assert states[-1]["state"] == "stopped"
    assert builds == []

    watcher.step(1, REQUEST_A)
    assert len(digests) == 1
    assert builds == []
    stopped[0] = False
    watcher.step(2, REQUEST_B)
    assert builds == [("build", REQUEST_B)]
    assert states[-1]["state"] == "ready"


def test_explicit_build_observer_publishes_running_and_verifies_completed_receipt(tmp_path):
    receipt = tmp_path / "build-status.json"
    states, verifications = [], []

    def verify_ready(expected_manifest_sha256):
        assert expected_manifest_sha256 == "e" * 64
        verifications.append(expected_manifest_sha256)
        return {"ready_build_id": "c" * 64, "ready_source_sha256": "d" * 64}

    observer = ExplicitBuildObserver(
        receipt, "fullmag-test", "windows-native-fdm-cpu-dev", states.append,
        verify_ready, "a" * 64,
    )
    receipt.write_text(
        '{"worktree_id":"fullmag-test","profile":"windows-native-fdm-cpu-dev",'
        '"execution_mode":"windows-workspace-build","state":"running"}',
        encoding="utf-8",
    )
    observer.step()
    assert states[-1] == {"state": "building", "source_sha256": "a" * 64}
    assert verifications == []

    receipt.write_text(
        '{"worktree_id":"fullmag-test","profile":"windows-native-fdm-cpu-dev",'
        '"execution_mode":"windows-workspace-build","state":"completed","exit_code":0,'
        '"build_manifest_sha256":"' + ("e" * 64) + '"}',
        encoding="utf-8",
    )
    observer.step()
    assert states[-1] == {
        "state": "ready", "source_sha256": "d" * 64,
        "ready_build_id": "c" * 64, "ready_source_sha256": "d" * 64,
    }
    assert verifications == ["e" * 64]
    observer.step()
    assert verifications == ["e" * 64]


def test_explicit_build_observer_fails_closed_without_a_manifest_pin(tmp_path):
    receipt = tmp_path / "build-status.json"
    states, verifications = [], []
    observer = ExplicitBuildObserver(
        receipt, "fullmag-test", "windows-native-fdm-cpu-dev", states.append,
        lambda expected_manifest: verifications.append(expected_manifest), "a" * 64,
    )
    receipt.write_text(
        '{"worktree_id":"fullmag-test","profile":"windows-native-fdm-cpu-dev",'
        '"execution_mode":"windows-workspace-build","state":"completed","exit_code":0}',
        encoding="utf-8",
    )
    observer.step()
    assert states[-1] == {"state": "failed", "source_sha256": "a" * 64}
    assert verifications == []
