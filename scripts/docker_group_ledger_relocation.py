"""Native-fenced transfer for one stopped Docker DEV group's retained ledger."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess

from docker_build_control import BuildControlError, ControlOutcomeUnknown, bounded_capture, canonical, docker_capture, docker_text
import docker_group_storage as group_storage

SCHEMA = "fullmag.group-ledger-relocation.v1"
INSPECTION = "fullmag.group-ledger-relocation-inspection.v1"
LOGICAL_ROOT = "/host-ledger/ledger"
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_VOLUME = re.compile(r"[a-z0-9][a-z0-9_.-]*\Z")


def require(condition, message):
    if not condition:
        raise BuildControlError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_request(control, request, *, allow_uninspected=False):
    require(getattr(control, "namespace", "") == "", "Legacy ledger relocation requires its original root namespace")
    fields = {"schema", "compose_project", "control_volume", "source_root", "source_commit",
              "daemon_id_sha256", "host_id", "source_volume", "target_subpath", "logical_root",
              "native_program", "bootstrap", "copy_script_sha256", "expected_inspection",
              "source_volume_sha256", "target_volume_sha256"}
    require(isinstance(request, dict) and set(request) == fields and request["schema"] == SCHEMA,
            "Unsupported ledger relocation request")
    require(request["compose_project"] == control.project and request["control_volume"] == control.volume
            and request["source_root"] == control.identity["source_root"]
            and request["target_subpath"] == group_storage.role_subpath(control, "ledger")
            and request["logical_root"] == LOGICAL_ROOT, "Ledger relocation group or path differs")
    require(isinstance(request["source_commit"], str) and re.fullmatch(r"[0-9a-f]{40}", request["source_commit"]),
            "Ledger relocation source commit is invalid")
    for name in ("daemon_id_sha256", "host_id", "copy_script_sha256", "source_volume_sha256", "target_volume_sha256"):
        require(isinstance(request[name], str) and _HEX.fullmatch(request[name]), "Invalid relocation " + name)
    source = request["source_volume"]
    require(isinstance(source, str) and _VOLUME.fullmatch(source) and source != control.volume,
            "Relocation requires a distinct legacy source volume")
    program = request["native_program"]
    require(isinstance(program, dict) and set(program) == {"image_id", "package_volume", "package_subpath", "candidate", "receipt_sha256", "cli_sha256"},
            "Incomplete native relocation program binding")
    require(isinstance(program["image_id"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", program["image_id"])
            and isinstance(program["package_volume"], str) and _VOLUME.fullmatch(program["package_volume"])
            and isinstance(program["package_subpath"], str) and re.fullmatch(r"groups/[0-9a-f]{64}", program["package_subpath"])
            and all(isinstance(program[name], str) and _HEX.fullmatch(program[name]) for name in ("receipt_sha256", "cli_sha256")),
            "Native relocation image/package pin differs")
    candidate = PurePosixPath(program["candidate"]) if isinstance(program["candidate"], str) else PurePosixPath("/")
    require(str(candidate) == program["candidate"] and candidate.parent == PurePosixPath("/opt/fullmag/package/.development/candidates")
            and re.fullmatch(r"\.backend-package-candidate-[A-Za-z0-9_-]+", candidate.name), "Native candidate path is outside its namespace")
    bootstrap = request["bootstrap"]
    require(isinstance(bootstrap, dict) and set(bootstrap) == {"terminal_path", "terminal_sha256", "result_path", "result_sha256", "container_id", "started_at"},
            "Bootstrap evidence is incomplete")
    for name in ("terminal_sha256", "result_sha256", "container_id"):
        require(isinstance(bootstrap[name], str) and _HEX.fullmatch(bootstrap[name]), "Invalid bootstrap pin")
    for name in ("terminal_path", "result_path"):
        relative = bootstrap[name]
        require(isinstance(relative, str) and re.fullmatch(r"group-ledger-bootstrap/attempts/[0-9a-f]{32}/(?:terminal|result)\.json", relative),
                "Bootstrap evidence path is outside its operation")
    require(PurePosixPath(bootstrap["terminal_path"]).parent == PurePosixPath(bootstrap["result_path"]).parent,
            "Bootstrap result and terminal belong to different operations")
    require(isinstance(bootstrap["started_at"], str) and bootstrap["started_at"], "Bootstrap incarnation is missing")
    expected = request["expected_inspection"]
    require((allow_uninspected and expected is None) or
            (isinstance(expected, dict) and expected.get("schema_version") == INSPECTION
             and expected.get("host_id") == request["host_id"]), "Exact native source inspection is required")
    return request


def assert_no_consumers(request, documents, allowed_ids=()):
    """The caller supplies a freshly authenticated complete Docker ps snapshot."""
    allowed = set(allowed_ids)
    for row in documents:
        if row.get("State", {}).get("Running") is not True or row.get("Id") in allowed:
            continue
        names = {mount.get("Name") for mount in row.get("Mounts", []) if mount.get("Type") == "volume"}
        require(request["source_volume"] not in names and request["control_volume"] not in names,
                "A retained ledger or target group volume still has an active consumer")


def _revalidate_bootstrap(control, request):
    from docker_host_ledger import _daemon_info
    import docker_group_ledger
    daemon = _daemon_info(docker_text)
    require(daemon["id_sha256"] == request["daemon_id_sha256"]
            and docker_group_ledger.host_id(daemon["id_sha256"], control.project) == request["host_id"],
            "Relocation daemon or logical group host changed")
    for name, digest in ((request["source_volume"], request["source_volume_sha256"]),
                         (control.volume, request["target_volume_sha256"])):
        rows = json.loads(docker_capture("volume", "inspect", name).stdout)
        require(len(rows) == 1 and rows[0].get("Name") == name and rows[0].get("Driver") == "local"
                and rows[0].get("Options") in (None, {}) and sha(canonical(rows[0])) == digest,
                "Ledger volume identity or backing changed")
    group_storage._inspect_existing_volume(control, docker_capture)
    pin = request["bootstrap"]
    terminal = control.read(pin["terminal_path"])
    result = control.read(pin["result_path"])
    require(sha(canonical(terminal)) == pin["terminal_sha256"] and sha(canonical(result)) == pin["result_sha256"],
            "Bootstrap receipt CAS changed")
    require(terminal.get("state") == "succeeded" and terminal.get("phase") == "group-ledger-bootstrap"
            and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
            and terminal.get("inputs", {}).get("source_root") == request["source_root"],
            "Bootstrap has no successful same-group terminal")
    require(terminal.get("source_group_ledger") == {"volume_name": request["source_volume"], "host_id": request["host_id"]},
            "Bootstrap predecessor ledger differs from relocation source")
    native = request["native_program"]
    require(result.get("state") == "candidate-ready" and result.get("candidate") == native["candidate"]
            and result.get("candidate_receipt_sha256") == native["receipt_sha256"]
            and result.get("candidate_cli_sha256") == native["cli_sha256"]
            and result.get("package_promoted") is False and result.get("runtime_started") is False
            and result.get("source", {}).get("resolved_commit") == request["source_commit"],
            "Bootstrap did not preserve a closed unpromoted native candidate")
    observed = json.loads(docker_capture("inspect", pin["container_id"]).stdout)
    require(len(observed) == 1, "Bootstrap backend identity is ambiguous")
    row = observed[0]
    labels, state = row.get("Config", {}).get("Labels", {}), row.get("State", {})
    require(row.get("Id") == pin["container_id"] and row.get("Image") == native["image_id"]
            and labels.get("com.docker.compose.project") == control.project
            and labels.get("com.docker.compose.service") == "backend"
            and state.get("StartedAt") == pin["started_at"] and state.get("Running") is False
            and state.get("OOMKilled") is False and state.get("ExitCode") == 0,
            "Bootstrap service has not ended successfully in its pinned incarnation")
    _validate_bootstrap_mounts(row, request)


def _validate_bootstrap_mounts(row, request):
    program = request["native_program"]
    for destination, volume, subpath in (
            ("/opt/fullmag/package", program["package_volume"], program["package_subpath"]),
            ("/host-ledger", request["source_volume"], "")):
        actual = [mount for mount in row.get("Mounts", []) if mount.get("Destination") == destination]
        declared = [mount for mount in row.get("HostConfig", {}).get("Mounts", []) if mount.get("Target") == destination]
        options = {"NoCopy": True, **({"Subpath": subpath} if subpath else {})}
        require(len(actual) == 1 and actual[0].get("Type") == "volume"
                and actual[0].get("Name") == volume and actual[0].get("RW") is True
                and actual[0].get("Driver") == "local"
                and len(declared) == 1 and declared[0] == {
                    "Type": "volume", "Source": volume, "Target": destination, "VolumeOptions": options},
                "Bootstrap package or source ledger mount differs from the exact relocation namespace")
        # Nested mounts would shadow bytes within the pinned view.
        require(not any(mount.get("Destination", "").startswith(destination + "/")
                        for mount in row.get("Mounts", [])), "Bootstrap mount contains an unexpected overlay")


def _live_consumers():
    ids = docker_capture("ps", "--quiet", "--no-trunc").stdout.decode().split()
    rows = json.loads(docker_capture("inspect", *ids).stdout) if ids else []
    require(isinstance(rows, list) and {row.get("Id") for row in rows} == set(ids),
            "Docker consumer inventory changed or is incomplete")
    return rows


def _helper(control, request, script, *, target=False, name=None):
    args = control.helper_args(script, name=name)
    selected = json.loads(docker_capture("image", "inspect", request["native_program"]["image_id"]).stdout)
    require(len(selected) == 1 and selected[0].get("Id") == request["native_program"]["image_id"],
            "Native helper image identity differs")
    if any(value.startswith("NVIDIA_REQUIRE_CUDA=") for value in selected[0].get("Config", {}).get("Env", [])):
        # CUDA-linked control commands need driver libraries, not a GPU device.
        args[args.index("--runtime") + 1] = "nvidia"
        args[args.index("NVIDIA_VISIBLE_DEVICES=void")] = "NVIDIA_VISIBLE_DEVICES=none"
        index = args.index("--entrypoint")
        args[index:index] = ["--env", "NVIDIA_DRIVER_CAPABILITIES=compute"]
    args[args.index("--entrypoint") + 2] = request["native_program"]["image_id"]
    program = request["native_program"]
    package = "type=volume,src=" + program["package_volume"] + ",dst=/opt/fullmag/package,readonly,volume-nocopy,volume-subpath=" + program["package_subpath"]
    ledger = ("type=volume,src=" + request["source_volume"] + ",dst=/host-ledger,readonly,volume-nocopy" if not target else
              "type=volume,src=" + control.volume + ",dst=/host-ledger,readonly,volume-nocopy,volume-subpath=" + request["target_subpath"])
    index = args.index("--entrypoint")
    args[index:index] = ["--mount", package, "--mount", ledger]
    return args


def _native_script(request, command, *arguments, published=False):
    program = request["native_program"]
    code = """import hashlib,json,os,sys
