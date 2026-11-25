'Private single-call frozen-surface experiment in the admitted GSG backend.'
import json
from pathlib import Path
import stat
import subprocess

from docker_build_control import canonical
from docker_dev_host import docker_argv
from docker_gsg_reference import (docker_capture, immutable, qualified_backend,
    require, sha, SHA, sync_prepared)

ROOT = "verification/gsg-full-source-surface-native-20261115/one-approved-attempt"
GLOBAL_ROOT = "/opt/fullmag/control/" + ROOT
DRIVER = "gsg_surface_native_probe.py"
POLICY_PATH = ".superpowers/sdd/2026-11-13-retained-dtq-public-field-proposal/full-gsg-native-experiment-20261115/policy-proposal.json"
PROPOSAL_SHA = "71280d4f14fa16ea3bc660108eb9895a65e3d142a9b178af2ab13d2d42ec269f"
POLICY_SHA = "3a1f606f192f05ec40499d2d833b22f0ed89f1168a68dfbdb9ba7cb0ea649124"
NATIVE_SOURCES = (
    "backends/fem/cpu/mfem/interactions/oersted/surface_rt0.cpp",
    "backends/fem/cpu/mfem/interactions/oersted/surface_rt0.hpp",
    "backends/fem/cpu/mfem/transport/affine_rt0_element.cpp",
    "backends/fem/cpu/mfem/transport/affine_rt0_element.hpp",
    "backends/fem/cpu/mfem/workflows/antenna_field_solve/frozen_surface_rt0.cpp",
    "backends/fem/cpu/mfem/workflows/antenna_field_solve/surface_rt0_io.cpp",
    "backends/fem/cpu/mfem/workflows/antenna_field_solve/surface_rt0_io.hpp",
    "native/include/fullmag_fem.h",
)
SOURCE_BASE = "examples/sushruth_2020_closed_gsg/corner12p5_20261112/"
SOURCE_BUNDLE = SOURCE_BASE + "input/fem_antenna_gsg_corner12p5.zarr/run-e9aff0de16d09f8de87b473179e239b28b8b4bbb4fea0c91a2e542f07d150438/script-execution-f20ccba613173164fda2353ab224ae1c0b938eae8e6109837c386810f20cf4d4-attempt-1/antenna-inspection.bundle"
REFERENCE_SHA = (
    "ebd83e03f5b7346853d741ae2b1c135de01c253bdcd3161f08c8a29bf41d6f87",
    "4c6e06cd67e9407b2c51ad963c3ef51884064a4b86e79cada2bc4f82059d6b84",
    "d0d4d7e1259f57894ed5c78b5a7d59ccdae66917287d3916549bef3d257189cd",
)


def snapshot_root(digest):
    require(isinstance(digest, str) and SHA.fullmatch(digest), "Exact request SHA required")
    return ROOT + "/snapshots/" + digest


def read_source(path):
    require(path.resolve(strict=True) == path, "Surface source must not traverse a symlink")
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 1048576,
            "Surface source must be one bounded regular file")
    raw = path.read_bytes()
    after = path.stat()
    signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    require(signature(before) == signature(after), "Surface source changed while reading")
    return raw


def source_files(selected):
    driver = read_source(selected / "tools" / DRIVER)
    sources = {name: sha(read_source(selected / name)) for name in NATIVE_SOURCES}
    policy_raw = read_source(selected / POLICY_PATH)
    require(sha(policy_raw) == POLICY_SHA, "Approved surface policy SHA differs")
    return driver, sources, json.loads(policy_raw)


