"""Managed preview/apply of one terminal activation's preserved history.

The existing Compose group, volume and operation lock are retained. The helper
has no network, GPU or Docker socket. SessionStore and scientific output mounts
are read-only; only authenticated control-history records can be moved.
"""
from __future__ import annotations

import argparse
import ast
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import uuid

from docker_activation_history_policy import (
    ATTEMPT, SHA, SCHEMA, HistoryError, canonical, digest, document, qualify_activation, qualify_rejected_activation,
)
from docker_activation_history_storage import (
    _directory, _raw, _locked, apply_plan, make_plan, source_files,
)
from docker_activation_history_inventory import (
    control_references, source_inventory, validate_existing_archives,
)
from docker_activation_history_output import validate_preserved_run
from docker_build_control import BuildControl, BuildControlError, bounded_capture, docker_capture
from docker_activation_history_admission import (
    ReadOnlyBuildControl, historical_mounts, ledger_evidence,
    validate_backend_control_mounts, validate_control_pins, writer_barriers,
)


EXPORT_SCHEMA = "fullmag.activation-provenance-export.v1"
MAX_INPUT = 8 * 1024 * 1024


def authored_zarr(raw):
    """Resolve one canonical /user-data Zarr target without executing source."""
    try:
        tree = ast.parse(raw.decode("utf-8"))
    except (ValueError, SyntaxError) as error:
        raise HistoryError("Archived script cannot be parsed") from error

    storage_calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "storage"
    ]
    if len(storage_calls) != 1:
        raise HistoryError("Historical script needs one storage call for archival qualification")
    values = [keyword.value for keyword in storage_calls[0].keywords
              if keyword.arg == "output_dir"]
    if len(values) != 1:
        raise HistoryError("Historical script needs one output_dir for archival qualification")

    value = values[0]
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        output = value.value
    elif isinstance(value, ast.Name) and isinstance(value.ctx, ast.Load):
        name = value.id
        if any(isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names)
               for node in ast.walk(tree)):
            raise HistoryError("Historical output name can be overwritten by a wildcard import")
        bindings = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                if node.id == name:
                    bindings.append(node)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if node.name == name:
                    bindings.append(node)
            elif isinstance(node, ast.arg) and node.arg == name:
                bindings.append(node)
            elif isinstance(node, ast.alias):
                bound_name = node.asname or node.name.split(".", 1)[0]
                if bound_name == name:
                    bindings.append(node)
            elif isinstance(node, ast.ExceptHandler) and node.name == name:
                bindings.append(node)
            elif isinstance(node, (ast.Global, ast.Nonlocal)) and name in node.names:
                bindings.append(node)
            elif node.__class__.__name__ == "MatchAs" and getattr(node, "name", None) == name:
                bindings.append(node)
            elif node.__class__.__name__ == "MatchStar" and getattr(node, "name", None) == name:
                bindings.append(node)
            elif node.__class__.__name__ == "MatchMapping" and getattr(node, "rest", None) == name:
                bindings.append(node)

        assignment = None
        for statement in tree.body:
            if (isinstance(statement, ast.Assign) and len(statement.targets) == 1
                    and isinstance(statement.targets[0], ast.Name)
                    and statement.targets[0].id == name):
                if assignment is not None:
                    raise HistoryError("Historical output name is assigned more than once")
                assignment = statement
        if (assignment is None or len(bindings) != 1
                or bindings[0] is not assignment.targets[0]
                or not isinstance(assignment.value, ast.Constant)
                or not isinstance(assignment.value.value, str)):
            raise HistoryError("Historical output name is not one stable module-level string literal")
        output = assignment.value.value
    else:
        raise HistoryError("Historical output_dir is not a literal string or stable module-level name")

    target = PurePosixPath(output)
    if (str(target) != output or not str(target).startswith("/user-data/")
            or ".." in target.parts or target.suffix != ".zarr"):
        raise HistoryError("Historical output is not a canonical /user-data Zarr directory")
    return target


