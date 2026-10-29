"""Fixed common-case scientific qualification on the selected volume DEV package.

Build admission remains owned by docker_boris_volume. This command never builds,
restarts services, calls the old coordinator, or promotes raw comparison to PASS.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import (BuildControl, BuildControlError, ControlOutcomeUnknown,
    bounded_capture, canonical, docker_capture, toolchain_configuration)

SCHEMA = "fullmag.nf-common.volume-scientific.v1"
IDENTITY = "fullmag.boris.volume-runtime.v1"
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
SHA = re.compile(r"[a-f0-9]{64}")
TOKEN = re.compile(r"[a-f0-9]{32}")
MEMORY = 2 << 30
CPU = 2_000_000_000
PIDS = 128
BORIS_SECONDS = 240
FULLMAG_SECONDS = 2100
COMPARE_SECONDS = 240
# These paths are produced by existing owners, never a user-selected command.
READ_NATIVE = r"""import hashlib,json,sys
from pathlib import Path
sys.path.insert(0,'/opt/fullmag');import backend_dev as b
root=Path('/build/external-reference-boris')/sys.argv[1]
b._assert_no_links(root,'BORIS scientific input')
receipt,raw=b._read_json(root/'build-receipt.json','BORIS receipt',8*1024*1024)
prefix,praw=b._read_json(root/'prefix/receipt.json','BORIS prefix',8*1024*1024)
package,pkgraw,_=b._validated_package(Path('/opt/fullmag/package'),'scientific Fullmag package',exclude_development_control=True)
provenance,provraw=b._read_json(b.PROVENANCE_PATH,'runtime provenance')
sys.path.insert(0,"/opt/fullmag/source/scripts")
from local_runner import boris_cpu
import docker_boris_prefix as supplier
for name,expected in receipt["binding"]["tool_sha256"].items():
 if not (name.startswith("/opt/fullmag/source/scripts/") or name=="/opt/fullmag/backend_dev.py") or boris_cpu.digest(Path(name))!=expected:raise RuntimeError("producer helper drift")
boris_cpu.validate_outputs(root/"artifacts",receipt)
if {name:boris_cpu.digest(root/"artifacts/outputs/boris"/name) for name in boris_cpu.OUTPUTS}!=receipt["outputs"]:raise RuntimeError("BORIS native output drift")
if [v for v in supplier.inventory(root/"prefix") if v["path"]!="receipt.json"]!=prefix["files"]:raise RuntimeError("BORIS prefix drift")
import base64
wrapper=base64.b64encode((root/"prefix/source/EmbeddedPythonWrapper.py").read_bytes()).decode()
print(json.dumps(dict(wrapper_b64=wrapper,producer=receipt,producer_sha256=hashlib.sha256(raw).hexdigest(),prefix=prefix,
 prefix_sha256=hashlib.sha256(praw).hexdigest(),package=package,package_sha256=hashlib.sha256(pkgraw).hexdigest(),
 provenance_sha256=hashlib.sha256(provraw).hexdigest(),provenance=provenance)))
