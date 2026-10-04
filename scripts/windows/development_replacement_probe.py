"""Managed verifier gate for a fresh candidate API from an accepted handoff.

This owns only a disposable verifier API. It completes admission only after
its exact restored acquisition; the capsule remains staged pending UI hydration.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
import uuid

from windows import development_handoff as capsule
from windows import runtime_bundle
from windows import development_scene_handoff as semantic
from windows.accepted_store_identity import store_binding


def run_probe(repo, fixture, env, prepared_result, old_api_instance_id, receipt, native_client=None):
    prepared = prepared_result["preparation"]
    layout = capsule._STORAGE.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    runtime = capsule._validate_runtime_root(layout["runtime_root"])
    manifest, _ = runtime_bundle.validate_bundle(prepared["candidate"]["bundle_root"], runtime, "dev")
    candidate = Path(prepared["candidate"]["bundle_root"])
    if capsule._sha256(capsule._read_limited(candidate / "manifest.json", runtime, "replacement manifest", 256 * 1024)) != prepared_result["candidate_manifest_sha256"]:
        raise capsule.HandoffError("Replacement candidate changed after preparation")
    api = candidate / "bin" / "fullmag-api.exe"
    root = Path(fixture) / "replacement-probe"
    capsule._contained_path(root, Path(fixture), "replacement probe")
    root.mkdir(exist_ok=False)
    state = root / "state"
    state.mkdir()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    source = manifest["source"]
    # Replacement belongs to the same managed watcher lifetime. Its API and
    # authoring session identities are fresh; the watcher generation stays pinned.
    generation = env["FULLMAG_DEVELOPMENT_BACKEND_GENERATION"]
    owner_token = uuid.uuid4().hex
    child_env = {**env, "FULLMAG_STATE_ROOT": str(state), "FULLMAG_API_PORT": str(port),
                 "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation,
                 "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": source["backend_source_sha256"],
                 "FULLMAG_DEVELOPMENT_BACKEND_VERSION": source["build_version"]["product_version"],
                 "FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token}
    child_env.pop("FULLMAG_DEVELOPMENT_RESTORE_STDIN", None)
    envelope = prepared["envelope"]
    if envelope is not None:
        child_env["FULLMAG_DEVELOPMENT_RESTORE_STDIN"] = "1"
    raw_input = b"" if envelope is None else capsule._canonical_json(
        envelope, "replacement prelisten envelope", capsule.MAX_SNAPSHOT_BYTES)
    accepted = Path(layout["runs_root"])
    scope = env.get("FULLMAG_ACCEPTED_STORE_SCOPE")
    accepted = accepted / "session-store" if scope is None else accepted / "workspaces" / scope / "session-store"
    if store_binding(accepted) != prepared_result["accepted_store_binding"]:
        raise capsule.HandoffError("Replacement actual store differs from accepted preparation")
    commit_path = accepted / "development" / "HANDOFF-COMMIT.json"
    fence_path = accepted / "development" / "ADMISSION-FENCE.json"
    before_commit = capsule._read_limited(commit_path, accepted, "replacement commit", 16 * 1024)
    if capsule._sha256(before_commit) != prepared_result["commit_sha256"]:
        raise capsule.HandoffError("Replacement durable acceptance changed after preparation")
    before_fence = capsule._read_limited(fence_path, accepted, "replacement fence", 4096)
    handoff_root = runtime / capsule.HANDOFF_DIRECTORY / prepared["handoff"]["handoff_id"]
    receipt_path = handoff_root / "receipt.json"
    before_capsule_receipt = capsule._read_limited(receipt_path, runtime, "replacement staged receipt", 16 * 1024)
    loaded = semantic.load_scene_handoff(repo, prepared["handoff"]["handoff_id"], prepared_result["binding"])
    if (loaded["snapshot_sha256"] != prepared["handoff"]["snapshot_sha256"]
            or loaded["scene"] != (None if envelope is None else envelope["scene_document"])
            or any(loaded[field] != prepared[field] for field in ("editor", "workspace", "project_document"))):
        raise capsule.HandoffError("Replacement authoring payload changed after preparation")
    process_record = {"label": "committed-replacement-api", "waited": False, "api_port": port}
    receipt["processes"].append(process_record)
    transport_errors = []
    with (root / "api.log").open("wb") as log:
        child = subprocess.Popen([str(api)], cwd=repo, env=child_env, stdin=subprocess.PIPE,
                                 stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        process_record["pid"] = child.pid
        writer = None
        try:
            def send_input():
                try:
                    child.stdin.write(raw_input)
                    child.stdin.flush()
                except (OSError, ValueError) as error:
                    transport_errors.append(type(error).__name__)
                finally:
                    child.stdin.close()

            writer = threading.Thread(target=send_input, daemon=True)
            writer.start()
            deadline = time.monotonic() + 20
            observed = None
            while time.monotonic() < deadline:
                if child.poll() is not None or transport_errors:
                    raise capsule.HandoffError("Owned replacement API failed before readiness")
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                try:
                    path = "/v2/sessions/current/model/scene" if envelope is not None else "/v2/platform/development-backend"
                    connection.request("GET", path)
                    response = connection.getresponse()
                    raw = response.read(capsule.MAX_SNAPSHOT_BYTES + 1)
                    pin = response.getheader("x-fullmag-api-instance")
                    if response.status == 200 and pin:
                        if len(raw) > capsule.MAX_SNAPSHOT_BYTES:
                            raise capsule.HandoffError("Replacement API authoring response exceeds limit")
                        observed = capsule._strict_json(raw, "replacement authoring response")
                        break
                except (OSError, http.client.HTTPException):
                    pass
                finally:
                    connection.close()
                time.sleep(0.025)
            if observed is None:
                raise capsule.HandoffError("Owned replacement API readiness outcome is unknown")
            parsed_pin = uuid.UUID(pin)
            if not parsed_pin.int or str(parsed_pin) != pin or pin == old_api_instance_id:
                raise capsule.HandoffError("Replacement API did not create a fresh canonical pin")
            owner_path = runtime / f"development-api-owner-{pin}.json"
            owner = capsule._strict_json(capsule._read_limited(owner_path, runtime, "replacement owner record", 16 * 1024), "replacement owner record")
            if (owner.get("schema") != "fullmag.development-api-owner.v1"
                    or owner.get("pid") != child.pid or owner.get("api_port") != port
                    or owner.get("api_instance_id") != pin
                    or owner.get("build_commit") != source["git_commit"]
                    or owner.get("build_snapshot") != source["source_snapshot_sha256"]):
                raise capsule.HandoffError("Replacement HTTP pin does not belong to the owned candidate API")
            if envelope is not None and observed != envelope["scene_document"]:
                raise capsule.HandoffError("Replacement API exposed a different scene after prelisten restore")
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            try:
                connection.request("GET", "/v2/platform/openapi.json")
                response = connection.getresponse()
                raw = response.read(capsule.MAX_SNAPSHOT_BYTES + 1)
                if (response.status != 200 or response.getheader("x-fullmag-api-instance") != pin
                        or len(raw) > capsule.MAX_SNAPSHOT_BYTES):
                    raise capsule.HandoffError("Replacement store binding response is not pinned")
                document = capsule._strict_json(raw, "replacement OpenAPI binding")
                if document.get("x-fullmag-runtime-store-binding", {}).get("binding") != prepared_result["accepted_store_binding"]:
                    raise capsule.HandoffError("Replacement API uses a different accepted store")
            finally:
                connection.close()
            address = owner.get("control_address", "")
            host, separator, control_port = address.partition(":")
            if host != "127.0.0.1" or not separator or not control_port.isdecimal() or not 0 < int(control_port) < 65536:
                raise capsule.HandoffError("Replacement private owner address is invalid")
            nonce = str(uuid.uuid4())
            frame = {"schema": "fullmag.development-api-control.v1", "owner_token": owner_token,
                     "api_instance_id": pin, "nonce": nonce, "command": "acquire"}
            with socket.create_connection((host, int(control_port)), timeout=2) as control:
                control.sendall(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
                with control.makefile("rb") as reader:
                    raw = reader.readline(capsule.MAX_SNAPSHOT_BYTES + 1)
                if len(raw) > capsule.MAX_SNAPSHOT_BYTES or not raw.endswith(b"\n"):
                    raise capsule.HandoffError("Replacement acquisition response exceeds limit")
                acquired = capsule._strict_json(raw, "replacement acquisition")
            if (acquired.get("schema") != "fullmag.development-authoring-acquisition.v1"
                    or acquired.get("nonce") != nonce or acquired.get("api_instance_id") != pin):
                raise capsule.HandoffError("Replacement authoring acquisition pin differs")
            workspace = acquired.get("workspace", {})
            if envelope is None:
                if workspace.get("state") != "no_session":
                    raise capsule.HandoffError("Replacement invented an authoring session")
            else:
                identity = workspace.get("identity", {})
                if (workspace.get("state") != "session" or workspace.get("scene_document") != envelope["scene_document"]
                        or identity.get("api_instance_id") != pin or identity.get("session_epoch") != 1
                        or not identity.get("session_id") or identity["session_id"] == envelope["old_session_id"]):
                    raise capsule.HandoffError("Replacement authoring identity was not restored fresh")
            writer.join(timeout=1)
            if writer.is_alive() or transport_errors:
                raise capsule.HandoffError("Replacement private input transport did not finish")
            if (capsule._read_limited(commit_path, accepted, "replacement commit", 16 * 1024) != before_commit
                    or capsule._read_limited(fence_path, accepted, "replacement fence", 4096) != before_fence
                    or capsule._read_limited(receipt_path, runtime, "replacement staged receipt", 16 * 1024) != before_capsule_receipt):
                raise capsule.HandoffError("Replacement changed the pending lifecycle markers")
            if store_binding(accepted) != prepared_result["accepted_store_binding"]:
                raise capsule.HandoffError("Replacement actual store changed during verification")
            process_record.update(api_instance_id=pin, old_api_instance_id=old_api_instance_id,
                                  restored_before_listen=True, fence_retained=True, capsule_receipt_staged=True)
            receipt["checks"].extend(("committed-replacement-owned-candidate-pin",
                                      "committed-replacement-exact-prelisten-authoring",
                                      "committed-replacement-fresh-authoring-acquisition",
                                      "committed-replacement-lifecycle-markers-retained"))
            complete_live_restore(host, int(control_port), owner_token, pin, port,
                                  prepared_result, accepted, before_commit, before_fence,
                                  receipt_path, before_capsule_receipt, process_record, receipt,
                                  repo, child_env, child.pid, root, owner_path, native_client)
        finally:
            # Only this fresh verifier API is stopped, after no compute command
            # was submitted. No user runtime is involved in this cleanup.
            if child.poll() is None:
                child.terminate()
                process_record["termination_reason"] = "owned verifier replacement cleanup; no compute submitted"
            process_record.update(exit_code=child.wait(timeout=10), waited=True)
            if writer is not None:
                writer.join(timeout=1)


def complete_live_restore(host, control_port, owner_token, pin, http_port,
                          prepared_result, accepted, before_commit, before_fence,
                          receipt_path, before_capsule_receipt, process_record, receipt,
                          repo, child_env, api_pid, probe_root, owner_path, native_client=None):
    prepared = prepared_result["preparation"]
    candidate_id = Path(prepared["candidate"]["bundle_root"]).name
    completion = {"handoff_id": prepared["handoff"]["handoff_id"],
                  "snapshot_sha256": prepared["handoff"]["snapshot_sha256"],
                  "target_build_id": prepared_result["binding"]["target_build_id"],
                  "candidate_bundle_id": candidate_id,
                  "candidate_manifest_sha256": prepared_result["candidate_manifest_sha256"],
                  "commit_sha256": prepared_result["commit_sha256"]}

    def exchange(control, frame):
        control.sendall(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
        with control.makefile("rb") as reader:
            raw = reader.readline(capsule.MAX_SNAPSHOT_BYTES + 1)
        if len(raw) > capsule.MAX_SNAPSHOT_BYTES or not raw.endswith(b"\n"):
            raise capsule.HandoffError("Completion private response exceeds its limit")
        return capsule._strict_json(raw, "completion private response")

    def acquire(control, nonce):
        frame = {"schema": "fullmag.development-api-control.v1", "owner_token": owner_token,
                 "api_instance_id": pin, "nonce": nonce, "command": "acquire"}
        acquired = exchange(control, frame)
        if (acquired.get("schema") != "fullmag.development-authoring-acquisition.v1"
                or acquired.get("nonce") != nonce or acquired.get("api_instance_id") != pin):
            raise capsule.HandoffError("Completion did not acquire its exact replacement API")
        workspace = acquired.get("workspace", {})
        envelope = prepared["envelope"]
        if envelope is None:
            if workspace.get("state") != "no_session" or workspace.get("session_epoch") != 0:
                raise capsule.HandoffError("Empty completion has a different authoring state")
        elif (workspace.get("state") != "session"
              or workspace.get("scene_document") != envelope["scene_document"]
              or workspace.get("identity", {}).get("session_epoch") != 1):
            raise capsule.HandoffError("Completion acquisition differs from restored capsule")
        return frame, workspace

    for field in ("commit_sha256", "snapshot_sha256", "candidate_manifest_sha256", "target_build_id"):
        nonce = str(uuid.uuid4())
        with socket.create_connection((host, control_port), timeout=20) as control:
            frame, _ = acquire(control, nonce)
            invalid = {**completion, field: "0" * 64}
            response = exchange(control, {**frame, "command": "complete_cold", "completion": invalid})
            if (response.get("schema") != "fullmag.development-api-control.v1"
                    or response.get("status") != "rejected"):
                raise capsule.HandoffError("Invalid completion pin lacked an explicit rejection")
        if (accepted.joinpath("development/HANDOFF-COMMIT.json").read_bytes() != before_commit
                or accepted.joinpath("development/ADMISSION-FENCE.json").read_bytes() != before_fence
                or os.path.lexists(accepted / "development/HANDOFF-COMPLETION.json")):
            raise capsule.HandoffError("Invalid completion changed durable admission state")
        receipt["checks"].append("live-completion-invalid-" + field + "-refused")
    nonce = str(uuid.uuid4())
    with socket.create_connection((host, control_port), timeout=20) as control:
        frame, workspace = acquire(control, nonce)
        released = exchange(control, {**frame, "command": "abort"})
        if (released.get("schema") != "fullmag.development-api-abort.v1"
                or released.get("nonce") != nonce or released.get("api_instance_id") != pin):
            raise capsule.HandoffError("Parent could not release its observation acquisition")
    identity = workspace.get("identity", {})
    expected_session = identity.get("session_id") if prepared["envelope"] is not None else None
    expected_epoch = 1 if expected_session is not None else 0
    request = {"schema": "fullmag.development-cli-completion-request.v1", "api_pid": api_pid,
               "api_port": http_port, "api_instance_id": pin,
               "old_api_instance_id": prepared_result["binding"]["api_instance_id"],
               "commit_sha256": completion["commit_sha256"],
               "candidate_bundle_id": candidate_id,
               "candidate_manifest_sha256": completion["candidate_manifest_sha256"],
               "expected_scene_sha256": workspace.get("scene_sha256") if expected_session is not None else capsule._sha256(b"null"),
               "expected_session_id": expected_session, "expected_session_epoch": expected_epoch}
    native_env = {**child_env, "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
                  "FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN": owner_token}
    native_env.pop("FULLMAG_DEVELOPMENT_OWNER_TOKEN", None)
    native_env.pop("FULLMAG_DEVELOPMENT_RESTORE_STDIN", None)
    native_cli = Path(native_client) if native_client is not None else Path(prepared["candidate"]["bundle_root"]) / "bin/fullmag.exe"

    def invoke_native(payload, label):
        helper = subprocess.Popen([str(native_cli), "runtime", "verify-development-completion-owner"],
                                  cwd=repo, env=native_env, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        record = {"label": label, "pid": helper.pid, "waited": False}
        receipt["processes"].append(record)
        try:
            output, errors = helper.communicate(capsule._canonical_json(payload, "native completion request", 4096), timeout=45)
        except subprocess.TimeoutExpired:
            record["outcome"] = "unknown; native completion must not be retried"
            raise capsule.HandoffError("Native completion client has an unknown outcome; its process was retained")
        record.update(waited=True, exit_code=helper.returncode)
        (probe_root / (label + ".log")).write_bytes(output + errors)
        if len(output) > 4096:
            raise capsule.HandoffError("Native completion client output exceeds limit")
        frames = [capsule._strict_json(line, "native completion frame") for line in output.splitlines() if line.strip()]
        if not frames:
            raise capsule.HandoffError("Native candidate owner validation produced no confirmation")
        progress = frames.pop(0)
        if (set(progress) != {"schema", "helper_pid", "helper_waited", "helper_exit_code"}
                or progress["schema"] != "fullmag.development-cli-candidate-owner-progress.v1"
                or type(progress["helper_pid"]) is not int or progress["helper_pid"] <= 0
                or progress["helper_waited"] is not True or progress["helper_exit_code"] != 0):
            raise capsule.HandoffError("Native candidate owner validator confirmation is invalid")
        receipt["processes"].append({"label": "native-candidate-owner-validator", "pid": progress["helper_pid"], "waited": True, "exit_code": 0})
        if len(frames) > 1 or (helper.returncode == 0 and len(frames) != 1):
            raise capsule.HandoffError("Native completion has an unexpected frame count")
        return helper.returncode, b"" if not frames else capsule._canonical_json(frames[0], "native completion result", 4096)

    for field, invalid in (("api_pid", api_pid + 1), ("expected_scene_sha256", "0" * 64)):
        code, _ = invoke_native({**request, field: invalid}, "native-completion-invalid-" + field)
        if (code == 0 or accepted.joinpath("development/HANDOFF-COMMIT.json").read_bytes() != before_commit
                or accepted.joinpath("development/ADMISSION-FENCE.json").read_bytes() != before_fence
                or os.path.lexists(accepted / "development/HANDOFF-COMPLETION.json")):
            raise capsule.HandoffError("Native completion accepted invalid ownership or changed admission")
        receipt["checks"].append("native-completion-invalid-" + field + "-refused")

    # Rewrite only this disposable API's already-verified discovery record,
    # redirecting the diagnostic client to a bounded fake ACK peer. The real
    # API is never sent completion during this protocol rejection check.
    original_owner = owner_path.read_bytes()
    original_owner_copy = probe_root / "native-completion-discovery-original.json"
    original_owner_copy.write_bytes(original_owner)
    fake_errors = []
    fake_sent = []
    with socket.socket() as fake_listener:
        fake_listener.bind(("127.0.0.1", 0))
        fake_listener.listen(1)
        fake_listener.settimeout(10)
        fake_owner = capsule._strict_json(original_owner, "owned discovery record")
        fake_owner["control_address"] = "127.0.0.1:" + str(fake_listener.getsockname()[1])
        fake_bytes = capsule._canonical_json(fake_owner, "owned fake discovery record", 8192)

        def fake_ack_peer():
            try:
                peer, _ = fake_listener.accept()
                with peer, peer.makefile("rb") as reader:
                    peer.settimeout(10)
                    first = capsule._strict_json(reader.readline(4097), "native fake acquire")
                    if first.get("command") != "acquire" or first.get("owner_token") != owner_token or first.get("api_instance_id") != pin:
                        raise capsule.HandoffError("Native fake peer received foreign acquisition")
                    peer.sendall(json.dumps({"schema": "fullmag.development-authoring-acquisition.v1",
                                            "nonce": first["nonce"], "api_instance_id": pin,
                                            "workspace": workspace}).encode() + b"\n")
                    second = capsule._strict_json(reader.readline(4097), "native fake completion")
                    if (second.get("command") != "complete_cold" or second.get("nonce") != first["nonce"]
                            or second.get("completion") != completion):
                        raise capsule.HandoffError("Native fake peer did not reach the production completion request")
                    peer.sendall(json.dumps({"schema": "fullmag.development-api-completion.v1",
                                            "nonce": first["nonce"], "api_instance_id": pin,
                                            "old_api_instance_id": request["old_api_instance_id"],
                                            "handoff_id": completion["handoff_id"],
                                            "snapshot_sha256": completion["snapshot_sha256"],
                                            "target_build_id": completion["target_build_id"],
                                            "accepted_store_binding": prepared_result["accepted_store_binding"],
                                            "session_id": expected_session, "session_epoch": expected_epoch,
                                            "scene_document_sha256": "0" * 64,
                                            "admission_reopened": True}).encode() + b"\n")
                    fake_sent.append(True)
            except (OSError, ValueError, capsule.HandoffError) as error:
                fake_errors.append(type(error).__name__)

        fake_thread = threading.Thread(target=fake_ack_peer, daemon=True)
        fake_thread.start()
        owner_path.write_bytes(fake_bytes)
        try:
            code, _ = invoke_native(request, "native-completion-foreign-ack")
        finally:
            if owner_path.read_bytes() != fake_bytes:
                raise capsule.HandoffError("Disposable owner record changed during fake ACK check; original retained in fixture")
            owner_path.write_bytes(original_owner)
            fake_thread.join(timeout=11)
        if code == 0 or fake_thread.is_alive() or fake_errors or fake_sent != [True]:
            raise capsule.HandoffError("Native completion did not reject the exercised foreign ACK")
    if (accepted.joinpath("development/HANDOFF-COMMIT.json").read_bytes() != before_commit
            or accepted.joinpath("development/ADMISSION-FENCE.json").read_bytes() != before_fence
            or os.path.lexists(accepted / "development/HANDOFF-COMPLETION.json")):
        raise capsule.HandoffError("Fake completion ACK changed actual durable admission")
    receipt["checks"].append("native-completion-foreign-ack-refused")
    code, output = invoke_native(request, "native-completion-owner-client")
    if code != 0:
        raise capsule.HandoffError("Native completion client failed; see its owned fixture log")
    native_result = capsule._strict_json(output, "native completion result")
    if (native_result.get("schema") != "fullmag.development-cli-completion-check.v1"
            or native_result.get("api_pid") != api_pid or native_result.get("api_instance_id") != pin
            or native_result.get("checks") != ["native-completion-owner-confirmed", "native-completion-held-restore-pinned", "native-completion-acknowledgement-validated"]):
        raise capsule.HandoffError("Native completion result differs from owned replacement")
    receipt["checks"].extend(native_result["checks"])
    response = native_result["acknowledgement"]
    if (response.get("schema") != "fullmag.development-api-completion.v1"
            or response.get("api_instance_id") != pin
            or response.get("old_api_instance_id") != prepared_result["binding"]["api_instance_id"]
            or any(response.get(field) != completion[field] for field in ("handoff_id", "snapshot_sha256", "target_build_id"))
            or response.get("accepted_store_binding") != prepared_result["accepted_store_binding"]
            or response.get("session_id") != expected_session or response.get("session_epoch") != expected_epoch
            or response.get("scene_document_sha256") != (workspace.get("scene_sha256") if expected_session is not None else capsule._sha256(b"null"))
            or response.get("admission_reopened") is not True):
        raise capsule.HandoffError("Live completion acknowledgement differs from trusted restore")
    for name in ("HANDOFF-COMMIT.json", "ADMISSION-FENCE.json", "HANDOFF-COMPLETION.json"):
        if os.path.lexists(accepted / "development" / name):
            raise capsule.HandoffError("Live completion retained an active admission marker")
    history = accepted / "development/completion-authorizations" / (completion["handoff_id"] + ".json")
    record = capsule._strict_json(capsule._read_limited(history, accepted, "live completion history", 64 * 1024), "live completion history")
    replacement = record.get("replacement", {})
    if (record.get("schema") != "fullmag.development-handoff-completion.v1"
            or record.get("commit") != capsule._strict_json(before_commit, "accepted commit")
            or any(replacement.get(field) != response.get(field) for field in
                   ("api_instance_id", "session_id", "session_epoch", "scene_document_sha256", "target_build_id", "accepted_store_binding"))
            or receipt_path.read_bytes() != before_capsule_receipt):
        raise capsule.HandoffError("Live completion history differs from acknowledgement")
    connection = http.client.HTTPConnection("127.0.0.1", http_port, timeout=2)
    try:
        if prepared["envelope"] is None:
            connection.request("GET", "/v2/platform/development-backend")
        else:
            connection.request("PUT", "/v2/sessions/current/model/scene",
                               body=json.dumps(prepared["envelope"]["scene_document"]).encode(),
                               headers={"Content-Type": "application/json"})
        result = connection.getresponse()
        result.read(capsule.MAX_SNAPSHOT_BYTES + 1)
        if result.status != 200 or result.getheader("x-fullmag-api-instance") != pin:
            raise capsule.HandoffError("Live completion did not reopen pinned HTTP admission")
    finally:
        connection.close()
    process_record.update(fence_retained=False, live_completion=True, admission_reopened=True,
                          completion_history_sha256=capsule._sha256(history.read_bytes()))
    receipt["checks"].extend(("live-completion-exact-history", "live-completion-active-markers-retired",
                              "live-completion-pinned-http-admission-reopened"))
