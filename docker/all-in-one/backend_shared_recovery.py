"""Recover shared ready candidates without inventing a local Make attempt.

The verified payload is first retained in the shared cache under its build
key. Only then may the private duplicate be retired. The last recovery receipt
and bounded diagnostics stay in the group's control volume. A crash during
unlink resumes through the ordinary building-candidate intent protocol.
"""
import hashlib
import os
import tempfile
from pathlib import Path
import stat

import backend_shared_store as shared


def _write_diagnostics(b, archive, data):
    target = archive / "shared-candidate-recovery.log"
    if target.exists() or target.is_symlink():
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            b._fail("shared recovery diagnostic archive is unsafe")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shared-recovery-", dir=archive)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        b._fsync_directory(archive, "shared recovery diagnostic archive")
    finally:
        temporary.unlink(missing_ok=True)


def recover_ready(b, output, control_root, build_root):
    configured = b.os.environ.get("FULLMAG_SHARED_BACKEND_STORE", "")
    if not configured:
        return
    if configured != str(shared.ROOT):
        b._fail("shared candidate recovery requires the managed store")
    store = shared.Store(Path(configured))
    for candidate in b._candidate_retirement_entries(control_root):
        # A committed rotation may leave an empty or marker-only directory.
        # The existing current-package proof owns that recovery path.
        names = {item.name for item in candidate.iterdir()}
        if not names or names == {b.PACKAGE_CANDIDATE_MARKER}:
            continue
        marker = b._validate_candidate_marker(candidate, output, build_root)
        if marker["state"] != "ready":
            continue
        receipt, raw, _ = b._validated_package(candidate, "shared ready candidate", exclude_candidate_marker=True)
        binding = receipt.get("shared_package")
        if binding is None:
            continue  # Legacy ready candidates retain their Make-attempt proof.
        if not isinstance(binding, dict) or binding.get("schema") != shared.SCHEMA:
            b._fail("ready candidate shared package binding is invalid")
        inputs = binding.get("inputs")
        if not isinstance(inputs, dict) or shared.key_for(inputs) != binding.get("key"):
            b._fail("ready candidate shared package inputs differ from its key")
        source = receipt.get("source", {})
        if (inputs.get("native_source_identity") != receipt.get("native_source_identity")
                or inputs.get("toolchain") != receipt.get("toolchain")
                or inputs.get("resolved_commit") != source.get("resolved_commit")
                or inputs.get("runtime_source_digest") != source.get("runtime_source_digest")
                or not isinstance(inputs.get("build"), dict)
                or any(receipt.get("build", {}).get(key) != value for key, value in inputs["build"].items())):
            b._fail("ready shared candidate receipt does not attest its cache inputs")
        records = receipt["artifacts"]
        if marker["artifact_inventory_sha256"] != b._sha256_bytes(b._canonical(records)):
            b._fail("ready shared candidate marker inventory differs")
        b._assert_direct_candidate_inventory(candidate, records, include_receipt=True)
        alias = store.private_alias(output, candidate, b.os.environ.get("FULLMAG_SHARED_BACKEND_GROUP", ""))
        try:
            with store.claim(inputs) as entry:
                cached = entry.read()
                if cached is None:
                    # GC may have evicted this key since the interrupted start.
                    # Re-publish the validated ready payload before retiring it.
                    entry.publish(alias, receipt)
                elif cached["receipt"]["artifacts"] != records:
                    b._fail("ready shared candidate differs from its cached payload")
                files, _ = b._stage_tree_inventory(candidate)
                optional = files - {record["path"] for record in records} - {
                    b.PACKAGE_CANDIDATE_MARKER, "backend-build-receipt.json"}
                diagnostic_records = []
                diagnostics = bytearray()
                for relative in sorted(optional):
                    path = candidate / relative
                    data, metadata = b._read_regular(path, "shared recovery diagnostic", b.MAX_BUILD_LOG_BYTES)
                    if metadata.st_nlink != 1 or not stat.S_ISREG(metadata.st_mode):
                        b._fail("shared recovery diagnostic is not private")
                    digest = hashlib.sha256(data).hexdigest()
                    diagnostic_records.append({"path": relative, "sha256": digest, "size": len(data),
                        "mode": "100755" if metadata.st_mode & 0o111 else "100644"})
                    diagnostics.extend(("\n=== " + relative + " sha256=" + digest + " ===\n").encode())
                    diagnostics.extend(data)
                    if len(diagnostics) > 64 * 1024**2:
                        b._fail("shared recovery diagnostics exceed their bounded control archive")
                # Fixed filenames bound this diagnostic archive to one recovery.
                # Publication is durable before marking the candidate disposable.
                archive = b.BACKEND_CONTROL_ROOT
                b._ensure_directory(archive, "shared recovery control archive")
                if diagnostics:
                    _write_diagnostics(b, archive, bytes(diagnostics))
                b._write_json(archive / "shared-candidate-recovery.json", {
                    "schema": "fullmag.shared-candidate-recovery.v1", "state": "cached",
                    "candidate": str(candidate), "key": entry.key,
                    "receipt_sha256": b._sha256_bytes(raw), "receipt": receipt,
                    "diagnostics": diagnostic_records,
                    "diagnostic_archive_sha256": hashlib.sha256(diagnostics).hexdigest() if diagnostics else None,
                }, "shared candidate recovery receipt")
                b._fsync_directory(archive, "shared candidate recovery receipt")
                b._write_candidate_marker(candidate, output, build_root, state="building", shared_restore={
                    "key": entry.key, "artifacts": records, "diagnostics": diagnostic_records})
                if not b._discard_interrupted_building_candidate(candidate, output, build_root):
                    b._fail("shared ready candidate retirement could not be proven")
                b._log_phase("shared-package", "candidate-recovered", key=entry.key)
        except shared.StoreError as error:
            b._fail(str(error))