"""


def require(ok, message):
    if not ok:
        raise BuildControlError("N/F volume qualification: " + message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inspect(identifier):
    require(isinstance(identifier, str) and SHA.fullmatch(identifier), "exact owned container ID required")
    rows = json.loads(docker_capture("inspect", identifier).stdout)
    require(len(rows) == 1 and rows[0].get("Id") == identifier, "container identity differs")
    return rows[0]


def native_binding(doc, producer_attempt, project, image, package_sha):
    import docker_boris_volume as producer
    value = doc["producer"]
    require(value.get("attempt_id") == producer_attempt and value.get("image_digest") == image,
            "BORIS producer/image differs")
    require(producer._checked_worker_receipt(value, value["admission"]), "BORIS producer is not successful terminal")
    require(value["admission"]["compose_project"] == project, "BORIS producer belongs to another group")
    import boris_nf_common_case_v3 as common
    require(value["binding"].get("common_cases") == {key:common.case_descriptor(key) for key in common.CASE_KEYS}, "producer common-case family differs")
    require(doc["package_sha256"] == package_sha and
            value["binding"]["fullmag_package_sha256"] == package_sha and
            value["binding"]["runtime_provenance_sha256"] == doc["provenance_sha256"] and
            value["binding"]["dependency_receipt_sha256"] == doc["prefix_sha256"],
            "producer/current package/prefix/provenance differ")
    require(doc["prefix"].get("schema") == "fullmag.boris.private-prefix.v1" and
            doc["prefix"].get("status") == "DEPENDENCY_PREFLIGHT_ONLY", "prefix is not preflighted")
    outputs = value["outputs"]
    require(outputs.get("BorisLin") == value["boris_build_proof"]["binary_sha256"], "BORIS output identity differs")
    binary = [v for v in doc["package"]["artifacts"] if v.get("path") == "bin/fullmag-bin"]
    require(len(binary) == 1 and SHA.fullmatch(binary[0]["sha256"]) and
            doc["provenance"]["binary_hashes"].get("fullmag-bin") == binary[0]["sha256"], "Fullmag binary is not bound")
    return dict(schema=SCHEMA, compose_project=project, image_id=image, producer_attempt=producer_attempt,
        producer_receipt_sha256=doc["producer_sha256"], prefix_receipt_sha256=doc["prefix_sha256"],
        fullmag_package_receipt_sha256=package_sha, runtime_provenance_sha256=doc["provenance_sha256"],
        fullmag_binary_sha256=binary[0]["sha256"], native_source_identity=doc["package"]["native_source_identity"],
        boris_build_proof=value["boris_build_proof"], boris_outputs=outputs)


def normalized_mounts(value):
    mounts = value.get("Mounts")
    require(isinstance(mounts, list) and all(isinstance(v, dict) for v in mounts), "mount records missing")
    destinations = [v.get("Destination") for v in mounts]
    require(all(isinstance(v, str) and v.startswith("/") for v in destinations) and
            len(set(destinations)) == len(destinations), "mount destinations malformed or duplicate")
    return sorted(mounts, key=lambda v: v["Destination"])


def same_backend(before, after):
    for key in ("Id", "Image", "Config", "HostConfig"):
        require(before[key] == after[key], "backend configuration changed: " + key)
    require(normalized_mounts(before) == normalized_mounts(after) and
            before["State"]["StartedAt"] == after["State"]["StartedAt"] and
            after["State"].get("Running") is True, "backend incarnation/mounts changed")


def volume(name, target, subpath=""):
    require(isinstance(name, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]+", name), "invalid named volume")
    require(not subpath or re.fullmatch(r"[a-zA-Z0-9_/-]+", subpath) and
            all(v not in ("", ".", "..") for v in subpath.split("/")), "invalid fixed volume subpath")
    return dict(kind="volume", source=name, target=target, subpath=subpath, readonly=True)


def specification(binding, control_volume, cache, technical, export, role, case_key=None):
    require(binding.get("schema") == SCHEMA and re.fullmatch(r"sha256:[a-f0-9]{64}", binding["image_id"]), "invalid native binding")
    require(role in ("boris", "fullmag", "compare"), "unknown scientific role")
    if role == "boris":
        require(case_key in ("r0", "r1", "r2"), "fixed BORIS case required")
    else:
        require(case_key is None, "unexpected case selector")
    mounts = [volume(control_volume, "/qualification", technical + "/controller"),
        volume(control_volume, "/source", technical + "/source"),
        volume(cache["volume_names"]["package"], "/package")]
    env = dict(PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1", PYTHONHOME="", LD_PRELOAD="", LD_AUDIT="",
        PATH="/package/bin:/usr/local/bin:/usr/bin:/bin", HOME="/tmp", MPLCONFIGDIR="/tmp/matplotlib",
        NVIDIA_VISIBLE_DEVICES="void", NVIDIA_DRIVER_CAPABILITIES="", OMP_NUM_THREADS="2", FULLMAG_CPU_THREADS="2",
        FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME="1", FULLMAG_FORCE_LOCAL_FEM_CPU="1", FULLMAG_FDM_EXECUTION="cpu",
        FULLMAG_FEM_EXECUTION="cpu", FULLMAG_FEM_MFEM_DEVICE="cpu", FULLMAG_FEM_REQUIRE_GPU="0", FULLMAG_FEM_REQUIRE_CEED="0",
        FULLMAG_PYTHON="/usr/local/bin/python3", FULLMAG_RUNTIME_ROOT="/package", FULLMAG_REPO_ROOT="/ram/workspace", FULLMAG_STATE_ROOT="/ram/workspace/.fullmag",
        FULLMAG_STATE_DIR="/ram/user-state", FULLMAG_API_PORT="0", FULLMAG_FEM_MESH_CACHE_DIR="/ram/mesh-cache",
        PYTHONPATH="/source/packages/fullmag-py/src:/tools/scripts:/tools", LD_LIBRARY_PATH="/package/lib:/opt/fullmag-deps/lib")
    if role == "boris":
        mounts += [volume(control_volume, "/tools", technical + "/tools"),
            volume(control_volume, "/input", technical + "/input/" + case_key),
            volume(control_volume, "/boris", technical + "/boris"),
            volume(cache["volume_names"]["build"], "/opt/fullmag-boris",
                   "external-reference-boris/" + binding["producer_attempt"] + "/prefix")]
        env["PYTHONPATH"] = "/tools/scripts:/opt/fullmag-boris/source:/opt/fullmag-boris/python"
        env["LD_LIBRARY_PATH"] = "/opt/fullmag-boris/sdk/usr/lib/x86_64-linux-gnu:/usr/local/lib"
        seconds = BORIS_SECONDS
    elif role == "fullmag":
        mounts += [volume(control_volume, "/tools", technical + "/fullmag-tools")]
        seconds = FULLMAG_SECONDS
    else:
        mounts += [volume(control_volume, "/tools", technical + "/tools")]
        seconds = COMPARE_SECONDS
    mounts.append(dict(kind="bind", source=str(export), target="/export", readonly=False, subpath=""))
    tmpfs = {"/tmp":"rw,nosuid,nodev,size=256m,mode=1777"} if role == "boris" else {
        "/tmp":"rw,nosuid,nodev,size=64m,mode=1777", "/ram":"rw,nosuid,nodev,size=768m,mode=1777"}
    return dict(image=binding["image_id"], project=binding["compose_project"], role=role, case_key=case_key,
        mounts=mounts, environment=env, timeout_seconds=seconds, tmpfs=tmpfs,
        command=["/usr/bin/timeout", "--signal=TERM", "--kill-after=10", str(seconds),
                 "/usr/local/bin/python3", "-B", "/qualification/docker_nf_common_volume.py", "_" + role])


def create_args(spec, run_id, ordinal):
    require(TOKEN.fullmatch(run_id), "invalid scientific attempt")
    require(type(ordinal) is int and 0 <= ordinal < 5, "unexpected fixed stage")
    args = ["create", "--name", "fullmag-nf-" + run_id + "-" + str(ordinal), "--pull", "never",
        "--init", "--no-healthcheck", "--runtime", "runc", "--network", "none", "--read-only", "--user", "65532:65532",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", str(MEMORY),
        "--memory-swap", str(MEMORY), "--cpus", "2", "--pids-limit", str(PIDS), "--workdir", "/tmp",
        "--log-driver", "local", "--log-opt", "max-size=8m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
        "--label", "com.docker.compose.project=" + spec["project"],
        "--label", "com.docker.compose.service=nf-common-scientific",
        "--label", "org.fullmag.scientific.attempt=" + run_id,
        "--label", "org.fullmag.scientific.ordinal=" + str(ordinal)]
    for target, options in spec["tmpfs"].items():
        args += ["--tmpfs", target + ":" + options]
    for mount in spec["mounts"]:
        text = "type=" + mount["kind"] + ",src=" + mount["source"] + ",dst=" + mount["target"]
        require(not any(c in mount["source"] for c in ",\n\r"), "mount source contains a separator")
        if mount["readonly"]:
            text += ",readonly"
        if mount["kind"] == "volume":
            text += ",volume-nocopy"
            if mount["subpath"]:
                text += ",volume-subpath=" + mount["subpath"]
        args += ["--mount", text]
    for key, value in sorted(spec["environment"].items()):
        args += ["--env", key + "=" + value]
    return args + ["--entrypoint", spec["command"][0], spec["image"], *spec["command"][1:]]


def attest(value, spec, run_id, ordinal):
    config, host = value["Config"], value["HostConfig"]
    labels = config.get("Labels", {})
    require(value.get("Image") == spec["image"] and
        labels.get("com.docker.compose.project") == spec["project"] and
        labels.get("com.docker.compose.service") == "nf-common-scientific" and
        labels.get("org.fullmag.scientific.attempt") == run_id and
        labels.get("org.fullmag.scientific.ordinal") == str(ordinal), "scientific ownership differs")
    require(config.get("Entrypoint") == spec["command"][:1] and config.get("Cmd") == spec["command"][1:] and
        config.get("User") == "65532:65532" and config.get("WorkingDir") == "/tmp" and
        config.get("Healthcheck", {}).get("Test") == ["NONE"], "scientific command/user differs")
    environment = config.get("Env", [])
    require(all([v for v in environment if v.split("=",1)[0] == k] == [k + "=" + x]
                for k, x in spec["environment"].items()), "scientific environment differs")
    require(host.get("Memory") == MEMORY and host.get("MemorySwap") == MEMORY and host.get("NanoCpus") == CPU and
        host.get("PidsLimit") == PIDS and host.get("ReadonlyRootfs") is True and host.get("Privileged") is False and
        host.get("NetworkMode") == "none" and not host.get("PortBindings") and not host.get("Devices") and
        not host.get("DeviceRequests") and host.get("Runtime") == "runc" and host.get("Init") is True and
        set(host.get("CapDrop", [])) == {"ALL"} and not host.get("CapAdd") and
        "no-new-privileges:true" in host.get("SecurityOpt", []) and host.get("Tmpfs") == spec["tmpfs"],
        "scientific resource/isolation limits differ")
    require(host.get("LogConfig") == {"Type":"local", "Config":{"max-size":"8m", "max-file":"1", "compress":"false"}}, "bounded Docker log configuration differs")
    actual = {v["Destination"]:v for v in normalized_mounts(value) if v["Destination"] not in
              ("/etc/hosts", "/etc/hostname", "/etc/resolv.conf")}
    require(set(actual) == {v["target"] for v in spec["mounts"]}, "scientific mount membership differs")
    for expected in spec["mounts"]:
        found = actual[expected["target"]]
        require(found.get("Type") == expected["kind"] and found.get("RW") is (not expected["readonly"]), "scientific mount type/mode differs")
        if expected["kind"] == "volume":
            require(found.get("Name") == expected["source"], "scientific named volume differs")
            requests = [v for v in host.get("Mounts", []) if v.get("Target") == expected["target"]]
            require(len(requests) == 1 and requests[0].get("Source") == expected["source"] and
                requests[0].get("VolumeOptions", {}).get("Subpath", "") == expected["subpath"] and
                requests[0].get("VolumeOptions", {}).get("NoCopy") is True, "scientific subpath/copy policy differs")
        else:
            raw = found["Source"].replace("\\", "/")
            alias = re.fullmatch(r"/(?:run/desktop/mnt/host|host_mnt)/([A-Za-z])/(.*)", raw)
            if alias:
                raw = alias.group(1) + ":/" + alias.group(2)
            require(str(Path(raw).resolve()).casefold() == str(Path(expected["source"]).resolve()).casefold(), "scientific export path differs")
    return value



def dispatch_copy(control, operation, argv, binding):
    name = "fullmag-nf-copy-" + operation["receipt"]["attempt"]
    require(argv.count("--name") == 1 and argv[argv.index("--name") + 1] == name and
            "--rm" in argv and "--detach" not in argv and "-d" not in argv, "copy requires its exact attached owner")
    record = dict(name=name, argv_sha256=digest(canonical(argv)), binding=binding, state="prepared")
    operation["receipt"]["copy_helper"] = record
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    operation["daemon_pending"] = True
    try:
        copied = bounded_capture(argv, data=b"", timeout=300)
        record["client_exit_code"] = copied.returncode
        if copied.returncode != 0:
            raise ControlOutcomeUnknown("copy client nonzero; daemon terminal outcome unproven")
        # Attached docker run --rm exit 0 acknowledges the exact helper's
        # completed command/container. A nonzero client result proves neither.
        record.update(state="daemon-completed-attached-exit0", terminal_proof="attached-docker-run-exit0",
                      stdout_sha256=digest(copied.stdout), stderr_sha256=digest(copied.stderr))
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
    except BaseException as error:
        record.update(state="outcome-unknown-resources-retained", error=type(error).__name__ + ": " + str(error))
        try:
            control.write(operation["root"] + "/receipt.json", operation["receipt"])
        except BaseException:
            pass  # The prepared owner/binding is durable; retain the primary unknown.
        raise ControlOutcomeUnknown("owned copy terminal outcome unproven; lease retained") from error
    operation["daemon_pending"] = False


def run_container(control, operation, spec, ordinal):
    token = operation["receipt"]["attempt"]
    name = "fullmag-nf-" + token + "-" + str(ordinal)
    record = dict(name=name, spec=spec, container_id=None, state="not-created", exit_code=None)
    operation["receipt"].setdefault("containers", []).append(record)
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    identifier = None
    try:
        operation["daemon_pending"] = True
        result = docker_capture(*create_args(spec, token, ordinal))
        identifier = result.stdout.decode().strip()
        require(SHA.fullmatch(identifier), "Docker create returned no exact ID; reconcile exact owned name")
        record.update(container_id=identifier, state="created")
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        attest(inspect(identifier), spec, token, ordinal)
        operation["daemon_pending"] = False
        operation["daemon_pending"] = True
        docker_capture("start", identifier)
        deadline = time.monotonic() + spec["timeout_seconds"] + 30
        while True:
            value = attest(inspect(identifier), spec, token, ordinal)
            state = value["State"]
            if state.get("Status") == "exited" and state.get("Running") is False:
                break
            if time.monotonic() >= deadline:
                raise BuildControlError("scientific observation deadline exceeded")
            time.sleep(.5)
        record.update(state="exited", exit_code=state.get("ExitCode"), terminal_state=state,
            attestation_sha256=digest(canonical(dict(Id=value["Id"], Image=value["Image"], Config=value["Config"],
                HostConfig=value["HostConfig"], Mounts=normalized_mounts(value), State=value["State"]))))
        operation["daemon_pending"] = False
        logs = docker_capture("logs", identifier, timeout=30)
        control.write_bytes(operation["root"] + "/container-" + str(ordinal) + ".log", logs.stdout + logs.stderr)
        control.write_bytes(operation["root"] + "/qualification/controller/container-" + str(ordinal) + ".log", logs.stdout + logs.stderr)
        record["worker_log_sha256"] = digest(logs.stdout + logs.stderr)
        require(type(state.get("ExitCode")) is int and state["ExitCode"] == 0 and
                state.get("OOMKilled") is False and not state.get("Error"), "scientific worker did not succeed")
        return record
    finally:
        # Never infer daemon termination from the Docker client exit. A failed
        # create whose ID was lost stays unknown, with the exact name retained.
        if identifier is not None and SHA.fullmatch(identifier):
            try:
                value = attest(inspect(identifier), spec, token, ordinal)
                if value["State"].get("Running"):
                    operation["daemon_pending"] = True
                    docker_capture("stop", "--time", "10", identifier, timeout=30)
                    value = attest(inspect(identifier), spec, token, ordinal)
                require(value["State"].get("Status") in ("created", "exited") and
                        value["State"].get("Running") is False, "owned scientific cleanup is unconfirmed")
                record["cleanup"] = dict(state=value["State"], owned_id=identifier, retained=True)
                operation["daemon_pending"] = False
            except BaseException as error:
                record["cleanup_error"] = str(error)
                operation["daemon_pending"] = True
                raise ControlOutcomeUnknown("scientific owned-container cleanup unconfirmed") from error
            finally:
                control.write(operation["root"] + "/container-" + str(ordinal) + ".json", record)


def capture(control, technical, selected, names, destination):
    from bootstrap_docker_toolchain import read_input
    require(len(names) <= 1024 and names == sorted(set(names)), "source closure count/order differs")
    files = {}
    total = 0
    for name in names:
        raw = read_input(selected, name)
        total += len(raw)
        require(len(raw) <= 4 << 20 and total <= 32 << 20, "source closure byte limit")
        relative = destination(name)
        control.write_bytes(technical + "/" + relative, raw)
        files[name] = digest(raw)
    for name, expected in files.items():
        require(digest(read_input(selected, name)) == expected, "source changed during capture: " + name)
    return files


def read_native(backend_id, producer_attempt):
    return json.loads(docker_capture("exec", backend_id, "/usr/local/bin/python3", "-B", "-c",
                                    READ_NATIVE, producer_attempt, timeout=300).stdout)


def _boris():
    sys.path.insert(0, "/tools/scripts")
    import boris_nf_common_case_v3 as common
    import run_managed_boris_nf as legacy
    inputs = legacy.read_json(Path("/input/run_input.json"))
    if inputs.get("schema") == "fullmag.boris_nf.fixed-m-iterations.v1.input":
        import boris_nf_iteration_diagnostic as diagnostic
        diagnostic.worker()
    else:
        common._worker()


def _fullmag():
    import runpy
    sys.path[:0] = ["/tools", "/source/packages/fullmag-py/src"]
    sys.argv = ["/tools/run_managed_fullmag_nf_common_v2.py", "execute"]
    runpy.run_path(sys.argv[0], run_name="__main__")


def _compare():
    sys.path[:0] = ["/tools/scripts", "/source/packages/fullmag-py/src"]
    import boris_nf_common_case_v3 as common
    import run_boris_fullmag_nf_common_matrix_v3 as matrix
    import run_managed_fullmag_nf_common_v2 as fullmag
    from compare_boris_fullmag_she_nf import load_fullmag_m2_artifact
    contract = fullmag.read(Path("/qualification"), "binding.json")
    binding = contract["native"]
    execution = fullmag.read(Path("/qualification"), "execution.json")
    require(execution.get("schema") == SCHEMA and execution.get("native_binding_sha256") == digest(canonical(binding)) and
        len(execution.get("containers", [])) == 4, "actual execution correspondence missing")
    root = Path("/references")
    rows = []
    actual = fullmag.read(root/"fullmag", "summary.json")
    require(actual.get("schema") == fullmag.OUTPUT_SCHEMA and actual.get("physics_qualified") is False and
            [v.get("key") for v in actual.get("cases", [])] == [v["key"] for v in fullmag.cases()], "Fullmag case completion differs")
    fullmag_closure = fullmag.closure(root/"fullmag")
    boris_closures = {}
    for case_key in common.CASE_KEYS:
        export = root/"boris"/case_key
        descriptor = common.case_descriptor(case_key)
        entries, probe, _ = common.validate_outputs(export, descriptor, binding["boris_build_proof"])
        verify_probe(binding, probe, contract["runtime_baseline"])
        boris_closures[case_key] = entries
        record = execution["containers"][common.CASE_KEYS.index(case_key)]
        identity = scientific_identity(binding, contract["run_id"], case_key, record, entries)
        identity.update(device_requested="cpu", device_detected="cpu", precision="double",
            binary_version=probe["binary_version"], python_version=probe["embedded_python_version"],
            precision_abi_sha256=digest(canonical(probe["precision_abi"])))
        ordinal = common.CASE_KEYS.index(case_key)
        worker_log = fullmag.member(Path("/qualification"), "container-" + str(ordinal) + ".log", 8 << 20).read_bytes()
        require(digest(worker_log) == record.get("worker_log_sha256"), "retained actual worker log differs")
        manifests = [json.loads(line) for line in worker_log.decode().splitlines()
            if line.startswith('{"schema": "' + common.CLOSURE_SCHEMA + '"')]
        require(manifests == [dict(schema=common.CLOSURE_SCHEMA, outputs=entries)], "actual worker output closure differs")
        summary = common.artifact_summary(export, descriptor, identity, entries)
        fullmag.write(Path("/export")/(case_key + "-boris-summary.json"), summary)
        artifact = matrix.normalize_common_boris(export, summary, case_key)
        for tolerance in matrix.TOLERANCES:
            key = f"{case_key}__tol-{tolerance:.0e}"
            case = next(v for v in actual["cases"] if v["key"] == key)
            directory = root/"fullmag/result"/key
            verified = fullmag.validate_case(directory, next(v for v in fullmag.cases() if v["key"] == key),
                dict(native_source_identity=binding["native_source_identity"], binary_sha256=binding["fullmag_binary_sha256"]), matrix.reference)
            require(verified == case, "independent Fullmag raw readback differs")
            other = load_fullmag_m2_artifact(directory/"transport/fullmag_m2_nf_reference.json")
            resolution = matrix.reference.common_resolutions()[case_key]
            require(other.shape == resolution.shape and other.step_m == resolution.cell_m, "common carrier differs")
            import math
            require(all(math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-18) for a, b in
                zip(other.origin_m, matrix.reference.mesh_registration(resolution)["fullmag_origin_m"])), "common origin differs")
            rows.append(dict(case_key=case_key, tolerance=tolerance, comparison=matrix.compare_common(artifact, other, case)))
    require(fullmag.closure(root/"fullmag") == fullmag_closure and all(
        common.validate_outputs(root/"boris"/key, common.case_descriptor(key), binding["boris_build_proof"])[0] == boris_closures[key]
        for key in common.CASE_KEYS), "raw outputs changed during comparison")
    fullmag.write(Path("/export/comparison.json"), dict(schema=SCHEMA, native=binding, rows=rows,
        retained_raw_outputs=dict(boris=boris_closures, fullmag=fullmag_closure),
        status="raw_comparison_complete_unqualified", physics_qualified=False, torque_comparable=False,
        r0_scope="capacity/raw completion only; bulk zero-interior residual unavailable"))




def verify_probe(binding, probe, baseline):
    from local_runner import boris_cpu as boris
    proof = binding["boris_build_proof"]
    expected = {"binary_sha256","binary_version","external_python_version","embedded_python_version","solver_exit_code",
        "solver_exit_protocol","device","precision_abi","numpy_version","matplotlib_version"}
    require(set(probe) == expected and all(isinstance(probe.get(k), str) and bool(probe[k]) for k in
        ("binary_version","external_python_version","embedded_python_version","numpy_version","matplotlib_version")) and
        "BORIS" in probe["binary_version"] and probe.get("device") == "cpu" and probe.get("binary_sha256") == proof["binary_sha256"] and
        probe.get("precision_abi") == boris.abi_binding(dict(job_id=binding["producer_attempt"],
            source_digest=proof["capsule_digest"], image_digest=binding["image_id"]), proof["compile_flags_sha256"],
            proof["cuda_flags_sha256"], boris.ABI_FACTS), "actual BORIS version/CPU binary64 ABI differs")
    require(probe["numpy_version"] == baseline["numpy"] and probe["external_python_version"] == baseline["python"] and
        probe["embedded_python_version"].split()[0] == baseline["python"].split()[0] and
        [v["version"] for v in baseline["private_modules"] if v["name"] == "matplotlib"] == [probe["matplotlib_version"]],
        "BORIS runtime imports differ from admitted same-image/private-prefix baseline")


def scientific_identity(binding, run_id, case_key, record, outputs):
    require(binding.get("schema") == SCHEMA and TOKEN.fullmatch(run_id) and case_key in ("r0", "r1", "r2"), "identity namespace differs")
    require(record.get("spec", {}).get("role") == "boris" and record["spec"].get("case_key") == case_key and
        record["spec"].get("image") == binding["image_id"] and record["spec"].get("project") == binding["compose_project"] and
        record.get("state") == "exited" and type(record.get("exit_code")) is int and record["exit_code"] == 0 and
        SHA.fullmatch(record.get("container_id", "")) and SHA.fullmatch(record.get("attestation_sha256", "")) and
        record.get("cleanup", {}).get("owned_id") == record["container_id"] and
        record["cleanup"]["state"].get("Running") is False and record["cleanup"]["state"].get("Status") == "exited" and
        record.get("terminal_state", {}).get("OOMKilled") is False and not record["terminal_state"].get("Error") and
        record["cleanup"]["state"] == record["terminal_state"],
        "identity has no actual owned capacity completion")
    return dict(schema_version=IDENTITY, scientific_run=run_id, case_key=case_key,
        container_id=record["container_id"], terminal_record_sha256=digest(canonical(record)),
        container_attestation_sha256=record["attestation_sha256"], native_binding_sha256=digest(canonical(binding)),
        producer_receipt_sha256=binding["producer_receipt_sha256"], prefix_receipt_sha256=binding["prefix_receipt_sha256"],
        binary_sha256=binding["boris_build_proof"]["binary_sha256"], source_manifest_sha256=binding["boris_outputs"]["source_manifest.json"],
        actual_outputs_sha256=digest(canonical(outputs)), memory_bytes=MEMORY, cpus=2, pids=PIDS,
        old_runner_job=False, physics_qualified=False)


def run(args):
    profile = getattr(args, "profile", "comparison")
    require(profile in ("comparison", "fixed-m-iterations-1248"), "unknown scientific profile")
    diagnostic = None
    if profile == "fixed-m-iterations-1248":
        import boris_nf_iteration_diagnostic as diagnostic
    import fullmag_storage as storage
    import boris_nf_common_case_v3 as common
    import run_managed_boris_nf_v2 as tools
    import run_managed_fullmag_nf_common_v2 as fullmag
    from bootstrap_docker_toolchain import read_input
    from docker_dev import _select_source, _compose_identity
    from docker_dev_host import require_host
    from docker_volume_activate import _linked_runtime_terminals, _validate_running_group
    from docker_dev_codegen import _backend_documents, _validate_backend, _probe_source, _source_matches
    import docker_backend_volume_cache as cache_owner
    require_host()
    require(TOKEN.fullmatch(args.attempt) and TOKEN.fullmatch(args.producer_attempt) and
        TOKEN.fullmatch(args.report_id) and SHA.fullmatch(args.config_sha256) and
        SHA.fullmatch(args.producer_receipt_sha256), "exact DEV/producer/report/config pins required")
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), Path(args.source_root))
    require(digest(read_input(selected, "scripts/docker_nf_common_volume.py")) == LOADED_SHA, "loaded controller differs")
    identity = _compose_identity(layout)
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    retained = "development/attempts/" + args.attempt
    terminal, document = control.read(retained + "/terminal.json"), control.read(retained + "/compose.json")
    require(document.get("name") == control.project and digest(canonical(document)) == args.config_sha256 and
        terminal.get("inputs", {}).get("source_root") == str(selected), "retained group/source/config differs")
    image = terminal["inputs"]["image_id"]
    admitted = []
    for candidate in _linked_runtime_terminals(control, args.attempt, terminal, source_root=str(selected), image=image, config_sha256=args.config_sha256):
        try:
            ids = _validate_running_group(control, identity, document, candidate, image, source_root=str(selected))
            admitted.append(ids)
        except BuildControlError:
            continue
    require(len(admitted) == 1, "one current admitted group required")
    backend_id, frontend_id = admitted[0]
    before = inspect(backend_id)
    images = json.loads(docker_capture("image", "inspect", image).stdout)
    require(len(images) == 1 and images[0].get("Id") == image and images[0].get("Os") == "linux" and
        images[0].get("Architecture") == "amd64" and not images[0].get("Config", {}).get("Volumes"), "same immutable scientific image required")
    cache = control.read(retained + "/backend-cache.json")
    cache_owner.validate_container(before, cache)
    storage.initialize_runtime(layout)
    scientific = storage.validate_path(Path(layout["runs_root"])/args.report_id/"nf-common-volume", Path(layout["runs_root"]))
    require(not scientific.exists(), "report output already exists; no blind retry")
    with control.operation("nf-scientific", dict(development_attempt=args.attempt, producer_attempt=args.producer_attempt,
        producer_receipt_sha256=args.producer_receipt_sha256, report_id=args.report_id,
        image_id=image, config_sha256=args.config_sha256, backend_id=backend_id, frontend_id=frontend_id,
        controller_sha256=LOADED_SHA, scientific_root=str(scientific), profile=profile)) as operation:
        # The existing operation lease excludes package-build/publication owners.
        # No service stop/start, second Compose project, or old runner API is used.
        same_backend(before, inspect(backend_id))
        require(control.read(retained + "/terminal.json") == terminal and control.read(retained + "/compose.json") == document, "retained admission changed")
        receipt, provenance, package_sha, binary = _backend_documents(backend_id)
        backend_source, _, _ = _validate_backend(receipt, provenance, package_sha, binary)
        probe, _ = _probe_source(backend_id, operation["receipt"]["attempt"])
        require(_source_matches(probe, backend_source), "current source/package differ")
        native_doc = read_native(backend_id, args.producer_attempt)
        require(native_doc["producer_sha256"] == args.producer_receipt_sha256, "producer receipt CAS differs")
        binding = native_binding(native_doc, args.producer_attempt, control.project, image, package_sha)
        technical = operation["root"] + "/qualification"
        # The same trusted bytes get separate host-tools attribution, never a
        # source_digest override or attribution to the earlier native package.
        names = sorted(set(tools.TOOL_NAMES) | {"scripts/boris_nf_common_case_v3.py", "scripts/run_managed_boris_nf_v3.py",
            "scripts/run_boris_fullmag_nf_common_matrix_v3.py", "scripts/run_managed_fullmag_nf_common_v2.py",
            "scripts/run_fullmag_m2_nf_common_case_v3.py"})
        if diagnostic is not None:
            names = sorted(set(names) | {"scripts/boris_nf_iteration_diagnostic.py"})
        require(len(names) <= 64, "existing BORIS worker tool count bound")
        hashes = capture(control, technical, selected, names, lambda name: "tools/" + name)
        tools_manifest = dict(schema="fullmag.boris.runtime-tools.v1", solver_capsule_attribution=False, files=hashes)
        control.write(technical + "/tools/manifest.json", tools_manifest)
        # BuildControl.write serializes canonical JSON followed by LF.
        tools_sha = digest(canonical(tools_manifest) + b"\n")
        controller = capture(control, technical, selected, ["scripts/docker_build_control.py", "scripts/docker_nf_common_volume.py"], lambda name: "controller/" + Path(name).name)
        require(controller["scripts/docker_nf_common_volume.py"] == LOADED_SHA, "loaded/captured controller differs")
        public_names = sorted(v for v in storage.git(selected, "ls-files", "-z", "--", "packages/fullmag-py").split("\0")
            if v and "/__pycache__/" not in v)
        require(public_names, "canonical public DSL source closure missing")
        public = capture(control, technical, selected, public_names, lambda name: "source/" + name)
        fullmag_names = list(fullmag.TOOLS)
        capture(control, technical, selected, sorted("scripts/" + v for v in fullmag_names), lambda name: "fullmag-tools/" + Path(name).name)
        # Exact cases are generated in the already-pinned scientific module.
        # Constructing them does not import or execute the solver.
        fullmag_cases = fullmag.cases()
        control.write(technical + "/fullmag-tools/manifest.json", dict(schema="fullmag.managed-fullmag-nf.v2",
            solver_capsule_attribution=False, cases=fullmag_cases, lane=fullmag.LANE,
            tools_sha256={v:hashes["scripts/"+v] for v in fullmag_names}, public_dsl_sha256=public,
            binary_sha256=binding["fullmag_binary_sha256"], native_source_identity=binding["native_source_identity"]))
        control.write(technical + "/controller/binding.json", dict(run_id=operation["receipt"]["attempt"], native=binding,
            tool_sha256=hashes, controller_sha256=controller, public_dsl_sha256=public,
            runtime_baseline=dict(python=native_doc["prefix"]["current_baseline"]["python"]["version"],
                numpy=native_doc["prefix"]["current_baseline"]["numpy"]["version"], private_modules=native_doc["prefix"]["modules"])))
        # A byte-identical RO execution view admits the existing explicit flush
        # adapter without mutating the compiled producer directory or source.
        source = "/build/external-reference-boris/" + args.producer_attempt + "/artifacts/outputs/boris"
        target = "/control/" + technical + "/boris"
        from local_runner import boris_cpu
        copy = "umask 027; mkdir -p " + shlex.quote(target)
        for name, expected in binding["boris_outputs"].items():
            require(name in boris_cpu.OUTPUTS and SHA.fullmatch(expected), "unknown BORIS output")
            src, dst = source + "/" + name, target + "/" + name
            copy += "; test ! -L " + shlex.quote(src) + "; test \"$(sha256sum " + shlex.quote(src) + " | cut -d' ' -f1)\" = " + expected
            copy += "; cp -- " + shlex.quote(src) + " " + shlex.quote(dst) + "; test \"$(sha256sum " + shlex.quote(dst) + " | cut -d' ' -f1)\" = " + expected
        argv = control.helper_args("timeout --signal=TERM --kill-after=10 240 bash -euo pipefail -c " + shlex.quote(copy),
            name="fullmag-nf-copy-" + operation["receipt"]["attempt"])
        point = argv.index("--entrypoint")
        argv[point:point] = ["--mount", "type=volume,src=" + cache["volume_names"]["build"] + ",dst=/build,readonly,volume-nocopy"]
        dispatch_copy(control, operation, argv, dict(native_binding_sha256=digest(canonical(binding)),
            build_volume=cache["volume_names"]["build"], source=source, target=target, outputs=binding["boris_outputs"]))
        import base64
        adapted = tools.adapt_wrapper(base64.b64decode(native_doc["wrapper_b64"], validate=True), binding["boris_build_proof"]["original_source"])
        control.write_bytes(technical + "/boris/EmbeddedPythonWrapper.py", adapted)
        family = (diagnostic.family_binding(binding, tools_sha, hashes["scripts/boris_nf_iteration_diagnostic.py"])
                  if diagnostic is not None else common.family_binding(binding, tools_sha, hashes["scripts/boris_nf_common_case_v3.py"]))
        scientific.mkdir(parents=True, exist_ok=False)
        previous = None
        for ordinal, key in enumerate(("r0",) if diagnostic is not None else common.CASE_KEYS):
            _, script, scenario = (diagnostic.fixed_inputs(key) if diagnostic is not None else common.fixed_inputs(key))
            control.write_bytes(technical + "/input/" + key + "/scenario.py", script)
            control.write_bytes(technical + "/input/" + key + "/scenario.json", scenario)
            control.write(technical + "/input/" + key + "/run_input.json", dict(schema=diagnostic.INPUT_SCHEMA if diagnostic is not None else "fullmag.boris_nf_common.input.v3",
                case_key=key, binding=binding, tools_manifest_sha256=tools_sha, family_binding=family, previous_capacity=previous))
            export = scientific/"boris"/key
            export.mkdir(parents=True, exist_ok=False)
            spec = specification(binding, control.volume, cache, technical, export, "boris", key)
            record = run_container(control, operation, spec, ordinal)
            previous = dict(case_key=key, scientific_run=operation["receipt"]["attempt"],
                container_id=record["container_id"], terminal_sha256=digest(canonical(record)), family_sha256=digest(canonical(family)),
                scope="capacity/raw completion only; not physics qualification")
        if diagnostic is None:
            export = scientific/"fullmag"
            export.mkdir()
            run_container(control, operation, specification(binding, control.volume, cache, technical, export, "fullmag"), 3)
            export = scientific/"comparison"
            export.mkdir()
            control.write(technical + "/controller/execution.json", dict(schema=SCHEMA, native_binding_sha256=digest(canonical(binding)),
                containers=operation["receipt"]["containers"]))
            spec = specification(binding, control.volume, cache, technical, export, "compare")
            spec["mounts"].append(dict(kind="bind", source=str(scientific), target="/references", readonly=True, subpath=""))
            run_container(control, operation, spec, 4)
        same_backend(before, inspect(backend_id))
        from windows_folder_host import read_owned_regular
        report_path = scientific/("boris/r0/diagnostic.json" if diagnostic is not None else "comparison/comparison.json")
        report_raw = read_owned_regular(report_path, maximum=8 << 20)
        report = json.loads(report_raw)
        if diagnostic is not None:
            _, diagnostic_probe, expected_report = diagnostic.validate_outputs(scientific/"boris/r0", diagnostic.descriptor(), binding["boris_build_proof"], binding)
            verify_probe(binding, diagnostic_probe, dict(python=native_doc["prefix"]["current_baseline"]["python"]["version"],
                numpy=native_doc["prefix"]["current_baseline"]["numpy"]["version"], private_modules=native_doc["prefix"]["modules"]))
            require(report == expected_report and report.get("schema") == diagnostic.SCHEMA
                and report.get("status") == "diagnostic_complete_unqualified"
                and report.get("comparison_v3") is False, "diagnostic report correspondence differs")
        else:
            require(report.get("schema") == SCHEMA and report.get("native") == binding and
                report.get("status") == "raw_comparison_complete_unqualified" and report.get("physics_qualified") is False and
                [(v.get("case_key"), v.get("tolerance")) for v in report.get("rows", [])] ==
                    [(k,t) for k in common.CASE_KEYS for t in (1e-8,1e-10)], "scientific comparison is incomplete")
        require(read_native(backend_id, args.producer_attempt) == native_doc, "native/prefix/package changed during qualification")
        final_probe, _ = _probe_source(backend_id, operation["receipt"]["attempt"] + "-f")
        require(_source_matches(final_probe, backend_source), "late current source/package differ")
        from bootstrap_docker_toolchain import read_input
        for name, expected in {**hashes, **controller, **public}.items():
            require(digest(read_input(selected, name)) == expected, "captured source changed: " + name)
        operation["receipt"].update(state="succeeded", qualification="FIXED-M DIAGNOSTIC ONLY; NOT SCIENTIFIC PASS" if diagnostic is not None else "RAW COMPARISON ONLY; NOT SCIENTIFIC PASS",
            native=binding, tool_sha256=hashes, public_dsl_sha256=public, physics_qualified=False,
            torque_comparable=False, scientific_root=str(scientific), source_capsule_attribution=False,
            report_sha256=digest(report_raw), profile=profile, comparison_sha256=None if diagnostic is not None else digest(report_raw), family_binding=family)
    terminal = control.read(operation["root"] + "/terminal.json")
    require(terminal.get("state") == "succeeded", "durable scientific terminal receipt missing")
    storage.atomic_json(scientific/"receipt.json", dict(schema=diagnostic.SCHEMA if diagnostic is not None else SCHEMA,
        state="diagnostic_complete_unqualified" if diagnostic is not None else "raw_comparison_complete_unqualified",
        control_volume=control.volume, control_terminal=operation["root"] + "/terminal.json",
        terminal_sha256=digest(canonical(terminal) + b"\n"), native=binding,
        report_sha256=digest(report_raw), comparison_sha256=None if diagnostic is not None else digest(report_raw),
        profile=profile, physics_qualified=False, torque_comparable=False))
    print(json.dumps(dict(control_root=operation["root"], scientific_root=str(scientific), physics_qualified=False)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--producer-attempt", required=True)
    parser.add_argument("--producer-receipt-sha256", required=True)
    parser.add_argument("--report-id", required=True)
    parser.add_argument("--profile", choices=("comparison", "fixed-m-iterations-1248"), default="comparison")
    run(parser.parse_args())


if __name__ == "__main__":
    if sys.argv[1:] in (["_boris"], ["_fullmag"], ["_compare"]):
        globals()[sys.argv[1]]()
    else:
        main()