from pathlib import Path
sys.path.insert(0,'/opt/fullmag')
import backend_dev as backend
p=json.loads(sys.argv[1]);published=sys.argv[2]=='published';root=backend.PACKAGE_ROOT if published else Path(p['candidate'])
options={'exclude_development_control':True} if published else {'exclude_candidate_marker':True}
r,raw,_=backend._validated_package(root,'ledger relocation program',**options)
if hashlib.sha256(raw).hexdigest()!=p['receipt_sha256']:raise SystemExit('candidate receipt differs')
cli=root/'bin/fullmag-bin'
if backend._sha256_file(cli,'ledger CLI',512*1024**2,package_artifact=True)[0]!=p['cli_sha256']:raise SystemExit('candidate CLI differs')
os.execve(str(cli),[str(cli),*sys.argv[3:]],{**os.environ,'LD_LIBRARY_PATH':str(root/'lib')})
"""
    return shlex.join(["python3", "-B", "-c", code, json.dumps(program), "published" if published else "candidate", "runtime", command,
                       "--ledger-root", LOGICAL_ROOT, "--host-id", request["host_id"], *arguments])


def inspect_source(control, operation, request):
    """Read a native source preview; this never copies or publishes adoption."""
    validate_request(control, request, allow_uninspected=True)
    require(getattr(control, "_active_operation", None) is operation
            and operation["receipt"].get("inputs", {}).get("source_root") == request["source_root"],
            "Inspection requires the selected group's active managed lease")
    _revalidate_bootstrap(control, request)
    assert_no_consumers(request, _live_consumers(), {operation["helper_container_id"]})
    observed = bounded_capture(_helper(control, request, _native_script(request, "ledger-relocation-inspect")),
                               data=b"", timeout=120)
    require(observed.returncode == 0, "Native source inspection refused relocation: " + observed.stderr.decode("utf-8", "replace"))
    inspection = json.loads(observed.stdout)
    candidate = {**request, "expected_inspection": inspection}
    validate_request(control, candidate)
    control.write_bytes(operation["root"] + "/request.json", canonical(candidate))
    operation["receipt"].update(state="succeeded", source_preview_verified=True,
                                request_path=operation["root"] + "/request.json", request_sha256=sha(canonical(candidate)),
                                data_copied=False, runtime_started=False)
    return candidate


def transfer(control, operation, request):
    """Copy only after preview; publish adoption evidence only after revalidation."""
    validate_request(control, request)
    require(getattr(control, "_active_operation", None) is operation
            and operation["receipt"].get("phase") == "group-ledger-relocation"
            and operation["receipt"].get("inputs", {}).get("source_root") == request["source_root"],
            "Relocation requires the selected group's active managed lease")
    _revalidate_bootstrap(control, request)
    allowed = {operation["helper_container_id"]}
    assert_no_consumers(request, _live_consumers(), allowed)
    copy_path = Path(__file__).with_name("docker_group_ledger_relocation_copy.py")
    copy_source = copy_path.read_bytes()
    require(sha(copy_source) == request["copy_script_sha256"], "Byte-transfer helper source changed")
    source_name = "fullmag-ledger-source-" + operation["receipt"]["attempt"]
    process = subprocess.Popen(_helper(control, request, _native_script(request, "ledger-relocation-inspect", "--hold-fence"), name=source_name),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    operation["daemon_pending"] = True
    try:
        raw = control._line(process).encode()
        inspection = json.loads(raw)
        require(inspection == request["expected_inspection"], "Native source inspection changed before transfer")
        source_rows = json.loads(docker_capture("inspect", source_name).stdout)
        require(len(source_rows) == 1 and source_rows[0].get("State", {}).get("Running") is True,
                "Native source fence is not confirmed alive")
        source_id = source_rows[0]["Id"]
        allowed.add(source_id)
        assert_no_consumers(request, _live_consumers(), allowed)
        relative = operation["root"] + "/source-inspection.json"
        exact = canonical(inspection)
        control.write_bytes(relative, exact)
        group_storage.prepare(control, operation, request["source_root"])
        payload = base64.b64encode(copy_source).decode()
        code = "import base64,json;code=base64.b64decode(" + repr(payload) + ");exec(compile(code,'ledger-copy','exec'));print(json.dumps(copy_snapshot('/host-ledger/ledger'," + repr('/control/' + request['target_subpath']) + ",json.loads(" + repr(exact.decode()) + "))))"
        require(process.poll() is None, "Native source fence exited before copy")
        copied = bounded_capture(_helper(control, request, shlex.join(["python3", "-B", "-c", code])), data=b"", timeout=120)
        require(copied.returncode == 0, "Ledger byte copy failed; partial target retained: " + copied.stderr.decode("utf-8", "replace"))
        transfer_result = json.loads(copied.stdout)
        control.write(operation["root"] + "/transfer.json", transfer_result)
        require(process.poll() is None, "Native source fence exited before target preview")
        preview = bounded_capture(_helper(control, request, _native_script(request, "ledger-relocation-preview",
            "--expected-inspection", control.path(relative), "--expected-inspection-sha256", sha(exact)), target=True), data=b"", timeout=120)
        require(preview.returncode == 0, "Native target preview refused the copy: " + preview.stderr.decode("utf-8", "replace"))
        verified = json.loads(preview.stdout)
        require(verified.get("schema_version") == "fullmag.group-ledger-relocation-preview.v1"
                and verified.get("status") == "verified" and verified.get("expected_inspection_sha256") == sha(exact)
                and verified.get("inspection") == inspection, "Native target preview evidence differs")
        control.write(operation["root"] + "/target-preview.json", verified)
        assert_no_consumers(request, _live_consumers(), allowed)
        process.stdin.write(b"release\n");process.stdin.flush();process.stdin.close()
        released = json.loads(control._line(process))
        require(process.wait(timeout=30) == 0 and released == {
            "schema_version": "fullmag.group-ledger-relocation-fence-release.v1", "status": "revalidated",
            "semantic_snapshot_sha256": inspection["semantic_snapshot_sha256"], "manifest_sha256": inspection["manifest_sha256"]},
            "Native source fence did not confirm unchanged evidence")
        control.write(operation["root"] + "/source-release.json", released)
        operation["daemon_pending"] = False
        receipt = {"schema": SCHEMA, "state": "verified", "request": request,
                   "source_inspection": inspection, "source_release": released, "target_preview": verified,
                   "transfer": transfer_result, "runtime_started": False, "solve_started": False}
        receipt_path = operation["root"] + "/relocation.json"
        control.write(receipt_path, receipt)
        operation["receipt"].update(state="succeeded", relocation_receipt=receipt_path,
                                    relocation_sha256=sha(canonical(receipt)), runtime_started=False, solve_started=False)
        return receipt
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired as error:
            raise ControlOutcomeUnknown("Native ledger fence outcome is unknown; resources retained") from error
        operation["daemon_pending"] = False


def read_relocation_pointer(control):
    """Derive adoption pins from the canonical managed operation publication.

    BuildControl owns phase/current.json. The immutable terminal must agree
    before its exact relocation artifact can authorize a later startup.
    """
    require(getattr(control, "namespace", "") == "", "Ledger relocation publication requires its original root namespace")
    current = control.read("group-ledger-relocation/current.json", optional=True)
    if current is None:
        return None
    require(isinstance(current, dict)
            and current.get("schema") == "fullmag.docker-build-operation.v1"
            and current.get("phase") == "group-ledger-relocation"
            and current.get("state") == "succeeded"
            and current.get("compose_project") == control.project
            and current.get("control_volume") == control.volume
            and isinstance(current.get("inputs"), dict)
            and current["inputs"].get("source_root") == control.identity["source_root"]
            and current.get("runtime_started") is False and current.get("solve_started") is False,
            "Ledger relocation has no successful same-group managed publication")
    attempt = current.get("attempt")
    require(isinstance(attempt, str) and re.fullmatch(r"[0-9a-f]{32}", attempt),
            "Managed ledger relocation attempt is invalid")
    root = "group-ledger-relocation/attempts/" + attempt
    terminal = control.read(root + "/terminal.json")
    require(isinstance(terminal, dict) and current == terminal,
            "Managed ledger relocation current differs from its immutable terminal")
    relative, digest = current.get("relocation_receipt"), current.get("relocation_sha256")
    require(relative == root + "/relocation.json"
            and isinstance(digest, str) and _HEX.fullmatch(digest),
            "Managed ledger relocation artifact is outside its exact attempt")
    return {"schema": SCHEMA, "receipt_path": relative, "receipt_sha256": digest}


def admit_migrated_ledger(control, operation, daemon_id_sha256, *, fresh_generation=None):
    """An existing group ledger must never become a fresh empty private role."""
    previous = control.read("development/verified.json", optional=True)
    if previous is None:
        previous = control.read("development/current.json", optional=True)
    else:
        require(isinstance(previous, dict) and previous.get("state") == "succeeded"
                and previous.get("compose_project") == control.project,
                "Last successful group development authority is malformed")
    if previous is None:
        return
    require(isinstance(previous, dict), "Previous group development record is malformed")
    attempt = previous.get("attempt")
    require(isinstance(attempt, str) and re.fullmatch(r"[0-9a-f]{32}", attempt),
            "Previous group development attempt is not pinned")
    predecessor = control.read("development/attempts/" + attempt + "/group-ledger.json", optional=True)
    if predecessor is None:
        require(previous.get("ledger_profile") != "group-ledger-v1", "Previous group ledger record is missing")
        return
    require(isinstance(predecessor, dict) and predecessor.get("schema") == "fullmag.docker-group-ledger.v1"
            and predecessor.get("compose_project") == control.project
            and predecessor.get("daemon_id_sha256") == daemon_id_sha256,
            "Previous ledger owner or daemon differs")
    already_private = predecessor.get("volume_name") == control.volume
    pointer = read_relocation_pointer(control)
    if already_private and pointer is None:
        # Fresh private groups retain their existing first-admission lifecycle.
        require(previous.get("group_ledger_relocation") is None,
                "Migrated group lost its ledger relocation receipt; fresh initialization refused")
        return
    require(isinstance(pointer, dict) and set(pointer) == {"schema", "receipt_path", "receipt_sha256"}
            and pointer.get("schema") == SCHEMA
            and isinstance(pointer.get("receipt_path"), str)
            and re.fullmatch(r"group-ledger-relocation/attempts/[0-9a-f]{32}/relocation\.json", pointer["receipt_path"]),
            "Existing group ledger requires an explicit verified relocation; fresh initialization refused")
    receipt = control.read(pointer["receipt_path"])
    require(isinstance(receipt, dict) and sha(canonical(receipt)) == pointer.get("receipt_sha256")
            and receipt.get("schema") == SCHEMA and receipt.get("state") == "verified",
            "Group ledger relocation receipt CAS or state differs")
    request = validate_request(control, receipt.get("request"))
    require(request["daemon_id_sha256"] == daemon_id_sha256
            and (already_private or request["source_volume"] == predecessor.get("volume_name"))
            and request["host_id"] == predecessor.get("host_id")
            and receipt.get("source_inspection") == request["expected_inspection"]
            and receipt.get("target_preview", {}).get("schema_version") == "fullmag.group-ledger-relocation-preview.v1"
            and receipt.get("target_preview", {}).get("inspection") == request["expected_inspection"]
            and receipt.get("target_preview", {}).get("expected_inspection_sha256") == sha(canonical(request["expected_inspection"]))
            and receipt.get("target_preview", {}).get("status") == "verified"
            and receipt.get("source_release") == {
                "schema_version": "fullmag.group-ledger-relocation-fence-release.v1", "status": "revalidated",
                "semantic_snapshot_sha256": request["expected_inspection"].get("semantic_snapshot_sha256"),
                "manifest_sha256": request["expected_inspection"].get("manifest_sha256")},
            "Ledger relocation is not bound to the exact predecessor")
    own_pin = {"receipt_path": pointer["receipt_path"], "receipt_sha256": pointer["receipt_sha256"]}
    if already_private:
        require(previous.get("group_ledger_relocation", own_pin) == own_pin,
                "Migrated group ledger relocation lineage changed")
        prospective = (prepare_fresh_ledger_admission(control, operation, daemon_id_sha256, fresh_generation, previous)
                       if fresh_generation is not None else False)
        if not prospective:
            require_initialized_private_ledger(control)
        operation["receipt"]["group_ledger_relocation"] = own_pin
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        return
    retained = control.read(operation["root"] + "/group-ledger.json", optional=True)
    if retained is not None:
        require(operation["receipt"].get("group_ledger_relocation") == own_pin
                and retained.get("volume_name") == control.volume and retained.get("host_id") == request["host_id"],
                "Partial resume lacks its original ledger adoption pin")
    relative = operation["root"] + "/relocated-ledger-inspection.json"
    exact = canonical(request["expected_inspection"])
    control.write_bytes(relative, exact)
    result = bounded_capture(_helper(control, request, _native_script(request, "ledger-relocation-preview",
        "--expected-inspection", control.path(relative), "--expected-inspection-sha256", sha(exact), published=True), target=True),
        data=b"", timeout=120)
    require(result.returncode == 0, "Published native program refused relocated history before startup")
    preview = json.loads(result.stdout)
    require(preview.get("status") == "verified" and preview.get("expected_inspection_sha256") == sha(exact)
            and preview.get("inspection") == request["expected_inspection"], "Relocated ledger startup preview differs")
    control.write(operation["root"] + "/relocated-ledger-preview.json", preview)
    operation["receipt"]["group_ledger_relocation"] = own_pin
    control.write(operation["root"] + "/receipt.json", operation["receipt"])


def require_initialized_private_ledger(control):
    """Guard migrated history before the normal native admission path."""
    script = ("test ! -L /data/ledger && test -d /data/ledger && "
              "for name in HOST_RESOURCE_LEDGER.json HOST_RESOURCE_LEDGER.init.json; do "
              "test ! -L /data/ledger/$name && test -f /data/ledger/$name && "
              "test -s /data/ledger/$name || exit 1; done")
    args = control.helper_args(script)
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount",
        "type=volume,src=" + control.volume + ",dst=/data,readonly,volume-nocopy,volume-subpath="
        + group_storage.role_subpath(control, "ledger")]
    exists = bounded_capture(args, data=b"", timeout=90)
    require(exists.returncode == 0, "Existing private group ledger is missing or uninitialized; fresh initialization refused")


FRESH_ADMISSION = "fullmag.group-ledger-first-admission.v1"
FRESH_FIELD = "fresh_group_ledger_admission"

# Runs only through the already authenticated operation helper. It observes the
# exact archive-created directory; only the late commit publishes a one-shot
# claim outside the mutable ledger leaf, before any backend is created.
_FRESH_ADMISSION_SCRIPT = r"""
import json,os,stat,sys
from pathlib import Path
p=json.loads(sys.stdin.buffer.read(16385));assert len(json.dumps(p))<16384
value=p['candidate'];mode=p['mode'];assert mode in ('inspect','commit')
root=Path('/control');role=root/'private/ledger';leaf=role/'ledger'
archive=root/'runtime-archives'/value['generation']/ 'group-ledger'
claim=root/'group-ledger-first-admission'/(value['generation']+'.json')
def directory(path,expected,owner=None):
 for part in (path,*path.parents):
  assert not part.is_symlink()
  if part==root:break
 else:raise AssertionError('Evidence escaped control root')
 st=path.lstat();assert stat.S_ISDIR(st.st_mode) and str(st.st_dev)+':'+str(st.st_ino)==expected
 if owner is not None:assert str(st.st_uid)+':'+str(st.st_gid)==owner
 return st
