"""Failure-only reconciliation of one canceled, retained toolchain operation."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

from docker_build_control import (BuildControl, BuildControlError, LABEL_SCHEMA, bounded_capture,
    canonical, docker_capture, toolchain_configuration)
from docker_volume_activation_reconcile import (_validate_helper, _validate_helper_logged,
    _probe_helper_absence)
from docker_volume_reconcile import (commit_script, digest, fingerprint, read_raw,
    require, write_immutable, TOOLCHAIN_CANCELED_SCHEMA as SCHEMA)

TOKEN = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
REF = re.compile(r"[a-z0-9]{20,64}\Z")
MAX_RECORDS = 4096
RFC3339_TIMESTAMP = re.compile(
    r"^(?P<whole>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r"(?:\.(?P<fraction>\d+))?(?P<offset>Z|[+-]\d{2}:\d{2})$"
)
LEGACY_BUILDKIT_VERSION = "v0.32.2"
QUALIFIED_BUILDKIT_VERSION = "v0.34.2"
QUALIFIED_BUILDX_VERSION = re.compile(r"(?:^|\s)v0\.38\.1(?:-desktop(?:\.\d+)?)?(?:\s|$)")
DOCKER_DESKTOP_SETTINGS = Path(
    "/mnt/c/ProgramData/DockerDesktop/install-settings.json"
)
WINDOWS_POWERSHELL = Path(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
)
WINDOWS_DOCKER = Path(
    "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
)
WINDOWS_DOCKER_EXECUTABLE = r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"
WINDOWS_CONTEXT_ENDPOINTS = {
    "default": "npipe:////./pipe/docker_engine",
    "desktop-linux": "npipe:////./pipe/dockerDesktopLinuxEngine",
    "desktop-windows": "npipe:////./pipe/dockerDesktopWindowsEngine",
}
WSL_CONTEXT_ENDPOINTS = {
    "default": "unix:///var/run/docker.sock",
    "desktop-linux": "npipe:////./pipe/dockerDesktopLinuxEngine",
    "desktop-windows": "npipe:////./pipe/dockerDesktopWindowsEngine",
}


def pairs(rows, label):
    require(isinstance(rows, list) and all(isinstance(x, dict) for x in rows),
            label + " must be explicit")
    require(all(set(x) == {"Name", "Value"} and isinstance(x["Name"], str)
                and isinstance(x["Value"], str) for x in rows), label + " is malformed")
    result = {x["Name"]: x["Value"] for x in rows}
    require(len(result) == len(rows), label + " contains duplicate names")
    return result


def timestamp(value):
    require(isinstance(value, str), "BuildKit timestamp is absent")
    match = RFC3339_TIMESTAMP.fullmatch(value)
    if match is None:
        raise BuildControlError("BuildKit timestamp is invalid")
    offset = "+00:00" if match["offset"] == "Z" else match["offset"]
    try:
        result = datetime.fromisoformat(match["whole"] + offset)
        require(result.utcoffset() is not None, "BuildKit timestamp lacks a timezone")
        utc = result.astimezone(timezone.utc)
        whole_seconds = (utc - datetime(1970, 1, 1, tzinfo=timezone.utc)).days * 86400
        whole_seconds += utc.hour * 3600 + utc.minute * 60 + utc.second
        fraction = match["fraction"] or ""
        require(len(fraction) <= 9, "BuildKit timestamp precision exceeds nanoseconds")
        fractional_seconds = Decimal(fraction).scaleb(-len(fraction)) if fraction else Decimal(0)
        return Decimal(whole_seconds) + fractional_seconds
    except (InvalidOperation, ValueError) as error:
        raise BuildControlError("BuildKit timestamp is invalid") from error


def build_record(document):
    require(isinstance(document, dict), "BuildKit inspect is not an object")
    result = {key: document.get(key) for key in
              ("Ref", "Dockerfile", "VCSRepository", "VCSRevision", "Target", "Status")}
    result["Dockerfile"] = str(result["Dockerfile"]).replace("\\", "/")
    # Keep the compact record and digest byte-compatible with the original
    # datetime.fromisoformat(...).timestamp() behavior, which truncates RFC3339
    # fractions beyond microseconds. `history` still uses Decimal timestamps
    # for exact nanosecond window admission before producing this record.
    result["StartedAt"] = legacy_compact_timestamp(document.get("StartedAt"))
    result["CompletedAt"] = legacy_compact_timestamp(document.get("CompletedAt"))
    result["BuildArgs"] = pairs(document.get("BuildArgs"), "BuildKit build arguments")
    result["Labels"] = pairs(document.get("Labels"), "BuildKit labels")
    error = document.get("Error")
    require(isinstance(error, dict), "Canceled build lacks its native error")
    # Stack embeds the observing CLI process and changes on every inspect.
    result["Error"] = {key: error.get(key) for key in ("Code", "Message")}
    return result


def legacy_compact_timestamp(value):
    require(isinstance(value, str), "BuildKit timestamp is absent")
    match = RFC3339_TIMESTAMP.fullmatch(value)
    require(match is not None, "BuildKit timestamp is invalid")
    # Compact receipt timestamps have historically been serialized at
    # datetime's microsecond precision. The pinned WSL Python rejects longer
    # fractions, so explicitly truncate nanoseconds to preserve that digest
    # contract while allowing the observation path to retain Decimal precision.
    fraction = (match["fraction"] or "")[:6]
    offset = "+00:00" if match["offset"] == "Z" else match["offset"]
    compact = match["whole"] + ("." + fraction if fraction else "") + offset
    try:
        result = datetime.fromisoformat(compact)
        require(result.utcoffset() is not None, "BuildKit timestamp lacks a timezone")
        return result.timestamp()
    except ValueError as error:
        raise BuildControlError("BuildKit timestamp is invalid") from error


def validate_record(record, request, original, document):
    build = document["services"]["fem-gpu-toolchain"]["build"]
    require(record["Ref"] == request["build_ref"], "Operator-pinned BuildKit ref differs")
    require(record["Status"] == "canceled"
            and record["Error"] == {"Code": 1, "Message": "context canceled"},
            "Only an explicitly canceled BuildKit record is admissible")
    require(record["Labels"].get("com.docker.compose.project") == original["compose_project"]
            and record["Labels"].get("com.docker.compose.service") == "fem-gpu-toolchain",
            "BuildKit project/service differs")
    require(record["Dockerfile"] == build["dockerfile"] == "docker/fem-gpu/Dockerfile"
            and record["Target"] == build["target"] == original["inputs"]["target"] == "fem-gpu-dev",
            "BuildKit target/Dockerfile differs")
    require(record["BuildArgs"] == build["args"] == original["inputs"]["build_args"],
            "BuildKit arguments differ")
    require(record["VCSRevision"] == request["source_revision"]
            and record["VCSRepository"] == request["source_repository"],
            "BuildKit VCS identity differs")
    started_at = Decimal(str(record["StartedAt"]))
    original_started_at = Decimal(str(original["started_at"]))
    if _is_qualified_desktop_profile(request):
        # `history` compares the unrounded nanosecond RFC3339 value strictly
        # against floor(start)-1. The persisted compact record uses float
        # seconds, so a valid nanosecond above that bound can round to it.
        start_in_window = Decimal(math.floor(original["started_at"]) - 1) <= started_at
    else:
        start_in_window = original_started_at <= started_at
    require(start_in_window and started_at <= original_started_at + 300
            and record["CompletedAt"] >= record["StartedAt"],
            "BuildKit operation is outside the admitted time window")
    require(digest(canonical(record)) == request["build_record_sha256"],
            "Pinned terminal BuildKit record changed")


def json_lines(output):
    stripped = output.strip()
    if not stripped:
        rows = []
    else:
        try:
            parsed = json.loads(stripped)
        except (TypeError, ValueError):
            rows = [json.loads(line) for line in output.splitlines() if line.strip()]
        else:
            rows = parsed if isinstance(parsed, list) else [parsed]
    require(len(rows) <= MAX_RECORDS and all(isinstance(row, dict) for row in rows),
            "BuildKit record enumeration exceeded its bound")
    return rows


def observer_capture(request, *args):
    observer = request["buildkit_observer"]
    if observer.get("kind") == "native":
        return docker_capture(*args)
    require(observer.get("kind") == "windows-docker-desktop"
            and observer.get("context") == "desktop-linux", "Unsupported BuildKit observer")
    executable = Path(observer.get("executable", ""))
    require(executable.is_absolute() and executable.name.lower() == "docker.exe"
            and executable.is_file() and executable.resolve(strict=True) == executable,
            "BuildKit observer executable is not the exact Docker CLI")
    output = bounded_capture([str(executable), "--context", observer["context"], *args],
                             data=b"", timeout=90)
    require(output.returncode == 0, "Read-only BuildKit observer failed: "
            + output.stderr.decode("utf-8", "replace")[-1024:])
    return output


def _require_pinned_file(path_value, sha256, label, *, expected_path=None):
    require(isinstance(path_value, str) and path_value, label + " path is absent")
    path = Path(path_value)
    require(path.is_absolute() and path.is_file()
            and path.resolve(strict=True) == path,
            label + " path is not a canonical regular file")
    if expected_path is not None:
        require(path == expected_path, label + " path differs from the qualified installation")
    require(SHA.fullmatch(sha256 or "") and digest(path.read_bytes()) == sha256,
            label + " executable/content changed")
    return path


def _windows_executable_capture(path, args, *, sha256, python_path, python_sha256,
                                verified=False, timeout=90, maximum=None):
    """Run one pinned PE executable; use WSL's /init bridge only for ENOEXEC."""
    if verified:
        executable = Path(path)
        require(executable.is_absolute() and executable.is_file()
                and executable.resolve(strict=True) == executable,
                "Previously pinned Windows observer path changed")
    else:
        executable = _require_pinned_file(str(path), sha256, "Windows observer")
    limits = {} if maximum is None else {"maximum": maximum}
    command = [str(executable), *args]
    try:
        return bounded_capture(command, data=b"", timeout=timeout, **limits)
    except OSError as error:
        if error.errno != errno.ENOEXEC:
            raise

    init = Path("/init")
    require(init.is_file() and os.access(init, os.X_OK)
            and init.resolve(strict=True) == init,
            "WSL /init executable bridge is unavailable or changed")
    interpreter = _require_pinned_file(
        python_path, python_sha256, "WSL observer interpreter"
    )
    # Popen cannot pass executable='/init' through bounded_capture. A fixed
    # Python trampoline replaces itself with that exact interpreter and argv;
    # it does not invoke a shell or reinterpret any user supplied string.
    trampoline = "import os, sys; os.execv('/init', sys.argv[1:])"
    bridge_argv = [str(interpreter), "-B", "-c", trampoline,
                   str(executable), str(executable), executable.name, *args]
    return bounded_capture(bridge_argv, data=b"", timeout=timeout, **limits)


