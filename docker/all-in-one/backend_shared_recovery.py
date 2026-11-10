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


QUARANTINE_SCHEMA = "fullmag.shared-candidate-quarantine.v1"


def _quarantine_inventory(b, candidate):
    files, directories = b._stage_tree_inventory(candidate)
    if len(files) + len(directories) > b.MAX_FAILED_CANDIDATE_ENTRIES:
        b._fail("shared candidate quarantine inventory exceeds its bound")
    return {"directories": sorted(directories), "files": [
             {"path": relative, "sha256": b._sha256_file(candidate / relative, "quarantine payload")[0],
             "size": (candidate / relative).stat().st_size,
             "mode": stat.S_IMODE((candidate / relative).stat().st_mode)}
            for relative in sorted(files)]}


def _immutable_receipt(b, path, document):
    data = b._canonical(document)
    if len(data) > 8 * 1024**2:
        b._fail("shared candidate quarantine receipt exceeds its bound")
    if path.exists() or path.is_symlink():
        existing, metadata = b._read_regular(path, "shared candidate quarantine receipt", 8 * 1024**2)
        if metadata.st_nlink != 1 or existing != data:
            b._fail("shared candidate quarantine receipt collision")
        return
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o440)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    b._fsync_directory(path.parent, "shared candidate quarantine receipt")


def _finish_quarantine(b, store, output, control_root, build_root, proof):
    name = proof.get("name")
    if (proof.get("schema") != QUARANTINE_SCHEMA or proof.get("state") != "prepared"
            or not isinstance(name, str) or not b.PACKAGE_CANDIDATE_NAME_RE.fullmatch(name)
            or proof.get("output") != str(output) or proof.get("build_root") != str(build_root)
            or proof.get("group") != b.os.environ.get("FULLMAG_SHARED_BACKEND_GROUP", "")):
        b._fail("shared candidate quarantine owner differs")
    candidate = control_root / b.PACKAGE_CANDIDATES_DIRNAME / name
    archive = control_root / b.PACKAGE_QUARANTINE_DIRNAME
    target = archive / name
    if candidate.exists() and (target.exists() or target.is_symlink()):
        b._fail("shared candidate quarantine destination collision")
    payload = candidate if candidate.exists() else target
    store.private_alias(output, payload, proof["group"])
    if _quarantine_inventory(b, payload) != proof.get("inventory"):
        b._fail("shared candidate quarantine payload identity differs")
    marker_raw, _ = b._read_regular(payload / b.PACKAGE_CANDIDATE_MARKER, "quarantine marker", 16 * 1024)
    receipt_raw, _ = b._read_regular(payload / "backend-build-receipt.json", "quarantine package receipt", 8 * 1024**2)
    if (b._sha256_bytes(marker_raw) != proof.get("marker_sha256")
            or b._sha256_bytes(receipt_raw) != proof.get("receipt_sha256")
            or b._sha256_bytes(b._canonical(proof["inventory"])) != proof.get("inventory_sha256")):
        b._fail("shared candidate quarantine metadata identity differs")
    if payload == candidate:
        b._validate_candidate_marker(candidate, output, build_root, state="ready")
        os.rename(candidate, target)
        b._fsync_directory(candidate.parent, "shared candidate quarantine source")
        b._fsync_directory(archive, "shared candidate quarantine destination")
    _immutable_receipt(b, archive / (name + ".completed.json"), {
        "schema": QUARANTINE_SCHEMA, "state": "completed", "name": name,
        "prepared_sha256": b._sha256_bytes(b._canonical(proof)), "target": str(target),
    })
    b._log_phase("shared-package", "candidate-quarantined", candidate=name)


def _resume_quarantines(b, store, output, control_root, build_root):
    journal = control_root / b.PACKAGE_ROTATION_JOURNAL_NAME
    if journal.exists() or journal.is_symlink():
        b._fail("shared candidate quarantine requires recovered package rotation")
    archive = control_root / b.PACKAGE_QUARANTINE_DIRNAME
    if not archive.exists() and not archive.is_symlink():
        return
    b._ensure_directory(archive, "shared candidate quarantine")
    entries = list(archive.iterdir())
    if len(entries) > 3 * b.MAX_PACKAGE_CANDIDATES:
        b._fail("shared candidate quarantine exceeds its bounded entry limit")
    prepared = [p for p in entries if p.name.endswith(".prepared.json")]
    allowed = {name for p in prepared for name in (
        p.name, p.name.removesuffix(".prepared.json"),
        p.name.removesuffix(".prepared.json") + ".completed.json")}
    if any(p.name not in allowed for p in entries):
        b._fail("shared candidate quarantine contains an unknown entry")
    for path in prepared:
        proof, _ = b._read_json(path, "shared candidate quarantine intent", 8 * 1024**2)
        if path.name != str(proof.get("name")) + ".prepared.json":
            b._fail("shared candidate quarantine intent filename differs")
        _immutable_receipt(b, path, proof)
        _finish_quarantine(b, store, output, control_root, build_root, proof)


def _quarantine_mismatch(b, store, output, control_root, build_root, candidate, marker, receipt, raw):
    records = receipt["artifacts"]
    if marker["artifact_inventory_sha256"] != b._sha256_bytes(b._canonical(records)):
        b._fail("ready shared candidate marker inventory differs")
    b._assert_direct_candidate_inventory(candidate, records, include_receipt=True)
    group = b.os.environ.get("FULLMAG_SHARED_BACKEND_GROUP", "")
    store.private_alias(output, candidate, group)
    archive = control_root / b.PACKAGE_QUARANTINE_DIRNAME
    b._ensure_directory(archive, "shared candidate quarantine")
    if len(list(archive.iterdir())) + 3 > 3 * b.MAX_PACKAGE_CANDIDATES:
        b._fail("shared candidate quarantine exceeds its bounded entry limit")
    if any((archive / (candidate.name + suffix)).exists() or
           (archive / (candidate.name + suffix)).is_symlink()
           for suffix in ("", ".prepared.json", ".completed.json")):
        b._fail("shared candidate quarantine destination collision")
    marker_raw, _ = b._read_regular(candidate / b.PACKAGE_CANDIDATE_MARKER, "quarantine marker", 16 * 1024)
    inventory = _quarantine_inventory(b, candidate)
    proof = {"schema": QUARANTINE_SCHEMA, "state": "prepared", "name": candidate.name,
        "output": str(output), "build_root": str(build_root), "group": group,
        "reason": "shared-input-receipt-mismatch", "marker_sha256": b._sha256_bytes(marker_raw),
        "receipt_sha256": b._sha256_bytes(raw), "inventory": inventory,
        "inventory_sha256": b._sha256_bytes(b._canonical(inventory))}
    _immutable_receipt(b, archive / (candidate.name + ".prepared.json"), proof)
    _finish_quarantine(b, store, output, control_root, build_root, proof)


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
    try:
        _resume_quarantines(b, store, output, control_root, build_root)
    except shared.StoreError as error:
        b._fail(str(error))
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
            try:
                _quarantine_mismatch(b, store, output, control_root, build_root, candidate, marker, receipt, raw)
            except shared.StoreError as error:
                b._fail(str(error))
            continue
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