directory(role,value['role_device_inode'],'65532:65532')
directory(leaf,value['fresh_device_inode'],'65532:65532')
directory(archive,value['archived_device_inode'],value['archived_owner'])
def initialized():
 for name in ('HOST_RESOURCE_LEDGER.json','HOST_RESOURCE_LEDGER.init.json'):
  path=leaf/name
  if path.is_symlink():raise AssertionError('Ledger authority alias refused')
  try:st=path.lstat()
  except FileNotFoundError:return False
  if not stat.S_ISREG(st.st_mode) or st.st_size<=0:return False
 return True
if initialized():
 assert mode=='inspect','Prospective empty admission changed before commit'
 print('{"state":"initialized"}')
else:
 assert not claim.exists() and not claim.is_symlink(),'Fresh generation already claimed; missing history cannot be reset'
 assert next(leaf.iterdir(),None) is None,'Fresh ledger is not exactly empty'
 assert stat.S_IMODE(leaf.lstat().st_mode)==0o750 and stat.S_IMODE(role.lstat().st_mode)==0o750
 if mode=='commit':
  claim.parent.mkdir(mode=0o750,parents=False,exist_ok=True)
  assert not claim.parent.is_symlink() and claim.parent.is_dir()
  raw=(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
  fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o440)
  with os.fdopen(fd,'wb') as stream:
   st=os.fstat(stream.fileno());assert stat.S_ISREG(st.st_mode) and st.st_nlink==1
   stream.write(raw);stream.flush();os.fsync(stream.fileno())
   named=claim.lstat();assert (st.st_dev,st.st_ino)==(named.st_dev,named.st_ino)
  for path in (claim.parent,root):
   before=path.lstat();fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
   try:
    opened=os.fstat(fd);assert (before.st_dev,before.st_ino)==(opened.st_dev,opened.st_ino)
    os.fsync(fd);after=path.lstat();assert (after.st_dev,after.st_ino)==(opened.st_dev,opened.st_ino)
   finally:os.close(fd)
 print('{"state":"'+('claimed' if mode=='commit' else 'empty')+'"}')