def windows_desktop_capture(request, *args, context="desktop-linux", allow_failure=False,
                            timeout=90, maximum=None, _verified=False):
    profile = request.get("windows_desktop_observer")
    require(isinstance(profile, dict), "Pinned Windows Docker Desktop observer is absent")
    executable = (Path(profile.get("executable", "")) if _verified else _require_pinned_file(
        profile.get("executable"), profile.get("sha256"), "Windows Docker CLI",
        expected_path=WINDOWS_DOCKER,
    ))
    require(executable == WINDOWS_DOCKER, "Windows Docker CLI path differs from the qualified install")
    docker_args = (["--context", context] if context is not None else [])
    output = _windows_executable_capture(
        executable, [*docker_args, *args],
        sha256=profile["sha256"], python_path=profile["python_executable"],
        python_sha256=profile["python_sha256"], verified=_verified,
        timeout=timeout, maximum=maximum,
    )
    if output.returncode and not allow_failure:
        require(False, "Pinned Windows Docker observer failed: "
                + output.stderr.decode("utf-8", "replace")[-1024:])
    return output


def windows_powershell_capture(request, script, *, timeout=60, maximum=8 * 1024 * 1024,
                               _verified=False):
    profile = request.get("windows_desktop_observer")
    require(isinstance(profile, dict), "Pinned Windows PowerShell observer is absent")
    executable = (Path(profile.get("powershell_executable", "")) if _verified else _require_pinned_file(
        profile.get("powershell_executable"), profile.get("powershell_sha256"),
        "Windows PowerShell", expected_path=WINDOWS_POWERSHELL,
    ))
    require(executable == WINDOWS_POWERSHELL,
            "Windows PowerShell path differs from the qualified install")
    output = _windows_executable_capture(
        executable, ["-NoProfile", "-NonInteractive", "-Command", script],
        sha256=profile["powershell_sha256"],
        python_path=profile["python_executable"],
        python_sha256=profile["python_sha256"], verified=_verified,
        timeout=timeout, maximum=maximum,
    )
    require(output.returncode == 0, "Authenticated Windows CIM observer failed")
    return output


def _windows_path_to_linux(path_value):
    require(isinstance(path_value, str) and path_value, "Windows plugin path is absent")
    if path_value.startswith("/mnt/"):
        path = Path(path_value)
    else:
        match = re.fullmatch(r"([A-Za-z]):\\(.+)", path_value)
        require(match is not None, "Windows plugin path is not a drive-qualified absolute path")
        drive, tail = match.groups()
        path = Path("/mnt") / drive.lower() / Path(*tail.split("\\"))
    require(path.is_absolute() and ".." not in path.parts,
            "Windows plugin path is not a safe absolute path")
    return path


def _plugin_inventory(raw, label):
    try:
        plugins = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise BuildControlError(label + " plugin inventory is invalid JSON") from error
    require(isinstance(plugins, list) and all(isinstance(plugin, dict) for plugin in plugins),
            label + " plugin inventory is incomplete")
    result = []
    names = set()
    for plugin in plugins:
        require(isinstance(plugin.get("Name"), str) and plugin["Name"]
                and isinstance(plugin.get("Version"), str) and plugin["Version"]
                and isinstance(plugin.get("Path"), str) and plugin["Path"],
                label + " plugin metadata is incomplete")
        require(plugin["Name"] not in names, label + " plugin inventory has duplicate names")
        names.add(plugin["Name"])
        result.append({key: plugin[key] for key in ("Name", "Version", "Path")})
    return sorted(result, key=lambda plugin: plugin["Name"])


def _validate_plugin_files(inventory, expected, *, windows, label, hash_names=None):
    expected_public = sorted(
        [{key: item[key] for key in ("Name", "Version", "Path")} for item in expected],
        key=lambda item: item["Name"],
    )
    expected_names = {item["Name"] for item in expected}
    require(inventory == expected_public and len(expected_public) == len(expected_names),
            label + " effective CLI plugin inventory changed")
    selected_names = expected_names if hash_names is None else set(hash_names)
    require(selected_names <= expected_names,
            label + " executable hash selection is not present in the pinned inventory")
    for plugin in inventory:
        if plugin["Name"] not in selected_names:
            continue
        expected_plugin = next(item for item in expected if item["Name"] == plugin["Name"])
        path = _windows_path_to_linux(plugin["Path"]) if windows else Path(plugin["Path"])
        require(path.is_absolute() and ".." not in path.parts and path.resolve(strict=True).is_file(),
                label + " plugin executable path is not a readable file")
        require(SHA.fullmatch(expected_plugin.get("sha256", ""))
                and digest(path.resolve(strict=True).read_bytes()) == expected_plugin["sha256"],
                label + " plugin executable changed")


def validate_observer(request):
    observer = request["buildkit_observer"]
    native_engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    require(native_engine == request["engine_id"], "Linux control engine identity changed")
    if observer.get("kind") == "windows-docker-desktop":
        require(SHA.fullmatch(observer.get("sha256", ""))
                and digest(Path(observer["executable"]).read_bytes()) == observer["sha256"],
                "BuildKit observer executable changed")
        version = observer_capture(request, "version", "--format", "{{.Client.Version}}").stdout.decode().strip()
        require(version == observer.get("version") and version, "BuildKit observer version changed")
    else:
        require(observer == {"kind": "native"}, "Unknown native BuildKit observer options")
    observed_engine = observer_capture(request, "info", "--format", "{{.ID}}").stdout.decode().strip()
    require(observed_engine == native_engine, "BuildKit observer and Linux control use different engines")
    buildx_version = observer_capture(request, "buildx", "version").stdout.decode().strip()
    require(buildx_version and buildx_version == request.get("buildx_version"),
            "Buildx plugin version changed")


def _is_qualified_desktop_profile(request):
    return isinstance(request.get("windows_desktop_observer"), dict)


def _windows_context_inventory(request, *, _verified=False):
    rows = json_lines(windows_desktop_capture(
        request, "context", "ls", "--format", "json", _verified=_verified,
    ).stdout)
    expected = request["windows_desktop_observer"]["contexts"]
    require(rows == expected, "Windows Docker context inventory changed")
    require(len(rows) == 3 and {row.get("Name") for row in rows} == set(WINDOWS_CONTEXT_ENDPOINTS),
            "Windows Docker context inventory is not the exact Desktop profile")
    for row in rows:
        name = row["Name"]
        require(row.get("DockerEndpoint") == WINDOWS_CONTEXT_ENDPOINTS[name]
                and row.get("Error") == ""
                and row.get("Current") is (name == "desktop-linux"),
                "Windows Docker context endpoint/current selection differs")
        inspected = json.loads(windows_desktop_capture(
            request, "context", "inspect", name,
            "--format", "{{json .Endpoints.docker}}",
            _verified=_verified,
        ).stdout)
        require(inspected == {"Host": WINDOWS_CONTEXT_ENDPOINTS[name], "SkipTLSVerify": False}
                and inspected == request["windows_desktop_observer"]["context_inspects"][name],
                "Windows Docker context inspect differs from its exact endpoint")
    return rows


def _normalized_buildx_rows(rows):
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            "Buildx builder enumeration is incomplete")
    normalized = []
    for row in rows:
        require(isinstance(row.get("Name"), str) and row["Name"],
                "Buildx builder name is absent")
        nodes = row.get("Nodes")
        require(isinstance(nodes, list) and all(isinstance(node, dict) for node in nodes),
                "Buildx builder node inventory is incomplete")
        normalized.append({
            "Name": row["Name"],
            "Driver": row.get("Driver"),
            "Nodes": sorted([
                {key: node[key] for key in ("Name", "Endpoint", "IDs", "Version", "Status", "Flags")
                 if key in node}
                for node in nodes
            ], key=lambda node: (node.get("Name", ""), node.get("Endpoint", ""))),
            **({"Err": row["Err"]} if "Err" in row else {}),
        })
    return sorted(normalized, key=lambda row: row["Name"])


def _validate_native_integrated_builder_inventory(rows, request):
    inventory = _normalized_buildx_rows(rows)
    require(inventory == request["builders"], "Linux-origin Buildx inventory changed")
    by_name = {builder["Name"]: builder for builder in inventory}
    require(set(by_name) == {"default", "desktop-linux", "desktop-windows"},
            "Linux-origin client has an independent or shadow builder")
    builder = by_name["default"]
    require(builder["Driver"] == "docker" and len(builder["Nodes"]) == 1,
            "Linux-origin builder is not one integrated Docker worker")
    node = builder["Nodes"][0]
    require(node.get("Status") == "running" and node.get("Version") == QUALIFIED_BUILDKIT_VERSION
            and node.get("Endpoint") in {"default", "desktop-linux"}
            and node.get("Name") in {"default", "desktop-linux"}
            and node.get("IDs") == [request["engine_id"]],
            "Linux-origin BuildKit worker is not the exact running local engine")
    for alias_name in ("desktop-linux", "desktop-windows"):
        alias = by_name[alias_name]
        require(alias["Driver"] == "" and alias.get("Err") == "protocol not available"
                and alias["Nodes"] == [{"Name": "", "Endpoint": ""}],
                "Linux-origin context alias is real or ambiguous, not a proven synthetic placeholder")
    return builder


