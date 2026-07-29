import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


REPO_ROOT = Path(__file__).resolve().parents[1]
RESTORE_SCRIPT = REPO_ROOT / "scripts/restore_persistent_fem_runtime.sh"


def _write_fake_validator(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import argparse
import hashlib
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-root", type=Path, required=True)
parser.add_argument("--compare-exact", type=Path)
parser.add_argument("--allow-unaddressed-staging", action="store_true")
args = parser.parse_args()

def identity(root):
    result = {}
    for item in sorted(root.rglob("*")):
        relative = str(item.relative_to(root))
        if item.is_symlink():
            result[relative] = ("symlink", os.readlink(item))
        elif item.is_dir():
            result[relative] = ("directory",)
        else:
            result[relative] = ("file", hashlib.sha256(item.read_bytes()).hexdigest())
    return result

if not (args.runtime_root / "manifest.json").is_file():
    raise SystemExit(2)
if args.compare_exact is not None and identity(args.runtime_root) != identity(args.compare_exact):
    raise SystemExit(2)
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_restore_repairs_corrupt_same_name_variant_from_latest_archive(
    tmp_path: Path,
) -> None:
    fake_repo = tmp_path / "repo"
    scripts = fake_repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(RESTORE_SCRIPT, scripts / RESTORE_SCRIPT.name)
    _write_fake_validator(scripts / "validate_managed_fem_runtime_bundle.py")

    bundle = tmp_path / "bundle"
    (bundle / "bin").mkdir(parents=True)
    manifest_bytes = json.dumps({"variant": "test-variant"}).encode()
    (bundle / "manifest.json").write_bytes(manifest_bytes)
    (bundle / "bin/fullmag-fem-gpu").write_text("known-good\n", encoding="utf-8")
    (bundle / "bin/fullmag-fem-gpu-link").symlink_to("fullmag-fem-gpu")

    build_root = tmp_path / "persistent"
    archive = build_root / "runtimes/fem-gpu-host-latest.tar"
    archive.parent.mkdir(parents=True)
    with tarfile.open(archive, "w") as output:
        output.add(bundle, arcname=".")

    env = os.environ.copy()
    env["FULLMAG_BUILD_ROOT"] = str(build_root)
    command = ["bash", str(scripts / RESTORE_SCRIPT.name)]
    first = subprocess.run(command, cwd=fake_repo, env=env, text=True, capture_output=True)
    assert first.returncode == 0, first.stderr

    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    variant = (
        fake_repo
        / ".fullmag/runtimes/fem-gpu-variants"
        / f"test-variant-{manifest_sha}"
    )
    assert (variant / "bin/fullmag-fem-gpu").read_text(encoding="utf-8") == "known-good\n"
    assert (variant / "bin/fullmag-fem-gpu-link").is_symlink()

    (variant / "bin/fullmag-fem-gpu").write_text("corrupt\n", encoding="utf-8")
    second = subprocess.run(command, cwd=fake_repo, env=env, text=True, capture_output=True)
    assert second.returncode == 0, second.stderr
    assert (variant / "bin/fullmag-fem-gpu").read_text(encoding="utf-8") == "known-good\n"
    assert not list(variant.parent.glob("*.restore-backup.*"))
    assert (fake_repo / ".fullmag/runtimes/fem-gpu-host").resolve() == variant.resolve()
