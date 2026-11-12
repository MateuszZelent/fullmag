"""Read-only proof that a stopped foreign bind is on fixed Windows storage.

The result binds only the supplied stopped-container snapshot. Callers must
re-read container state and obtain a fresh proof immediately before cutover;
this proof does not admit an active mount or authorize storage changes.
"""
from __future__ import annotations

import json
import re
import subprocess


SCHEMA = "fullmag.stopped-windows-bind-disjoint.v1"
POWERSHELL_PATH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
_MAX_OUTPUT_BYTES = 64 * 1024
_PROOF_KEYS = frozenset(
    {
        "schema",
        "path",
        "nearest_existing_path",
        "filesystem",
        "fixed",
        "no_reparse",
        "leaf_exists",
        "nearest_is_directory",
    }
)
_LOCAL_DRIVE_PATH = re.compile(r"[A-Za-z]:/(?:.*)\Z", re.ASCII)


STOPPED_WINDOWS_BIND_PROBE = r"""
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$requested=$request.path
$path=[IO.Path]::GetFullPath($requested)
$slashPath=$path.Replace('\','/')
if ($slashPath -ine $requested -or $path -notmatch '^[A-Za-z]:[\\/]') { throw 'canonical local drive path required' }
if ($requested -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'traversal refused' }
$disk=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($path))
if ([int]$disk.DriveType -ne 3 -or $disk.DriveFormat -notin @('NTFS','ReFS')) { throw 'fixed NTFS/ReFS required' }
$nearest=$null
$leafExists=$false
$nearestIsDirectory=$false
$cursor=$path
while ($null -ne $cursor) {
    $item=$null
    try {
        $item=Get-Item -Force -LiteralPath $cursor -ErrorAction Stop
    } catch {
        $category=$_.CategoryInfo.Category.ToString()
        $errorId=$_.FullyQualifiedErrorId
        if ($category -ne 'ObjectNotFound' -or $errorId -notmatch 'ItemNotFound|PathNotFound') { throw }
    }
    if ($null -ne $item) {
        if (([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse ancestor refused' }
        if ($null -eq $nearest) {
            $nearest=$item.FullName
            $leafExists=$cursor.Equals($path,[StringComparison]::OrdinalIgnoreCase)
            $nearestIsDirectory=[bool]$item.PSIsContainer
        }
    }
    $parent=[IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor=$parent.FullName
}
if ($null -eq $nearest) { throw 'no existing drive ancestor' }
if (-not $leafExists -and -not $nearestIsDirectory) { throw 'nearest existing ancestor is not a directory' }
[ordered]@{
    schema='fullmag.stopped-windows-bind-disjoint.v1'
    path=$requested
    nearest_existing_path=$nearest
    filesystem=$disk.DriveFormat
    fixed=$true
    no_reparse=$true
    leaf_exists=$leafExists
    nearest_is_directory=$nearestIsDirectory
} | ConvertTo-Json -Compress
"""


def _fail(message: str) -> None:
    raise ValueError(message)


def _host_path_adapter():
    if __package__:
        from .docker_volume_activate import _canonical_host_path
    else:
        from docker_volume_activate import _canonical_host_path
    return _canonical_host_path


def _canonical_windows_path(value: object) -> str:
    if type(value) is not str or not value or value != value.strip():
        _fail("stopped bind source must be a nonempty canonical path string")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        _fail("stopped bind source contains control characters")

    raw_posix = value.replace("\\", "/")
    if raw_posix.startswith("//"):
        _fail("UNC stopped bind sources are not accepted")
    if any(component in {".", ".."} for component in raw_posix.split("/")):
        _fail("stopped bind source must not contain dot traversal components")

    try:
        canonical = _host_path_adapter()(value)
    except Exception as error:
        raise ValueError("cannot canonicalize stopped bind source") from error
    if type(canonical) is not str or _LOCAL_DRIVE_PATH.fullmatch(canonical) is None:
        _fail("stopped bind source must resolve to one local Windows drive")
    if any(character in "<>:\"|?*" for character in canonical[3:]):
        _fail("stopped bind source contains an invalid Windows path component")

    components = canonical[3:].split("/") if len(canonical) > 3 else []
    if any(component in {"", ".", ".."} for component in components):
        _fail("stopped bind source is not a canonical drive path")
    if any(component.endswith((".", " ")) for component in components):
        _fail("stopped bind source has a Windows component ending in dot or space")
    return canonical