def preserved_output(output_root, request, files):
    root = _directory(output_root)
    name = request["output_name"]
    if not isinstance(name, str) or PurePosixPath(name).name != name or not name.endswith(".zarr"):
        raise HistoryError("Preserved output name is invalid")
    zarr = _directory(root / name)
    group = document(_raw(zarr / ".zgroup"), "Zarr group")
    if group.get("zarr_format") != 2:
        raise HistoryError("Historical Zarr schema is not qualified by this archival recipe")
    candidate = document(files["receipt.json"], "receipt")
    script = zarr.with_suffix(".py")
    script_raw = _raw(script)
    if digest(script_raw) != candidate["source_sha256"]:
        raise HistoryError("Adjacent preserved Python source differs from the activated script")
    export_path = zarr.with_suffix(".activation-" + request["attempt"] + ".json")
    export_raw = _raw(export_path)
    export = document(export_raw, "preserved provenance")
    expected_records = {name: base64.b64encode(raw).decode("ascii") for name, raw in sorted(files.items())}
    if (export.get("schema") != EXPORT_SCHEMA or export.get("attempt") != request["attempt"]
            or export.get("run_id") != candidate["run_id"] or export.get("records") != expected_records
            or export.get("source_sha256") != candidate["source_sha256"]
            or export.get("zarr_name") != name):
        raise HistoryError("Host provenance does not preserve the exact activation records")
    output = validate_preserved_run(zarr, candidate["run_id"])
    if PurePosixPath(output["output_dir"]).parents[1] != authored_zarr(script_raw):
        raise HistoryError("Preserved run output differs from the authored Zarr path")
    return {"script_sha256": digest(script_raw), "provenance_sha256": digest(export_raw),
            "zarr_root_metadata": {name: digest(_raw(zarr / name)) for name in (".zgroup", ".zattrs")},
            "run": output}


REJECTED_EXPORT_SCHEMA = "fullmag.activation-rejection-provenance-export.v1"


def preserved_rejection(output_root, request, files):
    root = _directory(output_root)
    name = request.get("source_filename")
    if not isinstance(name, str) or PurePosixPath(name).name != name or not name.endswith(".py"):
        raise HistoryError("Rejected source filename is invalid")
    receipt = document(files["receipt.json"], "receipt")
    source_sha = digest(_raw(root / name))
    export_path = root / (Path(name).stem + ".activation-" + request["attempt"] + ".json")
    export_raw = _raw(export_path)
    export = document(export_raw, "preserved rejection provenance")
    records = {name: base64.b64encode(raw).decode("ascii") for name, raw in sorted(files.items())}
    if (source_sha != receipt["source_sha256"] or export != {
            "schema": REJECTED_EXPORT_SCHEMA, "attempt": request["attempt"],
            "source_sha256": source_sha, "request_id": receipt["request_id"], "records": records}):
        raise HistoryError("Host rejection export does not preserve exact source and control records")
    return {"source_sha256": source_sha, "provenance_sha256": digest(export_raw), "kind": "rejected-no-run-v1"}


def rejected_store_records(store_root):
    from docker_volume_offline_reconcile import _metadata_file, _read_store_file
    paths = sorted(str(path.relative_to(store_root)) for path in store_root.rglob("*"))
    records = {path: _read_store_file(store_root, path)[0] for path in paths
               if path.endswith(".json") and (_metadata_file(path)
                   or any(word in path.casefold() for word in ("admission", "idempotency", "intake", "intent")))}
    return records, paths


