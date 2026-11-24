"""Read the pinned pre-recreation scientific inventory through readonly archive views."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path, PurePosixPath
import shlex

from docker_build_control import BuildControlError, bounded_capture, canonical
from docker_volume_fresh_runtime import pinned_group_archive

PROOF_PATH = "verification/succeeded-guest-abandon/a44491e4-34ce-4e2a-801f-55735d01371f/proof.json"
PROOF_SHA256 = "6626cec4fec79a67892c5c6d05cdf12ffdd8324861634d8731c04321ba36db96"
ARCHIVE_GENERATION = "e8f5877644ad4cd5b0d7e8648602d2c9"
HISTORICAL_IMAGE = "sha256:31b8a6ea4989a16b2dce1acd114ee62d28156a831fa82ff9ed837f97e6500d96"
EXPECTED = {"inventory_sha256": "232de2d8480fc9dc568d146d3d61708f72aeb468856292d551b052b0f25802a3",
            "files": 23339, "bytes": 1857645468,
            "config_sha256": "1960191d0a100190f75d6b3b4c71a64e7f8fe95a6a1e324dc43e37cfdc6d4da7",
            "fms_sha256": "6af101c6af9b1787692fae334ff601db2af702e9a4e9cdd2e73068813251264d"}
ENVIRONMENT = {"FULLMAG_HOST_LEDGER_ROOT", "FULLMAG_CONTAINER_STATE_ROOT", "FULLMAG_PROJECT_STORAGE_ROOT",
               "FULLMAG_RUNS_ROOT", "FULLMAG_RUNTIME_CONTROL_ROOT", "FULLMAG_STATE_ROOT",
               "FULLMAG_RUNTIME_SERVICES_ROOT", "FULLMAG_REPO_ROOT", "FULLMAG_RUNTIME_ROOT",
               "FULLMAG_RUNTIME_PROVENANCE"}


def require(value, message):
    if not value:
        raise BuildControlError(message)


def _relative(path):
    for prefix in ("/opt/fullmag/control/", "/control/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    relative = PurePosixPath(path)
    require(not relative.is_absolute() and ".." not in relative.parts and str(relative) == path,
            "Protected evidence path is not canonical")
    return path


def _pin(control, path, expected):
    path = _relative(path)
    control.path(path)
    raw = control.read_bytes(path)
    require(hashlib.sha256(raw).hexdigest() == expected, "Archived evidence CAS differs: " + path)
    return json.loads(raw)


def _archive_context(control):
    proof = _pin(control, PROOF_PATH, PROOF_SHA256)
    root = str(PurePosixPath(PROOF_PATH).parent)
    request = _pin(control, root + "/request.json", proof["documents"][root + "/request.json"])
    seed = _pin(control, request["recreate_request_path"], request["recreate_request_sha256"])
    guest = _pin(control, seed["guest_request_path"], seed["guest_request_sha256"])
    observation = _pin(control, root + "/observation.json", proof["documents"][root + "/observation.json"])
    inspect = _pin(control, root + "/backend/stopped-inspect.json",
                   proof["documents"][root + "/backend/stopped-inspect.json"])
    require(inspect.get("exit_code") == 0 and not inspect.get("stderr"), "Archived inspect did not succeed")
    old = json.loads(inspect["stdout"])
    require(isinstance(old, list) and len(old) == 1, "Archived backend identity is ambiguous")
    old = old[0]
    require(old["Id"] == request["backend"]["container_id"] and old["Image"] == HISTORICAL_IMAGE,
            "Archived backend image or incarnation differs")
    relative = "succeeded-namespace-recreate/attempts/" + request["original_attempt"] + "/compose.json"
    compose = _pin(control, relative, proof["compose_sha256"])
    require(request["source_root"] == control.identity["source_root"]
            and compose["name"] == control.project and seed["compose_project"] == control.project,
            "Protected history belongs to another source or group")
    require(observation["guest"]["protected"] == EXPECTED
            and hashlib.sha256(canonical(EXPECTED)).hexdigest() == proof["protected_sha256"],
            "Original protected inventory differs")
    generation_raw = control.read_bytes("group-ledger-generation.json")
    generation = json.loads(generation_raw)
    archive = pinned_group_archive(control, generation)
    require(generation["generation"] == ARCHIVE_GENERATION
            and archive["preserved_group_ledger_volume"] == control.volume
            and generation["preserved_subpath"] == "private/ledger", "Protected archive generation differs")
    mounts = compose["services"]["backend"]["volumes"]
    state = [m for m in mounts if m.get("target") == "/state"]
    source = [m for m in mounts if m.get("target") == "/opt/fullmag/source"]
    require(len(state) == len(source) == 1 and state[0].get("type") == source[0].get("type") == "bind",
            "Protected bind inventory differs")
    state_path, source_path = Path(state[0]["source"]), Path(source[0]["source"])
    require(state_path.is_absolute() and state_path.is_dir() and not state_path.is_symlink()
            and str(state_path.resolve(strict=True)) == str(state_path)
            and str(source_path) == control.identity["source_root"], "Protected bind root differs")
    environment = [v for v in old["Config"]["Env"] if v.split("=", 1)[0] in ENVIRONMENT]
    require(len({v.split("=", 1)[0] for v in environment}) == len(environment)
            and "FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger" in environment,
            "Protected canonical path environment differs")
    pin = {"schema": "fullmag.archived-scientific-inventory.v1", "proof_path": PROOF_PATH,
           "proof_sha256": PROOF_SHA256, "generation_sha256": hashlib.sha256(generation_raw).hexdigest(),
           "generation": generation, "state_root": str(state_path), "source_root": str(source_path),
           "historical_image": HISTORICAL_IMAGE, "expected_inventory": deepcopy(EXPECTED)}
    return pin, guest, environment


def describe_archived_protected(control):
    """Build only the immutable request binding; do not inspect or modify data."""
    return _archive_context(control)[0]


def read_archived_protected(control, request):
    """Rehash the original virtual paths, mapping every archived mount readonly."""
    pin, guest, environment = _archive_context(control)
    require(request.get("protected_store") == pin, "Protected request binding changed")
    archive = "runtime-archives/" + ARCHIVE_GENERATION
    specs = ["type=bind,src=" + pin["state_root"] + ",dst=/state,readonly",
             "type=bind,src=" + pin["source_root"] + ",dst=/opt/fullmag/source,readonly"]
    for target, subpath in (("/opt/fullmag/runtime-control", archive),
                            ("/state/runs/docker-all/session-store/runtime-services", archive + "/runtime-services"),
                            ("/host-ledger", "private/ledger"),
                            ("/host-ledger/ledger", archive + "/group-ledger")):
        specs.append("type=volume,src=" + control.volume + ",dst=" + target
                     + ",readonly,volume-nocopy,volume-subpath=" + subpath)
    code = ("import sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
            "import docker_volume_succeeded_guest_abandon as c;"
            "import docker_volume_succeeded_namespace_guest as g;"
            "p=c.strict_json(sys.stdin.buffer.read());s,b=g.image_modules(p['guest']);"
            "print(c.canonical(c.protected_inventory(p,s.canonical_paths())).decode())")
    args = control.helper_args("exec python3 -B -c " + shlex.quote(code))
    args = [v.replace("dst=/control,volume-nocopy", "dst=/control,readonly,volume-nocopy") for v in args]
    args[args.index(control.image)] = HISTORICAL_IMAGE
    extra = [part for spec in specs for part in ("--mount", spec)]
    extra.extend(part for value in environment for part in ("--env", value))
    args[args.index("--entrypoint"):args.index("--entrypoint")] = extra
    result = bounded_capture(args, data=canonical({"guest": guest}), timeout=300, maximum=65536)
    require(result.returncode == 0 and not result.stderr.strip(),
            "Archived protected inventory refused: " + result.stderr.decode("utf-8", "replace")[-2048:])
    observed = json.loads(result.stdout)
    require(observed == pin["expected_inventory"], "Archived scientific files changed")
    return observed
