"""Point-in-time absence proof for one bind of an exactly stopped foreign container.

This never waives present-source isolation. Windows and DrvFs must independently
prove absence under the same ordinary existing ancestor; permissions, reparse
points, running containers and topology drift fail closed. No source is created.
"""
from __future__ import annotations

import ntpath
from pathlib import Path, PureWindowsPath
import re
import stat

import docker_windows_bind_isolation as windows
from docker_build_control import canonical

SCHEMA = "fullmag.absent-stopped-windows-bind-proof.v1"
NATIVE_SCHEMA = "fullmag.windows-absent-bind-native.v1"
PROVIDER = windows.WINDOWS_PATH_PROVIDER + r"""
function MissingCode($path) {
    try {
        $null=[IO.File]::GetAttributes($path)
        throw 'candidate exists'
    } catch {
        $failure=$_.Exception
        while ($null -ne $failure.InnerException) { $failure=$failure.InnerException }
        $code=$failure.HResult -band 0xffff
        if (($failure -isnot [IO.FileNotFoundException] -and
             $failure -isnot [IO.DirectoryNotFoundException]) -or $code -notin @(2,3)) { throw }
        return $code
    }
}
$path=Canonical $request.path
if ($path.IndexOfAny([char[]]'*?') -ge 0) { throw 'exact non-wildcard path required' }
$missing=MissingCode $path
$cursor=[IO.Directory]::GetParent($path)
while ($null -ne $cursor) {
    try { $null=[IO.File]::GetAttributes($cursor.FullName); break }
    catch { $null=MissingCode $cursor.FullName; $cursor=$cursor.Parent }
}
if ($null -eq $cursor -or $null -eq $cursor.Parent) { throw 'non-root existing ancestor required' }
$ancestor=$cursor.FullName
NoReparse $ancestor
$ancestors=@()
while ($null -ne $cursor) {
    $attributes=[int][IO.File]::GetAttributes($cursor.FullName)
    if (($attributes -band 0x410) -ne 0x10) { throw 'ordinary directory ancestor required' }
    $ancestors+=@{path=$cursor.FullName;file_id=(FileId $cursor.FullName);attributes=$attributes -band 0x410}
    $cursor=$cursor.Parent
}
$drive=[IO.Path]::GetPathRoot($path).Substring(0,2)
$volumes=@(Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$drive+"'"))
if ($volumes.Count -ne 1 -or [int]$volumes[0].DriveType -ne 3 -or
    $volumes[0].FileSystem -notin @('NTFS','ReFS') -or
    $volumes[0].VolumeSerialNumber -notmatch '^[0-9A-Fa-f]{8}$') { throw 'fixed native volume required' }
if ((MissingCode $path) -ne $missing) { throw 'absence changed during observation' }
NoReparse $ancestor
@{schema='fullmag.windows-absent-bind-native.v1';path=$path;missing_code=$missing;
  ancestor=$ancestor;ancestors=$ancestors;volume=$drive;fixed=$true;
  serial=$volumes[0].VolumeSerialNumber.ToUpperInvariant();filesystem=$volumes[0].FileSystem} |
    ConvertTo-Json -Depth 8 -Compress
"""


def _stopped(pin):
    state = pin["state"]
    windows.require(state.get("Status") == "exited" and state.get("Running") is False
                    and state.get("Paused") is False and state.get("Restarting") is False
                    and state.get("Dead") is False and type(state.get("Pid")) is int
                    and state["Pid"] == 0, "Absent bind requires an exactly stopped foreign container")


def _native(source):
    raw = windows._capture([
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "-NoProfile", "-NonInteractive", "-Command", PROVIDER,
    ], canonical({"path": windows._windows_source_path(source)}))
    return _validate_native(windows._json(raw), source)


def _validate_native(value, source):
    path = windows._windows_source_path(source)
    windows.require("*" not in path and "?" not in path, "Absent bind cannot contain wildcard syntax")
    windows.require(isinstance(value, dict) and set(value) == {
        "schema", "path", "missing_code", "ancestor", "ancestors", "volume", "fixed", "serial", "filesystem"
    } and value["schema"] == NATIVE_SCHEMA and value["path"] == path
                    and type(value["missing_code"]) is int and value["missing_code"] in {2, 3}
                    and value["volume"] == path[:2] and value["fixed"] is True
                    and value["filesystem"] in {"NTFS", "ReFS"}
                    and isinstance(value["serial"], str) and re.fullmatch(r"[0-9A-F]{8}", value["serial"]),
                    "Native absence evidence is malformed")
    ancestor = PureWindowsPath(windows._windows_path(value["ancestor"]))
    windows.require(ancestor in PureWindowsPath(path).parents, "Existing ancestor does not contain absent bind")
    chain = [ancestor, *ancestor.parents]
    rows = value["ancestors"]
    windows.require(isinstance(rows, list) and len(rows) == len(chain), "Existing ancestor chain is incomplete")
    for row, expected in zip(rows, chain):
        windows.require(isinstance(row, dict) and set(row) == {"path", "file_id", "attributes"}
                        and row["path"] == str(expected) and row["attributes"] == 0x10
                        and isinstance(row["file_id"], str) and re.fullmatch(r"0x[0-9a-f]{32}", row["file_id"]),
                        "Native ancestor identity is malformed or contains reparse points")
    return value