def collect_guest(root, request, *, source_root, store_root, output_root):
    from docker_volume_offline_reconcile import _inventory_store, _read_store_file
    if source_inventory(source_root) != request["source_files"]:
        raise HistoryError("Launcher sources changed since host admission")
    validate_control_pins(root, request["admission_pins"])
    identity = request["identity"]
    if identity["namespace"]:
        registry = Path("/registry")
        if (digest(_raw(registry / "namespaces/current.json")) != identity["namespace_registry_sha256"]
                or (root / "operation.lock").stat().st_ino != (registry / "operation.lock").stat().st_ino
                or (root / "operation.lock").stat().st_dev != (registry / "operation.lock").stat().st_dev):
            raise HistoryError("Control namespace or shared lock identity differs")
    token = request["attempt"]
    source = root / "activation/attempts" / token
    archived = root / "activation/history-v1" / token
    if source.exists() and archived.exists():
        raise HistoryError("Duplicate live/history activation")
    files = source_files(source if source.exists() else archived)
    receipt = document(files["receipt.json"], "receipt")
    store = _inventory_store(store_root)
    rejected = request.get("qualification_kind") == "rejected-no-run-v1"
    if rejected:
        records, paths = rejected_store_records(store_root)
        candidate = qualify_rejected_activation(
            token, files, project=identity["compose_project"], volume=identity["control_volume"],
            namespace=identity["namespace"], store_records=records, inventory_paths=paths)
        output_evidence = preserved_rejection(output_root, request, files)
    else:
        run_id = receipt["run_id"]
        run_root = store_root / "runs" / run_id
        leases = {str(path.relative_to(store_root)): _read_store_file(store_root, str(path.relative_to(store_root)))[0]
                  for family in ("resource_leases", "preparation_resource_leases")
                  for path in (run_root / family).rglob("*.json")}
        candidate = qualify_activation(
            token, files, project=identity["compose_project"], volume=identity["control_volume"],
            namespace=identity["namespace"],
            run_catalog_raw=_read_store_file(store_root, "runs/" + run_id + "/run_catalog.json")[0],
            run_intent_raw=_read_store_file(store_root, "runs/" + run_id + "/run_intent.json")[0],
            lease_records=leases)
        output_evidence = preserved_output(output_root, request, files)
    ledger_raw = _raw(root / "private/ledger/ledger/HOST_RESOURCE_LEDGER.json")
    ledger = ledger_evidence(ledger_raw)
    refs = control_references(root, token, owner_marker_pin=request["owner_marker_pin"],
                              qualified_rejection=(
                                  {"candidate": candidate, "files": files} if rejected else None))
    archives = validate_existing_archives(root)
    # The selected completed archive is expected during exact-plan reentry.
    archives.pop(token, None)
    evidence = {"store": {key: value for key, value in store.items() if key != "root"},
                "output": output_evidence,
                "ledger": ledger,
                "control_reference_pins": refs["pins"], "prior_archives": archives,
                "qualified_current_terminal": refs["qualified_current_terminal"],
                "admission_pins": request["admission_pins"],
                "source_files": request["source_files"], "runtime": identity}
    return candidate, refs["protected"], digest(canonical(evidence))


def guest(request):
    if (not isinstance(request, dict) or ATTEMPT.fullmatch(str(request.get("attempt", ""))) is None
            or request.get("action") not in {"preview", "apply"}
            or request.get("qualification_kind") not in {None, "rejected-no-run-v1"}):
        raise HistoryError("Malformed managed history request")
    root = Path("/control")
    source_root, store_root, output_root = Path("/opt/fullmag/source"), Path("/history-store"), Path("/history-output")
    mounts = [line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()]
    for target in (source_root, store_root, output_root):
        if not any(parts[4] == str(target) and "ro" in parts[5].split(",") for parts in mounts):
            raise HistoryError("History source/user-data mount is not read-only")
    required_mode = "ro" if request["action"] == "preview" else "rw"
    if not any(parts[4] == "/control" and required_mode in parts[5].split(",") for parts in mounts):
        raise HistoryError("History control mount mode differs")
    with writer_barriers(
            store_root,
            root / "private/ledger/ledger",
            root / "runtime-control/host-ledger-roots") as barrier_check:
        return _guest_transaction(request, root, source_root, store_root, output_root, barrier_check)


