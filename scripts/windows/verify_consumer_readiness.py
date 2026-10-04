"""Exercise the private readiness lease in owned APIs with controlled watcher frames.

These frames and candidate pins are protocol fixtures, not evidence of two native
builds, a verified candidate selector, workspace hydration, or solver execution.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import socket
import time
import uuid


def exercise(*, frame, with_api, configured, fixture_storage, run_root,
             worktree, generation, source, checks, receipt):
    helper_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    receipt["readiness_verifier_sha256"] = helper_hash
    owner_token = uuid.uuid4().hex
    target_source = "c" * 64
    candidate = dict(worktree_id=worktree, generation_id=generation,
                     ready_build_id="b" * 64, ready_source_sha256=target_source,
                     candidate_bundle_id="d" * 32, candidate_manifest_sha256="e" * 64)
    owner_root = fixture_storage / "runtimes" / worktree

    def ready(**changes):
        frame("ready", source_sha256=target_source, ready_build_id=candidate["ready_build_id"],
              ready_source_sha256=target_source, **changes)

    def observe(get, *, eligible):
        deadline = time.monotonic() + 5
        while True:
            records = [json.loads(path.read_text(encoding="utf-8"))
                       for path in owner_root.glob("development-api-owner-*.json")]
            matching = [record for record in records
                        if record["pid"] == get.owner_pid and record["api_port"] == get.api_port]
            if len(matching) == 1:
                owner = matching[0]
                break
            assert time.monotonic() < deadline, "Owned private listener was not published"
            time.sleep(0.05)
        assert owner["owner_token_sha256"] == hashlib.sha256(owner_token.encode()).hexdigest()
        assert owner["api_instance_id"] == get()[2]["workspace_identity"]["api_instance_id"]
        address, port = owner["control_address"].rsplit(":", 1)
        assert address == "127.0.0.1"

        def exchange(command="consumer_status", readiness=None, *, omit_readiness=False, **changes):
            nonce = str(uuid.uuid4())
            message = dict(schema="fullmag.development-api-control.v1", owner_token=owner_token,
                           api_instance_id=owner["api_instance_id"], nonce=nonce,
                           command=command, readiness=readiness)
            if omit_readiness:
                message.pop("readiness")
            message.update(changes)
            with socket.create_connection((address, int(port)), timeout=3) as stream:
                stream.sendall(json.dumps(message).encode() + b"\n")
                response = bytearray()
                while b"\n" not in response:
                    block = stream.recv(4096)
                    assert block and len(response) + len(block) <= 8192
                    response.extend(block)
            line, trailing = response.split(b"\n", 1)
            assert not trailing.strip()
            result = json.loads(line)
            assert owner_token.encode() not in line
            if result.get("status") != "rejected":
                assert set(result) == {"schema", "nonce", "api_instance_id", "worktree_id",
                                       "generation_id", "ready_build_id", "ready_source_sha256",
                                       "readiness_confirmed"}
                assert result["schema"] == "fullmag.development-consumer-readiness.v1"
                assert result["nonce"] == nonce and result["api_instance_id"] == owner["api_instance_id"]
                assert result["worktree_id"] == worktree and result["generation_id"] == generation
            return result

        ready()
        first = exchange(omit_readiness=True)
        assert first["readiness_confirmed"] is False
        checks.append("consumer-readiness-absent-lease-false")
        if not eligible:
            assert first["ready_build_id"] is None and first["ready_source_sha256"] is None
            assert exchange("consumer_readiness", candidate)["status"] == "rejected"
            assert exchange("consumer_readiness")["readiness_confirmed"] is False
            checks.append("consumer-readiness-ineligible-update-refused")
            return

        assert first["ready_build_id"] == candidate["ready_build_id"]
        assert first["ready_source_sha256"] == target_source
        checks.append("consumer-readiness-status-has-fresh-different-source-candidate")
        assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True
        checks.append("consumer-readiness-authenticated-renewal")
        assert exchange("consumer_readiness", omit_readiness=True)["status"] == "rejected"
        assert exchange()["readiness_confirmed"] is True
        checks.append("consumer-readiness-missing-field-cannot-withdraw")

        for label, change in (
            ("token", {"owner_token": "f" * 32}),
            ("api", {"api_instance_id": str(uuid.uuid4())}),
            ("nonce", {"nonce": str(uuid.UUID(int=0))}),
            ("schema", {"schema": "fullmag.development-api-control.v2"}),
        ):
            assert exchange("consumer_readiness", None, **change)["status"] == "rejected"
            assert exchange()["readiness_confirmed"] is True
            checks.append("consumer-readiness-unauthenticated-" + label + "-cannot-withdraw")
        for label, command, fields in (
            ("status-payload", "consumer_status", {}),
            ("acquire-payload", "acquire", {}),
            ("handoff-payload", "consumer_readiness", {"handoff": {}}),
            ("completion-payload", "consumer_readiness", {"completion": {}}),
        ):
            assert exchange(command, candidate, **fields)["status"] == "rejected"
            checks.append("consumer-readiness-rejects-" + label)

        for label, change in (
            ("generation", {"generation_id": "2" * 32}),
            ("worktree", {"worktree_id": "another-worktree"}),
            ("build", {"ready_build_id": "a" * 64}),
            ("source", {"ready_source_sha256": "d" * 64}),
            ("bundle-shape", {"candidate_bundle_id": "INVALID"}),
            ("manifest-shape", {"candidate_manifest_sha256": "E" * 64}),
            ("unknown-field", {"ttl_ms": 60000}),
        ):
            assert exchange("consumer_readiness", {**candidate, **change})["status"] == "rejected"
            checks.append("consumer-readiness-rejects-candidate-" + label)
        assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True

        # Reading status and writing watcher heartbeats cannot renew the lease.
        expire_at = time.monotonic() + 5.4
        while time.monotonic() < expire_at:
            ready()
            exchange()
            time.sleep(min(0.3, max(0, expire_at - time.monotonic())))
        ready()
        assert exchange()["readiness_confirmed"] is False
        checks.append("consumer-readiness-expires-despite-status-reads-and-watcher-heartbeats")

        assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True
        renew_until = time.monotonic() + 5.4
        while time.monotonic() < renew_until:
            ready()
            assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True
            time.sleep(min(1, max(0, renew_until - time.monotonic())))
        ready()
        assert exchange()["readiness_confirmed"] is True
        checks.append("consumer-readiness-explicit-renewal-prolongs-monotonic-lease")

        cases = (
            ("waiting", lambda: frame()),
            ("build-changed", lambda: frame("ready", source_sha256=target_source,
                ready_build_id="d" * 64, ready_source_sha256=target_source)),
            ("source-changed", lambda: frame("ready", source_sha256="d" * 64,
                ready_build_id="b" * 64, ready_source_sha256="d" * 64)),
            ("same-as-running", lambda: frame("ready", ready_build_id="b" * 64,
                ready_source_sha256=source)),
            ("generation-changed", lambda: ready(generation_id="2" * 32)),
            ("worktree-changed", lambda: ready(worktree_id="another-worktree")),
            ("stale", lambda: ready(updated_unix_ms=int(time.time() * 1000) - 20000)),
            ("future", lambda: ready(updated_unix_ms=int(time.time() * 1000) + 20000)),
        )
        for label, change in cases:
            ready()
            assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True
            change()
            assert exchange()["readiness_confirmed"] is False
            ready()
            assert exchange()["readiness_confirmed"] is False
            checks.append("consumer-readiness-invalidates-without-revival-" + label)

        ready()
        assert exchange("consumer_readiness", candidate)["readiness_confirmed"] is True
        assert exchange("consumer_readiness")["readiness_confirmed"] is False
        assert exchange()["readiness_confirmed"] is False
        checks.append("consumer-readiness-explicit-withdrawal")
        code, _, created = get("/v2/sessions", method="POST", payload={
            "name": "Owned readiness admission fixture", "backend": "fdm",
            "device": "cpu", "precision": "double",
        })
        assert code == 201 and created["session_id"]
        checks.append("consumer-readiness-does-not-acquire-or-freeze-workspace")
        code, _, public = get()
        assert code == 200 and public["restart_available"] is False
        assert not {"candidate_bundle_id", "candidate_manifest_sha256", "owner_token",
                    "readiness_confirmed", "expires_at"}.intersection(public)
        checks.append("consumer-readiness-does-not-promote-or-expand-public-resource")

    receipt["readiness_fixture"] = "controlled watcher/current/candidate pins; no selector or cross-build proof"
    config = {**configured, "FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token,
              "FULLMAG_DEVELOPMENT_RESTART_COORDINATOR": "1",
              "FULLMAG_DEVELOPMENT_RESTART_UI_ORIGIN": "http://localhost:3197"}
    frame()
    with_api("consumer-readiness", config, lambda get: observe(get, eligible=True))
    frame()
    with_api("consumer-readiness-no-transport", configured | {
        "FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token}, lambda get: observe(get, eligible=False))
    checks.append("consumer-readiness-missing-coordinator-refused")
    frame()
    with_api("consumer-readiness-warm-configured", config | {
        "FULLMAG_RUNTIME_SERVICE_CONFIG": str(run_root / "unstarted-warm-service.json")},
        lambda get: observe(get, eligible=False))
    checks.append("consumer-readiness-warm-configuration-refused-without-starting-service")
    assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == helper_hash
    checks.append("consumer-readiness-driver-source-unchanged")
