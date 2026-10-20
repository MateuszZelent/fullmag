"""Explicit, directory-scoped user output mapping for Docker DEV scripts."""
import os
from pathlib import Path, PurePosixPath, PureWindowsPath

from docker_build_control import BuildControlError

OUTPUT_ROOT = "/opt/fullmag/script-output"
CONFIG_KEY = "FULLMAG_SCRIPT_OUTPUT_DIRECTORY"


def selected_directory(selected, *, configured=None):
    """Resolve an operator opt-in to one child directory, never the checkout."""
    if configured is None:
        from docker_dev_defaults import _known_checkouts, _read_dotenv
        main = _known_checkouts(Path(selected))[0]
        configured = os.environ.get(CONFIG_KEY, _read_dotenv(main / ".env").get(CONFIG_KEY, ""))
    if not configured:
        return None
    relative = PurePosixPath(str(configured).replace("\\", "/"))
    if (relative.is_absolute() or not relative.parts or ":" in str(relative)
            or any(part.casefold() in {"..", ".git"} for part in relative.parts)):
        raise BuildControlError(CONFIG_KEY + " must select a child directory inside the source checkout")
    root = Path(selected).resolve(strict=True)
    directory = root.joinpath(*relative.parts)
    import fullmag_storage as storage
    if directory == root or any(storage.is_link(path) for path in (directory, *directory.parents) if path == root or root in path.parents):
        raise BuildControlError("Script output directory cannot be the checkout root or a linked path")
    if not directory.is_dir() or root not in directory.resolve(strict=True).parents:
        raise BuildControlError("Script output directory must exist inside the selected checkout")
    if (directory / ".git").exists() or (directory / ".git").is_symlink():
        raise BuildControlError("Script output directory cannot contain Git administration")
    return directory


def configure(document, selected, *, configured=None):
    """Add only the explicitly configured child directory as a writable alias."""
    directory = selected_directory(selected, configured=configured)
    if directory is None:
        return
    backend = document["services"]["backend"]
    mounts = backend["volumes"]
    source = [m for m in mounts if m.get("target") == "/opt/fullmag/source"]
    if (len(source) != 1 or source[0].get("type") != "bind"
            or source[0].get("read_only") is not True
            or Path(source[0]["source"]).resolve() != Path(selected).resolve()):
        raise BuildControlError("Script output requires the exact readonly source checkout")
    if any(m.get("target", "").startswith(OUTPUT_ROOT) for m in mounts):
        raise BuildControlError("Script output alias is already configured or ambiguous")
    relative = directory.relative_to(Path(selected).resolve()).as_posix()
    backend["environment"].update(FULLMAG_SCRIPT_OUTPUT_ROOT=OUTPUT_ROOT,
        FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR="/opt/fullmag/source/" + relative)
    mounts.append({"type": "bind", "source": str(directory), "target": OUTPUT_ROOT,
                   "read_only": False, "bind": {"create_host_path": False}})
    backend["x-fullmag-script-output"] = {"schema": "fullmag.script-output-bind.v1",
        "source_relative": relative, "target": OUTPUT_ROOT,
        "purpose": "user-results-and-session-files"}
    validate(document)


def _host_shape(value):
    raw = str(value)
    return PureWindowsPath(raw) if PureWindowsPath(raw).is_absolute() else PurePosixPath(raw)


def validate(document):
    """Accept only an explicit output child of the unchanged readonly source."""
    backend = document["services"]["backend"]
    outputs = [m for m in backend["volumes"] if m.get("target") == OUTPUT_ROOT]
    if not outputs:
        if backend.get("environment", {}).get("FULLMAG_SCRIPT_OUTPUT_ROOT"):
            raise BuildControlError("Script output environment has no corresponding bind")
        return
    source = [m for m in backend["volumes"] if m.get("target") == "/opt/fullmag/source"]
    descriptor = backend.get("x-fullmag-script-output", {})
    if len(source) != 1 or len(outputs) != 1 or not isinstance(descriptor, dict) or descriptor.get("schema") != "fullmag.script-output-bind.v1":
        raise BuildControlError("Script output/source mapping is incomplete")
    src, out = source[0], outputs[0]
    relative = PurePosixPath(descriptor.get("source_relative", ""))
    if relative.is_absolute() or not relative.parts or ":" in str(relative) or any(p.casefold() in {"..", ".git"} for p in relative.parts):
        raise BuildControlError("Script output descriptor must select a child directory")
    if (src.get("type") != "bind" or src.get("read_only") is not True
            or out.get("type") != "bind" or out.get("read_only") is not False
            or _host_shape(out.get("source", "")) != _host_shape(src["source"]).joinpath(*relative.parts)
            or out.get("bind", {}).get("create_host_path") is not False
            or backend.get("environment", {}).get("FULLMAG_SCRIPT_OUTPUT_ROOT") != OUTPUT_ROOT
            or backend.get("environment", {}).get("FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR") != "/opt/fullmag/source/" + relative.as_posix()):
        raise BuildControlError("Script output alias differs from its configured source child")
    for name, service in document["services"].items():
        if name != "backend" and any(m.get("target", "").startswith(OUTPUT_ROOT) for m in service.get("volumes", [])):
            raise BuildControlError("Only the backend may receive the script output alias")
