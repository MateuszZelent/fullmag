"""Complete one pinned post-recreation frontend refresh without service mutation.

Run from a separate helper checkout when installing this module changes the
application snapshot. The ordinary backend source equality is never relaxed.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

from docker_build_control import BuildControl, canonical, toolchain_configuration
from docker_volume_reconcile import (SHA, TOKEN, digest, fingerprint, read_raw,
    require, validate_incarnation, validate_original_owner, write_immutable)

SCHEMA = "fullmag.docker-frontend-refresh-completion.v1"
ERROR = "Retained source/runtime bind differs: /opt/fullmag/source"
MARKED_FILES = ("Cargo.toml", "Cargo.lock", "apps/control-room/package.json")


def helper_source():
    root = Path(__file__).resolve().parent.parent
    commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True, stdout=subprocess.PIPE).stdout.decode().strip()
    status = subprocess.run(["git", "-C", str(root), "status", "--porcelain"],
        check=True, stdout=subprocess.PIPE).stdout
    require(not status, "Helper checkout must be clean and committed")
    files = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--", "scripts"],
        check=True, stdout=subprocess.PIPE).stdout.decode().split("\0")
    modules = {name: digest((root / name).read_bytes()) for name in files if name.endswith(".py")}
    require("scripts/docker_volume_frontend_refresh_reconcile.py" in modules,
            "Completion controller must belong to pinned helper commit")
    for module in tuple(sys.modules.values()):
        name = getattr(module, "__file__", None)
        if name and Path(name).suffix == ".py" and Path(name).resolve().parent.name == "scripts":
            path = Path(name).resolve()
            require(root in path.parents, "Executed launcher module is outside helper checkout")
    return {"root": str(root), "commit": commit, "modules": modules}


def container_pin(actual):
    return {"id": actual["Id"], "image": actual["Image"],
            "started_at": actual["State"]["StartedAt"], "fingerprint": fingerprint(actual)}


def validate_request(r):
    require(isinstance(r, dict) and set(r) == {"schema", "attempt", "base_attempt",
        "source_root", "source_commit", "compose_project", "control_volume", "port",
        "controller_sha256", "helper_source", "evidence"} and r["schema"] == SCHEMA,
        "Frontend completion request keys/schema differ")
    require(all(isinstance(r[k], str) and TOKEN.fullmatch(r[k])
                for k in ("attempt", "base_attempt")), "Exact attempt pins required")
    require(isinstance(r["source_commit"], str) and len(r["source_commit"]) == 40
            and all(c in "0123456789abcdef" for c in r["source_commit"]), "Invalid source commit")
    require(isinstance(r["controller_sha256"], str) and SHA.fullmatch(r["controller_sha256"]),
            "Controller pin required")
    require(type(r["port"]) is int and 1024 <= r["port"] <= 65535, "Invalid port")
    require(isinstance(r["source_root"], str) and Path(r["source_root"]).is_absolute(),
            "Absolute application source required")
    require(isinstance(r["evidence"], dict) and bool(r["evidence"]), "Pinned observation required")


def validate_unknown(original, previous, document, control, source, attempt, base_attempt):
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("phase") == "development"
        and original.get("state") == "outcome-unknown-resources-retained"
        and original.get("error") == ERROR
        and original.get("attempt") == attempt
        and original.get("compose_project") == control.project
        and original.get("control_volume") == control.volume
        and original.get("helper_container") == "fullmag-control-" + attempt,
        "Only the exact post-recreation frontend bind failure is supported")
    inputs = original.get("inputs", {})
    require(inputs.get("frontend_refresh_from_attempt") == base_attempt
        and inputs.get("source_root") == str(source)
        and inputs.get("native_build_requested") is False
        and not inputs.get("helper_transition")
        and not original.get("saved_authoring_restore_required"),
        "Unknown operation is not an ordinary source-matching frontend refresh")
    require(previous.get("state") in {"succeeded", "failed-confirmed"} and previous.get("attempt") == base_attempt
        and previous.get("compose_project") == control.project
        and previous.get("state_root") == original.get("state_root")
        and previous.get("backend_volumes") == original.get("backend_volumes")
        and previous.get("frontend_volume") == original.get("previous_frontend_volume")
        and isinstance(inputs.get("frontend_refresh_from_config_sha256"), str)
        and SHA.fullmatch(inputs["frontend_refresh_from_config_sha256"])
        and document.get("name") == control.project,
        "Original development authority/resources differ")
    require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1",
            "Completion never repeats startup Solve")


def file_identity(path):
    path = Path(path)
    require(not path.is_symlink(), "Identity path must not be a symlink")
    before = path.stat()
    value = {"device": before.st_dev, "inode": before.st_ino}
    if path.is_file():
        require(before.st_size <= 16 * 1024 * 1024, "Marked file exceeds bound")
        value["sha256"] = digest(path.read_bytes())
    else:
        require(path.is_dir(), "Identity path must be file or directory")
    after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            "Identity path changed during observation")
    return value


IDENTITY_SCRIPT = '''import hashlib,json,os,sys
p=sys.argv[1]
if os.path.islink(p):raise RuntimeError("Identity path is a symlink")
a=os.stat(p);v={"device":a.st_dev,"inode":a.st_ino}
if os.path.isfile(p):
 if a.st_size>16*1024*1024:raise RuntimeError("Marked file exceeds bound")
 with open(p,"rb") as f:v["sha256"]=hashlib.sha256(f.read(16*1024*1024+1)).hexdigest()
elif not os.path.isdir(p):raise RuntimeError("Invalid identity path")
b=os.stat(p)
if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns):raise RuntimeError("Identity changed")
print(json.dumps(v,sort_keys=True))
'''


def guest_identity(identifier, path):
    import docker_volume_dev as dev
    return json.loads(dev.docker_text("exec", identifier, "/usr/local/bin/python3", "-B",
                                      "-c", IDENTITY_SCRIPT, str(path)))


def derive_document(document, actual, source, identity=file_identity, guest=guest_identity):
    """Repin only aliases independently anchored in an already trusted backend."""
    result = copy.deepcopy(document)
    backend = document["services"]["backend"]
    front = result["services"]["frontend"]
    trusted = backend.get("x-fullmag-daemon-binds", {})
    backend_mounts = {m["Destination"]: m for m in actual["backend"]["Mounts"]}
    front_mounts = {m["Destination"]: m for m in actual["frontend"]["Mounts"]}
    require(len(backend_mounts) == len(actual["backend"]["Mounts"])
            and len(front_mounts) == len(actual["frontend"]["Mounts"]), "Duplicate mount destination")
    source_mount = next((m for m in backend["volumes"] if m["target"] == "/opt/fullmag/source"), None)
    require(source_mount is not None and Path(source_mount["source"]).resolve() == source.resolve(),
            "Trusted backend is not bound to selected host source")
    witness = {}
    for mount in front["volumes"]:
        if mount.get("type") != "bind":
            continue
        target = mount["target"]
        observed = front_mounts.get(target, {})
        pin = front.get("x-fullmag-daemon-binds", {}).get(target)
        if observed.get("Source") == pin:
            continue
        require(mount.get("read_only") is True and observed.get("Type") == "bind"
                and observed.get("RW") is False, "Only readonly frontend binds can be repinned")
        host = Path(mount["source"]).resolve(strict=True)
        candidates = []
        for bm in backend["volumes"]:
            if bm.get("type") != "bind" or bm.get("read_only") is not True:
                continue
            base = Path(bm["source"]).resolve(strict=True)
            if host == base or base in host.parents:
                candidates.append((len(base.parts), bm, base))
        require(bool(candidates), "Frontend bind lacks independent backend anchor")
        _, bm, base = max(candidates, key=lambda item: item[0])
        anchor = backend_mounts.get(bm["target"], {})
        alias = trusted.get(bm["target"])
        require(isinstance(alias, str) and alias.startswith("/run/desktop/mnt/host/wsl/")
                and anchor.get("Source") == alias and anchor.get("Type") == "bind"
                and anchor.get("RW") is False, "Backend daemon alias is not independently trusted")
        suffix = host.relative_to(base).as_posix()
        suffix = "" if suffix == "." else "/" + suffix
        if not suffix:
            require(observed.get("Source") == alias,
                    "Frontend root source differs from trusted backend alias")
        else:
            require(isinstance(observed.get("Source"), str)
                    and observed["Source"].startswith("/run/desktop/mnt/host/wsl/"),
                    "Frontend descendant lacks a WSL daemon alias")
        backend_path = bm["target"] + suffix
        paths = [(host, backend_path, target)]
        if host == source.resolve():
            paths += [(host / p, backend_path + "/" + p, target + "/" + p) for p in MARKED_FILES]
        elif host.is_dir():
            # Docker Desktop may allocate a separate opaque alias per child bind.
            # Prove that alias with the independent backend view and actual bytes.
            marker = None
            examined = 0
            for directory, folders, files in os.walk(host, followlinks=False):
                examined += 1
                require(examined < 256, "Descendant marker inventory exceeds its bound")
                folders[:] = sorted(f for f in folders if not (Path(directory) / f).is_symlink())
                for name in sorted(files):
                    examined += 1
                    hp = Path(directory) / name
                    if not hp.is_symlink() and hp.is_file() and hp.stat().st_size <= 16 * 1024 * 1024:
                        marker = hp.relative_to(host).as_posix()
                        break
                    require(examined < 256, "No bounded descendant marker file")
                if marker is not None:
                    break
            require(marker is not None, "Descendant bind requires a marked regular file")
            paths.append((host / marker, backend_path + "/" + marker, target + "/" + marker))
        rows = []
        for hp, bp, fp in paths:
            expected = identity(hp)
            require(expected == guest(actual["backend"]["Id"], bp)
                    == guest(actual["frontend"]["Id"], fp), "Host/backend/frontend file identity differs")
            rows.append({"host": str(hp), "backend": bp, "frontend": fp, "identity": expected})
        front.setdefault("x-fullmag-daemon-binds", {})[target] = observed["Source"]
        witness[target] = {"backend_target": bm["target"], "daemon_source": observed["Source"], "files": rows}
    require("/opt/fullmag/source" in witness, "Missing bounded source namespace repair")
    return result, witness


def observe(control, source, attempt, base_attempt, port):
    import docker_volume_dev as dev
    import docker_dev_codegen as codegen
    from docker_development_inputs import describe, frontend_view
    root = "development/attempts/" + attempt
    base = "development/attempts/" + base_attempt
    paths = ["active", root + "/receipt.json", root + "/compose.json", root + "/rollback-compose.json",
             root + "/backend-cache.json", root + "/frontend-seed.json", root + "/backend-build-receipt.json", root + "/provenance.json",
             base + "/terminal.json", "development/current.json",
             "frontend/development-inputs.json"]
    raw = {p: read_raw(control, p) for p in paths}
    optional_paths = ("development/verified.json", "iteration/current.json", "iteration/verified.json",
                      "resume/current.json", "resume/verified.json")
    for p in optional_paths:
        raw[p] = read_raw(control, p, optional=True)
    require(raw["active"].strip() == attempt.encode(), "Foreign active operation")
    require(read_raw(control, root + "/terminal.json", optional=True) is None, "Already terminal")
    current = json.loads(raw["development/current.json"])
    require(current.get("compose_project") == control.project
            and current.get("phase") == "development"
            and current.get("state") in {"failed-confirmed", "succeeded"}
            and current.get("inputs", {}).get("source_root") == str(source)
            and (current.get("attempt") == base_attempt
                 or current.get("inputs", {}).get("frontend_refresh_from_attempt") == base_attempt),
            "Development current pointer belongs to another lineage")
    original = json.loads(raw[root + "/receipt.json"])
    previous = json.loads(raw[base + "/terminal.json"])
    document = json.loads(raw[root + "/compose.json"])
    validate_unknown(original, previous, document, control, source, attempt, base_attempt)
    rollback = json.loads(raw[root + "/rollback-compose.json"])
    require(digest(canonical(rollback)) == original["inputs"]["frontend_refresh_from_config_sha256"]
            and document["services"]["backend"] == rollback["services"]["backend"],
            "Refresh changed retained backend declaration")
    actual = {}
    for name, identifier in (("backend", dev.compose_capture(document, "ps", "--all", "--quiet", "backend").decode().strip()),
                             ("frontend", dev.compose_capture(document, "ps", "--all", "--quiet", "frontend").decode().strip()),
                             ("lease", original["helper_container"])):
        require(name == "lease" or SHA.fullmatch(identifier), "Invalid container ID")
        values = json.loads(dev.docker_text("inspect", identifier))
        require(len(values) == 1, "Ambiguous retained container")
        actual[name] = values[0]
        require(values[0]["State"].get("Running") is True, "Retained container not running")
        if name != "lease":
            require(values[0]["State"].get("Health", {}).get("Status") == "healthy", "Service not healthy")
    old_frontend = previous.get("frontend_container")
    authority = previous if previous.get("state") == "succeeded" else None
    for phase in ("resume", "iteration"):
        value = raw[phase + "/verified.json"]
        if value is None:
            continue
        candidate = json.loads(value)
        if (candidate.get("state") == "succeeded"
                and candidate.get("inputs", {}).get("attempt") == base_attempt
                and candidate.get("inputs", {}).get("config_sha256") == original["inputs"]["frontend_refresh_from_config_sha256"]):
            require(value == raw[phase + "/current.json"], "Continuation authority superseded")
            token = candidate.get("attempt")
            require(isinstance(token, str) and TOKEN.fullmatch(token), "Invalid continuation attempt")
            relative = phase + "/attempts/" + token + "/terminal.json"
            raw[relative] = read_raw(control, relative)
            require(raw[relative] == value, "Continuation terminal CAS differs")
            require(candidate.get("compose_project") == control.project
                    and candidate.get("state_root") == original.get("state_root")
                    and candidate.get("backend_volumes") == original.get("backend_volumes"),
                    "Continuation resources differ")
            authority = candidate
            old_frontend = candidate.get("frontend_container", old_frontend)
    require(authority is not None and authority.get("backend_container") == actual["backend"]["Id"]
            and authority.get("backend_started_at") == actual["backend"]["State"]["StartedAt"]
            and isinstance(old_frontend, str) and actual["frontend"]["Id"] != old_frontend,
            "Refresh lacks authenticated successful backend continuation")
    control._inspect_operation_helper({"receipt": original}, expected_id=actual["lease"]["Id"])
    lease_log = dev.docker_text("logs", actual["lease"]["Id"])
    require(lease_log.splitlines() == ["READY", "LOGGED"],
            "Original helper has not durably consumed its build log")
    derived, witness = derive_document(document, actual, source)
    for name in ("backend", "frontend"):
        image = json.loads(dev.docker_text("image", "inspect", actual[name]["Image"]))[0]
        dev._validate_retained_service(derived, actual[name], name, image["Config"])
        require(actual[name]["Image"] == derived["services"][name]["image"], "Service image differs")
    import docker_backend_volume_cache as cache_adapter
    cache_adapter.validate_container(actual["backend"], json.loads(raw[root + "/backend-cache.json"]))
    ids = {n: actual[n]["Id"] for n in ("backend", "frontend")}
    dev._assert_private_restart_network(actual, ids, control.project)
    require(str(derived["services"]["frontend"]["environment"]["FULLMAG_FRONTEND_HOST_PORT"]) == str(port), "Port differs")
    package, provenance, package_sha, binary = codegen._backend_documents(ids["backend"])
    backend, provenance_sha, binary_sha = codegen._validate_backend(package, provenance, package_sha, binary)
    probe, _ = codegen._probe_source(ids["backend"], attempt)
    require(codegen._source_matches(probe, backend),
            "Native source snapshot differs; use a separate pinned helper checkout")
    require(package == json.loads(raw[root + "/backend-build-receipt.json"])
            and provenance == json.loads(raw[root + "/provenance.json"]), "Retained package publication differs")
    inputs = json.loads(raw["frontend/development-inputs.json"])
    require(describe(source, port)["files"] == inputs["files"], "Frontend seed changed")
    view = frontend_view(ids["frontend"], source, port, inputs=inputs)
    state = Path(original["state_root"])
    host = dev._session_host()
    dev._retained_certificate(state, derived)
    owner = host.read_owned_regular(state / host.OWNER_NAME)
    certificate = host.read_owned_regular(dev._certificate_path(state))
    require(canonical(json.loads(owner)) == canonical(json.loads(certificate))
            and json.loads(certificate).get("restart_verified") is True, "Storage owner/certificate differs")
    health = dev._frontend_recovery_backend_observation(ids["backend"], allow_empty=True)
    require(health.get("active_session") is False, "Completion requires empty healthy API")
    evidence = {"documents": {p: digest(v) if v is not None else None for p, v in raw.items()},
        "containers": {n: container_pin(a) for n, a in actual.items()},
        "lease_log_sha256": digest(lease_log.encode()), "derived_compose_sha256": digest(canonical(derived)), "namespace_witness": witness,
        "package": {"receipt": package_sha, "provenance": provenance_sha, "binary": binary_sha,
                    "source": backend}, "storage": {"owner": digest(owner), "certificate": digest(certificate)},
        "frontend_source_view": view, "frontend_volume": document["volumes"]["frontend-build"]["name"],
        "backend_observation": health}
    return evidence, original, derived


def transaction_script(control, r, request_sha, result_sha, derived_sha):
    """Observer lock + original operation lock, CAS, retained staged publication."""
    root = "development/attempts/" + r["attempt"]
    path = control.path(root)
    journal = control.path(root + "/completion/" + request_sha)
    q = shlex.quote
    script = "umask 027; "
    script += f"test ! -L {q(path + '/reconcile-observer.lock')}; "
    script += f"exec 9>{q(path + '/reconcile-observer.lock')}; flock -n 9; "
    script += "exec 8<>/control/operation.lock; if flock -n 8; then exit 72; fi; "
    script += f"test \"$(cat /control/active)\" = {q(r['attempt'])}; "
    for relative, sha in r["evidence"]["documents"].items():
        target = control.path(relative)
        if sha is None:
            script += f"test ! -e {q(target)}; test ! -L {q(target)}; "
            continue
        script += f"test ! -L {q(target)}; test -f {q(target)}; test $(stat -c %h {q(target)}) = 1; "
        script += f"test \"$(sha256sum {q(target)} | cut -d' ' -f1)\" = {q(sha)}; "
    script += f"test ! -e {q(path + '/terminal.json')}; printf 'READY\\n'; "
    script += 'IFS= read -r decision; test "$decision" = BEGIN; trap "" PIPE; printf "OBSERVING\\n"; '
    script += "retain_unknown() { printf 'RETAINED\\n' || true; while :; do sleep 1; done; }; "
    # Any interruption after BEGIN retains the observer, so another apply cannot race.
    script += 'if ! IFS=" " read -r decision value extra; then retain_unknown; fi; '
    script += f'if test "$decision" != COMMIT || test "$value" != {q(result_sha)} || test -n "$extra"; then retain_unknown; fi; '
    script += "publish() { "
    for name, sha in (("result.json", result_sha), ("compose.json", derived_sha),
                      ("frontend-source-view.json", digest(canonical(r["evidence"]["frontend_source_view"])))):
        script += f"test \"$(sha256sum {q(journal + '/' + name)} | cut -d' ' -f1)\" = {q(sha)} || return 1; "
    targets = [(journal + "/compose.json", path + "/compose.json"),
               (journal + "/frontend-source-view.json", path + "/frontend-source-view.json")]
    targets += [(journal + "/result.json", control.path(p)) for p in
                (root + "/receipt.json", "development/current.json", "development/verified.json", root + "/terminal.json")]
    for src, dst in targets:
        script += (f"test ! -L {q(dst)} || return 1; parent=$(dirname {q(dst)}); "
                   'test "$(readlink -f "$parent")" = "$parent" || return 1; '
                   't=$(mktemp "$parent/.completion.XXXXXXXX") || return 1; '
                   f"cat {q(src)} > \"$t\" && sync \"$t\" && mv -T -- \"$t\" {q(dst)} && sync \"$parent\" || return 1; ")
    return script + "}; publish || retain_unknown; printf 'COMMITTED\\n'"


def completed(control, r, request_sha):
    root = "development/attempts/" + r["attempt"]
    terminal = read_raw(control, root + "/terminal.json", optional=True)
    if terminal is None:
        return False
    result = json.loads(terminal)
    require(result.get("state") == "succeeded" and result.get("frontend_refresh_completion", {}).get("request_sha256") == request_sha,
            "Foreign terminal publication")
    for p in (root + "/receipt.json", "development/current.json", "development/verified.json",
              root + "/completion/" + request_sha + "/result.json"):
        require(read_raw(control, p) == terminal, "Partial terminal publication; retain lease and journal")
    require(digest(read_raw(control, root + "/completion/" + request_sha + "/original-compose.json"))
            == r["evidence"]["documents"][root + "/compose.json"], "Original Compose archive differs")
    require(digest(read_raw(control, root + "/unknown-receipt.json"))
            == r["evidence"]["documents"][root + "/receipt.json"], "Original receipt archive differs")
    require(digest(read_raw(control, root + "/compose.json")) == r["evidence"]["derived_compose_sha256"], "Derived Compose differs")
    return True


def prepare(control, source, attempt, base_attempt, port):
    require(TOKEN.fullmatch(attempt) and TOKEN.fullmatch(base_attempt), "Exact attempts required")
    evidence, _, _ = observe(control, source, attempt, base_attempt, port)
    r = {"schema": SCHEMA, "attempt": attempt, "base_attempt": base_attempt,
        "source_root": str(source), "source_commit": evidence["package"]["source"]["commit"],
        "compose_project": control.project, "control_volume": control.volume, "port": port,
        "controller_sha256": digest(Path(__file__).read_bytes()), "helper_source": helper_source(), "evidence": evidence}
    validate_request(r)
    raw = canonical(r)
    relative = "verification/frontend-refresh-completion/" + digest(raw) + "/request.json"
    write_immutable(control, relative, raw)
    return {"request": relative, "request_sha256": digest(raw), "control_volume": control.volume}


def apply(control, source, relative, request_sha):
    require(isinstance(request_sha, str) and SHA.fullmatch(request_sha), "Request digest required")
    raw = read_raw(control, relative)
    require(digest(raw) == request_sha, "Request CAS differs")
    r = json.loads(raw); validate_request(r)
    require(r["source_root"] == str(source) and r["compose_project"] == control.project
            and r["control_volume"] == control.volume
            and r["controller_sha256"] == digest(Path(__file__).read_bytes()), "Helper/source/group differs")
    require(helper_source() == r["helper_source"], "Pinned helper checkout/commit/modules changed")
    if completed(control, r, request_sha):
        deadline = time.monotonic() + 30
        while read_raw(control, "active", optional=True) is not None:
            require(read_raw(control, "active").strip() == r["attempt"].encode(), "Foreign active operation after completion")
            require(time.monotonic() < deadline, "Terminal exists but original helper retirement unconfirmed")
            time.sleep(.25)
        return {"state": "succeeded", "replay": True, "lease_retired": True}
    evidence, original, derived = observe(control, source, r["attempt"], r["base_attempt"], r["port"])
    require(evidence == r["evidence"], "Prepared evidence changed")
    root = "development/attempts/" + r["attempt"]
    journal = root + "/completion/" + request_sha
    result = copy.deepcopy(original)
    result.pop("error", None)
    result.update(state="succeeded", finished_at=time.time(), config_sha256=evidence["derived_compose_sha256"],
        frontend_volume=evidence["frontend_volume"], backend_container=evidence["containers"]["backend"]["id"],
        frontend_container=evidence["containers"]["frontend"]["id"],
        backend_started_at=evidence["containers"]["backend"]["started_at"],
        source_commit=evidence["package"]["source"]["commit"], source_digest=evidence["package"]["source"]["source_digest"],
        source_snapshot_sha256=evidence["package"]["source"]["snapshot"],
        backend_build_receipt_sha256=evidence["package"]["receipt"], native_build_executed=False,
        previous_development_attempt=r["base_attempt"],
        previous_config_sha256=original["inputs"]["frontend_refresh_from_config_sha256"],
        url="http://127.0.0.1:" + str(r["port"]), frontend_refresh_completion={"schema": SCHEMA,
            "request": relative, "request_sha256": request_sha, "services_mutated": False,
            "original_compose": journal + "/original-compose.json"})
    existing_result = read_raw(control, journal + "/result.json", optional=True)
    if existing_result is not None:
        result["finished_at"] = json.loads(existing_result).get("finished_at")
    result_raw = canonical(result) + b"\n"
    write_immutable(control, journal + "/result.json", result_raw)
    write_immutable(control, journal + "/compose.json", canonical(derived))
    write_immutable(control, journal + "/frontend-source-view.json", canonical(evidence["frontend_source_view"]))
    write_immutable(control, journal + "/original-compose.json", read_raw(control, root + "/compose.json"))
    write_immutable(control, root + "/unknown-receipt.json", read_raw(control, root + "/receipt.json"))
    name = "fullmag-frontend-completion-" + uuid.uuid4().hex
    helper = subprocess.Popen(control.helper_args(transaction_script(control, r, request_sha,
        digest(result_raw), digest(canonical(derived))), name=name), stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        require(control._line(helper) == "READY", "Completion observer CAS/lease refused")
        helper.stdin.write(b"BEGIN\n"); helper.stdin.flush()
        require(control._line(helper) == "OBSERVING", "Observer BEGIN outcome unknown; retain resources")
        repeated, _, _ = observe(control, source, r["attempt"], r["base_attempt"], r["port"])
        require(repeated == evidence, "Evidence changed under observer fence")
        helper.stdin.write(("COMMIT " + digest(result_raw) + "\n").encode()); helper.stdin.flush(); helper.stdin.close()
        require(control._line(helper) == "COMMITTED", "Completion outcome unknown; retain exact observer/journal")
        require(helper.wait(timeout=30) == 0, "Completion observer did not exit")
    finally:
        if not helper.stdin.closed:
            helper.stdin.close()
    require(completed(control, r, request_sha), "Completion publication absent")
    deadline = time.monotonic() + 30
    while read_raw(control, "active", optional=True) is not None:
        require(time.monotonic() < deadline, "Terminal published; original helper lease retirement unconfirmed")
        time.sleep(.25)
    return {"state": "succeeded", "attempt": r["attempt"], "services_mutated": False, "lease_retired": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--attempt")
    parser.add_argument("--base-attempt")
    parser.add_argument("--port", type=int)
    parser.add_argument("--request")
    parser.add_argument("--request-sha256")
    args = parser.parse_args()
    require(args.prepare != args.apply, "Select prepare or apply")
    from docker_dev import _select_source, _compose_identity
    source, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    cfg = toolchain_configuration(source, identity)
    control = BuildControl(identity, cfg["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    if args.prepare:
        require(args.attempt and args.base_attempt and args.port and not args.request and not args.request_sha256,
                "Prepare requires attempts and port only")
        result = prepare(control, source, args.attempt, args.base_attempt, args.port)
    else:
        require(args.request and args.request_sha256 and not args.attempt and not args.base_attempt and not args.port,
                "Apply requires exact request and digest only")
        result = apply(control, source, args.request, args.request_sha256)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