def _guest_transaction(request, root, source_root, store_root, output_root, barrier_check):
    def collect():
        barrier_check()
        result = collect_guest(root, request, source_root=source_root, store_root=store_root, output_root=output_root)
        barrier_check()
        return result
    if request["action"] == "preview":
        info = (root / "operation.lock").lstat()
        with _locked(root, {"device": info.st_dev, "inode": info.st_ino}):
            for name in ("active", "activation/unresolved.json", "cache-retirement/closing.json"):
                path = root / name
                if path.exists() or path.is_symlink():
                    raise HistoryError("Live operation/recovery blocks history preview")
            candidate, protected, evidence = collect()
            plan = make_plan(root, [candidate], identity=request["identity"],
                             external_evidence_sha256=evidence, protected=protected)
            return {"state": "preview", "plan": plan, "plan_sha256": digest(canonical(plan))}
    plan = request.get("plan")
    expected = request.get("plan_sha256")
    if (not isinstance(plan, dict) or not isinstance(expected, str) or SHA.fullmatch(expected) is None
            or plan.get("identity") != request["identity"]
            or [item.get("attempt") for item in plan.get("candidates", [])] != [request["attempt"]]):
        raise HistoryError("Apply does not identify one pinned activation plan")
    def fresh():
        candidate, protected, evidence = collect()
        if candidate != plan["candidates"][0] or request["attempt"] in protected:
            raise HistoryError("Activation qualification changed under the operation lock")
        return evidence
    receipt = apply_plan(root, plan, expected_plan_sha256=expected, fresh_external_evidence=fresh)
    if source_inventory(source_root) != request["source_files"]:
        raise HistoryError("Launcher sources changed during archival; inspect retained receipt")
    return receipt


def _consumer_inventory(control, expected_ids):
    identifiers = docker_capture("ps", "--all", "--quiet", "--no-trunc", "--filter", "volume=" + control.volume).stdout.decode().split()
    if set(identifiers) != set(expected_ids) or len(identifiers) != len(expected_ids):
        raise HistoryError("Control volume has an unknown or retained container consumer")
    rows = json.loads(docker_capture("inspect", *sorted(identifiers)).stdout)
    backend = [row for row in rows if row.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == "backend"]
    if len(backend) != 1:
        raise HistoryError("History needs one exact retained backend consumer")
    validate_backend_control_mounts(control, backend[0])
    return {row["Id"]: {"image": row["Image"], "started_at": row["State"]["StartedAt"],
                        "running": row["State"]["Running"]} for row in rows}


def _owner_marker(control, backend):
    # Read the root-owned immutable volume marker with its owner UID and the
    # directory's group. This grants no capability and changes no permissions.
    code = '''from pathlib import Path
import json,stat,hashlib
p=Path('/opt/fullmag/control/.fullmag-toolchain-control-owner.json')
s=p.lstat()
if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>16384: raise RuntimeError('unsafe owner marker')
raw=p.read_bytes()
print(json.dumps({'document':json.loads(raw),'pin':{'sha256':hashlib.sha256(raw).hexdigest(),'stat':{'inode':s.st_ino,'size':s.st_size,'mtime_ns':s.st_mtime_ns,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}}}))
'''
    result = json.loads(docker_capture("exec", "--user", "0:65532", backend, "/usr/local/bin/python3", "-B", "-c", code).stdout)
    expected = {"mount": "/opt/fullmag/control", "namespace": "/opt/fullmag/control/backend", "role": "control",
                "schema": "fullmag.docker-toolchain-control-owner.v1", "state": "owned", "volume_name": control.volume}
    if result.get("document") != expected:
        raise HistoryError("Control owner marker is not the exact ownership-only schema")
    return result["pin"]


def helper_args(control, selected, image, store_root, output_root, *, action):
    probe = ReadOnlyBuildControl(control.identity, image)
    if (probe.volume != control.volume or probe.namespace != control.namespace
            or probe.namespace_registry_sha256 != control.namespace_registry_sha256):
        raise HistoryError("History helper changed control identity")
    command = "/usr/local/bin/python3 -B /opt/fullmag/source/scripts/docker_activation_history.py --guest"
    # Only this explicit transaction helper receives a writable control mount
    # for apply. Its constructor and all host admission helpers remain RO.
    args = BuildControl.helper_args(probe, command, name="fullmag-history-" + uuid.uuid4().hex)
    if action == "preview":
        for index, value in enumerate(args[:-1]):
            if value == "--mount" and ",dst=/control," in args[index + 1]:
                args[index + 1] += ",readonly"
    anchor = args.index("--entrypoint")
    for host, target in ((selected, "/opt/fullmag/source"), (store_root, "/history-store"), (output_root, "/history-output")):
        text = str(host)
        if not host.is_absolute() or any(character in text for character in ("\n", "\r", ":", ",")):
            raise HistoryError("History bind source requires a canonical Linux path")
        args[anchor:anchor] = ["--mount", "type=bind,src=" + text + ",dst=" + target + ",readonly"]
    args[args.index("--memory") + 1] = "256m"
    return args


