"""Freeze and stage an explicit Windows x64 CPython 3.12 embeddable runtime."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

from stage_node_runtime import regular_bytes
from verify_pe_dependencies import require_x64_pe


PTH = b"python312.zip\n.\nsite-packages\nimport site\n"
BOOTSTRAP = b'''"""Application-local Python search paths and native DLL handles."""
import os
from pathlib import Path
import site

_root = Path(__file__).resolve().parent
_dll_handles = [os.add_dll_directory(str(_root.parent / "bin"))]
site.addsitedir(str(_root / "site-packages"))
'''
REQUIRED = {"python.exe", "python312.dll", "python3.dll", "python312.zip", "python312._pth", "LICENSE.txt"}


def digest(content):
    return hashlib.sha256(content).hexdigest()


def inspect_runtime(root):
    if not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("Python runtime root must be an absolute regular directory")
    files = sorted(root.iterdir(), key=lambda path: path.name.lower())
    names = {path.name for path in files}
    if len({name.lower() for name in names}) != len(files):
        raise ValueError("Ambiguous Python runtime filenames")
    if not REQUIRED <= names:
        raise ValueError("Incomplete CPython 3.12 embeddable distribution")
    inventory = []
    for path in files:
        content = regular_bytes(path)
        if path.suffix.lower() not in {".exe", ".dll", ".pyd", ".zip", "._pth", ".txt"}:
            raise ValueError(f"Unexpected embeddable runtime input: {path.name}")
        if path.suffix.lower() in {".exe", ".dll", ".pyd"}:
            require_x64_pe(path)
        inventory.append({"source": str(path), "path": "python/" + path.name, "sha256": digest(content)})
    config = (root / "python312._pth").read_text(encoding="utf-8")
    entries = [line.strip() for line in config.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if entries != ["python312.zip", "."]:
        raise ValueError("Source Python path configuration must be the isolated embeddable default")
    with zipfile.ZipFile(root / "python312.zip") as archive:
        if "encodings/__init__.pyc" not in archive.namelist():
            raise ValueError("Embeddable Python standard library is incomplete")
    result = subprocess.run([str(root / "python.exe"), "-I", "-S", "-c",
                             "import json,sys,struct; print(json.dumps(dict(version=list(sys.version_info[:3]), implementation=sys.implementation.name, platform=sys.platform, bits=struct.calcsize('P')*8)))"],
                            capture_output=True, text=True, timeout=15, check=True)
    host = json.loads(result.stdout)
    if host["version"][:2] != [3, 12] or host["platform"] != "win32" or host["bits"] != 64 or host["implementation"] != "cpython":
        raise ValueError("Packaged Python must be native Windows x64 CPython 3.12")
    for entry in inventory:
        if digest(regular_bytes(Path(entry["source"]))) != entry["sha256"]:
            raise ValueError("Python runtime input changed during inspection")
    return {"schema_version": 1, "kind": "bundled-windows-x64-cpython-embed", "host": host,
            "source_root": str(root), "files": inventory, "qualification": "not_verified"}


def stage_runtime(inventory, destination):
    if inventory.get("schema_version") != 1 or inventory.get("kind") != "bundled-windows-x64-cpython-embed":
        raise ValueError("Invalid Python runtime inventory")
    root = Path(inventory["source_root"])
    current = inspect_runtime(root)
    if current != inventory:
        raise ValueError("Python runtime inventory changed before staging")
    destination = destination.resolve(strict=True)
    if root == destination or root in destination.parents or destination in root.parents:
        raise ValueError("Python runtime source and staging must be separate trees")
    python_dir = destination / "python"
    if python_dir.resolve() != python_dir or (python_dir.exists() and (not python_dir.is_dir() or any(python_dir.iterdir()))):
        raise ValueError("Python runtime staging directory must be regular and empty")
    pending = []
    for entry in inventory["files"]:
        content = regular_bytes(Path(entry["source"]))
        if digest(content) != entry["sha256"]:
            raise ValueError("Python runtime input changed before copying")
        if entry["path"] == "python/python312._pth":
            content = PTH
        pending.append((entry["path"], content))
    pending.append(("python/sitecustomize.py", BOOTSTRAP))
    license_content = next(content for name, content in pending if name == "python/LICENSE.txt")
    pending.append(("share/licenses/python-LICENSE.txt", license_content))
    for name, content in pending:
        target = destination / name
        if target.resolve() != target or target.exists():
            raise ValueError("Python runtime destination conflicts or traverses a link")
    for name, content in pending:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    staged = [{"path": name, "sha256": digest(content)} for name, content in pending]
    for entry in staged:
        if digest(regular_bytes(destination / entry["path"])) != entry["sha256"]:
            raise ValueError("Python runtime changed during staging")
    return dict(inventory, staged_files=staged)


def verify_runtime(inventory, destination):
    destination = destination.resolve(strict=True)
    for entry in inventory["staged_files"]:
        path = destination / entry["path"]
        if not path.resolve(strict=True).is_relative_to(destination) or digest(regular_bytes(path)) != entry["sha256"]:
            raise ValueError("Staged Python runtime hash mismatch")
    # Poison interpreter environment and remove PATH: all Python paths must remain local.
    env = dict(os.environ, PATH="", PYTHONHOME="invalid-external-python", PYTHONPATH="invalid-external-modules")
    result = subprocess.run([str(destination / "python/python.exe"), "-c",
        "import json,sys,sitecustomize; assert len(sitecustomize._dll_handles)==1; print(json.dumps(dict(version=list(sys.version_info[:3]), isolated=sys.flags.isolated, no_user_site=sys.flags.no_user_site, paths=sys.path, executable=sys.executable)))"],
        cwd=destination, env=env, capture_output=True, text=True, timeout=15, check=True)
    proof = json.loads(result.stdout)
    if proof["version"] != inventory["host"]["version"] or proof["isolated"] != 1 or proof["no_user_site"] != 1:
        raise ValueError("Staged Python interpreter is not the isolated pinned runtime")
    python_dir = destination / "python"
    if Path(proof["executable"]).resolve() != python_dir / "python.exe" or not proof["paths"]:
        raise ValueError("Staged Python executable/path proof is invalid")
    for path in proof["paths"]:
        if not path or not Path(path).resolve().is_relative_to(python_dir):
            raise ValueError("Staged Python search path escapes application")
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["inspect", "stage", "verify"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "inspect":
        result = inspect_runtime(args.root)
    else:
        inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
        result = stage_runtime(inventory, args.destination) if args.mode == "stage" else verify_runtime(inventory, args.destination)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