def package_binding(backend, pins):
    import docker_dev_codegen as codegen
    receipt, provenance, receipt_sha, provenance_binary = codegen._backend_documents(backend)
    _source, provenance_sha, binary_sha = codegen._validate_backend(receipt, provenance, receipt_sha, provenance_binary)
    require(receipt_sha == pins["backend_build_receipt_sha256"], "Backend build receipt changed")
    require(provenance_sha == pins["backend_provenance_sha256"] and binary_sha == pins["api_binary_sha256"],
            "Backend provenance or API binary changed")
    artifacts = receipt.get("artifacts")
    require(isinstance(artifacts, list), "Managed FEM library artifact is absent")
    libraries = [row for row in artifacts if isinstance(row, dict) and row.get("path") == "lib/libfullmag_fem.so"]
    require(len(libraries) == 1 and isinstance(libraries[0].get("sha256"), str) and
            SHA.fullmatch(libraries[0]["sha256"]), "One exact managed FEM library artifact required")
    manifest = receipt.get("source", {}).get("manifest_sha256")
    require(isinstance(manifest, str) and SHA.fullmatch(manifest), "Managed source manifest SHA absent")
    return {"library_sha256": libraries[0]["sha256"], "source_manifest_sha256": manifest}


def make_request(pins, driver, sources, policy, binding):
    return {**pins, **binding, "schema": "fullmag.gsg-surface-native-probe-request.v1",
        "proposal_sha256": PROPOSAL_SHA, "policy_sha256": POLICY_SHA, "policy": policy,
        "driver_sha256": sha(driver), "source_files": sources,
        "source_root_container": "/opt/fullmag/source", "global_root": GLOBAL_ROOT,
        "source_bundle": {"path": SOURCE_BUNDLE,
            "sha256": "bf0aef6a71242351e6a9ac996f17ce7f87eea0b51c4d6f381cfd272339367c04"},
        "source_ir": {"path": SOURCE_BASE + "verification/prepared-86k-ir.json",
            "sha256": "88d63e76ded73975bb141ee643430c866c7bb8f3eb9a264afeba399a79527a06"},
        "references": [{"target_index": index,
            "path": SOURCE_BASE + "verification/reference-86k/corner12p5-target-" + str(index) + ".json",
            "sha256": digest} for index, digest in zip((0, 8, 16), REFERENCE_SHA)],
        "scope": {"cells": 85980, "vertex_count": 23263, "canonical_face_count": 188926,
            "target_indices": [0, 8, 16],
            "frozen_sha256": "e09b767ad149dd2bad56539f66b8097badcfb26a4c047de8b1903caf95a5e096"},
        "source_state_sha256": "f8721cba20504a1a92b8b63bb9e93786fc58ea0a8063fa83675b16de6d6338b9",
        "output_directory": "/opt/fullmag/script-output/sushruth_2020_closed_gsg/corner12p5_20261112/input/fem_antenna_gsg_corner12p5.zarr/diagnostics/surface-native-probe-20261115"}


def preflight_record(value, digest, request):
    packing, library = value.get("packing", {}), value.get("library_binding", {})
    require(value.get("status") == "PREFLIGHT PASS" and value.get("request_sha256") == digest and
            type(value.get("native_evaluations")) is int and value["native_evaluations"] == 0 and
            value.get("new_solve") is False, "Surface preflight must confirm exact request and zero evaluations")
    require(packing.get("frozen_sha256") == request["scope"]["frozen_sha256"] and
            packing.get("source_cells") == request["scope"]["cells"] and
            packing.get("vertices") == request["scope"]["vertex_count"] and
            packing.get("canonical_faces") == request["scope"]["canonical_face_count"], "Surface preflight packing differs")
    require(library.get("library_sha256") == request["library_sha256"], "Surface preflight library differs")
    return {"schema": "fullmag.gsg-surface-native-preflight.v1", "request_sha256": digest,
        "proposal_sha256": PROPOSAL_SHA, "driver_sha256": request["driver_sha256"], "evidence": value}


def require_preflight(control, digest, request):
    raw = control.read_bytes(snapshot_root(digest) + "/preflight.json", optional=True)
    require(raw is not None, "Run requires retained successful preflight")
    value = json.loads(raw)
    require(value == preflight_record(value.get("evidence", {}), digest, request), "Surface preflight pins differ")
    return sha(raw)