def _runtime_witness_pin(args):
    relative = getattr(args, "historical_runtime_witness", None)
    sha = getattr(args, "historical_runtime_witness_sha256", None)
    if relative is None and sha is None:
        return None
    if not isinstance(relative, str) or not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise HistoryError("Historical runtime witness requires both exact path and SHA-256")
    path = PurePosixPath(relative)
    if (str(path) != relative or len(path.parts) != 4
            or path.parts[0] not in {"resume", "iteration"} or path.parts[1] != "attempts"
            or not ATTEMPT.fullmatch(path.parts[2]) or path.parts[3] != "terminal.json"):
        raise HistoryError("Historical runtime witness must identify one control terminal")
    return relative, sha


def host_context(args):
    witness = _runtime_witness_pin(args)
    import fullmag_storage as storage
    from docker_development_inputs import select_checkout
    from docker_compose_identity import compose_project_identity
    from docker_build_control import toolchain_configuration
    from docker_volume_activate import _linked_runtime_terminals, _validate_running_group
    from docker_dev_host import validate_host_path
    selected = select_checkout(args.repo_root.resolve(strict=True), args.source_root).resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    configured = toolchain_configuration(selected, identity)
    image_helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = ReadOnlyBuildControl(identity, image_helper)
    if os.name != "posix":
        raise HistoryError("History v1 qualification requires the Linux/WSL host")
    volume = json.loads(docker_capture("volume", "inspect", control.volume).stdout)
    if (len(volume) != 1 or volume[0].get("Driver") != "local" or volume[0].get("Options")
            or any((volume[0].get("Labels") or {}).get(key) != value for key, value in control.shared_labels.items())):
        raise HistoryError("History control volume ownership differs")
    previous = control.read("development/current.json")
    current_root = "development/attempts/" + previous["attempt"]
    original = control.read(current_root + "/terminal.json")
    compose = control.read(current_root + "/compose.json")
    if canonical(previous) != canonical(original) or digest(canonical(compose)) != previous["config_sha256"]:
        raise HistoryError("Current development terminal/config differs")
    image = previous["inputs"]["image_id"]
    runtime_terminals = _linked_runtime_terminals(control, previous["attempt"], original,
        source_root=str(selected), image=image, config_sha256=previous["config_sha256"])
    validation_error = None
    for terminal in runtime_terminals:
        try:
            backend, frontend = _validate_running_group(control, identity, compose, terminal, image,
                                                       source_root=str(selected))
            break
        except BuildControlError as error:
            validation_error = error
    else:
        raise HistoryError("No linked terminal matches the retained group: " + str(validation_error))
    consumers = _consumer_inventory(control, [backend, frontend])
    owner = _owner_marker(control, backend)
    receipt = control.read("activation/attempts/" + args.activation + "/receipt.json")
    old_root = "development/attempts/" + receipt["development_attempt"]
    development = control.read(old_root + "/terminal.json")
    old_compose = control.read(old_root + "/compose.json")
    if canonical(development) != canonical(control.read(old_root + "/receipt.json")):
        raise HistoryError("Historical development receipt differs from terminal")
    old_state, old_user = historical_mounts(control, receipt, development, old_compose, selected,
                                          runtime_witness=witness)
    state_root = storage.validate_path(old_state, layout["runtime_root"], "historical state")
    store = _directory(state_root / "runs/docker-all/session-store")
    script_path = Path(receipt["source_root"]) / receipt["source_relative"]
    if receipt["source_root"] != str(selected) or script_path.resolve(strict=True) != script_path or not script_path.is_relative_to(selected):
        raise HistoryError("Historical source is outside the selected checkout")
    script_raw = _raw(script_path)
    if digest(script_raw) != receipt["source_sha256"]:
        raise HistoryError("Historical source no longer matches its activation")
    rejected = bool(getattr(args, "rejected_no_run", False))
    if rejected:
        zarr = script_path
    else:
        authored = authored_zarr(script_raw)
        user_root = storage.validate_path(old_user, layout["storage_root"], "historical user data")
        zarr = _directory(user_root.joinpath(*authored.parts[2:]))
    for path in (selected, store, zarr):
        validate_host_path(path, "preserved history input")
    request = {"attempt": args.activation, "action": "preview", "output_name": zarr.name,
               "source_files": source_inventory(selected), "owner_marker_pin": owner,
               "admission_pins": dict(control.read_pins),
               "identity": {"compose_project": control.project, "control_volume": control.volume,
                            "namespace": control.namespace, "namespace_registry_sha256": control.namespace_registry_sha256,
                            "source_root": str(selected), "backend_image": image, "services": consumers,
                            "store_root": str(store), "output_zarr": str(zarr)}}
    if rejected:
        request.update(qualification_kind="rejected-no-run-v1", source_filename=script_path.name)
    return control, selected, image, store, zarr.parent, request