def _mapping(source, native):
    target = windows._windows_source_path(source)
    path = Path(windows._capture(["wslpath", "-u", target]).decode("utf-8", "strict").strip())
    windows.require(path.is_absolute() and ".." not in path.parts,
                    "Absent Windows target translation is unsafe")
    # Only ENOENT qualifies. Permission errors, ELOOP and a broken symlink
    # are not absence: lstat sees the link, so it will be rejected as present.
    try:
        path.lstat()
    except FileNotFoundError:
        pass
    else:
        windows.require(False, "Translated absent bind exists")
    ancestor = path.parent
    while True:
        try:
            info = ancestor.lstat()
            break
        except FileNotFoundError:
            windows.require(ancestor != ancestor.parent, "No existing translated ancestor")
            ancestor = ancestor.parent
    windows._canonical_linux(ancestor)
    windows.require(stat.S_ISDIR(info.st_mode), "Translated ancestor is not an ordinary directory")
    roundtrip = windows._capture(["wslpath", "-w", str(path)]).decode("utf-8", "strict").strip()
    ancestor_back = windows._capture(["wslpath", "-w", str(ancestor)]).decode("utf-8", "strict").strip()
    windows.require(ntpath.normcase(roundtrip) == ntpath.normcase(target)
                    and ntpath.normcase(ancestor_back) == ntpath.normcase(native["ancestor"]),
                    "Native and DrvFs absent-target/ancestor roundtrips differ")
    mount = windows._findmnt(ancestor, recursive=True)
    windows.require(mount.get("fstype") in {"9p", "drvfs"} and mount.get("fsroot") == "/"
                    and ntpath.normcase(str(mount.get("source"))) == ntpath.normcase(target[:2] + "\\"),
                    "Absent bind ancestor is not on its exact native drive mapping")
    target_root = Path(mount.get("target", ""))
    windows.require(target_root.is_absolute() and ".." not in target_root.parts
                    and (ancestor == target_root or target_root in ancestor.parents),
                    "Drive mount does not contain the existing ancestor")
    windows._reject_submounts(mount, ancestor)
    return {"path": str(path), "roundtrip": roundtrip, "ancestor": str(ancestor),
            "ancestor_roundtrip": ancestor_back, "mount": mount,
            "device": info.st_dev, "inode": info.st_ino, "mode": info.st_mode}


def _observe(context, backend, foreign, source):
    pin = windows._container_pin(foreign)
    _stopped(pin)
    linux = windows._linux_identity(context["source_root"], context["reference_root"])
    engine = windows._engine()
    windows.require(engine["ID"] == linux["engine_id"], "Engine differs from admitted WSL root")
    native = _native(source)
    mapping = _mapping(source, native)
    windows.require(mapping["device"] != linux["root_device"], "Absent bind aliases selected ext4 filesystem")
    return {"engine": engine, "backend": windows._container_pin(backend), "foreign": pin,
            "linux": linux, "native": native, "mapping": mapping}


