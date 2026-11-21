"""Read-only control admission and writer exclusion for history publication."""
from contextlib import contextmanager, ExitStack
import math
import os
from pathlib import Path, PurePosixPath
import stat

from docker_build_control import BuildControl, BuildControlError
from docker_activation_history_policy import ATTEMPT, SHA, HistoryError, canonical, digest, document
from docker_activation_history_storage import _directory, _optional_digest


class ReadOnlyBuildControl(BuildControl):
    """Includes namespace resolution performed by the base constructor."""

    def __init__(self, identity, image):
        self.read_pins = {}
        super().__init__(identity, image)

    def read_bytes(self, relative, **kwargs):
        raw = super().read_bytes(relative, **kwargs)
        self.read_pins[relative] = digest(raw) if raw is not None else None
        return raw

    def helper_args(self, script, *, name=None, initialize=False):
        if initialize:
            raise BuildControlError("History admission cannot initialize control storage")
        args = super().helper_args(script, name=name)
        for index, value in enumerate(args[:-1]):
            if value == "--mount" and ",dst=/control," in args[index + 1]:
                args[index + 1] += ",readonly"
        return args


def validate_control_pins(root, pins):
    if not isinstance(pins, dict) or not pins or len(pins) > 128:
        raise HistoryError("Historical admission record pins are missing or unbounded")
    for relative, expected in pins.items():
        path = PurePosixPath(relative)
        if (path.is_absolute() or ".." in path.parts or str(path) != relative
                or not relative.endswith(".json")
                or (expected is not None and (not isinstance(expected, str) or not SHA.fullmatch(expected)))):
            raise HistoryError("Historical admission record pin is malformed")
        parts = path.parts
        # The one selected activation may already be archived on exact-plan
        # reentry. Its archive integrity is checked separately by the reader.
        if (len(parts) == 4 and parts[:2] == ("activation", "attempts")
                and ATTEMPT.fullmatch(parts[2])
                and not (root / "activation/attempts" / parts[2]).exists()):
            relative = "activation/history-v1/" + parts[2] + "/" + parts[3]
        if _optional_digest(root, relative) != expected:
            raise HistoryError("Historical admission record changed: " + str(path))


def _historical_runtime_witness(control, receipt, original, selected, pin):
    """Attest a failed start's declared mounts using one pinned prior recovery.

    This proves historical mount admission, not the binary used by a run.
    Run/output/source identity remains independently validated by the caller.
    """
    if not isinstance(pin, tuple) or len(pin) != 2:
        raise HistoryError("Historical recovery requires an explicit witness path and digest")
    relative, expected_sha = pin
    if not isinstance(relative, str) or not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha):
        raise HistoryError("Historical recovery witness pin is malformed")
    path = PurePosixPath(relative)
    if (str(path) != relative or len(path.parts) != 4
            or path.parts[0] not in {"resume", "iteration"} or path.parts[1] != "attempts"
            or not ATTEMPT.fullmatch(path.parts[2]) or path.parts[3] != "terminal.json"):
        raise HistoryError("Historical recovery witness path is not one terminal record")
    raw = control.read_bytes(relative, maximum=1024 * 1024, timeout=30)
    if digest(raw) != expected_sha:
        raise HistoryError("Historical recovery witness raw digest differs")
    witness = document(raw, "historical recovery terminal")
    counterpart = str(path.with_name("receipt.json"))
    saved_raw = control.read_bytes(counterpart, maximum=1024 * 1024, timeout=30)
    if raw != saved_raw:
        raise HistoryError("Historical recovery terminal and receipt differ")
    from docker_volume_activate import _validate_linked_runtime_terminal
    try:
        _validate_linked_runtime_terminal(witness, phase=path.parts[0],
            original_attempt=original["attempt"], original=original,
            source_root=str(selected), image=receipt["image_id"],
            config_sha256=receipt["config_sha256"])
    except BuildControlError as error:
        raise HistoryError("Historical recovery witness identity differs: " + str(error)) from error
    inputs = witness["inputs"]
    activation_inputs = receipt.get("inputs", {})
    if (witness.get("schema") != "fullmag.docker-build-operation.v1"
            or witness.get("attempt") != path.parts[2]
            or witness.get("control_volume") != control.volume
            or witness.get("control_namespace", "") != control.namespace
            or inputs.get("source_root") != str(selected)
            or inputs.get("image_id") != receipt["image_id"]
            or witness.get("backend_container") != receipt.get("backend_container")
            or receipt.get("backend_container") != activation_inputs.get("backend_container")
            or witness.get("idle_backend_stopped") is True):
        raise HistoryError("Historical recovery witness ownership/backend differs")
    times = [original.get("finished_at"), witness.get("started_at"),
             witness.get("finished_at"), receipt.get("started_at")]
    if (any(type(value) not in (int, float) or not 0 < value < 1e15
            or not math.isfinite(value) for value in times)
            or times != sorted(times)):
        raise HistoryError("Historical recovery witness must follow failure and precede activation")


