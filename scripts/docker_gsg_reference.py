"""Managed, single-attempt postprocessing of the approved saved GSG sources."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
import re
import stat
import subprocess

from docker_build_control import (BuildControl, BuildControlError,
    canonical, docker_capture, toolchain_configuration)
from docker_dev_host import docker_argv, require_host

ROOT = "verification/gsg-source-convergence-reference-20261105/one-approved-attempt"
ATTEMPT = "/opt/fullmag/control/" + ROOT
DRIVER = "run_gsg_source_convergence_reference.py"
TOOLS = ("antenna_gsg_convergence_reference.py", "antenna_rt0_surface_oracle.py",
         "antenna_triangle_surface_oracle.py", "verify_archived_solution_http.py")
PROPOSAL_SHA = "7c61be489e0638d52bdec8324480fc24572c3ae8988fee77e8a9f8eb6c475c04"
FINE_ROOT = "verification/gsg-junction-fine-reference-20261112/one-approved-attempt"
FINE_ATTEMPT = "/opt/fullmag/control/" + FINE_ROOT
FINE86K_ROOT = "verification/gsg-junction-fine86k-reference-20261112/one-approved-attempt"
FINE86K_PROPOSAL_SHA = "bb7667f455287d43f7e127ccbc28da4dfa6f15b3795d375c7503e9eb5781e901"
FINE_SOURCE = FINE_ROOT + "/source-binding.json"
FINE_DRIVER = "run_gsg_junction_reference.py"
FINE_TOOLS = (*TOOLS, DRIVER)
FINE_PROPOSAL_SHA = "c43eb7b0c56b9673590781cebb355ee8a7f579174b98f810c6f993594c6c5198"
WHEEL = "/opt/fullmag/control/verification/universe-volume-policy-20261023/rt0-surface-reference-20261024/mpmath-1.3.0-py3-none-any.whl"
ARCHIVE_SHA = "087acfc293e919102335bfcb13330c22091473b6b1a0aad1f2363da26d6789c5"
ARCHIVE_REQUEST_SHA = "378d6de31723e26ba5261af1235065be4c13e39f97433b3b83cadeb3b738029d"
MAX_SOURCE = 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}")


def require(value, message):
    if not value:
        raise BuildControlError(message)


def fine_root(work_profile):
    require(type(work_profile) is str and work_profile in (
        "gsg_junction_fine_reference_v1","gsg_junction_fine_reference_86k_v1"),
        "Unknown fine work profile")
    return FINE_ROOT if work_profile == "gsg_junction_fine_reference_v1" else FINE86K_ROOT


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def source_files(selected, *, junction_fine=False):
    files = {}
    names = (*FINE_TOOLS, FINE_DRIVER) if junction_fine else (*TOOLS, DRIVER)
    for name in names:
        path = selected / "scripts" / name
        require(path.resolve(strict=True) == path, "Reference source must not traverse a symlink")
        before = path.stat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= MAX_SOURCE,
                "Reference source is not one bounded regular file")
        raw = path.read_bytes()
        after = path.stat()
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "Reference source changed while reading")
        files[name] = raw
    return files


def immutable(control, relative, raw):
    existing = control.read_bytes(relative, optional=True)
    require(existing is None or existing == raw, "Prepared reference input already exists with different bytes")
    if existing is None:
        control.write_bytes(relative, raw)


DIRECTORY_SYNC = r'''import os,stat,sys
from pathlib import Path
stop=Path('/opt/fullmag/control')
current=Path(sys.argv[1])
while True:
 if current.resolve(strict=True)!=current or not stat.S_ISDIR(current.lstat().st_mode):
  raise RuntimeError('Prepared reference directory is not canonical')
 fd=os.open(current,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
 if current==stop:break
 current=current.parent
'''


def sync_prepared(backend, digest, *, root=ROOT):
    docker_capture("exec", backend, "/usr/local/bin/python3", "-B", "-c", DIRECTORY_SYNC,
                   "/opt/fullmag/control/" + root + "/snapshots/" + digest + "/prepared", timeout=30)


def qualified_backend(control, selected, identity, attempt, config_sha, *, allow_no_archive=False):
    import docker_dev_codegen as codegen
    import docker_readonly_result_archive as archive
    from docker_volume_activate import _linked_runtime_terminals, _validate_running_group
    require(re.fullmatch(r"[0-9a-f]{32}", attempt) and SHA.fullmatch(config_sha), "Exact development/config pins required")
    base = "development/attempts/" + attempt
    original = control.read(base + "/terminal.json")
    document = control.read(base + "/compose.json")
    require(sha(canonical(document)) == config_sha and document.get("name") == control.project,
            "Retained Compose configuration differs")
    require(original.get("compose_project") == control.project and
            original.get("inputs", {}).get("source_root") == str(selected), "Retained source group differs")
    image = original["inputs"]["image_id"]
    terminals = _linked_runtime_terminals(control, attempt, original, source_root=str(selected), image=image, config_sha256=config_sha)
    admitted = []
    for terminal in terminals:
        try:
            admitted.append(_validate_running_group(control, identity, document, terminal, image, source_root=str(selected)))
        except BuildControlError:
            continue
    require(len(admitted) == 1, "One current admitted healthy service pair required")
    backend, observed = codegen._running_service(control.project, "backend", identity, selected, control.namespace)
    require(backend == admitted[0][0] or observed.get("Id") == admitted[0][0], "Selected backend incarnation differs")
    backend = observed["Id"]
    descriptor = archive.validate_document(document)
    require(descriptor is not None or allow_no_archive, "Approved read-only result archive required")
    if descriptor is not None:
        require(descriptor["manifest_sha256"] == ARCHIVE_SHA and descriptor["request_sha256"] == ARCHIVE_REQUEST_SHA,
                "Approved read-only result archive required")
        archive.load_request(control, selected, (descriptor["request_path"], descriptor["request_sha256"]))
        archive.validate_container(document, observed)
        environment = codegen._environment(observed)
        require(all(environment.get(key) == document["services"]["backend"]["environment"][key] for key in archive.ENV),
                "Read-only archive process environment differs")
    control_mount = codegen._mount_for(observed, "/opt/fullmag/control")
    require(control_mount.get("Name") == control.volume, "Backend control volume differs")
    codegen._validate_control_mount_subpath(observed, control_mount, "/opt/fullmag/control",
        codegen._inspect_named_volume(control.volume), control.namespace)
    receipt, provenance, receipt_sha, provenance_binary = codegen._backend_documents(backend)
    _source, provenance_sha, binary_sha = codegen._validate_backend(receipt, provenance, receipt_sha, provenance_binary)
    require(observed.get("State", {}).get("Health", {}).get("Status") == "healthy", "Backend is not healthy")
    return {"compose_project": control.project, "source_root": str(selected), "development_attempt": attempt,
            "config_sha256": config_sha, "backend_container_id": backend, "backend_image_id": observed["Image"],
            "backend_started_at": observed["State"]["StartedAt"], "backend_build_receipt_sha256": receipt_sha,
            "backend_provenance_sha256": provenance_sha, "api_binary_sha256": binary_sha,
            "archive_manifest_sha256": ARCHIVE_SHA if descriptor is not None else None}


def make_request(pins, files):
    return {**pins, "schema": "fullmag.gsg-source-convergence-reference-request.v1", "reference_checks": 9,
            "automatic_retries": 0, "proposal_sha256": PROPOSAL_SHA, "wheel": WHEEL,
            "tools": {name: sha(files[name]) for name in TOOLS}, "driver_sha256": sha(files[DRIVER])}


def make_fine_request(pins, files, source_raw, *, work_profile="gsg_junction_fine_reference_v1"):
    from run_gsg_junction_reference import validate_binding
    require(len(source_raw) <= MAX_SOURCE, "Fine source binding exceeds metadata bound")
    source = validate_binding(json.loads(source_raw),work_profile=work_profile)
    expanded=work_profile == "gsg_junction_fine_reference_86k_v1"
    return {**pins, "schema": "fullmag.gsg-junction-reference-request.v1", "reference_checks": 3,
            "automatic_retries": 0, "proposal_sha256": FINE86K_PROPOSAL_SHA if expanded else FINE_PROPOSAL_SHA, "wheel": WHEEL,
            **({"work_profile":work_profile} if expanded else {}),
            "tools": {name: sha(files[name]) for name in FINE_TOOLS},
            "driver_sha256": sha(files[FINE_DRIVER]), "source": source, "source_binding_sha256": sha(source_raw)}


def preflight_record(value, request_sha, request, *, junction_fine=False, work_profile="gsg_junction_fine_reference_v1"):
    require(value.get("status") == "PREFLIGHT PASS" and value.get("reference_evaluations") == 0 and
            value.get("new_solve") is False and isinstance(value.get("dependency"), dict),
            "Driver did not confirm zero-evaluation preflight")
    cases = value.get("cases")
    require(isinstance(cases, list) and len(cases) == (1 if junction_fine else 3), "Preflight source closure differs")
    labels = ("corner12p5",) if junction_fine else ("100nm", "75nm", "50nm")
    counts = (request["source"]["cells"],) if junction_fine else (14299, 25516, 72911)
    for row, label, count in zip(cases, labels, counts):
        require(row.get("label") == label and row.get("cells") == count and
                all(isinstance(row.get(key), str) and SHA.fullmatch(row[key]) for key in
                    ("source_state_sha256", "prepared_execution_sha256", "bundle_sha256", "ir_sha256")) and
                all(isinstance(row.get(key), str) and row[key] for key in ("run_id", "solution_set_id", "revision")) and
                isinstance(row.get("source_current_a"), (int, float)) and isinstance(row.get("payloads"), dict) and
                len(row["payloads"]) == 10 and all(isinstance(payload, dict) and
                    isinstance(payload.get("sha256"), str) and SHA.fullmatch(payload["sha256"]) and
                    type(payload.get("byte_length")) is int and payload["byte_length"] > 0
                    for payload in row["payloads"].values()), "Preflight source pins are incomplete")
    if junction_fine:
        row, source = cases[0], request["source"]
        require(all(row.get(key) == source[key] for key in
                    ("ir_sha256", "bundle_sha256", "source_state_sha256", "prepared_execution_sha256"))
                and all(row.get(key) == source["run"][key] for key in ("run_id", "solution_set_id", "revision"))
                and type(row.get("source_current_a")) in (int, float)
                and math.isfinite(row["source_current_a"])
                and struct.pack("<d", row["source_current_a"]) == struct.pack("<d", source["source_current_a"]),
                "Fine preflight source identity or signed current differs")
        require({field.get("field_id"): field.get("payload_sha256") for field in row.get("http_fields", [])} ==
                {field["field_id"]: field["payload_sha256"] for field in source["run"]["datasets"]},
                "Fine preflight V/J/H readback differs")
    return {"schema": "fullmag.gsg-reference-preflight.v1", "request_sha256": request_sha,
            "proposal_sha256": (FINE86K_PROPOSAL_SHA if work_profile == "gsg_junction_fine_reference_86k_v1" else FINE_PROPOSAL_SHA) if junction_fine else PROPOSAL_SHA,
            "driver_sha256": request["driver_sha256"], "evidence": value}


def require_preflight(control, digest, request, *, junction_fine=False, work_profile="gsg_junction_fine_reference_v1"):
    root = fine_root(work_profile) if junction_fine else ROOT
    raw = control.read_bytes(root + "/snapshots/" + digest + "/preflight.json", optional=True)
    require(raw is not None, "Run requires the retained successful preflight")
    value = json.loads(raw)
    require(value == preflight_record(value.get("evidence", {}), digest, request, junction_fine=junction_fine,work_profile=work_profile),
            "Retained preflight request/profile pins differ")
    return sha(raw)


# Fixed wrapper reaps its own child; losing the attached client is never an exit proof.
WORKER = r'''import hashlib,json,os,stat,subprocess,sys
from pathlib import Path
root=Path("/opt/fullmag/control/verification/gsg-source-convergence-reference-20261105/one-approved-attempt")
def check(ok,message):
 if not ok:raise RuntimeError(message)
def read(path,digest):
 check(path.resolve(strict=True)==path,'noncanonical reference input')
 before=path.stat();check(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=1048576,'reference input size/type differs')
 raw=path.read_bytes();after=path.stat()
 check((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'reference input changed')
 check(hashlib.sha256(raw).hexdigest()==digest,'reference input SHA differs');return raw
def publish(name,value):
 with (root/name).open('x') as stream:
  json.dump(value,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
digest,mode=sys.argv[1:];check(mode in ('preflight','run'),'unsupported reference mode')
check(len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'invalid request digest')
snapshot=root/'snapshots'/digest
request=json.loads(read(snapshot/'request.json',digest))
files={**request['tools'],'run_gsg_source_convergence_reference.py':request['driver_sha256']}
for name,pin in files.items():
 check(Path(name).name==name and name.endswith('.py'),'reference module name differs');read(snapshot/'prepared'/name,pin)
command=[sys.executable,'-B',str(snapshot/'prepared/run_gsg_source_convergence_reference.py'),'--request-sha256',digest]
if mode=='preflight':
 sys.exit(subprocess.call(command+['--preflight']))
publish('launch.json',{'request_sha256':digest,'new_solve':False,'automatic_retries':0})
child=subprocess.Popen(command)
code=child.wait()
stable=all(hashlib.sha256((snapshot/'prepared'/name).read_bytes()).hexdigest()==pin for name,pin in files.items())
publish('worker-exit.json',{'schema':'fullmag.gsg-reference-worker-exit.v1','request_sha256':digest,'pid':child.pid,'exit_code':code,'child_reaped':True,'source_inputs_stable':stable,'new_solve':False})
sys.exit(code if stable else 2)
'''


# The original wrapper remains byte-for-byte intact for the frozen nine checks.
FINE_WORKER = WORKER.replace(ATTEMPT, FINE_ATTEMPT).replace(DRIVER, FINE_DRIVER)


def attached(control, operation, backend, request_sha, *, junction_fine=False, work_profile="gsg_junction_fine_reference_v1"):
    root = fine_root(work_profile) if junction_fine else ROOT
    worker = FINE_WORKER.replace(FINE_ATTEMPT,"/opt/fullmag/control/"+root) if junction_fine else WORKER
    operation["daemon_pending"] = True
    process = subprocess.Popen([*docker_argv("exec"), backend, "/usr/local/bin/python3", "-B", "-c", worker,
                                request_sha, "run"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while chunk := process.stdout.read1(65536):
        operation["logger"].stdin.write(chunk)
        operation["logger"].stdin.flush()
    code = process.wait()
    raw = control.read_bytes(root + "/worker-exit.json", optional=True)
    require(raw is not None, "Worker exit is not confirmed; resources retained")
    proof = json.loads(raw)
    require(proof.get("schema") == "fullmag.gsg-reference-worker-exit.v1" and
            proof.get("request_sha256") == request_sha and proof.get("child_reaped") is True and
            proof.get("new_solve") is False and type(proof.get("exit_code")) is int and
            proof["exit_code"] == code, "Worker/client termination differs; resources retained")
    operation["daemon_pending"] = False
    require(proof.get("source_inputs_stable") is True, "Prepared reference tools changed")
    if code == 0:
        result_raw = control.read_bytes(root + "/result.json")
        result = json.loads(result_raw)
        require(result.get("schema") == ("fullmag.gsg-junction-reference-result.v1" if junction_fine
                                         else "fullmag.gsg-source-convergence-reference-result.v1") and
                result.get("request_sha256") == request_sha and result.get("exit_code") == 0 and
                result.get("checks_completed") == result.get("checks_passed") == result.get("checks_total") == (3 if junction_fine else 9) and
                result.get("qualified_basis") is False and result.get("new_solve") is False and
                result.get("qualification") == "NOT VERIFIED", "Durable three-check result differs" if junction_fine else "Durable nine-check result differs")
        operation["receipt"]["reference_result_sha256"] = sha(result_raw)
    return code, sha(raw)


def execute(control, selected, identity, args):
    if args.mode in ("surface-native-preflight", "surface-native-run"):
        import docker_gsg_surface_reference
        return docker_gsg_surface_reference.execute(control, selected, identity, args)
    require(args.mode == "prepare" or (isinstance(args.request_sha256, str) and SHA.fullmatch(args.request_sha256)),
            "Preflight/run require the prepared request SHA")
    require(args.mode != "prepare" or not args.request_sha256, "Prepare does not accept a prior request pin")
    junction_fine = args.mode in ("junction-fine-preflight", "junction-fine-run")
    work_profile=getattr(args,"work_profile","gsg_junction_fine_reference_v1")
    require(junction_fine or work_profile == "gsg_junction_fine_reference_v1","Work profile requires fine mode")
    fine_options={"junction_fine":True,"work_profile":work_profile} if junction_fine else {}
    mode = args.mode.removeprefix("junction-fine-") if junction_fine else args.mode
    root = fine_root(work_profile) if junction_fine else ROOT
    worker = FINE_WORKER.replace(FINE_ATTEMPT,"/opt/fullmag/control/"+root) if junction_fine else WORKER
    admission = {"allow_no_archive": True} if junction_fine else {}
    files = source_files(selected, **({"junction_fine": True} if junction_fine else {}))
    pins = qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission)
    request_value = (make_fine_request(pins, files, control.read_bytes(root+"/source-binding.json"),work_profile=work_profile) if junction_fine
                     else make_request(pins, files))
    request_raw = canonical(request_value) + b"\n"
    digest = sha(request_raw)
    require(args.mode == "prepare" or args.request_sha256 == digest, "Prepared source/group request differs")
    inputs = {**pins, "mode": args.mode, "request_sha256": digest,
              "controller_sha256": sha(Path(__file__).read_bytes()), "new_solve": False}
    with control.operation("gsg-reference", inputs) as operation:
        require(qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission) == pins,
                "Backend identity changed during admission")
        for name in ("launch.json", "started.json", "worker-exit.json", "result.json"):
            require(control.read_bytes(root + "/" + name, optional=True) is None, "Approved reference attempt already dispatched")
        for name, raw in files.items():
            immutable(control, root + "/snapshots/" + digest + "/prepared/" + name, raw)
        immutable(control, root + "/snapshots/" + digest + "/request.json", request_raw)
        sync_prepared(pins["backend_container_id"], digest, **({"root": root} if junction_fine else {}))
        require(source_files(selected, **({"junction_fine": True} if junction_fine else {})) == files, "Source tools changed during preparation")
        code = 0
        if mode == "preflight":
            operation["daemon_pending"] = True
            result = docker_capture("exec", pins["backend_container_id"], "/usr/local/bin/python3", "-B", "-c", worker,
                                    digest, "preflight", timeout=1800, allow_failure=True)
            # A returned preflight command is reaped by its fixed wrapper; no reference starts here.
            operation["daemon_pending"] = False
            control.write_bytes(operation["root"] + "/stdout.log", result.stdout)
            control.write_bytes(operation["root"] + "/stderr.log", result.stderr)
            code = result.returncode
            if code == 0:
                value = json.loads(result.stdout)
                record = preflight_record(value, digest, json.loads(request_raw), **fine_options)
                immutable(control, root + "/snapshots/" + digest + "/preflight.json", canonical(record) + b"\n")
                sync_prepared(pins["backend_container_id"], digest, **({"root": root} if junction_fine else {}))
        elif mode == "run":
            operation["receipt"]["preflight_sha256"] = require_preflight(control, digest, json.loads(request_raw), **fine_options)
            code, proof_sha = attached(control, operation, pins["backend_container_id"], digest, **fine_options)
            operation["receipt"]["worker_exit_sha256"] = proof_sha
        require(source_files(selected, **({"junction_fine": True} if junction_fine else {})) == files, "Reference source changed during operation")
        require(qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission) == pins,
                "Backend identity changed during operation")
        operation["receipt"].update(state="succeeded" if code == 0 else "failed-confirmed", exit_code=code,
                                    request_sha256=digest, reference_qualification="NOT VERIFIED")
        print(json.dumps({"mode": args.mode, "request": "/opt/fullmag/control/" + root + "/snapshots/" + digest + "/request.json", "request_sha256": digest,
                          "exit_code": code, "new_solve": False}))
        return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--mode", choices=("prepare", "preflight", "run", "junction-fine-preflight", "junction-fine-run", "surface-native-preflight", "surface-native-run"), required=True)
    parser.add_argument("--request-sha256", default="")
    parser.add_argument("--work-profile",choices=("gsg_junction_fine_reference_v1","gsg_junction_fine_reference_86k_v1"),default="gsg_junction_fine_reference_v1")
    args = parser.parse_args()
    from docker_dev import _select_source, _compose_identity
    require_host()
    selected, layout = _select_source(args.source_root, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, image)
    control.prepare()
    return execute(control, selected, identity, args)


if __name__ == "__main__":
    raise SystemExit(main())