def run(args):
    if not ATTEMPT.fullmatch(args.activation):
        raise HistoryError("History requires one exact activation ID")
    if args.apply != bool(args.plan_sha256):
        raise HistoryError("Apply requires a reviewed preview digest; preview has no apply pin")
    if args.plan_sha256 and SHA.fullmatch(args.plan_sha256) is None:
        raise HistoryError("Apply plan digest is malformed")
    control, selected, image, store, output_root, request = host_context(args)
    def invoke(value):
        result = bounded_capture(helper_args(control, selected, image, store, output_root, action=value["action"]),
                                 data=canonical(value), maximum=MAX_INPUT, timeout=300)
        if result.returncode:
            raise HistoryError(result.stderr.decode("utf-8", "replace")[-4096:] or "History helper failed")
        return document(bytes(result.stdout), "history helper result")
    retained = (control.read("activation/history-operations-v1/" + args.plan_sha256 + "/plan.json", optional=True)
                if args.apply else None)
    if retained is None:
        preview = invoke(request)
        if not args.apply:
            return preview
        if preview.get("plan_sha256") != args.plan_sha256:
            raise HistoryError("History preview changed; no records moved")
        retained = preview["plan"]
    elif digest(canonical(retained)) != args.plan_sha256:
        raise HistoryError("Retained history plan differs from its digest")
    request.update(action="apply", plan=retained, plan_sha256=args.plan_sha256)
    # Recheck all container consumers immediately before starting the bounded
    # lock-holding helper; a foreign/unknown helper refuses rather than drains.
    if _consumer_inventory(control, request["identity"]["services"]) != request["identity"]["services"]:
        raise HistoryError("Service incarnation changed before history apply")
    result = invoke(request)
    if _consumer_inventory(control, request["identity"]["services"]) != request["identity"]["services"]:
        raise HistoryError("Service incarnation changed; inspect the retained history receipt")
    return result


def main():
    if sys.argv[1:] == ["--guest"]:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise HistoryError("Managed history request exceeds its input budget")
        result = guest(document(raw, "managed history request"))
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--repo-root", type=Path, required=True)
        parser.add_argument("--source-root", type=Path, required=True)
        parser.add_argument("--activation", required=True)
        parser.add_argument("--rejected-no-run", action="store_true",
            help="Qualify one confirmed API rejection with no related RunIntent/admission/lease; preserve all bytes")
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--plan-sha256")
        parser.add_argument("--historical-runtime-witness",
            help="Pinned resume/attempts/<id>/terminal.json or iteration equivalent for a failed historical start")
        parser.add_argument("--historical-runtime-witness-sha256",
            help="Raw SHA-256 of that immutable pre-activation terminal; requires its matching receipt")
        result = run(parser.parse_args())
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HistoryError, BuildControlError, OSError, ValueError) as error:
        print("Activation history refused; resources retained: " + str(error), file=sys.stderr)
        raise SystemExit(2)
