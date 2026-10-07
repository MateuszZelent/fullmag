"""Bind managed FEM artifacts to terminal runtime and workspace receipts."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

MAX_LOG_BYTES = 64 * 1024 * 1024
MAX_RECEIPT_BYTES = 4 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
CONTAINER_ROOT = "/workspace/benchmark-output"
_REPARSE = 0x400


class RuntimeArtifactRootError(ValueError):
    pass


def _checked(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute():
        raise RuntimeArtifactRootError("Runtime evidence paths must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE:
            raise RuntimeArtifactRootError("Runtime evidence traverses a symlink/reparse point")
    info = path.lstat()
    if directory and not stat.S_ISDIR(info.st_mode):
        raise RuntimeArtifactRootError("Runtime artifact directory is not a directory")
    if path.resolve(strict=True) != path:
        raise RuntimeArtifactRootError("Runtime evidence path is noncanonical")
    return path


def _read(path, limit):
    path = _checked(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise RuntimeArtifactRootError("Runtime evidence is not a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeArtifactRootError("Runtime evidence identity changed")
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    final = _checked(path).lstat()
    identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if len(data) > limit or identity(before) != identity(after) or identity(after) != identity(final):
        raise RuntimeArtifactRootError("Runtime evidence changed or exceeded its size limit")
    return data


def _object(data):
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeArtifactRootError("Runtime receipt must be a JSON object")
    return value


def _summary(data):
    text = data.decode("utf-8")
    decoder = json.JSONDecoder()
    summaries = []
    covered_until = 0
    for match in re.finditer(r"(?m)^\{", text):
        if match.start() < covered_until:
            continue
        try:
            value, end = decoder.raw_decode(text, match.start())
        except ValueError as error:
            raise RuntimeArtifactRootError("Malformed top-level runtime JSON") from error
        covered_until = end
        if isinstance(value, dict) and ("workspace_dir" in value or "artifact_dir" in value):
            summaries.append((value, end))
    if len(summaries) != 1 or text[summaries[0][1]:].strip():
        raise RuntimeArtifactRootError("Missing, ambiguous or nonterminal runtime summary")
    return summaries[0][0]


def _mapped(root, raw):
    if not isinstance(raw, str) or "\\" in raw or "\x00" in raw:
        raise RuntimeArtifactRootError("Invalid container artifact path")
    path = PurePosixPath(raw)
    if not raw.startswith(CONTAINER_ROOT + "/") or str(path) != raw:
        raise RuntimeArtifactRootError("Container artifact path has a different prefix or is noncanonical")
    parts = raw[len(CONTAINER_ROOT) + 1:].split("/")
    if any(part in ("", ".", "..") or ":" in part for part in parts):
        raise RuntimeArtifactRootError("Unsafe container artifact path")
    return _checked(root.joinpath(*parts), directory=True)


def _require_case_workspace(workspace: Path, case: str, run_id: str) -> None:
    prefix = f"{case}-{run_id}-"
    if not workspace.name.startswith(prefix):
        raise RuntimeArtifactRootError("Runtime workspace does not belong to the requested case and run")
    attempt = workspace.name[len(prefix):]
    if re.fullmatch(r"(?:0|[1-9][0-9]?)", attempt) is None:
        raise RuntimeArtifactRootError("Runtime workspace has a noncanonical output attempt")


def resolve_runtime_artifact_root(output_root: Path, case: str, expected_model_sha256: str) -> tuple[Path, dict]:
    """Resolve exact recorded artifacts without guessing or modifying storage."""
    try:
        if not isinstance(case, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", case) is None:
            raise RuntimeArtifactRootError("Invalid runtime case identity")
        if not isinstance(expected_model_sha256, str) or re.fullmatch(r"[a-f0-9]{64}", expected_model_sha256) is None:
            raise RuntimeArtifactRootError("Expected model identity must be lowercase SHA-256")
        root = _checked(Path(output_root), directory=True)
        log_path = root / case / "runtime.log"
        log = _read(log_path, MAX_LOG_BYTES)
        summary = _summary(log)
        if any(summary.get(key) != value for key, value in {"status": "completed", "backend": "fem", "mode": "strict", "precision": "double"}.items()):
            raise RuntimeArtifactRootError("Runtime summary is not a completed strict double FEM execution")
        summary_run_id = summary.get("run_id")
        summary_session_id = summary.get("session_id")
        if any(not isinstance(value, str) or not value.strip() for value in (summary_run_id, summary_session_id)):
            raise RuntimeArtifactRootError("Runtime summary is missing run/session identity")
        workspace = _mapped(root, summary.get("workspace_dir"))
        _require_case_workspace(workspace, case, summary_run_id)
        artifacts = _mapped(root, summary.get("artifact_dir"))
        if artifacts != workspace / "artifacts":
            raise RuntimeArtifactRootError("Runtime artifacts must be the workspace artifacts directory")
        manifest_path, storage_path = workspace / "fullmag-run.json", workspace / "output-storage.json"
        manifest_bytes, storage_bytes = _read(manifest_path, MAX_RECEIPT_BYTES), _read(storage_path, MAX_RECEIPT_BYTES)
        manifest, storage = _object(manifest_bytes), _object(storage_bytes)
        source = manifest.get("source")
        run_id = manifest.get("run_id")
        session_id = manifest.get("session_id")
        if (manifest.get("schema") != "fullmag.run_manifest.v1" or manifest.get("status") != "completed"
                or type(manifest.get("exit_code")) is not int or manifest["exit_code"] != 0
                or not isinstance(source, dict) or source.get("sha256") != expected_model_sha256
                or not isinstance(run_id, str) or not run_id.strip()
                or not isinstance(session_id, str) or not session_id.strip()):
            raise RuntimeArtifactRootError("Run manifest identity or terminal state mismatch")
        if summary_run_id != run_id or summary_session_id != session_id:
            raise RuntimeArtifactRootError("Runtime summary run/session identity mismatch")
        resolved = storage.get("resolved")
        if (storage.get("schema") != "fullmag.output_storage.resolved.v1" or storage.get("state") != "succeeded"
                or not isinstance(resolved, dict) or resolved.get("run_id") != run_id
                or resolved.get("output_dir") != summary["workspace_dir"]):
            raise RuntimeArtifactRootError("Output storage identity or terminal state mismatch")
        outputs = manifest.get("outputs")
        metadata_entries = [entry for entry in outputs if isinstance(entry, dict) and entry.get("path") == "artifacts/metadata.json"] if isinstance(outputs, list) else []
        if len(metadata_entries) != 1 or metadata_entries[0].get("kind") != "metadata":
            raise RuntimeArtifactRootError("Run manifest does not uniquely bind artifact metadata")
        metadata_path = artifacts / "metadata.json"
        metadata_bytes = _read(metadata_path, MAX_METADATA_BYTES)
        metadata = _object(metadata_bytes)
        problem_meta = metadata.get("problem_meta")
        runtime_meta = problem_meta.get("runtime_metadata") if isinstance(problem_meta, dict) else None
        if (metadata.get("source_hash") != expected_model_sha256 or not isinstance(runtime_meta, dict)
                or runtime_meta.get("producer_run_id") != run_id):
            raise RuntimeArtifactRootError("Artifact metadata source or producer identity mismatch")
        binding = {"schema": "fullmag.managed-runtime-artifact-binding.v1", "run_id": run_id, "session_id": session_id,
                   "model_sha256": expected_model_sha256, "workspace_dir": str(workspace), "artifact_dir": str(artifacts),
                   "container_workspace_dir": summary["workspace_dir"], "container_artifact_dir": summary["artifact_dir"]}
        for key, path, data in (("runtime_log", log_path, log), ("run_manifest", manifest_path, manifest_bytes), ("output_storage", storage_path, storage_bytes), ("metadata", metadata_path, metadata_bytes)):
            binding[key] = str(path)
            binding[key + "_sha256"] = hashlib.sha256(data).hexdigest()
        return artifacts, binding
    except RuntimeArtifactRootError:
        raise
    except (OSError, ValueError, TypeError, RuntimeError) as error:
        raise RuntimeArtifactRootError("Cannot bind runtime artifacts: " + str(error)) from error