"""


def _fresh_operation(control, operation):
    group_storage._validate_operation(control, operation, control.identity["source_root"])
    require(operation["receipt"]["phase"] == "development", "Fresh ledger admission requires a development operation")
    helper = control._assert_live_operation_helper(operation)
    require(control._inspect_operation_helper(operation, expected_id=helper) == helper,
            "Fresh ledger helper identity changed")
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    require(_project_container_ids(control.project) == {helper}
            and _volume_consumer_ids(control.volume) == {helper}, "Fresh ledger admission has another consumer")
    return helper


def _fresh_candidate(control, operation, daemon_id_sha256, generation, previous):
    from docker_volume_fresh_runtime import pinned_group_archive
    from docker_host_ledger import _daemon_info
    require(_daemon_info(docker_text)["id_sha256"] == daemon_id_sha256, "Fresh ledger daemon changed")
    archive = pinned_group_archive(control, generation)
    token = generation["generation"]
    require(archive.get("preserved_group_ledger_volume") == control.volume
            and archive.get("preserved_group_ledger_subpath") == group_storage.role_subpath(control, "ledger"),
            "Fresh admission requires this private ledger role")
    return {"schema": FRESH_ADMISSION, "compose_project": control.project, "control_volume": control.volume,
            "source_root": control.identity["source_root"], "daemon_id_sha256": daemon_id_sha256,
            "generation": token, "generation_record": generation,
            "archive_terminal_sha256": generation["archive_terminal_sha256"],
            "fresh_device_inode": archive["fresh_group_ledger_device_inode"],
            "role_device_inode": archive["fresh_group_ledger_role_device_inode"],
            "archived_device_inode": archive["archived_group_ledger_device_inode"],
            "archived_owner": archive["archived_group_ledger_owner"],
            "previous_development_attempt": previous["attempt"], "operation_attempt": operation["receipt"]["attempt"]}


def _probe_fresh_candidate(control, operation, candidate, *, commit=False):
    from docker_dev_host import docker_argv
    helper = _fresh_operation(control, operation)
    require(len(canonical(candidate)) <= 12000, "Fresh admission candidate exceeds bound")
    result = bounded_capture(docker_argv("exec", "--user", "65532:65532", "-i", helper,
        "python3", "-B", "-c", _FRESH_ADMISSION_SCRIPT),
        data=canonical({"candidate": candidate, "mode": "commit" if commit else "inspect"}), timeout=90, maximum=16384)
    detail = result.stderr if result.stderr.strip() else result.stdout
    require(result.returncode == 0 and not result.stderr.strip(),
            f"Fresh ledger admission refused (exit {result.returncode}): "
            + detail.decode("utf-8", "replace")[-2048:])
    value = json.loads(result.stdout)
    require(value in ({"state": "claimed"},) if commit else value in ({"state": "empty"}, {"state": "initialized"}),
            "Fresh ledger admission returned another state")
    require(_fresh_operation(control, operation) == helper, "Fresh ledger operation lease or consumers changed")
    return value["state"]


def _require_archive_predecessor(control, terminal, candidate, *, read=None):
    """Authenticate an archived failed start separately from its last success."""
    archived_id = terminal.get("inputs", {}).get("attempt")
    if archived_id == candidate["previous_development_attempt"]:
        return
    require(isinstance(archived_id, str) and re.fullmatch(r"[0-9a-f]{32}", archived_id),
            "Fresh archive predecessor is not pinned")
    read = control.read if read is None else read
    previous_id = candidate["previous_development_attempt"]
    previous = read("development/attempts/" + previous_id + "/terminal.json")
    failed = read("development/attempts/" + archived_id + "/terminal.json")
    for record, identifier, state in ((previous, previous_id, "succeeded"), (failed, archived_id, "failed-confirmed")):
        require(isinstance(record, dict) and record.get("schema") == "fullmag.docker-build-operation.v1"
                and record.get("phase") == "development" and record.get("state") == state
                and record.get("attempt") == identifier and record.get("compose_project") == control.project
                and record.get("control_volume") == control.volume
                and record.get("inputs", {}).get("source_root") == candidate["source_root"],
                "Fresh archive predecessor development authority differs")
    state_root = previous.get("state_root")
    identifiers = [failed.get("backend_container"), failed.get("frontend_container")]
    from docker_volume_development_interrupted import STARTING_SERVICES_SCHEMA
    reconciliation = failed.get("reconciliation", {})
    if reconciliation.get("schema") == STARTING_SERVICES_SCHEMA:
        original = read("development/attempts/" + archived_id + "/unknown-receipt.json")
        require(isinstance(state_root, str) and PurePosixPath(state_root).is_absolute()
                and PurePosixPath(state_root).parent.name == "docker-volume-dev"
                and isinstance(original, dict) and original.get("state") == "starting-services"
                and original.get("attempt") == archived_id
                and original.get("state_root") == str(PurePosixPath(state_root).with_name(archived_id))
                and [original.get("backend_container"), original.get("frontend_container")] == identifiers
                and sha(canonical(original) + b"\n") == reconciliation.get("original_receipt_sha256"),
                "Fresh archive interrupted development receipt differs")
        state_root = original["state_root"]
    require(isinstance(state_root, str) and state_root
            and failed.get("state_root") == terminal.get("previous_state_root") == state_root
            and all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) for value in identifiers)
            and len(set(identifiers)) == 2 and terminal.get("removed_containers") == identifiers
            and isinstance(failed.get("config_sha256"), str) and _HEX.fullmatch(failed["config_sha256"])
            and terminal.get("inputs", {}).get("config_sha256") == failed["config_sha256"],
            "Fresh archive predecessor state, containers or configuration differ")
    proofs = [record.get(INITIALIZED_FIELD) for record in (previous, failed)]
    require(all(isinstance(proof, dict) and proof.get("schema") == INITIALIZED_ADMISSION
                and isinstance(proof.get("candidate"), dict) for proof in proofs),
            "Fresh archive predecessor lacks initialized history")
    old, retained = [proof["candidate"] for proof in proofs]
    independent = {"operation_attempt", "previous_development_attempt"}
    require(isinstance(old.get("generation"), str) and re.fullmatch(r"[0-9a-f]{32}", old["generation"])
            and old["generation"] != candidate["generation"]
            and set(old) == set(retained)
            and all(retained[key] == value for key, value in old.items() if key not in independent)
            and all(old.get(key) == candidate[key] for key in
                    ("compose_project", "control_volume", "source_root", "daemon_id_sha256"))
            and old.get("operation_attempt") == previous_id
            and retained.get("operation_attempt") == archived_id
            and retained.get("previous_development_attempt") == previous_id,
            "Fresh archive predecessor initialized lineage differs")


def _require_unstarted_generation(control, candidate):
    token = candidate["generation"]
    terminal = control.read("recreate-services/attempts/" + token + "/terminal.json")
    require(isinstance(terminal, dict) and terminal.get("state") == "succeeded"
            and terminal.get("phase") == "recreate-services" and terminal.get("attempt") == token
            and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
            and isinstance(terminal.get("runtime_control_archive"), dict)
            and sha(canonical(terminal["runtime_control_archive"])) == candidate["archive_terminal_sha256"],
            "Fresh ledger archive does not precede this development history")
    _require_archive_predecessor(control, terminal, candidate)
    previous = control.read("development/verified.json", optional=True)
    if previous is None:
        previous = control.read("development/current.json", optional=True)
    require(isinstance(previous, dict) and previous.get("attempt") == candidate["previous_development_attempt"],
            "Fresh generation already has a later development admission")


def prepare_fresh_ledger_admission(control, operation, daemon_id_sha256, generation, previous):
    """Early preflight records intent only; it never consumes the first start."""
    _fresh_operation(control, operation)
    candidate = _fresh_candidate(control, operation, daemon_id_sha256, generation, previous)
    if prepare_initialized_ledger_readmission(control, operation, candidate, previous):
        return False
    state = _probe_fresh_candidate(control, operation, candidate)
    if state == "initialized":
        return False
    _require_unstarted_generation(control, candidate)
    existing = operation["receipt"].get(FRESH_FIELD)
    require(existing is None or existing == candidate, "Prospective fresh admission changed")
    operation["receipt"][FRESH_FIELD] = candidate
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    return True


def commit_fresh_ledger_admission(control, operation):
    """Burn the one-shot claim after preflight and before the first daemon create."""
    candidate = operation["receipt"].get(FRESH_FIELD)
    require(isinstance(candidate, dict), "No prospective first-admission pin")
    _fresh_operation(control, operation)
    generation = control.read("group-ledger-generation.json")
    require(generation == candidate["generation_record"], "Fresh admission generation changed")
    expected = _fresh_candidate(control, operation, candidate["daemon_id_sha256"], generation,
                                {"attempt": candidate["previous_development_attempt"]})
    require(candidate == expected, "Fresh admission archive, inode, or owner changed")
    _require_unstarted_generation(control, candidate)
    _probe_fresh_candidate(control, operation, candidate, commit=True)


INITIALIZED_ADMISSION = "fullmag.group-ledger-initialized-readmission.v1"
INITIALIZED_FIELD = "initialized_group_ledger_readmission"

_INITIALIZED_LEDGER_PROBE_SCRIPT = r"""
import hashlib,json,os,stat,sys
from pathlib import Path
payload=json.loads(sys.stdin.buffer.read(16385))
value=payload['candidate'];maximum=payload['maximum_bytes']
assert type(maximum) is int and 0<maximum<=8388608
root=Path('/control')
root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
opened=[]
def identity(s):
 return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def metadata(s):
 return {'device_inode':str(s.st_dev)+':'+str(s.st_ino),'owner':str(s.st_uid)+':'+str(s.st_gid),
         'mode':stat.S_IMODE(s.st_mode)}