def _validate_windows_buildx_inventory(request, *, _verified=False):
    profile = request["windows_desktop_observer"]
    rows = json_lines(windows_desktop_capture(
        request, "buildx", "ls", "--format", "json", _verified=_verified,
    ).stdout)
    inventory = _normalized_buildx_rows(rows)
    require(inventory == profile["buildx_builders"],
            "Windows Buildx cross-provider inventory changed")
    by_name = {row["Name"]: row for row in inventory}
    require(set(by_name) == {"default", "desktop-linux", "desktop-windows", "fullmag-windows"},
            "Windows Buildx inventory contains an unknown builder or missing alias")
    engine_id = request["engine_id"]
    for name in ("default", "desktop-linux"):
        row = by_name[name]
        require(row["Driver"] == "docker" and len(row["Nodes"]) == 1,
                "Windows integrated builder alias is not a single Docker node")
        node = row["Nodes"][0]
        require(node.get("Name") == name and node.get("Endpoint") == name
                and node.get("IDs") == [engine_id] and node.get("Status") == "running"
                and node.get("Version") == QUALIFIED_BUILDKIT_VERSION,
                "Windows integrated alias differs from the Linux engine worker")
    windows_alias = by_name["desktop-windows"]
    require(windows_alias["Driver"] == "" and len(windows_alias["Nodes"]) == 1
            and windows_alias["Err"] and "dockerDesktopWindowsEngine/_ping" in windows_alias["Err"]
            and "context deadline exceeded" in windows_alias["Err"],
            "desktop-windows is not the exact unavailable synthetic alias")
    alias_node = windows_alias["Nodes"][0]
    require(alias_node == {"Name": "", "Endpoint": ""},
            "desktop-windows has a real or ambiguous BuildKit node")
    inactive = by_name["fullmag-windows"]
    require(inactive["Driver"] == "docker-container" and len(inactive["Nodes"]) == 1,
            "Windows-only auxiliary builder differs from its qualified inactive profile")
    inactive_node = inactive["Nodes"][0]
    require(inactive_node.get("Name") == "fullmag-windows0"
            and inactive_node.get("Endpoint") == "desktop-linux"
            and inactive_node.get("Status") == "inactive"
            and not inactive_node.get("IDs"),
            "Windows-only auxiliary builder may be active or has a real worker")
    container = "buildx_buildkit_fullmag-windows0"
    absent = windows_desktop_capture(
        request, "container", "inspect", container, allow_failure=True,
        _verified=_verified,
    )
    error_text = absent.stderr.decode("utf-8", "replace").strip()
    expected_absence = "Error response from daemon: No such container: " + container
    require(absent.returncode != 0 and absent.stdout.strip() in {b"", b"[]"}
            and error_text == expected_absence,
            "Windows-only inactive builder container exists or its absence is ambiguous")
    return inventory


def validate_windows_desktop_profile(request):
    profile = request.get("windows_desktop_observer")
    require(isinstance(profile, dict), "Pinned Windows Docker Desktop observer is absent")
    _require_pinned_file(profile.get("executable"), profile.get("sha256"),
                         "Windows Docker CLI", expected_path=WINDOWS_DOCKER)
    _require_pinned_file(profile.get("powershell_executable"), profile.get("powershell_sha256"),
                         "Windows PowerShell", expected_path=WINDOWS_POWERSHELL)
    _require_pinned_file(profile.get("settings_path"), profile.get("settings_sha256"),
                         "Docker Desktop install settings", expected_path=DOCKER_DESKTOP_SETTINGS)
    _require_pinned_file(profile.get("python_executable"), profile.get("python_sha256"),
                         "WSL observer interpreter")
    current_interpreter = Path(sys.executable).resolve(strict=True)
    require(Path(profile["python_executable"]) == current_interpreter,
            "WSL observer interpreter differs from the running pinned Python")
    try:
        settings = json.loads(DOCKER_DESKTOP_SETTINGS.read_bytes())
    except (OSError, ValueError) as error:
        raise BuildControlError("Docker Desktop install settings are invalid") from error
    require(isinstance(settings, dict) and settings.get("noWindowsContainers") is True,
            "Docker Desktop is not explicitly configured for Linux containers only")

    version = windows_desktop_capture(request, "version", "--format", "{{.Client.Version}}",
                                      _verified=True).stdout.decode().strip()
    require(version == profile["version"], "Pinned Windows Docker CLI version changed")
    require(_windows_context_inventory(request, _verified=True) == profile["contexts"],
            "Windows context inventory changed")

    engine_rows = json_lines(windows_desktop_capture(
        request, "desktop", "engine", "ls", "--format", "json", _verified=True,
    ).stdout)
    require(engine_rows == profile["desktop_engines"]
            and engine_rows == [{"Name": "linux", "Description": "Linux engine", "Current": True}],
            "Docker Desktop does not affirmatively expose only the selected Linux engine")
    for context in ("default", "desktop-linux"):
        observed = windows_desktop_capture(
            request, "info", "--format", "{{.ID}}\t{{.OSType}}", context=context,
            _verified=True,
        ).stdout.decode().strip().split("\t")
        require(observed == [request["engine_id"], "linux"],
                "Windows Docker context does not resolve to the exact Linux engine")
    unavailable = windows_desktop_capture(
        request, "version", "--format", "{{.Server.Version}}", context="desktop-windows",
        allow_failure=True, _verified=True,
    )
    unavailable_text = (unavailable.stderr + unavailable.stdout).decode("utf-8", "replace")
    require(unavailable.returncode != 0 and "500" in unavailable_text
            and "/v1.56/version" in unavailable_text,
            "desktop-windows failure is not the observed version-endpoint HTTP 500")

    _validate_windows_buildx_inventory(request, _verified=True)
    plugins = _plugin_inventory(windows_desktop_capture(
        request, "info", "--format", "{{json .ClientInfo.Plugins}}", _verified=True,
    ).stdout, "Windows")
    _validate_plugin_files(plugins, profile["plugins"], windows=True, label="Windows",
                           hash_names={"buildx", "desktop"})
    require(any(plugin["Name"] == "buildx" and QUALIFIED_BUILDX_VERSION.search(plugin["Version"])
                for plugin in plugins), "Windows Buildx plugin is not the pinned v0.38.1 executable")
    _require_pinned_file(profile.get("executable"), profile.get("sha256"),
                         "Windows Docker CLI", expected_path=WINDOWS_DOCKER)
    _require_pinned_file(profile.get("powershell_executable"), profile.get("powershell_sha256"),
                         "Windows PowerShell", expected_path=WINDOWS_POWERSHELL)
    _require_pinned_file(profile.get("settings_path"), profile.get("settings_sha256"),
                         "Docker Desktop install settings", expected_path=DOCKER_DESKTOP_SETTINGS)
    _require_pinned_file(profile.get("python_executable"), profile.get("python_sha256"),
                         "WSL observer interpreter")
    return profile["buildx_builders"]


def validate_native_buildx_plugin(request):
    expected = request["native_buildx_plugin"]
    plugins = _plugin_inventory(docker_capture(
        "info", "--format", "{{json .ClientInfo.Plugins}}",
    ).stdout, "Linux")
    _validate_plugin_files(plugins, expected["inventory"], windows=False, label="Linux",
                           hash_names={"buildx"})
    buildx = [plugin for plugin in plugins if plugin["Name"] == "buildx"]
    require(len(buildx) == 1 and QUALIFIED_BUILDX_VERSION.search(buildx[0]["Version"])
            and buildx[0]["Path"] == expected["path"],
            "Linux-origin Buildx plugin path/version differs from the pinned executable")


def validate_native_instances_absent():
    require(not any(os.environ.get(name) for name in (
        "BUILDX_BUILDER", "BUILDX_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST",
    )), "Docker/Buildx environment overrides prevent origin-client qualification")
    config = Path(os.environ.get("DOCKER_CONFIG", str(Path.home() / ".docker")))
    require(config.is_absolute() and not config.is_symlink(),
            "Linux-origin Docker config directory is not canonical")
    if not config.exists():
        return
    require(config.resolve(strict=True) == config and config.is_dir(),
            "Linux-origin Docker config directory is not canonical")
    instances = config / "buildx" / "instances"
    if instances.exists() or instances.is_symlink():
        require(not instances.is_symlink() and instances.is_dir()
                and instances.resolve(strict=True) == instances,
                "Linux-origin Buildx instances path is unsafe")
        require(not any(instances.iterdir()),
                "Linux-origin Docker config contains a shadow Buildx instance")


