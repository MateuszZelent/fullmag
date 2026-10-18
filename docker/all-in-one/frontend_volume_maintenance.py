"""One-shot, fixed-path ownership probe for frontend named-volume initialization."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path("/frontend")
MARKER_NAME = ".fullmag-frontend-development-owner.json"
SCHEMA = "fullmag.frontend-development-volume.v1"
OWNER_SCHEMA = "fullmag.frontend-development-owner.v1"
ROLE = "frontend-development"
UID = 65532
GID = 65532
ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
NONCE = re.compile(r"^[0-9a-f]{32}$")
DIRS = (
    "workspace",
    "workspace/apps",
    "workspace/apps/control-room",
    "workspace/apps/control-room/app",
    "workspace/apps/control-room/src",
    "workspace/apps/control-room/public",
    "workspace/apps/control-room/scripts",
    "cache",
    "pnpm-store",
    "pnpm-home",
    "corepack",
    "home",
    "tmp",
    "frozen-inputs",
)


class Error(RuntimeError):
    pass


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _identity():
    values = {
        "schema": os.environ.get("FULLMAG_FRONTEND_VOLUME_SCHEMA"),
        "owner_schema": os.environ.get("FULLMAG_FRONTEND_VOLUME_OWNER_SCHEMA"),
        "project_id": os.environ.get("FULLMAG_FRONTEND_VOLUME_PROJECT_ID"),
        "worktree_id": os.environ.get("FULLMAG_FRONTEND_VOLUME_WORKTREE_ID"),
        "toolchain_image_id": os.environ.get("FULLMAG_FRONTEND_VOLUME_TOOLCHAIN_IMAGE_ID"),
        "profile": os.environ.get("FULLMAG_FRONTEND_VOLUME_PROFILE"),
        "role": os.environ.get("FULLMAG_FRONTEND_VOLUME_ROLE"),
        "owner_id": os.environ.get("FULLMAG_FRONTEND_VOLUME_OWNER_ID"),
        "creation_id": os.environ.get("FULLMAG_FRONTEND_VOLUME_CREATION_ID"),
        "volume_name": os.environ.get("FULLMAG_FRONTEND_VOLUME_NAME"),
    }
    if values["schema"] != SCHEMA or values["owner_schema"] != OWNER_SCHEMA:
        raise Error("unsupported frontend volume schema")
    if values["role"] != ROLE or values["profile"] != "dev":
        raise Error("unsupported frontend volume role/profile")
    if not ID.fullmatch(values["project_id"] or "") or not ID.fullmatch(values["worktree_id"] or ""):
        raise Error("invalid project/worktree identity")
    if not IMAGE.fullmatch(values["toolchain_image_id"] or ""):
        raise Error("invalid immutable toolchain identity")
    if not NONCE.fullmatch(values["creation_id"] or ""):
        raise Error("invalid creation identity")
    seed = {
        "schema": SCHEMA,
        "project_id": values["project_id"],
        "worktree_id": values["worktree_id"],
        "toolchain_image_id": values["toolchain_image_id"],
        "profile": values["profile"],
        "role": values["role"],
    }
    owner = hashlib.sha256(_canonical(seed)).hexdigest()
    if values["owner_id"] != owner or values["volume_name"] != "fullmag-frontend-dev-v1-" + owner[:32]:
        raise Error("owner/volume identity is not canonical")
    return {
        "schema": OWNER_SCHEMA,
        "volume_schema": SCHEMA,
        **{key: value for key, value in seed.items() if key != "schema"},
        "owner_id": owner,
        "creation_id": values["creation_id"],
        "volume_name": values["volume_name"],
        "uid": UID,
        "gid": GID,
    }


def _read_marker():
    path = ROOT / MARKER_NAME
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise Error("frontend owner marker is not a regular file")
    if (info.st_uid, info.st_gid) != (UID, GID) or stat.S_IMODE(info.st_mode) != 0o660:
        raise Error("frontend owner marker ownership/mode is invalid")
    if info.st_size > 16384:
        raise Error("frontend owner marker exceeds its size bound")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
            or (opened.st_uid, opened.st_gid) != (UID, GID)
            or stat.S_IMODE(opened.st_mode) != 0o660
            or opened.st_size > 16384
        ):
            raise Error("frontend owner marker changed while opening")
        raw = os.read(fd, 16385)
    finally:
        os.close(fd)
    if len(raw) > 16384:
        raise Error("frontend owner marker exceeds its size bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise Error("frontend owner marker contains duplicate keys")
            result[key] = value
        return result
    try:
        document = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, ValueError) as error:
        raise Error("frontend owner marker is invalid JSON") from error
    return document


def _verify(expected):
    if os.geteuid() != UID or os.getegid() != GID:
        raise Error("verification must run as UID/GID 65532")
    root_info = ROOT.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise Error("frontend volume root is not a real directory")
    if (root_info.st_uid, root_info.st_gid) != (UID, GID):
        raise Error("frontend volume root ownership is invalid")
    if stat.S_IMODE(root_info.st_mode) != 0o770:
        raise Error("frontend volume root mode is invalid")
    if _read_marker() != expected:
        raise Error("frontend owner marker does not match this volume identity")
    for relative in DIRS:
        path = ROOT.joinpath(*relative.split("/"))
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise Error("frontend volume layout is missing a fixed directory")
        if (info.st_uid, info.st_gid) != (UID, GID) or stat.S_IMODE(info.st_mode) != 0o770:
            raise Error("frontend fixed directory ownership/mode is invalid")
    return {
        "verified": True,
        "owner_id": expected["owner_id"],
        "volume_name": expected["volume_name"],
        "creation_id": expected["creation_id"],
        "role": ROLE,
        "uid": UID,
        "gid": GID,
    }


def _initialize(expected):
    if os.geteuid() != 0 or os.getegid() != 0:
        raise Error("initialization must run as root")
    if os.environ.get("FULLMAG_FRONTEND_VOLUME_UID") != str(UID) or os.environ.get("FULLMAG_FRONTEND_VOLUME_GID") != str(GID):
        raise Error("fixed frontend owner UID/GID are invalid")
    root_info = ROOT.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise Error("new frontend volume root is not a real directory")
    if os.listdir(ROOT):
        raise Error("new frontend volume is not empty; refusing adoption")
    for relative in DIRS:
        path = ROOT.joinpath(*relative.split("/"))
        path.mkdir(exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise Error("fixed frontend layout path is not a real directory")
    marker_path = ROOT / MARKER_NAME
    fd = os.open(marker_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o660)
    try:
        data = _canonical(expected) + b"\n"
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise Error("short owner marker write")
            view = view[count:]
        os.fchmod(fd, 0o660)
        os.fchown(fd, UID, GID)
        os.fsync(fd)
    finally:
        os.close(fd)
    # Set modes while root still owns each directory; then transfer ownership.
    for relative in reversed(DIRS):
        fd = os.open(ROOT.joinpath(*relative.split("/")), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fchmod(fd, 0o770)
            os.fchown(fd, UID, GID)
            os.fsync(fd)
        finally:
            os.close(fd)
    root_fd = os.open(ROOT, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fchmod(root_fd, 0o770)
        os.fchown(root_fd, UID, GID)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)
    return {
        "verified": True,
        "owner_id": expected["owner_id"],
        "volume_name": expected["volume_name"],
        "creation_id": expected["creation_id"],
        "role": ROLE,
        "uid": UID,
        "gid": GID,
    }


def main(argv):
    if len(argv) != 2 or argv[1] not in {"initialize", "verify"}:
        raise Error("expected the fixed initialize or verify operation")
    expected = _identity()
    if os.environ.get("FULLMAG_FRONTEND_VOLUME_OPERATION") != argv[1]:
        raise Error("operation argument differs from its fixed environment")
    result = _initialize(expected) if argv[1] == "initialize" else _verify(expected)
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as error:
        sys.stderr.write(f"frontend volume maintenance failed: {error}\n")
        raise SystemExit(2)
