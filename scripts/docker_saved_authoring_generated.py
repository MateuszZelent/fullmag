"""Pinned generated UI source for saved-authoring restart, not recovery."""
import hashlib
import inspect
import os
from pathlib import PurePosixPath
import pathlib
import re
import stat

from docker_build_control import BuildControlError

SCHEMA = "fullmag.saved-generated-authoring-restart.v1"
SCHEMA_V2 = "fullmag.saved-generated-authoring-restart.v2"
GENERATED_SOURCE_MAX_BYTES = 8 * 1024 * 1024


def require(value, message):
    if not value:
        raise BuildControlError("Generated authoring restart: " + message)


def service_owner_field(request):
    return ("service_owner_identity_sha256" if request.get("schema") == SCHEMA_V2
            else "service_owner_sha256")


def service_owner_digest(request, owner, canonical):
    if request.get("schema") == SCHEMA_V2:
        require(isinstance(owner, dict) and
                isinstance(owner.get("heartbeat_at"), str) and owner["heartbeat_at"],
                "stable owner requires the native heartbeat observation")
        owner = {key: value for key, value in owner.items() if key != "heartbeat_at"}
    return hashlib.sha256(canonical(owner)).hexdigest()


def validate_checkpoint(request):
    enabled = request.get("schema") in (SCHEMA, SCHEMA_V2)
    require(("generated_source" in request) == enabled, "schema/source pins differ")
    if not enabled:
        return None
    require(not any(k in request for k in ("cancelled_preclaim", "historical_preclaim")),
            "generated authoring cannot mix preclaim recovery")
    pin = request["generated_source"]
    require(isinstance(pin, dict) and set(pin) == {"path", "sha256", "bytes", "archive_entry"},
            "source pin fields differ")
    path = pin["path"]
    require(isinstance(path, str) and len(path) < 4096 and
            PurePosixPath(path).is_absolute() and str(PurePosixPath(path)) == path and
            ".." not in PurePosixPath(path).parts and "\\" not in path and
            PurePosixPath(path).name == "scene_document.py", "invalid generated source path")
    require(isinstance(pin["sha256"], str) and re.fullmatch("[0-9a-f]{64}", pin["sha256"])
            and type(pin["bytes"]) is int and 0 < pin["bytes"] <= GENERATED_SOURCE_MAX_BYTES,
            "invalid generated source digest/size")
    require(pin["archive_entry"] in ("project/source.py", "project/source/script.py"),
            "invalid generated source archive entry")
    return pin


def validate_archive(archive, manifest, pin):
    require(manifest.get("source") == pin["archive_entry"], "archive source binding differs")
    raw = archive.read(pin["archive_entry"])
    require(len(raw) == pin["bytes"] and hashlib.sha256(raw).hexdigest() == pin["sha256"],
            "archived generated source bytes differ")


def validate_probe(probe, request):
    pin = validate_checkpoint(request)
    if pin is None:
        require("generated_source" not in probe, "legacy probe cannot include generated source")
        return
    source = probe.get("generated_source")
    require(isinstance(source, dict) and set(source) == {"before", "after"} and
            source["before"] == source["after"], "generated source changed during preflight")
    observed = source["before"]
    require(isinstance(observed, dict) and set(observed) ==
            {"path", "sha256", "bytes", "workspace_root", "device", "inode", "mtime_ns", "ctime_ns"},
            "generated source observation fields differ")
    require(all(observed[k] == pin[k] for k in ("path", "bytes", "sha256")) and
            isinstance(observed["workspace_root"], str) and
            str(PurePosixPath(observed["workspace_root"]) / "scene_document.py") == pin["path"] and
            all(type(observed[k]) is int and observed[k] >= 0
                for k in ("device", "inode", "mtime_ns", "ctime_ns")),
            "generated source observation pins differ")
    script = {"origin": "generated", "writable": True, "path": pin["path"]}
    for suffix in ("before", "after"):
        current = probe["resources"]["current_" + suffix]["body"]
        session = probe["resources"]["status_" + suffix]["body"]["session"]
        require(current.get("script_path") == pin["path"] and
                current.get("script") == {**script, "sha256": pin["sha256"]} and
                session.get("script") == script and
                session.get("workspace_root") == observed["workspace_root"],
                "generated source API metadata differs")


def observe_generated_source(pin, workspace):
    """Read a bounded regular source; never execute or import its contents."""
    workspace = pathlib.Path(workspace)
    path = workspace / "scene_document.py"
    if not workspace.is_absolute() or str(path) != pin["path"]:
        raise RuntimeError("generated source is not the canonical workspace artifact")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise RuntimeError("generated source path contains a symlink")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                not 0 < before.st_size <= GENERATED_SOURCE_MAX_BYTES):
            raise RuntimeError("generated source is not a bounded unlinked regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(GENERATED_SOURCE_MAX_BYTES + 1)
        after = os.fstat(fd)
        current = path.stat(follow_symlinks=False)
        def identity(value):
            return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if (identity(before) != identity(after) or identity(after) != identity(current) or
                current.st_nlink != 1 or any(p.is_symlink() for p in path.parents) or
                len(raw) != pin["bytes"] or hashlib.sha256(raw).hexdigest() != pin["sha256"]):
            raise RuntimeError("generated source identity/bytes changed")
        return {"path": str(path), "workspace_root": str(workspace), "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(), "device": after.st_dev,
                "inode": after.st_ino, "mtime_ns": after.st_mtime_ns, "ctime_ns": after.st_ctime_ns}
    finally:
        os.close(fd)


PROBE_FUNCTION = ("import hashlib,os,pathlib,stat\n"
                  + "GENERATED_SOURCE_MAX_BYTES=" + repr(GENERATED_SOURCE_MAX_BYTES) + "\n"
                  + inspect.getsource(observe_generated_source))