def historical_mounts(control, receipt, terminal, compose, selected, *, runtime_witness=None):
    """Authenticate old paths against the activation's immutable config pin."""
    token = receipt.get("development_attempt")
    expected_config = receipt.get("config_sha256")
    activation_inputs, development_inputs = receipt.get("inputs"), terminal.get("inputs")
    if (not isinstance(token, str) or not ATTEMPT.fullmatch(token)
            or not isinstance(expected_config, str) or not SHA.fullmatch(expected_config)
            or not isinstance(activation_inputs, dict) or not isinstance(development_inputs, dict)):
        raise HistoryError("Historical activation/development identity is incomplete")
    development_state = terminal.get("state")
    if (development_state not in {"succeeded", "failed-confirmed"}
            or (development_state == "failed-confirmed" and runtime_witness is None)
            or (development_state == "succeeded" and runtime_witness is not None)):
        raise HistoryError("Historical failed development requires one explicit recovery witness")
    expected = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
                "state": development_state, "attempt": token, "compose_project": control.project,
                "control_volume": control.volume, "config_sha256": expected_config}
    if (any(terminal.get(key) != value for key, value in expected.items())
            or terminal.get("control_namespace", "") != control.namespace
            or receipt.get("control_namespace", "") != control.namespace
            or digest(canonical(compose)) != expected_config or compose.get("name") != control.project):
        raise HistoryError("Historical development terminal/config identity differs")
    for key in ("development_attempt", "config_sha256", "source_root", "image_id"):
        if activation_inputs.get(key) != receipt.get(key):
            raise HistoryError("Historical activation input pin differs: " + key)
    if (receipt.get("source_root") != str(selected)
            or development_inputs.get("source_root") != str(selected)
            or development_inputs.get("image_id") != receipt.get("image_id")
            or development_inputs.get("source_worktree_id") != control.identity["worktree_id"]
            or development_inputs.get("source_project_id") != control.identity["project_id"]):
        raise HistoryError("Historical source/image/worktree identity differs")
    backend = compose.get("services", {}).get("backend", {})
    if backend.get("image") != receipt.get("image_id"):
        raise HistoryError("Historical backend image differs")
    mounts = backend.get("volumes", [])
    def mount(target, kind):
        matches = [item for item in mounts if isinstance(item, dict) and item.get("target") == target]
        if len(matches) != 1 or matches[0].get("type") != kind:
            raise HistoryError("Historical mount is ambiguous: " + target)
        return matches[0]
    source, state, user = (mount(target, "bind") for target in ("/opt/fullmag/source", "/state", "/user-data"))
    if (source.get("source") != str(selected) or source.get("read_only") is not True
            or state.get("source") != terminal.get("state_root")):
        raise HistoryError("Historical source/state mount differs from terminal")
    for target, subpath in (("/opt/fullmag/control", control.namespace),
                            ("/host-ledger", control.subpath("private/ledger"))):
        binding = mount(target, "volume")
        volume = compose.get("volumes", {}).get(binding.get("source"), {})
        if (volume.get("name") != control.volume
                or binding.get("volume", {}).get("subpath", "") != subpath):
            raise HistoryError("Historical control/ledger volume binding differs")
    if development_state == "failed-confirmed":
        _historical_runtime_witness(control, receipt, terminal, selected, runtime_witness)
    return Path(state["source"]), Path(user["source"])


