"""Explicit read-only admission of the approved retained result store."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture

REVIEW_SHA256 = "bab5df49564d6a3a549679904dba9094343a9a2a804891f0a250b134bdb6c932"
PARENT_REVIEW_SHA256 = "c0a35618e47919eb5214c889f119da4359543cba41c4178f71bf19f39f8204cf"
PARENT_RUN_ID = "run-live-3926fcbd084cf93d924a7f29af0726974a719301104d867ee46b01a200bf3cf6"
GUEST_ROOT = "/opt/fullmag/retained-results/antenna/session-store"
MANIFEST_ROOT = "/opt/fullmag/result-archive"
ENV = ("FULLMAG_READONLY_RESULT_ARCHIVE_PATH", "FULLMAG_READONLY_RESULT_ARCHIVE_SHA256", "FULLMAG_READONLY_RESULT_ARCHIVE_PROJECT")
WRITER_BYTES = b"fullmag.writer.lock.v1\n"
MAX_MANIFEST_BYTES = 64 * 1024
SHA = re.compile(r"[0-9a-f]{64}")
REQUEST_PATH = re.compile(r"readonly-results/[0-9a-f]{64}/request\.json")


def require(value, message):
    if not value:
        raise BuildControlError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw, maximum=MAX_MANIFEST_BYTES):
    require(0 < len(raw) <= maximum, "Readonly archive document exceeds its bound")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate readonly archive field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    require(isinstance(value, dict), "Readonly archive document must be an object")
    return value


def option_pins(path, digest):
    if path is None and digest is None:
        return None
    require(isinstance(path, str) and REQUEST_PATH.fullmatch(path)
            and isinstance(digest, str) and SHA.fullmatch(digest), "Readonly archive requires paired exact control request pins")
    return path, digest


def source_identity(root):
    root = Path(root)
    require(root.is_absolute() and str(root) == str(root.resolve(strict=True)), "Readonly archive host root is not canonical")
    for item in (root, *root.parents):
        require(stat.S_ISDIR(item.lstat().st_mode), "Readonly archive path contains a symlink or non-directory")
    info = root.stat()
    return {"device": info.st_dev, "inode": info.st_ino, "mode": info.st_mode}


def read_file(path, maximum):
    path = Path(path)
    require(all(not parent.is_symlink() for parent in path.parents), "Readonly archive record has a symlink parent")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum,
                "Readonly archive record is not one bounded regular file")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        require(len(raw) == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "Readonly archive record changed")
        return raw


def manifest_from_review(review_raw, project, host_root):
    digest = sha(review_raw)
    count = 4 if digest == REVIEW_SHA256 else 5 if digest == PARENT_REVIEW_SHA256 else 0
    require(count != 0, "Readonly archive review is not the approved inventory")
    review = decode(review_raw)
    require(review.get("schema") == "fullmag.retained_result_archive_review_inventory.v1"
            and review.get("source_root") == str(host_root) and len(review.get("runs", [])) == count,
            "Readonly archive review source differs")
    if count == 5:
        require(sum(row.get("run_id") == PARENT_RUN_ID for row in review["runs"]) == 1,
                "Readonly archive fifth run is not the approved parent")
    runs = []
    for row in review["runs"]:
        require((re.fullmatch(r"run-[0-9a-f]{64}", row["run_id"]) or
                 (count == 5 and row["run_id"] == PARENT_RUN_ID))
                and re.fullmatch(r"project-[A-Za-z0-9_-]+", row["project_id"])
                and SHA.fullmatch(row["payload_fingerprint"]), "Readonly archive run identity is invalid")
        value = {key: row[key] for key in ("project_id", "run_id", "payload_fingerprint")}
        for member in ("run_intent", "run_catalog", "artifact_catalog"):
            record = row["records"][member + ".json"]
            require(set(record) == {"bytes", "sha256"} and SHA.fullmatch(record["sha256"])
                    and type(record["bytes"]) is int and 0 < record["bytes"] <= 16 * 1024 * 1024, "Readonly archive metadata pin is invalid")
            value[member] = {"sha256": record["sha256"], "byte_count": record["bytes"]}
        runs.append(value)
    require(len({row["run_id"] for row in runs}) == len(runs), "Readonly archive run identity is duplicated")
    return {"schema": "fullmag.readonly_result_archive.v1", "compose_project": project,
            "host_source_root": str(host_root), "guest_source_root": GUEST_ROOT,
            "writer_lock": {"sha256": sha(WRITER_BYTES), "byte_count": len(WRITER_BYTES)}, "runs": runs}


def verify_records(manifest):
    import fcntl
    root = Path(manifest["host_source_root"])
    source_identity(root)
    fd = os.open(root / "WRITER.lock", os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == len(WRITER_BYTES), "Readonly archive WRITER.lock differs")
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        require(os.read(fd, len(WRITER_BYTES) + 1) == WRITER_BYTES, "Readonly archive WRITER.lock descriptor differs")
        for row in manifest["runs"]:
            for name in ("run_intent", "run_catalog", "artifact_catalog"):
                raw = read_file(root / "runs" / row["run_id"] / (name + ".json"), 16 * 1024 * 1024)
                require(sha(raw) == row[name]["sha256"] and len(raw) == row[name]["byte_count"], "Readonly archive metadata changed")
        current = (root / "WRITER.lock").lstat()
        require((info.st_dev, info.st_ino) == (current.st_dev, current.st_ino), "Readonly archive writer lock was replaced")
    finally:
        os.close(fd)


def prepare(control, selected, layout, review_raw, *, publish=True):
    import fullmag_storage as storage
    from docker_volume_resume_protected import describe_archived_protected
    protected = describe_archived_protected(control)
    host_root = Path(protected["state_root"]) / "runs/docker-all/session-store"
    storage.validate_path(host_root, layout["storage_root"], "approved readonly result archive")
    identity = source_identity(host_root)
    manifest = manifest_from_review(review_raw, control.project, host_root)
    verify_records(manifest)
    manifest_raw = canonical(manifest) + b"\n"
    require(len(manifest_raw) <= MAX_MANIFEST_BYTES, "Readonly archive manifest exceeds 64 KiB")
    parent = "readonly-results/" + sha(manifest_raw)
    request = {"schema": "fullmag.readonly-result-archive-admission.v1", "source_root": str(selected),
        "compose_project": control.project, "protected_store": protected, "host_source_identity": identity,
        "review_sha256": sha(review_raw), "manifest_path": parent + "/manifest.json", "manifest_sha256": sha(manifest_raw)}
    request_raw = canonical(request) + b"\n"
    if not publish:
        return {"state": "readonly-result-archive-preview-passed", "request": parent + "/request.json",
                "request_sha256": sha(request_raw), "manifest_sha256": sha(manifest_raw)}
    for name, raw in (("review.json", review_raw), ("manifest.json", manifest_raw), ("request.json", request_raw)):
        relative = parent + "/" + name
        existing = control.read_bytes(relative, optional=True)
        require(existing is None or existing == raw, "Prepared readonly archive bytes already differ")
        if existing is None:
            control.write_bytes(relative, raw)
    return {"request": parent + "/request.json", "request_sha256": sha(request_raw), "manifest_sha256": sha(manifest_raw)}


def load_request(control, selected, pins):
    from docker_volume_resume_protected import describe_archived_protected
    path, expected = pins
    raw = control.read_bytes(path)
    require(sha(raw) == expected, "Readonly archive admission request changed")
    request = decode(raw)
    require(set(request) == {"schema", "source_root", "compose_project", "protected_store", "host_source_identity",
            "review_sha256", "manifest_path", "manifest_sha256"}
            and request["schema"] == "fullmag.readonly-result-archive-admission.v1"
            and request["source_root"] == str(selected) and request["compose_project"] == control.project
            and request["review_sha256"] in (REVIEW_SHA256, PARENT_REVIEW_SHA256),
            "Readonly archive admission belongs to another source or group")
    protected = describe_archived_protected(control)
    require(request["protected_store"] == protected, "Readonly archive frozen history changed")
    host_root = Path(protected["state_root"]) / "runs/docker-all/session-store"
    require(source_identity(host_root) == request["host_source_identity"], "Readonly archive host directory incarnation changed")
    parent = str(PurePosixPath(path).parent)
    manifest_raw = control.read_bytes(parent + "/manifest.json")
    require(request["manifest_path"] == parent + "/manifest.json" and sha(manifest_raw) == request["manifest_sha256"]
            and parent == "readonly-results/" + sha(manifest_raw), "Readonly archive manifest CAS differs")
    manifest = decode(manifest_raw)
    review_raw = control.read_bytes(parent + "/review.json")
    require(sha(review_raw) == request["review_sha256"], "Readonly archive review differs from its request pin")
    require(manifest == manifest_from_review(review_raw, control.project, host_root),
            "Readonly archive manifest differs from the approved review")
    verify_records(manifest)
    return request, manifest


def retained_options(args, document):
    requested = option_pins(getattr(args, "readonly_result_archive_request", None), getattr(args, "readonly_result_archive_request_sha256", None))
    descriptor = document.get("x-fullmag-readonly-result-archive")
    if descriptor is not None and requested is None:
        args.readonly_result_archive_request = descriptor["request_path"]
        args.readonly_result_archive_request_sha256 = descriptor["request_sha256"]
    return requested


def configure(document, control, selected, pins):
    if pins is None:
        return
    request, manifest = load_request(control, selected, pins)
    backend = document["services"]["backend"]
    require(not any(m.get("target", "").startswith((GUEST_ROOT, MANIFEST_ROOT)) for m in backend["volumes"]), "Readonly archive alias is already occupied")
    parent = str(PurePosixPath(request["manifest_path"]).parent)
    subpath = control.subpath(parent)
    require(document["volumes"]["build-control"]["name"] == control.volume, "Readonly archive manifest volume differs")
    backend["volumes"] += [
        {"type": "bind", "source": manifest["host_source_root"], "target": GUEST_ROOT, "read_only": True, "bind": {"create_host_path": False}},
        {"type": "volume", "source": "build-control", "target": MANIFEST_ROOT, "read_only": True, "volume": {"nocopy": True, "subpath": subpath}}]
    backend["environment"].update(dict(zip(ENV, (MANIFEST_ROOT + "/manifest.json", request["manifest_sha256"], control.project))))
    document["x-fullmag-readonly-result-archive"] = {"request_path": pins[0], "request_sha256": pins[1],
        "manifest_sha256": request["manifest_sha256"], "host_source_root": manifest["host_source_root"],
        "host_source_identity": request["host_source_identity"], "volume_subpath": subpath}
    validate_document(document)


def validate_document(document):
    descriptor = document.get("x-fullmag-readonly-result-archive")
    backend, frontend = (document.get("services", {}).get(name, {}) for name in ("backend", "frontend"))
    present = {name for name in ENV if name in backend.get("environment", {})}
    mounts = [m for m in backend.get("volumes", []) if m.get("target", "").startswith((GUEST_ROOT, MANIFEST_ROOT))]
    require(not any(name in frontend.get("environment", {}) for name in ENV)
            and not any(m.get("target", "").startswith((GUEST_ROOT, MANIFEST_ROOT)) for m in frontend.get("volumes", [])), "Readonly result archive must be backend-only")
    if descriptor is None:
        require(not present and not mounts, "Readonly result archive environment or mount has no admission")
        return None
    require(isinstance(descriptor, dict) and set(descriptor) == {"request_path", "request_sha256", "manifest_sha256", "host_source_root", "host_source_identity", "volume_subpath"}
            and present == set(ENV) and len(mounts) == 2, "Readonly result archive mapping is incomplete")
    option_pins(descriptor["request_path"], descriptor["request_sha256"])
    subpath = PurePosixPath(descriptor["volume_subpath"])
    require(SHA.fullmatch(descriptor["manifest_sha256"]) and not subpath.is_absolute()
            and ".." not in subpath.parts and str(subpath) == descriptor["volume_subpath"]
            and subpath.parts[-2:] == ("readonly-results", descriptor["manifest_sha256"]), "Readonly manifest subpath differs")
    expected_env = dict(zip(ENV, (MANIFEST_ROOT + "/manifest.json", descriptor["manifest_sha256"], document["name"])))
    require(all(backend["environment"][key] == value for key, value in expected_env.items()), "Readonly result archive environment differs")
    source = [m for m in mounts if m.get("target") == GUEST_ROOT]
    config = [m for m in mounts if m.get("target") == MANIFEST_ROOT]
    require(len(source) == len(config) == 1 and source[0] == {"type": "bind", "source": descriptor["host_source_root"], "target": GUEST_ROOT,
            "read_only": True, "bind": {"create_host_path": False}}
            and config[0] == {"type": "volume", "source": "build-control", "target": MANIFEST_ROOT, "read_only": True,
                "volume": {"nocopy": True, "subpath": descriptor["volume_subpath"]}}, "Readonly result archive mount boundary differs")
    return descriptor


def validate_container(document, actual):
    descriptor = validate_document(document)
    if descriptor is None:
        return
    require(source_identity(Path(descriptor["host_source_root"])) == descriptor["host_source_identity"],
            "Readonly result archive host incarnation changed")
    from docker_backend_volume_cache import _observed_volume_subpath
    from run_managed_browser import host_path
    roots = {GUEST_ROOT, MANIFEST_ROOT}
    mounts = [m for m in actual.get("Mounts", []) if any(m.get("Destination") == root or m.get("Destination", "").startswith(root + "/") for root in roots)]
    require(len(mounts) == 2 and {m.get("Destination") for m in mounts} == roots
            and all(m.get("RW") is False for m in mounts), "Readonly result archive has writable, nested or missing Engine mounts")
    source = next(m for m in mounts if m["Destination"] == GUEST_ROOT)
    config = next(m for m in mounts if m["Destination"] == MANIFEST_ROOT)
    pinned = document["services"]["backend"].get("x-fullmag-daemon-binds", {}).get(GUEST_ROOT)
    require(source.get("Type") == "bind" and (source.get("Source") == pinned if pinned is not None else
            host_path(source.get("Source")) == Path(descriptor["host_source_root"]).resolve()), "Readonly result archive Engine source differs")
    name = document["volumes"]["build-control"]["name"]
    observed = json.loads(docker_capture("volume", "inspect", name).stdout)
    require(len(observed) == 1 and observed[0].get("Name") == name and config.get("Type") == "volume", "Readonly manifest Engine volume differs")
    require(_observed_volume_subpath(actual, config, MANIFEST_ROOT, name, observed[0]["Mountpoint"]) == descriptor["volume_subpath"], "Readonly manifest Engine subpath differs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--review-sha256", required=True)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    from docker_dev import _select_source, _compose_identity
    from docker_build_control import toolchain_configuration
    selected, layout = _select_source(args.source_root, args.source_root)
    identity = _compose_identity(layout)
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    require(args.review_sha256 in (REVIEW_SHA256, PARENT_REVIEW_SHA256),
            "Only the explicitly approved readonly result review is admitted")
    review = read_file(args.review, MAX_MANIFEST_BYTES)
    require(sha(review) == args.review_sha256, "Readonly archive review differs from the explicit input pin")
    print(json.dumps(prepare(control, selected, layout, review, publish=not args.preview)))


if __name__ == "__main__":
    main()