def history(request, original):
    validate_observer(request)
    builders = json_lines(observer_capture(request, "buildx", "ls", "--format", "json").stdout)
    require(builders and all(isinstance(x.get("Name"), str) for x in builders),
            "Builder enumeration is incomplete")
    qualified_desktop_profile = _is_qualified_desktop_profile(request)
    if qualified_desktop_profile:
        require(QUALIFIED_BUILDX_VERSION.search(request["buildx_version"]) is not None,
                "Only the reviewed Buildx v0.38.1 history client is admissible")
        validate_native_context(request)
        validate_native_instances_absent()
        validate_native_buildx_plugin(request)
        validate_windows_desktop_profile(request)
        normalized = _validate_native_integrated_builder_inventory(builders, request)
        query_builders = [next(row for row in builders if row["Name"] == normalized["Name"])]
        buildkit_version = QUALIFIED_BUILDKIT_VERSION
        filter_lower_bound = math.floor(original["started_at"]) - 1
        candidate_lower_bound = filter_lower_bound
    else:
        inventory = sorted([{"Name": x["Name"], "Driver": x.get("Driver"),
            "Nodes": sorted([{k: node.get(k) for k in ("Name", "Endpoint", "IDs", "Version", "Status")}
                             for node in x.get("Nodes", [])], key=lambda node: node["Name"])}
            for x in builders], key=lambda builder: builder["Name"])
        require(inventory == request["builders"], "Builder/node/version inventory changed")
        require(all(b["Driver"] and b["Nodes"] and all(
            n["Status"] == "running" and n["Endpoint"]
            and isinstance(n["IDs"], list) and n["IDs"] and all(isinstance(x, str) and x for x in n["IDs"])
            for n in b["Nodes"]) for b in inventory), "History inspection requires complete running builders")
        require(all(n["Version"] == LEGACY_BUILDKIT_VERSION for b in inventory for n in b["Nodes"]),
                "History filter-before-limit semantics require the reviewed BuildKit v0.32.2")
        # Preserve the original v0.32.2 admission and worker-alias behavior.
        query_builders = sorted(builders, key=lambda item: item["Name"] != request["buildkit_observer"].get("context"))
        buildkit_version = LEGACY_BUILDKIT_VERSION
        filter_lower_bound = math.floor(original["started_at"]) - 1
        candidate_lower_bound = Decimal(str(original["started_at"]))
    require(all(node.get("Version") == buildkit_version for builder in query_builders
                for node in builder.get("Nodes", [])),
            "BuildKit server version changed during history inspection")
    # Completed history is filtered before Buildx's 50-record limit; separately
    # ask for all running records without a time bound.
    since = datetime.fromtimestamp(filter_lower_bound, timezone.utc).isoformat().replace("+00:00", "Z")
    matches = {}
    seen_workers = set()
    for builder in query_builders:
        node_ids = tuple(sorted(worker for node in builder["Nodes"] for worker in node.get("IDs", [])))
        require(node_ids, "Builder worker identity is absent")
        if node_ids in seen_workers:
            continue  # Exact worker aliases share one history; do not query an incompatible context alias.
        seen_workers.add(node_ids)
        name = builder["Name"]
        rows = json_lines(observer_capture(request, "buildx", "history", "ls", "--builder", name,
                "--filter", "startedAt>" + since, "--no-trunc", "--format", "json").stdout)
        require(len(rows) < 50, "BuildKit history may be truncated; completeness unproven")
        active_rows = json_lines(observer_capture(request, "buildx", "history", "ls", "--builder", name,
                                  "--filter", "status=running", "--no-trunc", "--format", "json").stdout)
        require(len(active_rows) < 50, "Active BuildKit history may be truncated")
        known = {row.get("ref") for row in rows}
        rows.extend(row for row in active_rows if row.get("ref") not in known)
        for row in rows:
            # All live records are inspected, including records without project labels.
            active = not row.get("completed_at")
            if not active and not qualified_desktop_profile:
                created_at = timestamp(row.get("created_at"))
                if created_at < Decimal(str(original["started_at"])):
                    continue
            raw_ref = row.get("ref")
            require(isinstance(raw_ref, str), "BuildKit enumeration has an invalid ref")
            ref = raw_ref.split("/")[-1]
            require(REF.fullmatch(ref), "BuildKit enumeration has an invalid ref")
            observed = json.loads(observer_capture(request, "buildx", "history", "inspect", ref,
                "--builder", name, "--format", "json").stdout)
            labels = pairs(observed.get("Labels", []), "BuildKit labels")
            if active:
                require(observed.get("CompletedAt")
                        and labels.get("com.docker.compose.project") != original["compose_project"],
                        "An active or unattributed build prevents recovery")
            started_at = timestamp(observed.get("StartedAt")) if not active else None
            if qualified_desktop_profile and not active:
                require(started_at > candidate_lower_bound and observed.get("CompletedAt"),
                        "Completed BuildKit event is outside the pinned filter-before-limit window")
            if (not active and labels.get("com.docker.compose.project") == original["compose_project"]
                    and (started_at > candidate_lower_bound if qualified_desktop_profile
                         else started_at >= Decimal(str(original["started_at"])))):
                # A second build for this group, even with different args, is ambiguous.
                candidate = build_record(observed)
                key = (node_ids, ref)
                require(key not in matches or matches[key] == candidate,
                        "Builder aliases disagree about a record")
                matches[key] = candidate
    require(len(matches) == 1, "BuildKit retained group history is not unique")
    record = next(iter(matches.values()))
    require(record["Ref"] == request["build_ref"], "Unique retained BuildKit ref differs")
    return record


def validate_native_context(request):
    profile = request["windows_desktop_observer"]
    name = docker_capture("context", "show").stdout.decode().strip()
    require(name == profile["linux_context"] == "default",
            "Linux-origin Docker context changed")
    rows = json_lines(docker_capture("context", "ls", "--format", "json").stdout)
    normalized = _normalized_native_context_rows(rows)
    require(normalized == request["native_contexts"],
            "Linux-origin Docker context inventory changed")
    require(len(normalized) == len(WSL_CONTEXT_ENDPOINTS)
            and {row["Name"] for row in normalized} == set(WSL_CONTEXT_ENDPOINTS),
            "Linux-origin Docker context inventory is not the exact Desktop profile")
    for row in normalized:
        context_name = row["Name"]
        inspected = json.loads(docker_capture(
            "context", "inspect", context_name, "--format", "{{json .Endpoints.docker}}",
        ).stdout)
        require(inspected == {"Host": WSL_CONTEXT_ENDPOINTS[context_name], "SkipTLSVerify": False}
                and inspected == request["native_context_inspects"][context_name],
                "Linux-origin context endpoint is not the pinned local Desktop alias")


def _normalized_native_context_rows(rows):
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            "Linux-origin Docker context inventory is incomplete")
    normalized = []
    for row in rows:
        require(isinstance(row.get("Name"), str) and row["Name"],
                "Linux-origin Docker context name is absent")
        normalized.append({key: row.get(key) for key in ("Name", "DockerEndpoint", "Current", "Error")})
    return sorted(normalized, key=lambda row: row["Name"])


