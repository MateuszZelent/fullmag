"""Read-only control admission and writer exclusion for history publication."""
from contextlib import contextmanager, ExitStack
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


def historical_mounts(control, receipt, terminal, compose, selected):
    """Authenticate old paths against the activation's immutable config pin."""
    token = receipt.get("development_attempt")
    expected_config = receipt.get("config_sha256")
    activation_inputs, development_inputs = receipt.get("inputs"), terminal.get("inputs")
    if (not isinstance(token, str) or not ATTEMPT.fullmatch(token)
            or not isinstance(expected_config, str) or not SHA.fullmatch(expected_config)
            or not isinstance(activation_inputs, dict) or not isinstance(development_inputs, dict)):
        raise HistoryError("Historical activation/development identity is incomplete")
    expected = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
                "state": "succeeded", "attempt": token, "compose_project": control.project,
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
def writer_barriers(store_root, ledger_root):
    """Hold the same shared locks as offline recovery through the rename.

    No lock is created or replaced. Independent native/API writers take these
    exact inodes exclusively; a JSON owner record alone is insufficient.

    HOST_INVENTORY_OWNER.lock is deliberately not acquired: it is a lifetime
    owner fence, not a write transaction. Inventory sampling, owner acquisition,
    reservation and release all acquire the ledger writer before mutation
    (host_resource_ledger.rs). Holding that writer shared excludes those writes
    while preserving the healthy inventory owner's lifetime lock. History only
    renames control evidence; it neither retires nor replaces the ledger owner.
    """
    import fcntl
    store_root, ledger_root = _directory(store_root), _directory(ledger_root)
    # Match HostResourceLedger::with_terminal_run_evidence_fence lock order.
    paths = [ledger_root / "WRITER.lock", store_root / "WRITER.lock"]
    with ExitStack() as stack:
        held = []
        for path in paths:
            before = path.lstat()
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