def _require_stopped_state(container_state: object) -> None:
    if type(container_state) is not dict:
        _fail("container_state must be an object")
    if container_state.get("Status") != "exited":
        _fail("container must be exactly exited")
    for field in ("Running", "Paused", "Restarting", "OOMKilled", "Dead"):
        if container_state.get(field) is not False:
            _fail(f"stopped container requires {field}=false")
    pid = container_state.get("Pid")
    if type(pid) is not int or pid != 0:
        _fail("stopped container requires integer Pid=0")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _fail("PowerShell proof contains a duplicate JSON key")
        value[key] = item
    return value


def _reject_constant(value: str):
    _fail(f"PowerShell proof contains a nonfinite JSON value: {value}")


def _canonical_nearest(value: object) -> str:
    if type(value) is not str or not value or value != value.strip():
        _fail("PowerShell nearest_existing_path is invalid")
    raw_posix = value.replace("\\", "/")
    if raw_posix.startswith("//") or any(
        component in {".", ".."} for component in raw_posix.split("/")
    ):
        _fail("PowerShell nearest_existing_path is unsafe")
    try:
        canonical = _host_path_adapter()(value)
    except Exception as error:
        raise ValueError("cannot canonicalize PowerShell nearest path") from error
    if type(canonical) is not str or _LOCAL_DRIVE_PATH.fullmatch(canonical) is None:
        _fail("PowerShell nearest path must be on one local drive")
    return canonical


def _is_ancestor_or_same(ancestor: str, path: str) -> bool:
    ancestor_folded = ancestor.replace("\\", "/").casefold()
    path_folded = path.replace("\\", "/").casefold()
    if ancestor_folded == path_folded:
        return True
    prefix = ancestor_folded if ancestor_folded.endswith("/") else ancestor_folded + "/"
    return path_folded.startswith(prefix)


def _validate_proof(raw: bytes, requested_path: str) -> dict:
    try:
        proof = json.loads(
            raw.decode("utf-8-sig", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ValueError("PowerShell stopped-bind proof is not safe JSON") from error
    if type(proof) is not dict or any(type(key) is not str for key in proof):
        _fail("PowerShell stopped-bind proof must be a JSON object")
    if frozenset(proof) != _PROOF_KEYS:
        _fail("PowerShell stopped-bind proof has missing or unknown keys")
    if proof["schema"] != "fullmag.stopped-windows-bind-disjoint.v1":
        _fail("PowerShell stopped-bind proof schema differs")
    if proof["path"] != requested_path:
        _fail("PowerShell proof path differs from the requested canonical path")

    nearest = _canonical_nearest(proof["nearest_existing_path"])
    if not _is_ancestor_or_same(nearest, requested_path):
        _fail("PowerShell nearest existing path is not a lexical ancestor")

    if type(proof["filesystem"]) is not str or proof["filesystem"] not in {"NTFS", "ReFS"}:
        _fail("stopped bind is not on NTFS or ReFS")
    for field in ("fixed", "no_reparse", "leaf_exists", "nearest_is_directory"):
        if type(proof[field]) is not bool:
            _fail(f"PowerShell proof field {field} must be boolean")
    if proof["fixed"] is not True or proof["no_reparse"] is not True:
        _fail("fixed local storage without reparse ancestors was not proven")

    if proof["leaf_exists"]:
        if nearest.casefold() != requested_path.casefold():
            _fail("an existing leaf must be the nearest existing item")
    else:
        if nearest.casefold() == requested_path.casefold():
            _fail("a missing leaf cannot itself be the nearest existing item")
        if not proof["nearest_is_directory"]:
            _fail("missing leaf requires an existing directory ancestor")
    return proof


def qualify_stopped_windows_bind(source, container_state) -> dict:
    """Prove a stopped container's Windows bind lies on fixed NTFS/ReFS.

    The proof is scoped to this exited snapshot. Re-read container state and
    obtain a fresh proof immediately before any later cutover; this helper
    performs no Docker operation and does not establish active-bind admission.
    """

    _require_stopped_state(container_state)
    canonical = _canonical_windows_path(source)
    payload = json.dumps(
        {"path": canonical}, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    try:
        result = subprocess.run(
            [
                POWERSHELL_PATH,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                STOPPED_WINDOWS_BIND_PROBE,
            ],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("fixed PowerShell stopped-bind proof failed") from error
    if (
        type(result.returncode) is not int
        or result.returncode != 0
        or type(result.stdout) is not bytes
        or type(result.stderr) is not bytes
        or len(result.stdout) > _MAX_OUTPUT_BYTES
        or len(result.stderr) > _MAX_OUTPUT_BYTES
    ):
        _fail("PowerShell stopped-bind probe returned no bounded successful proof")
    return _validate_proof(result.stdout, canonical)