# This wrapper never claims the native-call fence. Only the validated driver does.
WORKER = r'''import hashlib,json,os,signal,stat,subprocess,sys
from pathlib import Path
root=Path("/opt/fullmag/control/verification/gsg-full-source-surface-native-20261115/one-approved-attempt")
def check(ok,message):
 if not ok:raise RuntimeError(message)
def read(path,digest):
 check(path.resolve(strict=True)==path,'noncanonical surface input')
 before=path.stat();check(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=1048576,'surface input size/type differs')
 raw=path.read_bytes();after=path.stat()
 signature=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
 check(signature(before)==signature(after),'surface input changed')
 check(hashlib.sha256(raw).hexdigest()==digest,'surface input SHA differs');return raw
digest,mode=sys.argv[1:3]
proof_nonce=sys.argv[3] if len(sys.argv)==4 else None
check(len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'invalid request digest')
check(mode in ('preflight','run'),'unsupported surface mode')
check((mode=='run' and len(sys.argv)==3) or (mode=='preflight' and proof_nonce is not None and len(proof_nonce)==64 and all(c in '0123456789abcdef' for c in proof_nonce)),'invalid preflight proof nonce')
check(not (root/'started.json').exists(),'approved native surface call already started')
snapshot=root/'snapshots'/digest
request=json.loads(read(snapshot/'request.json',digest))
driver=snapshot/'prepared/gsg_surface_native_probe.py'
read(driver,request['driver_sha256'])
proof_path=snapshot/('preflight-worker-exit-'+proof_nonce+'.json' if mode=='preflight' else 'worker-exit.json')
check(not proof_path.exists(),'surface snapshot worker already exited')
command=[sys.executable,'-B',str(driver),'--request-sha256',digest]
if mode=='preflight':command.append('--preflight')
child=subprocess.Popen(command)
interrupted=0
def stop(signum,frame):
 global interrupted
 interrupted=signum
 if child.poll() is None:child.terminate()
for signum in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(signum,stop)
timed_out=False
try:code=child.wait(timeout=1800 if mode=='preflight' else 7350)
except subprocess.TimeoutExpired:
 timed_out=True
 if child.poll() is None:child.terminate()
 code=child.wait()
stable=hashlib.sha256(driver.read_bytes()).hexdigest()==request['driver_sha256'] and hashlib.sha256((snapshot/'request.json').read_bytes()).hexdigest()==digest
exit_code=124 if timed_out else (128+interrupted if interrupted else (128-code if code<0 else code))
if not stable and exit_code==0:exit_code=2
proof={'schema':'fullmag.gsg-surface-native-worker-exit.v1','mode':mode,'request_sha256':digest,'pid':child.pid,'exit_code':exit_code,'child_exit_code':code,'child_reaped':True,'source_inputs_stable':stable,'new_solve':False,'timed_out':timed_out,'stop_signal':interrupted}
if mode=='preflight':proof['proof_nonce']=proof_nonce
with proof_path.open('x') as stream:
 json.dump(proof,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
fd=os.open(snapshot,os.O_RDONLY|os.O_DIRECTORY)
try:os.fsync(fd)
finally:os.close(fd)
sys.exit(exit_code)
'''


def worker_exit(control, operation, digest, mode, code, proof_nonce=None):
    if mode == "preflight":
        require(isinstance(proof_nonce, str) and SHA.fullmatch(proof_nonce), "Exact preflight proof nonce required")
    name = "preflight-worker-exit-" + proof_nonce + ".json" if mode == "preflight" else "worker-exit.json"
    raw = control.read_bytes(snapshot_root(digest) + "/" + name, optional=True)
    require(raw is not None, "Surface worker exit is not confirmed; resources retained")
    value = json.loads(raw)
    require(value.get("schema") == "fullmag.gsg-surface-native-worker-exit.v1" and
            value.get("mode") == mode and value.get("request_sha256") == digest and
            value.get("child_reaped") is True and type(value.get("exit_code")) is int and
            value["exit_code"] == code and value.get("new_solve") is False and
            (mode != "preflight" or value.get("proof_nonce") == proof_nonce),
            "Surface worker/client termination differs; resources retained")
    operation["daemon_pending"] = False
    require(value.get("source_inputs_stable") is True, "Prepared surface inputs changed")
    return sha(raw)