def ledger_evidence(raw):
    """Pin all ledger semantics except the periodic host telemetry sample ID."""
    from docker_volume_offline_reconcile import _validate_group_ledger
    value = document(raw, "group ledger")
    summary = _validate_group_ledger(value)
    runtime = value.get("runtime_state")
    if (not isinstance(runtime, dict) or runtime.get("schema_version") != "host_runtime_state.v1"
            or not isinstance(runtime.get("snapshot_sha256"), str)
            or SHA.fullmatch(runtime["snapshot_sha256"]) is None):
        raise HistoryError("Group ledger runtime sample identity is malformed")
    # The healthy inventory owner publishes a new sample every five seconds.
    # Policies, readiness, all reservations and any future fields stay pinned.
    del runtime["snapshot_sha256"]
    return {**summary, "stable_sha256": digest(canonical(value))}


def validate_backend_control_mounts(control, row):
    """Prove the helper and native backend refer to the same ledger inodes."""
    for target, subpath in (("/opt/fullmag/control", control.namespace),
                            ("/host-ledger", control.subpath("private/ledger")),
                            ("/opt/fullmag/runtime-control", control.subpath("runtime-control"))):
        observed = [mount for mount in row.get("Mounts", []) if mount.get("Destination") == target]
        declared = [mount for mount in row.get("HostConfig", {}).get("Mounts", [])
                    if mount.get("Target") == target]
        if (len(observed) != 1 or len(declared) != 1
                or observed[0].get("Type") != "volume" or observed[0].get("Name") != control.volume
                or observed[0].get("RW") is not True
                or declared[0].get("Type") != "volume" or declared[0].get("Source") != control.volume
                or declared[0].get("VolumeOptions", {}).get("Subpath", "") != subpath
                or any(mount.get("Destination", "").startswith(target + "/") for mount in row.get("Mounts", []))):
            raise HistoryError("Native control/ledger mount differs from archival fence: " + target)


@contextmanager
def writer_barriers(store_root, ledger_root, host_ledger_roots_root=None):
    """Hold the same shared locks as offline recovery through the rename.

    No lock is created or replaced. Independent native/API writers take these
    exact inodes exclusively; a JSON owner record alone is insufficient.

    Production history transactions pass the host-ledger-roots registry root
    first, matching the Rust registry -> ledger -> session-store lock order.
    The optional root preserves existing isolated unit fixtures.

    HOST_INVENTORY_OWNER.lock is deliberately not acquired: it is a lifetime
    owner fence, not a write transaction. Inventory sampling, owner acquisition,
    reservation and release all acquire the ledger writer before mutation
    (host_resource_ledger.rs). Holding that writer shared excludes those writes
    while preserving the healthy inventory owner's lifetime lock. History only
    renames control evidence; it neither retires nor replaces the ledger owner.
    """
    import fcntl
    store_root, ledger_root = _directory(store_root), _directory(ledger_root)
    paths = []
    if host_ledger_roots_root is not None:
        registry_root = _directory(host_ledger_roots_root)
        paths.append(registry_root / "WRITER.lock")
    # Match host registry -> HostResourceLedger -> SessionStore lock order.
    paths.extend([ledger_root / "WRITER.lock", store_root / "WRITER.lock"])
    with ExitStack() as stack:
        held = []
        for path in paths:
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise HistoryError("History writer lock is linked, nonregular or replaced")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            stack.callback(os.close, descriptor)
            opened = os.fstat(descriptor)
            def identity(value):
                return value.st_dev, value.st_ino, value.st_nlink, value.st_mode
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or identity(before) != identity(opened)):
                raise HistoryError("History writer lock is linked, nonregular or replaced")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise HistoryError("A native/API writer is active at " + str(path) + "; history retained") from error
            held.append((path, identity(opened)))

        def unchanged():
            if any(identity(path.lstat()) != expected for path, expected in held):
                raise HistoryError("History writer lock inode changed")

        unchanged()
        yield unchanged
        unchanged()