def potential_build_client(argv):
    require(isinstance(argv, list) and all(isinstance(x, str) for x in argv), "Invalid client argv")
    if not argv:
        return False
    executable = argv[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
    args = argv[1:]
    if executable in {"docker", "docker.exe", "docker-compose", "docker-compose.exe",
                      "docker-buildx", "docker-buildx.exe"}:
        # Parse global flags before checking the command, never substring-match payloads.
        while args and args[0].startswith("-"):
            option = args.pop(0)
            if option in {"--context", "--config", "--host", "-H", "--log-level"}:
                if not args:
                    return True
                args.pop(0)
            elif option in {"--debug", "-D"}:
                continue
            elif any(option.startswith(x + "=") for x in ("--context", "--config", "--host", "--log-level")):
                continue
            else:
                return True
        if executable.startswith("docker-buildx") and args[:1] != ["buildx"]:
            args.insert(0, "buildx")
        if executable.startswith("docker-compose") and args[:1] != ["compose"]:
            args.insert(0, "compose")
        readonly = [("inspect",), ("ps",), ("logs",), ("top",), ("stats",), ("version",), ("info",),
                    ("image", "inspect"), ("context", "show"), ("context", "ls"), ("buildx", "ls"),
                    ("buildx", "history", "ls"), ("buildx", "history", "inspect"),
                    ("compose", "ps"), ("compose", "config"), ("compose", "version"), ("compose", "ls")]
        return not any(tuple(args[:len(prefix)]) == prefix for prefix in readonly)
    return any(Path(argument.replace("\\", "/")).name in {
        "docker_volume_dev.py", "docker_dev.py", "docker_build_control.py",
        "bootstrap_docker_toolchain.py", "setup_docker.py", "docker-dev",
        "docker-dev-toolchain", "docker-dev-recreate-volume", "docker-dev-resume-volume"}
        for argument in args)


WINDOWS_PROCESS_NAMES = frozenset({
    "docker.exe", "docker-compose.exe", "docker-buildx.exe", "just.exe",
    "python.exe", "python3.exe", "dockerd.exe", "buildkitd.exe",
})
MAX_WINDOWS_PROCESS_RECHECKS = 8


def _windows_process_rows_query(request, *, process_id=None):
    query = "Get-CimInstance Win32_Process"
    if process_id is not None:
        require(type(process_id) is int and process_id > 0,
                "Windows PID recheck requires a positive process ID")
        query += f" -Filter 'ProcessId = {process_id}'"
    else:
        query += " | Where-Object {$names -contains $_.Name}"
    script = (
        "$ErrorActionPreference='Stop'; "
        "$names=@('docker.exe','docker-compose.exe','docker-buildx.exe','just.exe',"
        "'python.exe','python3.exe','dockerd.exe','buildkitd.exe'); "
        f"$rows=@({query} | Select-Object ProcessId,CreationDate,Name,ExecutablePath,CommandLine); "
        "ConvertTo-Json -InputObject $rows -Compress"
    )
    output = windows_powershell_capture(request, script)
    require(len(output.stdout) <= 8 * 1024 * 1024 and len(output.stderr) <= 8 * 1024 * 1024,
            "Windows process list exceeds its bound")
    require(output.stdout.strip(), "Windows process census returned empty output")
    try:
        windows = json.loads(output.stdout.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Windows CIM process census is malformed") from error
    if isinstance(windows, dict):
        windows = [windows]
    require(isinstance(windows, list) and all(isinstance(row, dict) for row in windows),
            "Windows CIM process census is malformed")
    return windows


def _windows_process_identity_gaps(row):
    gaps = []
    if row.get("Name") not in WINDOWS_PROCESS_NAMES:
        gaps.append("Name")
    if type(row.get("ProcessId")) is not int or row["ProcessId"] <= 0:
        gaps.append("ProcessId")
    if not isinstance(row.get("CreationDate"), str) or not row["CreationDate"]:
        gaps.append("CreationDate")
    if not isinstance(row.get("CommandLine"), str) or not row["CommandLine"]:
        gaps.append("CommandLine")
    return gaps


def _windows_process_identity_error(row, gaps, *, stage):
    process_id = row.get("ProcessId")
    if type(process_id) is not int or process_id <= 0:
        process_id = "unknown"
    name = row.get("Name")
    if not isinstance(name, str) or name not in WINDOWS_PROCESS_NAMES:
        name = "unknown"
    missing = ",".join(gaps)
    return BuildControlError(
        f"Windows process identity is incomplete {stage}: PID {process_id} ({name}), missing {missing}"
    )


def _windows_process_rows(request):
    windows = _windows_process_rows_query(request)
    incomplete = [(row, _windows_process_identity_gaps(row)) for row in windows]
    incomplete = [(row, gaps) for row, gaps in incomplete if gaps]
    if not incomplete:
        return windows

    require(len(incomplete) <= MAX_WINDOWS_PROCESS_RECHECKS,
            "Too many Windows CIM rows have incomplete process identity")
    for row, gaps in incomplete:
        if row.get("Name") not in WINDOWS_PROCESS_NAMES or "ProcessId" in gaps:
            raise _windows_process_identity_error(row, gaps, stage="in CIM snapshot")
        process_id = row["ProcessId"]
        rechecked = _windows_process_rows_query(request, process_id=process_id)
        require(len(rechecked) <= 1,
                f"Windows PID recheck returned multiple rows for PID {process_id}")
        if rechecked:
            current = rechecked[0]
            require(current.get("ProcessId") == process_id,
                    f"Windows PID recheck returned a different identity for PID {process_id}")
            current_name = current.get("Name")
            require(isinstance(current_name, str) and current_name,
                    f"Windows PID recheck returned an incomplete name for PID {process_id}")
            if current_name not in WINDOWS_PROCESS_NAMES:
                # The original process exited and Windows has reused its PID
                # for an unrelated process; the complete full recensus below
                # still classifies every currently relevant client.
                continue
            current_gaps = _windows_process_identity_gaps(current)
            if current_gaps:
                raise _windows_process_identity_error(
                    current, current_gaps, stage="after PID recheck"
                )

    # A missing PID confirms only that the sampled process exited. A complete
    # PID recheck does not replace the host census either: rerun the full query
    # so any surviving or newly started client remains visible to classification.
    windows = _windows_process_rows_query(request)
    for row in windows:
        gaps = _windows_process_identity_gaps(row)
        if gaps:
            raise _windows_process_identity_error(row, gaps, stage="after full refresh")
    return windows


def _foreign_helper_control(pin):
    """Build the existing helper protocol without resolving or mutating its volume."""
    from bootstrap_docker_toolchain import control_volume_name
    from docker_compose_identity import source_labels

    identity = {key: pin[key] for key in
                ("project_name", "project_id", "worktree_id", "checkout_kind")}
    control = BuildControl.__new__(BuildControl)
    control.identity = identity
    control.project = pin["project_name"]
    control.image = pin["helper_image"]
    control.volume = control_volume_name(control.project)
    control.labels = {
        "org.fullmag.build-control.schema": LABEL_SCHEMA,
        "org.fullmag.compose.project": control.project,
        "org.fullmag.source.worktree-id": identity["worktree_id"],
        "org.fullmag.build.role": "control",
        "com.fullmag.compose.project": control.project,
        "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
        "com.fullmag.toolchain.control.project": control.project,
        "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
    }
    control.namespace = ""
    control.namespace_registry = None
    control.namespace_registry_sha256 = None
    control._active_operation = None
    require(control.volume == pin["control_volume"],
            "Foreign helper's deterministic control volume identity differs")
    source_identity_labels = source_labels(identity)
    require(isinstance(source_identity_labels, dict) and source_identity_labels
            and all(isinstance(key, str) and isinstance(value, str)
                    for key, value in source_identity_labels.items()),
            "Foreign helper source identity is incomplete")
    return control


def _foreign_helper_expected_argv(control, pin):
    script = control.operation_script(pin["phase"], pin["attempt"])
    helper_args = control.helper_args(script, name=pin["helper_name"])
    require(helper_args and helper_args[0] == "docker",
            "Foreign helper command is not generated by the pinned BuildControl protocol")
    argv = ["docker", "--context", "desktop-linux", *helper_args[1:]]
    require(digest(canonical(argv)) == pin["argv_sha256"],
            "Foreign helper canonical argv differs from its exact pin")
    command_line = subprocess.list2cmdline(argv)
    require(digest(command_line.encode("utf-8")) == pin["command_line_sha256"],
            "Foreign helper Windows command line differs from its exact pin")
    return argv, command_line


def _windows_row_is_potential_client(row):
    try:
        argv = [argument.strip('"') for argument in
                shlex.split(row["CommandLine"], posix=False)]
    except ValueError:
        # A malformed command line for an inventoried client is unresolved,
        # never evidence that the process is harmless.
        return True
    return potential_build_client(argv)


def _foreign_helper_process_match(row, pin, expected_command_line):
    return (
        row.get("Name") == pin["process_name"]
        and row.get("ExecutablePath") == pin["process_executable_path"]
        and row.get("CommandLine") == expected_command_line
        and digest(row["CommandLine"].encode("utf-8")) == pin["command_line_sha256"]
    )


def _validate_foreign_control_helper_document(document, pin, control, image_labels):
    require(isinstance(document, dict)
            and document.get("Id") == pin["container_id"]
            and document.get("Name") in {pin["helper_name"], "/" + pin["helper_name"]}
            and document.get("Image") == pin["helper_image_id"],
            "Foreign control-helper container identity differs")
    state = document.get("State")
    require(isinstance(state, dict) and state.get("Running") is True
            and state.get("StartedAt") == pin["container_started_at"],
            "Foreign control-helper container incarnation is no longer running")
    config = document.get("Config")
    require(isinstance(config, dict) and config.get("Image") == pin["helper_image"],
            "Foreign control-helper image reference differs")
    expected_args = control.helper_args(
        control.operation_script(pin["phase"], pin["attempt"]),
        name=pin["helper_name"],
    )
    entrypoint = expected_args.index("--entrypoint")
    expected_cmd = expected_args[entrypoint + 3:]
    require(config.get("Entrypoint") == ["/bin/bash"]
            and config.get("Cmd") == expected_cmd
            and config.get("User") == "65532:65532",
            "Foreign control-helper command is not the canonical lease waiter")
    from docker_compose_identity import source_labels
    require(isinstance(image_labels, dict)
            and all(isinstance(key, str) and isinstance(value, str)
                    for key, value in image_labels.items()),
            "Pinned foreign helper image labels are incomplete")
    expected_labels = {
        **image_labels,
        "com.docker.compose.project": pin["project_name"],
        "com.docker.compose.service": "build-control",
        **control.labels,
        **source_labels(control.identity),
    }
    require(config.get("Labels") == expected_labels,
            "Foreign control-helper source/control labels differ")

    host = document.get("HostConfig")
    require(isinstance(host, dict)
            and host.get("NetworkMode") == "none"
            and host.get("ReadonlyRootfs") is True
            and host.get("Privileged") is False
            and host.get("CapAdd") in (None, [])
            and host.get("CapDrop") == ["ALL"]
            and host.get("SecurityOpt") == ["no-new-privileges:true"]
            and host.get("PidsLimit") == 32
            and host.get("Memory") == 64 * 1024 * 1024
            and host.get("NanoCpus") == 250_000_000
            and host.get("Runtime") == "runc"
            and host.get("AutoRemove") is True
            and host.get("Devices") in (None, [])
            and host.get("DeviceRequests") in (None, [])
            and host.get("PidMode", "") == ""
            and host.get("IpcMode") == "private"
            and host.get("UTSMode", "") == ""
            and host.get("UsernsMode", "") == ""
            and host.get("Binds") in (None, [])
            and host.get("Tmpfs") in (None, {})
            and host.get("Mounts") == [{
                "Type": "volume", "Source": pin["control_volume"],
                "Target": "/control", "VolumeOptions": {"NoCopy": True},
            }],
            "Foreign control-helper host isolation or mount boundary differs")
    mounts = document.get("Mounts")
    require(isinstance(mounts, list) and len(mounts) == 1
            and isinstance(mounts[0], dict)
            and set(mounts[0]) == {
                "Type", "Name", "Source", "Destination", "Driver", "Mode", "RW", "Propagation",
            }
            and mounts[0] == {
                "Type": "volume", "Name": pin["control_volume"],
                "Source": "/var/lib/docker/volumes/" + pin["control_volume"] + "/_data",
                "Destination": "/control", "Driver": "local", "Mode": "z", "RW": True,
                "Propagation": "",
            },
            "Foreign control-helper has an extra, changed, or non-control mount")
    require(document.get("Config", {}).get("Image") == pin["helper_image"]
            and document.get("Image") == pin["helper_image_id"],
            "Foreign control-helper immutable image identity differs")
    require(digest(canonical(document)) == pin["container_inspect_sha256"],
            "Foreign control-helper container inspect digest differs")


def _inspect_foreign_control_volume(control, pin):
    result = docker_capture("volume", "inspect", pin["control_volume"], timeout=60)
    try:
        documents = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Foreign control volume inspection is not valid JSON") from error
    require(isinstance(documents, list) and len(documents) == 1
            and isinstance(documents[0], dict),
            "Foreign control volume identity is ambiguous")
    volume = documents[0]
    require(volume.get("Name") == pin["control_volume"]
            and volume.get("Driver") == "local"
            and volume.get("Options") in (None, {})
            and volume.get("Labels") == control.labels,
            "Foreign helper volume is not the exact isolated local control volume")
    return {"Name": volume.get("Name"), "Driver": volume.get("Driver"),
            "Options": volume.get("Options") or {}, "Labels": volume.get("Labels")}


def _inspect_foreign_helper_image(request, pin):
    native_result = docker_capture("image", "inspect", pin["helper_image"], timeout=60)
    try:
        native_rows = json.loads(native_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Native foreign helper image inspection is not valid JSON") from error
    require(isinstance(native_rows, list) and len(native_rows) == 1
            and isinstance(native_rows[0], dict),
            "Native foreign helper image identity is ambiguous")

    windows_result = windows_desktop_capture(
        request, "image", "inspect", pin["helper_image"], context="desktop-linux",
        maximum=8 * 1024 * 1024,
    )
    try:
        windows_rows = json.loads(windows_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Windows foreign helper image inspection is not valid JSON") from error
    require(isinstance(windows_rows, list) and len(windows_rows) == 1
            and isinstance(windows_rows[0], dict),
            "Windows foreign helper image identity is ambiguous")
    native_image = native_rows[0]
    windows_image = windows_rows[0]
    require(native_image.get("Id") == pin["helper_image_id"]
            and windows_image.get("Id") == pin["helper_image_id"]
            and canonical(native_image) == canonical(windows_image),
            "Native and Windows observers disagree about the immutable foreign helper image")
    config = native_image.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    require(labels is None or isinstance(labels, dict),
            "Foreign helper image label metadata is malformed")
    labels = labels or {}
    require(all(isinstance(key, str) and isinstance(value, str)
                for key, value in labels.items()),
            "Foreign helper image label metadata is incomplete")
    return labels


def _inspect_foreign_control_helper(request, pin, control):
    native_engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    require(native_engine == request["engine_id"],
            "Foreign helper's WSL observer does not use the pinned Linux engine")
    native_doc_output = docker_capture("inspect", pin["container_id"], timeout=60)
    try:
        native_rows = json.loads(native_doc_output.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Native foreign control-helper inspect is not valid JSON") from error
    require(isinstance(native_rows, list) and len(native_rows) == 1,
            "Native foreign control-helper container identity is ambiguous")
    native_document = native_rows[0]

    windows_info = windows_desktop_capture(
        request, "info", "--format", "{{.ID}}\t{{.OSType}}", context="desktop-linux",
    )
    require(windows_info.stdout.decode().strip().split("\t") == [request["engine_id"], "linux"],
            "Foreign helper Windows client does not use the exact Linux engine")
    windows_inspect = windows_desktop_capture(
        request, "inspect", pin["container_id"], context="desktop-linux", maximum=8 * 1024 * 1024,
    )
    try:
        windows_rows = json.loads(windows_inspect.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Windows foreign control-helper inspect is not valid JSON") from error
    require(isinstance(windows_rows, list) and len(windows_rows) == 1,
            "Windows foreign control-helper container identity is ambiguous")
    windows_document = windows_rows[0]
    require(canonical(windows_document) == canonical(native_document),
            "Native and Windows observers disagree about the foreign helper container")

    image_labels = _inspect_foreign_helper_image(request, pin)
    _validate_foreign_control_helper_document(native_document, pin, control, image_labels)
    _validate_foreign_control_helper_document(windows_document, pin, control, image_labels)

    native_volume = _inspect_foreign_control_volume(control, pin)
    windows_volume_result = windows_desktop_capture(
        request, "volume", "inspect", pin["control_volume"], context="desktop-linux",
        maximum=8 * 1024 * 1024,
    )
    try:
        windows_volumes = json.loads(windows_volume_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Windows foreign control-volume inspection is not valid JSON") from error
    require(isinstance(windows_volumes, list) and len(windows_volumes) == 1,
            "Windows foreign control volume identity is ambiguous")
    windows_volume = windows_volumes[0]
    normalized_windows_volume = {
        "Name": windows_volume.get("Name"), "Driver": windows_volume.get("Driver"),
        "Options": windows_volume.get("Options") or {},
        "Labels": windows_volume.get("Labels"),
    }
    require(normalized_windows_volume == {
                "Name": pin["control_volume"], "Driver": "local", "Options": {},
                "Labels": control.labels,
            },
            "Windows foreign control volume ownership differs")
    require(normalized_windows_volume == native_volume,
            "Native and Windows observers disagree about the foreign control volume")
    return canonical({"container": canonical(native_document).decode("utf-8"),
                      "volume": native_volume}).decode("utf-8")


def _windows_process_snapshot(request, *, with_signature=False):
    """Take one quick CIM census; slow topology and object checks run separately."""
    pin = _validate_foreign_control_helper_pin(request)
    expected_command_line = None
    if pin is not None:
        _, expected_command_line = _foreign_helper_expected_argv(
            _foreign_helper_control(pin), pin
        )
    windows = _windows_process_rows(request)
    daemons = [row for row in windows
               if row["Name"].lower() in {"dockerd.exe", "buildkitd.exe"}]
    require(not daemons, "Independent Windows Docker/BuildKit daemon process is present")
    clients = [row for row in windows if _windows_row_is_potential_client(row)]
    if pin is None:
        require(not clients,
                "Potential live build clients remain without an exact declared helper pin")
        identity = ("no-pinned-helper", 0)
    else:
        require(len(clients) == 1,
                "Potential live build clients include an additional or unrecognized process")
        process = clients[0]
        require(_foreign_helper_process_match(process, pin, expected_command_line),
                "Foreign control-helper raw command line or executable differs")
        require(process.get("ProcessId") == pin["pid"]
                and process.get("CreationDate") == pin["process_creation_date"],
                "Foreign control-helper process identity was reused")
        require(digest(process["CommandLine"].encode("utf-8")) == pin["command_line_sha256"],
                "Foreign control-helper command line differs from its raw pin")
        identity = (process["ProcessId"], process["CreationDate"], pin["command_line_sha256"])
    summary = {"windows_cim_processes": len(windows), "windows_docker_daemons": 0,
               "windows_buildkit_daemons": 0, "windows_potential_build_clients": [],
               "windows_foreign_control_helpers": int(pin is not None)}
    return (summary, identity) if with_signature else summary


def _linux_process_snapshot(source):
    require(os.name != "nt" and Path("/proc/sys/kernel/random/boot_id").is_file(),
            "This legacy recovery requires the originating Linux/WSL host")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    scanned = 0
    conflicts = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        scanned += 1
        require(scanned <= 32768, "Process enumeration exceeded its bound")
        try:
            raw = (entry / "cmdline").read_bytes()
            require(len(raw) <= 1024 * 1024, "Host command line exceeds its bound")
            argv = [x.decode("utf-8", "strict") for x in raw.split(b"\0") if x]
            if not argv:
                continue
            opaque_python = ("python" in argv[0] and ("-" in argv[1:] or "-c" in argv[1:]))
            local_opaque = opaque_python and (entry / "cwd").resolve(strict=True) == source
            if potential_build_client(argv) or local_opaque:
                conflicts.append(int(entry.name))
        except FileNotFoundError:
            continue
        except (OSError, UnicodeDecodeError) as error:
            raise BuildControlError("Host process absence cannot be established") from error
    return {"linux_boot_id": boot_id, "linux_processes_scanned": scanned}, tuple(conflicts)


def _legacy_windows_process_snapshot():
    powershell = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    if not powershell.exists():
        require("microsoft" not in Path("/proc/sys/kernel/osrelease").read_text().lower(),
                "WSL Windows process observer is unavailable")
        return {}, ()
    script = (
        "$ErrorActionPreference='Stop'; "
        "$p=@(Get-CimInstance Win32_Process | Where-Object {"
        "$_.Name -match '^(docker|docker-compose|docker-buildx|just|python|python3)(\\.exe)?$'}); "
        "@($p | Select-Object ProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress")
    output = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
                            check=True, capture_output=True, timeout=60)
    require(len(output.stdout) <= 8 * 1024 * 1024, "Windows process list exceeds its bound")
    require(output.stdout.strip(), "Windows process census returned empty output")
    try:
        windows = json.loads(output.stdout.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Windows process census is malformed") from error
    if isinstance(windows, dict):
        windows = [windows]
    require(isinstance(windows, list) and all(isinstance(row, dict) for row in windows),
            "Windows process census is malformed")
    conflicts = []
    for row in windows:
        require(row.get("CommandLine") and row.get("CreationDate"),
                "Windows client identity is incomplete")
        argv = [x.strip('"') for x in shlex.split(row["CommandLine"], posix=False)]
        if potential_build_client(argv):
            conflicts.append("windows:" + str(row.get("ProcessId")))
    return {"windows_cim_processes": len(windows), "windows_docker_daemons": 0,
            "windows_buildkit_daemons": 0, "windows_potential_build_clients": []}, tuple(conflicts)


def _host_process_census(source, request, *, passes=1, windows_first=False):
    observations = []
    latest_summary = {}
    for _ in range(passes):
        if windows_first:
            if _is_qualified_desktop_profile(request or {}):
                windows_summary, windows_identity = _windows_process_snapshot(
                    request, with_signature=True
                )
                windows_conflicts = ()
            else:
                windows_summary, windows_conflicts = _legacy_windows_process_snapshot()
                windows_identity = windows_conflicts
            linux_summary, linux_conflicts = _linux_process_snapshot(source)
        else:
            linux_summary, linux_conflicts = _linux_process_snapshot(source)
            require(not linux_conflicts,
                    "Potential live build clients remain: " + repr(linux_conflicts))
            if _is_qualified_desktop_profile(request or {}):
                windows_summary, windows_identity = _windows_process_snapshot(
                    request, with_signature=True
                )
                windows_conflicts = ()
            else:
                windows_summary, windows_conflicts = _legacy_windows_process_snapshot()
                windows_identity = windows_conflicts
        conflicts = tuple(linux_conflicts) + tuple(windows_conflicts)
        require(not conflicts, "Potential live build clients remain: " + repr(conflicts))
        observations.append((linux_summary["linux_boot_id"], windows_identity))
        latest_summary = {**linux_summary, **windows_summary, "potential_build_clients": [],
                          "host_process_census_passes": passes}
    require(all(observation == observations[0] for observation in observations[1:]),
            "Host client identities changed during the final double census")
    return latest_summary


def _validate_host_client_environment(request):
    """Complete slow engine and pinned-object probes before the final census."""
    validate_observer(request)
    validate_native_context(request)
    _windows_context_inventory(request)
    validate_windows_desktop_profile(request)
    pin = _validate_foreign_control_helper_pin(request)
    if pin is not None:
        _inspect_foreign_control_helper(request, pin, _foreign_helper_control(pin))


def host_clients(source, request=None, *, final=False, environment_validated=False):
    """Early mode is fast; final mode ends with fresh process censuses."""
    if final and _is_qualified_desktop_profile(request or {}):
        if not environment_validated:
            _validate_host_client_environment(request)
        # This path is intentionally short: preview performs its final source
        # and control pin check after the slow probes and immediately before it.
        return _host_process_census(source, request, passes=2, windows_first=True)
    require(not environment_validated,
            "Host environment validation is only valid for the qualified final census")
    return _host_process_census(source, request, passes=2 if final else 1,
                                windows_first=final)


def pin_file(control, relative, expected):
    raw = read_raw(control, relative, optional=True)
    require((digest(raw) if raw is not None else None) == expected, "Control document changed: " + relative)
    return raw


def validate_request(request):
    require(request.get("schema") == SCHEMA and TOKEN.fullmatch(request.get("attempt", "")),
            "Exact toolchain canceled request required")
    for field in ("unknown_receipt_sha256", "compose_sha256", "build_log_sha256",
                  "helper_fingerprint", "build_record_sha256"):
        require(SHA.fullmatch(request.get(field, "")), "Missing digest: " + field)
    for field in ("phase_current_sha256", "verified_sha256"):
        require(request.get(field) is None or SHA.fullmatch(request[field]), "Invalid optional digest: " + field)
    require(REF.fullmatch(request.get("build_ref", "")), "Invalid BuildKit ref")
    require(isinstance(request.get("helper_started_at"), str) and request["helper_started_at"],
            "Original helper start timestamp required")
    require(re.fullmatch(r"[0-9a-f]{40}", request.get("source_revision", "")), "Full source revision required")
    require(isinstance(request.get("source_repository"), str), "Source repository required")
    require(isinstance(request.get("buildkit_observer"), dict), "Explicit BuildKit observer required")
    require(isinstance(request.get("buildx_version"), str) and request["buildx_version"],
            "Exact Buildx plugin version required")
    require(isinstance(request.get("engine_id"), str) and request["engine_id"]
            and isinstance(request.get("builders"), list) and request["builders"],
            "Pinned engine/builder inventory required")
    require(isinstance(request.get("controller_inputs"), dict) and request["controller_inputs"],
            "Controller source pins required")
    if "windows_desktop_observer" in request:
        profile = request["windows_desktop_observer"]
        require(request["buildkit_observer"] == {"kind": "native"},
                "The qualified desktop profile must use the original Linux Docker client for history")
        require(isinstance(profile, dict)
                and set(profile) == {
                    "schema", "executable", "sha256", "version", "linux_context",
                    "linux_context_endpoint", "powershell_executable",
                    "powershell_sha256", "settings_path", "settings_sha256", "python_executable",
                    "python_sha256", "linux_engine_id", "desktop_engines", "contexts",
                    "context_inspects", "buildx_builders", "plugins",
                }
                and profile.get("schema") == "fullmag.docker-desktop-toolchain-observer.v1",
                "The qualified Windows Docker Desktop observer profile is incomplete")
        require(QUALIFIED_BUILDX_VERSION.search(request["buildx_version"]) is not None,
                "The qualified history client must be pinned to Buildx v0.38.1")
        require(profile["linux_engine_id"] == request["engine_id"]
                and all(isinstance(profile.get(key), str) and profile[key]
                        for key in ("version", "linux_context", "linux_context_endpoint", "executable",
                                    "powershell_executable", "settings_path",
                                    "python_executable")),
                "Windows observer engine or executable identity is incomplete")
        require(profile["linux_context"] == "default",
                "The original WSL toolchain client must use its pinned default context")
        require(profile["linux_context_endpoint"] == "unix:///var/run/docker.sock",
                "The original WSL client must use the local Docker Desktop Unix socket")
        for key in ("sha256", "powershell_sha256", "settings_sha256", "python_sha256"):
            require(SHA.fullmatch(profile.get(key, "")),
                    "Windows observer digest is invalid: " + key)
        require(profile["executable"] == str(WINDOWS_DOCKER)
                and profile["powershell_executable"] == str(WINDOWS_POWERSHELL)
                and profile["settings_path"] == str(DOCKER_DESKTOP_SETTINGS),
                "Windows observer executable/settings paths are not the qualified installation")
        require(profile.get("desktop_engines") == [
                    {"Name": "linux", "Description": "Linux engine", "Current": True}],
                "The pinned Desktop engine profile must contain only the active Linux engine")
        require(isinstance(profile.get("contexts"), list)
                and len(profile["contexts"]) == len(WINDOWS_CONTEXT_ENDPOINTS)
                and {row.get("Name") for row in profile["contexts"] if isinstance(row, dict)}
                    == set(WINDOWS_CONTEXT_ENDPOINTS),
                "Pinned Windows context list is incomplete")
        require(isinstance(profile.get("context_inspects"), dict)
                and set(profile["context_inspects"]) == set(WINDOWS_CONTEXT_ENDPOINTS),
                "Pinned Windows context endpoint inspections are incomplete")
        require(isinstance(profile.get("buildx_builders"), list)
                and {row.get("Name") for row in profile["buildx_builders"] if isinstance(row, dict)}
                    == {"default", "desktop-linux", "desktop-windows", "fullmag-windows"},
                "Pinned Windows Buildx inventory is incomplete")
        require(isinstance(profile.get("plugins"), list) and profile["plugins"],
                "Windows CLI plugin paths must be pinned")
        for plugin in profile["plugins"]:
            require(isinstance(plugin, dict)
                    and set(plugin) == {"Name", "Version", "Path", "sha256"}
                    and all(isinstance(plugin.get(key), str) and plugin[key]
                            for key in ("Name", "Version", "Path"))
                    and SHA.fullmatch(plugin.get("sha256", "")),
                    "Windows CLI plugin pin is incomplete")
        plugin_names = [plugin["Name"] for plugin in profile["plugins"]]
        require(len(plugin_names) == len(set(plugin_names))
                and {"buildx", "desktop"} <= set(plugin_names),
                "Effective Buildx and Docker Desktop CLI plugins must be uniquely pinned")
        require(any(plugin["Name"] == "buildx"
                    and QUALIFIED_BUILDX_VERSION.search(plugin["Version"])
                    for plugin in profile["plugins"]),
                "Windows Buildx plugin must be pinned to v0.38.1")
        native_plugin = request.get("native_buildx_plugin")
        require(isinstance(native_plugin, dict)
                and set(native_plugin) == {"path", "inventory"}
                and isinstance(native_plugin.get("path"), str) and native_plugin["path"]
                and isinstance(native_plugin.get("inventory"), list),
                "Linux-origin Buildx executable pin is incomplete")
        require(any(isinstance(plugin, dict) and plugin.get("Name") == "buildx"
                    for plugin in native_plugin["inventory"]),
                "Linux-origin executable pin must include the effective Buildx plugin")
        require(any(isinstance(plugin, dict) and plugin.get("Name") == "buildx"
                    and plugin.get("Path") == native_plugin["path"]
                    and SHA.fullmatch(plugin.get("sha256", ""))
                    for plugin in native_plugin["inventory"]),
                "Linux-origin Buildx plugin path/hash is not pinned")
        native_names = []
        for plugin in native_plugin["inventory"]:
            require(isinstance(plugin, dict)
                    and set(plugin) == {"Name", "Version", "Path", "sha256"}
                    and all(isinstance(plugin.get(key), str) and plugin[key]
                            for key in ("Name", "Version", "Path"))
                    and SHA.fullmatch(plugin.get("sha256", "")),
                    "Linux-origin Docker CLI plugin pin is incomplete")
            native_names.append(plugin["Name"])
        require(len(native_names) == len(set(native_names)),
                "Linux-origin Docker CLI plugin pin contains duplicate names")
        require(QUALIFIED_BUILDX_VERSION.search(request["buildx_version"]) is not None,
                "Linux-origin Buildx v0.38.1 command is not pinned")
        require(len(request["builders"]) == 3
                and {row.get("Name") for row in request["builders"] if isinstance(row, dict)}
                    == {"default", "desktop-linux", "desktop-windows"},
                "The qualified Linux-origin inventory must contain one worker and two known aliases")
        expected_contexts = [
            {"Name": name, "DockerEndpoint": endpoint, "Current": name == "default", "Error": ""}
            for name, endpoint in WSL_CONTEXT_ENDPOINTS.items()
        ]
        require(request.get("native_contexts") == expected_contexts,
                "The qualified Linux-origin context inventory is incomplete or changed")
        expected_inspects = {
            name: {"Host": endpoint, "SkipTLSVerify": False}
            for name, endpoint in WSL_CONTEXT_ENDPOINTS.items()
        }
        require(request.get("native_context_inspects") == expected_inspects,
                "The qualified Linux-origin context endpoint pins are incomplete or changed")
        _validate_foreign_control_helper_pin(request)


def _validate_foreign_control_helper_pin(request):
    pin = request.get("foreign_control_helper")
    if pin is None:
        return None
    fields = {
        "schema", "pid", "process_name", "process_creation_date", "process_executable_path",
        "command_line_sha256", "argv_sha256", "container_id", "container_started_at",
        "container_inspect_sha256", "project_name", "project_id", "worktree_id",
        "checkout_kind", "control_volume", "helper_name", "attempt", "phase",
        "helper_image", "helper_image_id",
    }
    require(isinstance(pin, dict) and set(pin) == fields
            and pin.get("schema") == "fullmag.foreign-control-helper.v1",
            "The pinned foreign control-helper profile is incomplete")
    require(type(pin.get("pid")) is int and pin["pid"] > 0
            and pin.get("process_name") == "docker.exe"
            and pin.get("process_executable_path") == WINDOWS_DOCKER_EXECUTABLE
            and isinstance(pin.get("process_creation_date"), str)
            and re.fullmatch(r"/Date\(-?\d+\)/", pin["process_creation_date"]) is not None,
            "The pinned foreign Docker client process identity is invalid")
    for key in ("command_line_sha256", "argv_sha256", "container_inspect_sha256"):
        require(SHA.fullmatch(pin.get(key, "")), "Foreign helper process/container digest is invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", pin.get("container_id", "")) is not None
            and isinstance(pin.get("container_started_at"), str),
            "The pinned foreign control-helper container identity is invalid")
    timestamp(pin["container_started_at"])
    require(isinstance(pin.get("project_name"), str)
            and re.fullmatch(r"fullmag-worktree-[a-z0-9_-]+", pin["project_name"]) is not None
            and pin["project_name"] != request["compose_project"]
            and isinstance(pin.get("project_id"), str)
            and re.fullmatch(r"[a-z0-9][a-z0-9._-]*", pin["project_id"]) is not None
            and isinstance(pin.get("worktree_id"), str)
            and re.fullmatch(r"[a-z0-9_][a-z0-9._-]*", pin["worktree_id"]) is not None
            and pin.get("checkout_kind") == "worktree",
            "The foreign helper must bind a different registered worktree identity")
    require(TOKEN.fullmatch(pin.get("attempt", "")) is not None
            and pin.get("helper_name") == "fullmag-control-" + pin["attempt"]
            and isinstance(pin.get("phase"), str)
            and re.fullmatch(r"[a-z][a-z0-9-]+", pin["phase"]) is not None,
            "The foreign control-helper lease identity is invalid")
    require(isinstance(pin.get("helper_image"), str)
            and re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", pin["helper_image"]) is not None
            and re.fullmatch(r"sha256:[0-9a-f]{64}", pin.get("helper_image_id", "")) is not None,
            "The foreign control-helper image pin is invalid")
    from bootstrap_docker_toolchain import control_volume_name
    expected_volume = control_volume_name(pin["project_name"])
    require(pin.get("control_volume") == expected_volume
            and pin["control_volume"] != control_volume_name(request["compose_project"]),
            "The foreign helper volume is not isolated from the recovery target")
    return pin


def _validate_source_and_control_pins(control, source, request, original_raw, original, root, helper_id):
    from bootstrap_docker_toolchain import tracked_input_files, read_input
    retained = read_raw(control, root + "/unknown-receipt.json", optional=True)
    if retained is None:
        retained = read_raw(control, root + "/receipt.json")
    require(retained == original_raw and digest(retained) == request["unknown_receipt_sha256"],
            "Original retained receipt changed during observation")
    require(read_raw(control, "active").decode().strip() == request["attempt"],
            "Lease owner changed during observation")
    helper, helper_id_again = _validate_helper(control, original["helper_container"],
                                               request["attempt"], phase="toolchain")
    require(helper_id_again == helper_id
            and fingerprint(helper) == request["helper_fingerprint"]
            and helper["State"].get("StartedAt") == request["helper_started_at"],
            "Original helper incarnation changed during observation")
    _validate_helper_logged(helper_id)
    document = json.loads(pin_file(control, root + "/compose.json", request["compose_sha256"]))
    require(document.get("name") == control.project and set(document["services"]) == {"fem-gpu-toolchain"}
            and document["services"]["fem-gpu-toolchain"]["build"]["context"] == str(source),
            "Retained toolchain Compose source changed during observation")
    observed_log = docker_capture("exec", helper_id, "sha256sum", control.path(root + "/build.log")).stdout
    require(observed_log.decode().split()[0] == request["build_log_sha256"],
            "Build log changed during observation")
    files = [{"path": path.as_posix(), "sha256": hashlib.sha256(read_input(source, path)).hexdigest()}
             for path in tracked_input_files(source)]
    require(files == original["inputs"]["source_inputs"],
            "Toolchain source inputs changed during observation")
    for relative, expected in request["controller_inputs"].items():
        require(relative in {"scripts/docker_volume_toolchain_reconcile.py", "scripts/docker_volume_reconcile.py",
                             "scripts/docker_volume_activation_reconcile.py"}, "Unknown controller pin")
        require(digest((source / relative).read_bytes()) == expected, "Controller source changed")
    require(set(request["controller_inputs"]) == {"scripts/docker_volume_toolchain_reconcile.py",
            "scripts/docker_volume_reconcile.py", "scripts/docker_volume_activation_reconcile.py"},
            "Controller pin set is incomplete")


def preview(control, source, request):
    from bootstrap_docker_toolchain import tracked_input_files, read_input
    root = "toolchain/attempts/" + request["attempt"]
    original_raw = read_raw(control, root + "/unknown-receipt.json", optional=True)
    if original_raw is None:
        original_raw = read_raw(control, root + "/receipt.json")
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Original receipt changed")
    original = json.loads(original_raw)
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
            and original.get("phase") == "toolchain"
            and original.get("state") in {"starting", "building", "outcome-unknown-resources-retained"}
            and original.get("attempt") == request["attempt"]
            and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume,
            "Original retained toolchain identity differs")
    require(request["source_root"] == str(source) and request["compose_project"] == control.project,
            "Selected source/group differs")
    helper, helper_id = _validate_helper(control, original["helper_container"],
                                         request["attempt"], phase="toolchain")
    require(fingerprint(helper) == request["helper_fingerprint"]
            and helper["State"].get("StartedAt") == request["helper_started_at"],
            "Original helper incarnation changed")
    _validate_helper_logged(helper_id)
    document = json.loads(pin_file(control, root + "/compose.json", request["compose_sha256"]))
    require(document.get("name") == control.project and set(document["services"]) == {"fem-gpu-toolchain"}
            and document["services"]["fem-gpu-toolchain"]["build"]["context"] == str(source),
            "Retained toolchain Compose source differs")
    # The log may exceed the JSON document bound; hash it inside its owner.
    observed_log = docker_capture("exec", helper_id, "sha256sum", control.path(root + "/build.log")).stdout
    require(observed_log.decode().split()[0] == request["build_log_sha256"], "Build log changed")
    files = [{"path": p.as_posix(), "sha256": hashlib.sha256(read_input(source, p)).hexdigest()}
             for p in tracked_input_files(source)]
    require(files == original["inputs"]["source_inputs"], "Toolchain source inputs changed")
    for relative, expected in request["controller_inputs"].items():
        require(relative in {"scripts/docker_volume_toolchain_reconcile.py", "scripts/docker_volume_reconcile.py",
                             "scripts/docker_volume_activation_reconcile.py"}, "Unknown controller pin")
        require(digest((source / relative).read_bytes()) == expected, "Controller source changed")
    require(set(request["controller_inputs"]) == {"scripts/docker_volume_toolchain_reconcile.py",
            "scripts/docker_volume_reconcile.py", "scripts/docker_volume_activation_reconcile.py"},
            "Controller pin set is incomplete")
    require(read_raw(control, "active").decode().strip() == request["attempt"], "Lease owner changed")
    # Cheap early census refuses unknown clients before the slower history
    # and Desktop probes. The final census is repeated after all source/control
    # checks below so its process identities are the last observation.
    host_clients(source, request)
    first = history(request, original)
    validate_record(first, request, original, document)
    _validate_source_and_control_pins(control, source, request, original_raw,
                                      original, root, helper_id)
    time.sleep(1)
    second = history(request, original)
    require(second == first, "BuildKit terminal observation is unstable")
    desktop_profile = _is_qualified_desktop_profile(request)
    if desktop_profile:
        _validate_host_client_environment(request)
    _validate_source_and_control_pins(control, source, request, original_raw,
                                      original, root, helper_id)
    clients = host_clients(source, request, final=True, environment_validated=desktop_profile)
    return original_raw, first, clients


def failure_result(original_raw, record, request, request_sha):
    result = copy.deepcopy(json.loads(original_raw))
    result.pop("exit_code", None)  # No host exit status survived this interruption.
    result.update(state="failed-confirmed", finished_at=record["CompletedAt"],
                  error="BuildKit canceled after host observer interruption; host exit status unavailable",
                  build_data_qualification="NOT VERIFIED",
                  reconciliation={"schema": SCHEMA, "request_sha256": request_sha,
                    "original_receipt_sha256": request["unknown_receipt_sha256"],
                    "binding": "operator-pinned-legacy-composite-identity",
                    "buildkit": record})
    return canonical(result) + b"\n"



def confirm_release(control, request):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        active = read_raw(control, "active", optional=True)
        name = "fullmag-control-" + request["attempt"]
        if active is None:
            if _probe_helper_absence(name) is not None:
                return
        else:
            require(active.decode().strip() == request["attempt"], "Active owner changed during release")
            helper, _ = _validate_helper(control, name, request["attempt"], phase="toolchain")
            require(fingerprint(helper) == request["helper_fingerprint"]
                    and helper["State"].get("StartedAt") == request["helper_started_at"],
                    "Original helper incarnation changed during release")
        time.sleep(.25)
    raise BuildControlError("Terminal committed; original helper release not yet confirmed")


def reconcile(args):
    from docker_dev import _select_source, _compose_identity
    selected, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    request_raw = read_raw(control, args.request)
    require(digest(request_raw) == args.request_sha256, "Request CAS differs")
    request = json.loads(request_raw)
    validate_request(request)
    root = "toolchain/attempts/" + request["attempt"]
    terminal = read_raw(control, root + "/terminal.json", optional=True)
    if terminal is not None:
        original = pin_file(control, root + "/unknown-receipt.json", request["unknown_receipt_sha256"])
        record = json.loads(terminal)["reconciliation"]["buildkit"]
        document = json.loads(pin_file(control, root + "/compose.json", request["compose_sha256"]))
        validate_record(record, request, json.loads(original), document)
        result = failure_result(original, record, request, args.request_sha256)
        require(terminal == result, "Terminal belongs to another recovery")
        pin_file(control, root + "/receipt.json", digest(result))
        pin_file(control, "toolchain/current.json", digest(result))
        pin_file(control, "toolchain/verified.json", request["verified_sha256"])
        confirm_release(control, request)
        print(json.dumps({"state": "failed-confirmed", "attempt": request["attempt"], "replay": True}))
        return
    original_raw, record, clients = preview(control, selected, request)
    result = failure_result(original_raw, record, request, args.request_sha256)
    current = read_raw(control, root + "/receipt.json")
    require(current in (original_raw, result), "Unrecognized partial receipt")
    phase_current = read_raw(control, "toolchain/current.json", optional=True)
    require((digest(phase_current) if phase_current is not None else None)
            in {request["phase_current_sha256"], digest(result)}, "Unrecognized current pointer")
    pin_file(control, "toolchain/verified.json", request["verified_sha256"])
    if args.preview:
        print(json.dumps({"state": "validated-only", "attempt": request["attempt"],
                          "result_sha256": digest(result), "host_clients": clients}))
        return
    transaction = root + "/reconciliation/" + digest(result)
    write_immutable(control, root + "/unknown-receipt.json", original_raw)
    write_immutable(control, transaction + "/result.json", result)
    write_immutable(control, transaction + "/prepared.json", canonical({"schema": SCHEMA,
        "request_sha256": args.request_sha256, "unknown_receipt_sha256": request["unknown_receipt_sha256"],
        "result_sha256": digest(result)}) + b"\n")
    # Observe again immediately before publication. The original helper still owns the operation lock.
    require(preview(control, selected, request)[0] == original_raw, "Source operation changed")
    script = commit_script(control, root, request, transaction, digest(result), digest(current),
                           phase="toolchain", publish_verified=False)
    committed = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    require(committed.returncode == 0, "Commit outcome unknown; replay exact request without deleting resources")
    for relative in (root + "/receipt.json", "toolchain/current.json", root + "/terminal.json"):
        pin_file(control, relative, digest(result))
    pin_file(control, "toolchain/verified.json", request["verified_sha256"])
    confirm_release(control, request)
    print(json.dumps({"state": "failed-confirmed", "attempt": request["attempt"],
                      "build_data_qualification": "NOT VERIFIED"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--preview", action="store_true")
    reconcile(parser.parse_args())


if __name__ == "__main__":
    main()
