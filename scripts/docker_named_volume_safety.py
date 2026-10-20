"""Fail-closed validation for Docker local named-volume backing."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any, Mapping


class DockerNamedVolumeSafetyError(ValueError):
    """A named volume does not have ordinary Docker-managed backing."""


def validate_local_named_volume(
    document: Mapping[str, Any], expected_name: str
) -> str:
    """Validate the backing identity of one local named volume.

    Docker's local driver accepts mount options that can redirect a named
    volume to a host directory. Callers must validate this inspect record
    before trusting the volume's labels or writing build data into it.
    """

    if document.get("Name") != expected_name:
        raise DockerNamedVolumeSafetyError("Docker volume identity changed")
    if document.get("Driver") != "local":
        raise DockerNamedVolumeSafetyError("Docker named volume must use the local driver")
    options = document.get("Options")
    if options not in (None, {}):
        raise DockerNamedVolumeSafetyError(
            "Docker local named volume must not have driver options"
        )
    if document.get("Scope") not in (None, "local"):
        raise DockerNamedVolumeSafetyError("Docker named volume is not local scope")

    return validate_linux_volume_mountpoint(document.get("Mountpoint"))


def validate_linux_volume_mountpoint(mountpoint_value: Any) -> str:
    """Admit a Docker-managed Linux mountpoint without Windows path aliases."""

    if (
        not isinstance(mountpoint_value, str)
        or not mountpoint_value.startswith("/")
        or "\\" in mountpoint_value
    ):
        raise DockerNamedVolumeSafetyError(
            "Docker named volume has no canonical Linux mountpoint"
        )
    mountpoint = PurePosixPath(mountpoint_value)
    if (
        mountpoint == PurePosixPath("/")
        or any(part in {"", ".", ".."} for part in mountpoint.parts[1:])
    ):
        raise DockerNamedVolumeSafetyError("Docker named volume mountpoint is unsafe")

    lowered = mountpoint_value.lower()
    if (
        "/run/desktop/mnt/host" in lowered
        or re.search(r"/mnt/[a-z](?:/|$)", lowered)
        or "/host_mnt/" in lowered
    ):
        raise DockerNamedVolumeSafetyError(
            "Docker named volume resolves through a Windows host bind"
        )
    return str(mountpoint)