def require_result(result, digest, code):
    require(result.get("request_sha256") == digest and result.get("status") in ("SUCCEEDED", "REFUSED") and
            type(result.get("native_evaluations")) is int and result["native_evaluations"] in (0, 1) and
            result.get("private_numerical_probe") is True and result.get("accepted_parent_verified") is False and
            result.get("inspection_only") is True and result.get("error_certificate_available") is False and
            result.get("qualified_basis") is False and result.get("new_solve") is False, "Durable private surface result differs")
    if result["native_evaluations"] == 1:
        require(type(result.get("native_status")) is int, "Native return status absent")
    if code == 0:
        comparisons = result.get("comparisons", [])
        targets = result.get("native_evidence", {}).get("targets", [])
        require(result["status"] == "SUCCEEDED" and result["native_evaluations"] == 1 and
                result["native_status"] == 0 and isinstance(comparisons, list) and len(comparisons) == 3 and
                [row.get("target_index") for row in comparisons] == [0, 8, 16] and
                all(row.get("within_gate") is True for row in comparisons) and isinstance(targets, list) and len(targets) == 3,
                "Successful surface result requires three accepted comparisons")
        for target in targets:
            precisions = target.get("precisions", [])
            require(isinstance(precisions, list) and len(precisions) == 3,
                    "Successful surface result requires nine precision reports")
            require(all(isinstance(p, dict) and p.get("evaluated") is True for p in precisions[1:]),
                    "Successful surface result requires both MPFR passes")
            for index, precision in enumerate(precisions):
                require(isinstance(precision, dict) and type(precision.get("evaluated")) is bool and
                        isinstance(precision.get("refusal_reason"), str), "Precision state record is incomplete")
                for name in ("h_xyz_apm", "whole_h_xyz_apm"):
                    values = precision.get(name)
                    require(isinstance(values, list) and len(values) == 3 and
                            all(isinstance(value, str) for value in values), "Precision vector record is incomplete")
                    if precision["evaluated"]:
                        require(all(value.strip() for value in values), "Evaluated precision vector is empty")
                for name in ("sum_local_norm_apm", "cancellation", "maximum_face_cancellation"):
                    require(isinstance(precision.get(name), str), "Precision scalar record is incomplete")
                    if precision["evaluated"]:
                        require(precision[name].strip(), "Evaluated precision scalar is empty")
                if precision["evaluated"]:
                    require(precision["refusal_reason"] == "", "Evaluated precision cannot contain refusal")
                else:
                    require(index == 0 and precision["refusal_reason"].strip() and
                            target.get("binary64_requires_highprecision") is True,
                            "Binary64 refusal requires a reason and native MPFR fallback")
    else:
        require(result["status"] == "REFUSED", "Failed surface worker cannot publish success")