def validate_absent_stopped_windows_bind_proof(proof, *, source, container_id):
    windows.require(isinstance(proof, dict) and set(proof) == windows.PROOF_FIELDS
                    and proof["schema"] == SCHEMA and proof["decision"] == "absent-stopped"
                    and proof["container_id"] == container_id and windows.CID.fullmatch(str(container_id))
                    and proof["source_sha256"] == windows._sha(source.encode("utf-8"))
                    and proof["provider_sha256"] == windows._sha(PROVIDER.encode("utf-8"))
                    and proof["before"] == proof["after"], "Absent bind proof schema/source/observation differs")
    observed = proof["before"]
    windows.require(isinstance(observed, dict) and set(observed) == {
        "engine", "backend", "foreign", "linux", "native", "mapping"
    } and observed["foreign"]["id"] == container_id, "Absent bind proof lacks consumer identity")
    _stopped(observed["foreign"])
    windows._validate_engine(observed["engine"])
    _validate_native(observed["native"], source)
    context = proof["context"]
    windows.require(isinstance(context, dict) and set(context) == {
        "identity", "project", "control_volume", "control_namespace", "ledger_volume", "distro",
        "source_root", "reference_root"
    } and isinstance(context["identity"], dict)
                    and context["identity"].get("project_name") == context["project"]
                    and context["identity"].get("source_root") == context["source_root"]
                    and context["identity"].get("checkout_kind") in {"main-checkout", "worktree"}
                    and isinstance(context["control_namespace"], str)
                    and all(isinstance(context[key], str) and context[key] for key in (
                        "project", "control_volume", "ledger_volume", "distro", "source_root", "reference_root")),
                    "Absent bind proof lacks registered group context")
    for pin in (observed["backend"], observed["foreign"]):
        windows.require(isinstance(pin, dict) and set(pin) == {"id", "image", "config_sha256",
            "host_config_sha256", "mounts_sha256", "networks_sha256", "state"
        } and windows.CID.fullmatch(str(pin["id"])) and windows.IMAGE.fullmatch(str(pin["image"]))
                        and isinstance(pin["state"], dict)
                        and all(isinstance(pin[key], str) and windows.SHA.fullmatch(pin[key])
                                for key in ("config_sha256", "host_config_sha256", "mounts_sha256", "networks_sha256")),
                        "Absent bind proof critical container pin is incomplete")
    linux, mapping = observed["linux"], observed["mapping"]
    windows.require(isinstance(linux, dict) and linux.get("root_mount", {}).get("target") == "/"
                    and linux["root_mount"].get("fstype") == "ext4"
                    and linux["root_mount"].get("fsroot") == "/"
                    and all(type(linux.get(key)) is int and linux[key] > 0
                            for key in ("root_device", "source_inode", "reference_inode"))
                    and isinstance(linux.get("marker_sha256"), str)
                    and windows.SHA.fullmatch(linux["marker_sha256"]), "Absent bind lacks admitted ext4 identity")
    windows.require(isinstance(mapping, dict) and set(mapping) == {
        "path", "roundtrip", "ancestor", "ancestor_roundtrip", "mount", "device", "inode", "mode"
    } and all(type(mapping[key]) is int for key in ("device", "inode", "mode"))
                    and isinstance(mapping["mount"], dict)
                    and mapping["mount"].get("fstype") in {"9p", "drvfs"}
                    and mapping["mount"].get("fsroot") == "/"
                    and ntpath.normcase(str(mapping["mount"].get("source"))) ==
                        ntpath.normcase(windows._windows_source_path(source)[:2] + "\\")
                    and ntpath.normcase(mapping["roundtrip"]) == ntpath.normcase(windows._windows_source_path(source))
                    and ntpath.normcase(mapping["ancestor_roundtrip"]) == ntpath.normcase(observed["native"]["ancestor"])
                    and Path(mapping["ancestor"]) in Path(mapping["path"]).parents,
                    "Absent bind proof DrvFs mapping is incomplete")
    mount_root, ancestor = Path(mapping["mount"].get("target", "")), Path(mapping["ancestor"])
    windows.require(mount_root.is_absolute() and ".." not in mount_root.parts
                    and ancestor.is_absolute() and ".." not in ancestor.parts
                    and (ancestor == mount_root or mount_root in ancestor.parents),
                    "Absent bind proof mount does not contain its existing ancestor")
    windows.require(observed["linux"]["reference_root"] == context["reference_root"]
                    and observed["linux"]["source_root"] == context["source_root"]
                    and observed["engine"]["ID"] == observed["linux"]["engine_id"]
                    and observed["mapping"]["device"] != observed["linux"]["root_device"]
                    and observed["mapping"]["inode"] > 0
                    and stat.S_ISDIR(observed["mapping"]["mode"])
                    and observed["backend"]["id"] != container_id, "Absent bind proof context differs")
    return proof


def prove_absent_stopped_windows_bind(control, backend, container, source, reference_root):
    windows._windows_source_path(source)
    first_backend, first_foreign = windows._inspect(backend["Id"]), windows._inspect(container["Id"])
    windows.require(windows._container_pin(first_backend) == windows._container_pin(backend)
                    and windows._container_pin(first_foreign) == windows._container_pin(container),
                    "Consumer changed before absent-bind proof")
    context = windows._context(control, first_backend, first_foreign, source, reference_root)
    before = _observe(context, first_backend, first_foreign, source)
    next_backend, next_foreign = windows._inspect(backend["Id"]), windows._inspect(container["Id"])
    windows.require(windows._context(control, next_backend, next_foreign, source, reference_root) == context,
                    "Absent-bind registered context changed")
    after = _observe(context, next_backend, next_foreign, source)
    windows.require(before == after, "Absent bind/container/topology changed during observation")
    final_backend, final_foreign = windows._inspect(backend["Id"]), windows._inspect(container["Id"])
    windows.require(windows._container_pin(final_backend) == after["backend"]
                    and windows._container_pin(final_foreign) == after["foreign"]
                    and windows._engine() == after["engine"], "Consumer/engine changed after absence observation")
    proof = {"schema": SCHEMA, "decision": "absent-stopped", "container_id": container["Id"],
             "source_sha256": windows._sha(source.encode("utf-8")), "context": context,
             "provider_sha256": windows._sha(PROVIDER.encode("utf-8")), "before": before, "after": after}
    validate_absent_stopped_windows_bind_proof(proof, source=source, container_id=container["Id"])
    from docker_bind_overlap_probe import _archive_foreign_proof
    _archive_foreign_proof(control, proof)
    return proof