def directory(path,expected,owner,mode=0o750):
 for part in (path,*path.parents):
  assert not part.is_symlink(),'Directory alias refused'
  if part==root:break
 else:raise AssertionError('Directory escaped control root')
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 opened.append((path,fd))
 s=os.fstat(fd)
 assert stat.S_ISDIR(s.st_mode) and s.st_dev==os.fstat(root_fd).st_dev,'Directory filesystem differs'
 assert s.st_ino==int(expected.split(':')[1]),'Directory inode differs'
 assert metadata(s)['owner']==owner and stat.S_IMODE(s.st_mode)==mode,'Directory owner/mode differs'
 assert (path.lstat().st_dev,path.lstat().st_ino)==(s.st_dev,s.st_ino),'Directory changed'
 return fd,metadata(s)
try:
 role,role_info=directory(root/'private/ledger',value['role_device_inode'],'65532:65532')
 leaf,leaf_info=directory(root/'private/ledger/ledger',value['fresh_device_inode'],'65532:65532')
 archived,archive_info=directory(root/'runtime-archives'/value['generation']/'group-ledger',
                                 value['archived_device_inode'],value['archived_owner'],payload['archived_mode'])
 files={}
 for name in ('HOST_RESOURCE_LEDGER.json','HOST_RESOURCE_LEDGER.init.json'):
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=leaf)
  try:
   before=os.fstat(fd)
   assert stat.S_ISREG(before.st_mode) and before.st_nlink==1,'Ledger file is not a single regular file'
   assert metadata(before)['owner']=='65532:65532','Ledger file owner differs'
   assert 0<before.st_size<=maximum,'Ledger file size refused'
   digest=hashlib.sha256();size=0
   while True:
    block=os.read(fd,65536)
    if not block:break
    size+=len(block);assert size<=maximum,'Ledger file exceeded bound'
    digest.update(block)
   assert identity(before)==identity(os.fstat(fd)) and size==before.st_size,'Ledger file changed while read'
   named=os.stat(name,dir_fd=leaf,follow_symlinks=False)
   assert identity(named)==identity(before),'Ledger file pathname changed'
   files[name]={**metadata(before),'size':size,'sha256':digest.hexdigest()}
  finally:os.close(fd)
 for path,fd in opened:
  assert identity(path.lstat())==identity(os.fstat(fd)),'Directory changed while read'
 assert (root.lstat().st_dev,root.lstat().st_ino)==(os.fstat(root_fd).st_dev,os.fstat(root_fd).st_ino)
 print(json.dumps({'directories':{'role':role_info,'leaf':leaf_info,'archive':archive_info},'files':files}))
