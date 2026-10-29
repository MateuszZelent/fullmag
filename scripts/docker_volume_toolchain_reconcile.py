"""Failure-only reconciliation of one canceled, retained toolchain operation."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

from docker_build_control import (BuildControl, BuildControlError, bounded_capture,
    canonical, docker_capture, toolchain_configuration)
from docker_volume_activation_reconcile import (_validate_helper, _validate_helper_logged,
    _probe_helper_absence)
from docker_volume_reconcile import (commit_script, digest, fingerprint, read_raw,
    require, write_immutable, TOOLCHAIN_CANCELED_SCHEMA as SCHEMA)

TOKEN = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
REF = re.compile(r"[a-z0-9]{20,64}\Z")
MAX_RECORDS = 4096


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
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.utcoffset() is not None, "BuildKit timestamp lacks a timezone")
        return result.timestamp()
    except ValueError as error:
        raise BuildControlError("BuildKit timestamp is invalid") from error


def build_record(document):
    require(isinstance(document, dict), "BuildKit inspect is not an object")
    result = {key: document.get(key) for key in
              ("Ref", "Dockerfile", "VCSRepository", "VCSRevision", "Target", "Status")}
    result["Dockerfile"] = str(result["Dockerfile"]).replace("\\", "/")
    result["StartedAt"] = timestamp(document.get("StartedAt"))
    result["CompletedAt"] = timestamp(document.get("CompletedAt"))
    result["BuildArgs"] = pairs(document.get("BuildArgs"), "BuildKit build arguments")
    result["Labels"] = pairs(document.get("Labels"), "BuildKit labels")
    error = document.get("Error")
    require(isinstance(error, dict), "Canceled build lacks its native error")
    # Stack embeds the observing CLI process and changes on every inspect.
    result["Error"] = {key: error.get(key) for key in ("Code", "Message")}
    return result


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
    require(original["started_at"] <= record["StartedAt"] <= original["started_at"] + 300
            and record["CompletedAt"] >= record["StartedAt"],
            "BuildKit operation is outside the admitted time window")
    require(digest(canonical(record)) == request["build_record_sha256"],
            "Pinned terminal BuildKit record changed")


def json_lines(output):
    rows = [json.loads(line) for line in output.splitlines() if line.strip()]
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


def history(request, original):
    validate_observer(request)
    builders = json_lines(observer_capture(request, "buildx", "ls", "--format", "json").stdout)
    require(builders and all(isinstance(x.get("Name"), str) for x in builders),
            "Builder enumeration is incomplete")
    inventory = sorted([{"Name": x["Name"], "Driver": x.get("Driver"),
        "Nodes": sorted([{k: node.get(k) for k in ("Name", "Endpoint", "IDs", "Version", "Status")}
                         for node in x.get("Nodes", [])], key=lambda node: node["Name"])}
        for x in builders], key=lambda builder: builder["Name"])
    require(inventory == request["builders"], "Builder/node/version inventory changed")
    require(all(b["Driver"] and b["Nodes"] and all(
        n["Status"] == "running" and n["Endpoint"]
        and isinstance(n["IDs"], list) and n["IDs"] and all(isinstance(x, str) and x for x in n["IDs"])
        for n in b["Nodes"]) for b in inventory), "History inspection requires complete running builders")
    require(all(n["Version"] == "v0.32.2" for b in inventory for n in b["Nodes"]),
            "History filter-before-limit semantics require the reviewed BuildKit v0.32.2")
    # BuildKit v0.32.2 filters complete events before its limit. Keep running discovery unbounded in time.
    since = datetime.fromtimestamp(int(original["started_at"]) - 1, timezone.utc).isoformat().replace("+00:00", "Z")
    matches = {}
    seen_workers = set()
    preferred = request["buildkit_observer"].get("context")
    for builder in sorted(builders, key=lambda item: item["Name"] != preferred):
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
            if not active and timestamp(row.get("created_at")) < original["started_at"]:
                continue
            ref = row.get("ref", "").split("/")[-1]
            require(REF.fullmatch(ref), "BuildKit enumeration has an invalid ref")
            observed = json.loads(observer_capture(request, "buildx", "history", "inspect", ref,
                "--builder", name, "--format", "json").stdout)
            labels = pairs(observed.get("Labels", []), "BuildKit labels")
            if active:
                require(observed.get("CompletedAt")
                        and labels.get("com.docker.compose.project") != original["compose_project"],
                        "An active or unattributed build prevents recovery")
            if (labels.get("com.docker.compose.project") == original["compose_project"]
                    and timestamp(observed.get("StartedAt")) >= original["started_at"]):
                # A second build for this group, even with different args, is ambiguous.
                candidate = build_record(observed)
                key = (node_ids, ref)
                require(key not in matches or matches[key] == candidate,
                        "Builder aliases disagree about a record")
                matches[key] = candidate
    require(len(matches) == 1, "BuildKit group history is not unique")
    record = next(iter(matches.values()))
    require(record["Ref"] == request["build_ref"], "Unique BuildKit ref differs")
    return record


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


def host_clients(source):
    require(os.name != "nt" and Path("/proc/sys/kernel/random/boot_id").is_file(),
            "This legacy recovery requires the originating Linux/WSL host")
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
    # Docker Desktop's Windows executable can outlive its WSL forwarding process.
    powershell = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    if powershell.exists():
        script = (
            "$ErrorActionPreference='Stop'; "
            "$p=@(Get-CimInstance Win32_Process | Where-Object {"
            "$_.Name -match '^(docker|docker-compose|docker-buildx|just|python|python3)(\\.exe)?$'}); "
            "@($p | Select-Object ProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress")
        output = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
                                check=True, capture_output=True, timeout=60)
        require(len(output.stdout) <= 8 * 1024 * 1024, "Windows process list exceeds its bound")
        windows = json.loads(output.stdout.decode("utf-8-sig")) if output.stdout.strip() else []
        if isinstance(windows, dict):
            windows = [windows]
        for row in windows:
            require(row.get("CommandLine") and row.get("CreationDate"), "Windows client identity is incomplete")
            argv = [x.strip('"') for x in shlex.split(row["CommandLine"], posix=False)]
            if potential_build_client(argv):
                conflicts.append("windows:" + str(row["ProcessId"]))
    else:
        require("microsoft" not in Path("/proc/sys/kernel/osrelease").read_text().lower(),
                "WSL Windows process observer is unavailable")
    require(not conflicts, "Potential live build clients remain: " + repr(conflicts))
    return {"linux_boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "linux_processes_scanned": scanned, "potential_build_clients": []}


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
    clients = host_clients(source)
    first = history(request, original)
    validate_record(first, request, original, document)
    time.sleep(1)
    second = history(request, original)
    require(second == first, "BuildKit terminal observation is unstable")
    host_clients(source)
    require(read_raw(control, "active").decode().strip() == request["attempt"], "Lease owner changed")
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