def attached(control, operation, backend, digest):
    operation["daemon_pending"] = True
    process = subprocess.Popen([*docker_argv("exec"), backend, "/usr/local/bin/python3", "-B", "-c", WORKER,
                                digest, "run"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while chunk := process.stdout.read1(65536):
        operation["logger"].stdin.write(chunk)
        operation["logger"].stdin.flush()
    code = process.wait()
    proof_sha = worker_exit(control, operation, digest, "run", code)
    raw = control.read_bytes(snapshot_root(digest) + "/result.json")
    require_result(json.loads(raw), digest, code)
    operation["receipt"]["surface_result_sha256"] = sha(raw)
    return code, proof_sha


def execute(control, selected, identity, args):
    require(args.mode in ("surface-native-preflight", "surface-native-run"), "Unknown private surface mode")
    mode = args.mode[len("surface-native-"):]
    require(mode != "run" or isinstance(args.request_sha256, str) and SHA.fullmatch(args.request_sha256),
            "Surface run requires exact request SHA")
    driver, sources, policy = source_files(selected)
    pins = qualified_backend(control, selected, identity, args.attempt, args.config_sha256, allow_no_archive=True)
    binding = package_binding(pins["backend_container_id"], pins)
    request = make_request(pins, driver, sources, policy, binding)
    raw = canonical(request) + b"\n"
    digest = sha(raw)
    require(not args.request_sha256 or args.request_sha256 == digest, "Prepared surface source/group request differs")
    root = snapshot_root(digest)
    inputs = {**pins, "mode": args.mode, "request_sha256": digest,
        "controller_sha256": sha(Path(__file__).read_bytes()), "new_solve": False}
    with control.operation("gsg-reference", inputs) as operation:
        require(qualified_backend(control, selected, identity, args.attempt, args.config_sha256, allow_no_archive=True) == pins,
                "Backend identity changed during surface admission")
        require(control.read_bytes(ROOT + "/started.json", optional=True) is None, "Approved native surface call already started")
        immutable(control, root + "/request.json", raw)
        immutable(control, root + "/prepared/" + DRIVER, driver)
        sync_prepared(pins["backend_container_id"], digest, root=ROOT)
        require(source_files(selected) == (driver, sources, policy), "Surface inputs changed during preparation")
        if mode == "preflight":
            existing = control.read_bytes(root + "/preflight.json", optional=True)
            if existing is not None:
                require_preflight(control, digest, request)
                code = 0
            else:
                proof_nonce = sha(operation["root"].encode("utf-8"))
                operation["daemon_pending"] = True
                result = docker_capture("exec", pins["backend_container_id"], "/usr/local/bin/python3", "-B", "-c", WORKER,
                    digest, "preflight", proof_nonce, timeout=1900, allow_failure=True)
                proof_sha = worker_exit(control, operation, digest, "preflight", result.returncode, proof_nonce)
                operation["receipt"]["preflight_worker_exit_sha256"] = proof_sha
                control.write_bytes(operation["root"] + "/stdout.log", result.stdout)
                control.write_bytes(operation["root"] + "/stderr.log", result.stderr)
                operation["logger"].stdin.write(result.stdout + result.stderr)
                operation["logger"].stdin.flush()
                code = result.returncode
                if code == 0:
                    record = preflight_record(json.loads(result.stdout), digest, request)
                    immutable(control, root + "/preflight.json", canonical(record) + b"\n")
                    sync_prepared(pins["backend_container_id"], digest, root=ROOT)
        else:
            operation["receipt"]["preflight_sha256"] = require_preflight(control, digest, request)
            require(control.read_bytes(root + "/worker-exit.json", optional=True) is None, "Surface snapshot worker already exited")
            code, proof_sha = attached(control, operation, pins["backend_container_id"], digest)
            operation["receipt"]["worker_exit_sha256"] = proof_sha
        require(source_files(selected) == (driver, sources, policy), "Surface source changed during operation")
        require(qualified_backend(control, selected, identity, args.attempt, args.config_sha256, allow_no_archive=True) == pins and
                package_binding(pins["backend_container_id"], pins) == binding, "Backend package changed during surface operation")
        operation["receipt"].update(state="succeeded" if code == 0 else "failed-confirmed", exit_code=code,
            request_sha256=digest, reference_qualification="NOT VERIFIED")
        print(json.dumps({"mode": args.mode, "request": "/opt/fullmag/control/" + root + "/request.json",
            "request_sha256": digest, "exit_code": code, "new_solve": False}))
        return code