finally:
 for path,fd in opened:os.close(fd)
 os.close(root_fd)
"""


def _initialized_history(control, operation, candidate, previous):
    """Authenticate the spent claim separately from the later successful run."""
    import docker_group_ledger as group_ledger
    history = {}

    def read(relative):
        raw = control.read_bytes(relative, optional=True)
        require(isinstance(raw, bytes) and raw, "Initialized ledger history is missing: " + relative)
        value = json.loads(raw)
        require(isinstance(value, dict), "Initialized ledger history is malformed: " + relative)
        history[relative] = sha(raw)
        return value

    generation = read("group-ledger-generation.json")
    expected = _fresh_candidate(control, operation, candidate["daemon_id_sha256"], generation, previous)
    require(candidate == expected, "Initialized ledger candidate identity changed")
    token = candidate["generation"]
    claim_path = "group-ledger-first-admission/" + token + ".json"
    claim = read(claim_path)
    independent = {"operation_attempt", "previous_development_attempt"}
    require(set(claim) == set(candidate)
            and all(claim[key] == value for key, value in candidate.items() if key not in independent)
            and all(isinstance(claim.get(key), str) and re.fullmatch(r"[0-9a-f]{32}", claim[key])
                    for key in independent), "Initialized ledger first claim differs from its archive")
    creator_id = claim["operation_attempt"]
    creator = read("development/attempts/" + creator_id + "/terminal.json")
    latest = read("development/verified.json")
    latest_id = latest.get("attempt")
    require(isinstance(latest_id, str) and re.fullmatch(r"[0-9a-f]{32}", latest_id),
            "Initialized ledger verified attempt is invalid")
    require(latest == previous == read("development/attempts/" + latest_id + "/terminal.json")
            and latest.get("state") == "succeeded", "Initialized ledger has no exact later successful authority")
    for record, attempt in ((creator, creator_id), (latest, latest_id)):
        require(record.get("schema") == "fullmag.docker-build-operation.v1"
                and record.get("phase") == "development" and record.get("attempt") == attempt
                and record.get("compose_project") == control.project
                and record.get("control_volume") == control.volume
                and record.get("private_group_storage") == "group-volume-v1"
                and record.get("ledger_profile") == "group-ledger-v1"
                and record.get("inputs", {}).get("source_root") == control.identity["source_root"],
                "Initialized ledger development identity differs")
    require(creator.get("state") in {"succeeded", "failed-confirmed"}
            and creator.get(FRESH_FIELD) == claim,
            "Initialized ledger first claim has no confirmed creator")
    archived = read("recreate-services/attempts/" + token + "/terminal.json")
    require(archived.get("state") == "succeeded" and archived.get("phase") == "recreate-services"
            and archived.get("attempt") == token and archived.get("compose_project") == control.project
            and archived.get("control_volume") == control.volume
            and sha(canonical(archived.get("runtime_control_archive"))) == candidate["archive_terminal_sha256"],
            "Initialized ledger claim predecessor or archive differs")
    _require_archive_predecessor(control, archived, claim, read=read)
    expected_profile = {"schema": "fullmag.docker-group-ledger.v1", "profile": group_ledger.PROFILE,
                        "daemon_id_sha256": candidate["daemon_id_sha256"], "compose_project": control.project,
                        "volume_name": control.volume,
                        "host_id": group_ledger.host_id(candidate["daemon_id_sha256"], control.project)}
    for attempt in {creator_id, latest_id}:
        require(read("development/attempts/" + attempt + "/group-ledger.json") == expected_profile,
                "Initialized ledger historical profile differs")
    return history


def _observe_initialized_ledger(control, operation, candidate, previous):
    from docker_build_control import MAX_DOCUMENT_BYTES
    from docker_dev_host import docker_argv
    from docker_group_ledger import GroupLedgerError, _validated_volume_mountpoint
    from docker_volume_fresh_runtime import pinned_group_archive
    helper = _fresh_operation(control, operation)
    history = _initialized_history(control, operation, candidate, previous)
    archive = pinned_group_archive(control, candidate["generation_record"])
    raw_volume = docker_text("volume", "inspect", control.volume)
    try:
        mountpoint = _validated_volume_mountpoint(control.volume, control.project, lambda *args: raw_volume)
    except GroupLedgerError as error:
        raise BuildControlError(str(error)) from error
    volume = json.loads(raw_volume)[0]
    require(isinstance(volume.get("CreatedAt"), str) and volume["CreatedAt"],
            "Initialized ledger volume has no creation identity")
    result = bounded_capture(docker_argv("exec", "--user", "65532:65532", "-i", helper,
        "python3", "-B", "-c", _INITIALIZED_LEDGER_PROBE_SCRIPT),
        data=canonical({"candidate": candidate, "maximum_bytes": MAX_DOCUMENT_BYTES,
                        "archived_mode": int(archive["archived_group_ledger_mode"], 8)}),
        timeout=90, maximum=16384)
    detail = result.stderr if result.stderr.strip() else result.stdout
    require(result.returncode == 0 and not result.stderr.strip(),
            f"Initialized ledger observation refused (exit {result.returncode}): "
            + detail.decode("utf-8", "replace")[-2048:])
    observation = json.loads(result.stdout)
    require(isinstance(observation, dict) and set(observation) == {"directories", "files"},
            "Initialized ledger observation is malformed")
    require(_fresh_operation(control, operation) == helper, "Initialized ledger lease or consumers changed")
    return {"schema": INITIALIZED_ADMISSION, "candidate": candidate, "history": history,
            "helper_id": helper, "volume": {"name": volume["Name"], "mountpoint": mountpoint,
                "created_at": volume["CreatedAt"], "labels_sha256": sha(canonical(volume["Labels"]))},
            "observation": observation}


def prepare_initialized_ledger_readmission(control, operation, candidate, previous):
    """Keep unclaimed legacy admission unchanged; never recreate a spent ledger."""
    _fresh_operation(control, operation)
    generation = control.read("group-ledger-generation.json")
    require(candidate == _fresh_candidate(control, operation, candidate["daemon_id_sha256"], generation, previous),
            "Initialized ledger candidate identity changed")
    terminal = control.read("development/attempts/" + previous["attempt"] + "/terminal.json", optional=True)
    required = INITIALIZED_FIELD in previous or (isinstance(terminal, dict) and INITIALIZED_FIELD in terminal)
    if required:
        proof = previous.get(INITIALIZED_FIELD)
        require(terminal == previous and isinstance(proof, dict) and proof.get("schema") == INITIALIZED_ADMISSION,
                "Required initialized ledger proof was lost")
        old_generation = proof.get("candidate", {}).get("generation") if isinstance(proof.get("candidate"), dict) else None
        if old_generation != candidate["generation"]:
            require(isinstance(old_generation, str) and re.fullmatch(r"[0-9a-f]{32}", old_generation),
                    "Required initialized ledger generation was lost")
            _require_unstarted_generation(control, candidate)
            required = False
    claim = control.read_bytes("group-ledger-first-admission/" + candidate["generation"] + ".json", optional=True)
    if claim is None:
        require(not required, "Required initialized ledger first claim was lost")
        return False
    require(isinstance(json.loads(claim), dict), "Initialized ledger first claim is malformed")
    require(operation["receipt"].get(FRESH_FIELD) is None, "Fresh and initialized ledger proofs cannot coexist")
    proof = _observe_initialized_ledger(control, operation, candidate, previous)
    retained = operation["receipt"].get(INITIALIZED_FIELD)
    require(retained is None or retained == proof, "Initialized ledger preparation changed")
    operation["receipt"][INITIALIZED_FIELD] = proof
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    return True


def revalidate_initialized_ledger_readmission(control, operation):
    proof = operation["receipt"].get(INITIALIZED_FIELD)
    require(isinstance(proof, dict) and proof.get("schema") == INITIALIZED_ADMISSION
            and operation["receipt"].get(FRESH_FIELD) is None,
            "No exclusive initialized ledger proof")
    previous = control.read("development/verified.json")
    require(_observe_initialized_ledger(control, operation, proof["candidate"], previous) == proof,
            "Initialized ledger proof changed before daemon create")
