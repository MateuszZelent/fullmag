#!/usr/bin/env python3
"""Install only reviewed Task4 fixture CI wiring; never run its test."""
from pathlib import Path
import hashlib
import json
import sys

PINS = {'materialize-task4-fixture-ci.py': {'bytes': 10315, 'sha256': '6d12e23efbd436d51110ff2d0aa5324bc455f43974f046977f1269cffe982ec3'}, 'run_retained_dtq_authenticated_fixture_contract.sh': {'bytes': 1221, 'sha256': '8baf6015f241c0e17cef03652ab32852e6a0eb0e57f20c2d5c8943b4334661c9'}, 'task-4-authenticated-acceptance.rs': {'bytes': 19296, 'sha256': '920f4aa611b1da2aa67c61a5e8a163360f1569768377fd851a7d562e6492b7ca'}, 'task-4-fix3-source-pins.json': {'bytes': 3192, 'sha256': 'b8ddaa732ed748902636823c03eaafc10837f253d2a1272a006284339c3d304e'}, 'task-4-fixture-ci-inputs.json': {'bytes': 4575, 'sha256': '3e8d1b9fcb6babb428c03e25c3359bac273bb88d34325dcbdc9923bbdc0b62a4'}, 'task-4-fixture-justfile-insertions.json': {'bytes': 615, 'sha256': 'e16c09da083f44acc128514379206976feaf721de5711ea3c8fdf0c357501c82'}, 'task-4-register-ci.py': {'bytes': 8223, 'sha256': '4f5f486c8b93e02148870ca288a932c04a31182f8613e2514e4215141f24f03a'}, 'task-4-source-fixture-request.json': {'bytes': 146, 'sha256': '3db311cfd98f9a2f994e6e5e21a76e370599193daa7b783c39bd68a6de96e165'}, 'task-4-source-fixture.py': {'bytes': 9085, 'sha256': '01bfc908ccfc67ed0f8cc83370e4e1be67be49770d0becd82937187c80506730'}, 'task-4-source-fixture.rs': {'bytes': 19406, 'sha256': '89d35188d079596652f46aaca40fd56e09bddfdf7273c560589fe6fb4552ca89'}}
HELPER_PIN = {"bytes": 1957, "sha256": "3a9da2aa9db80d86767319d6811f8d26192ee41772f446d2b679afe52bf41bfa"}

def pin(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

def main():
    if sys.argv[1:] != ["install"]:
        raise ValueError("Usage: apply-task4-fixture-ci.py install")
    data = Path(__file__).resolve().parent
    root = data.parents[1]
    fixture = data / "task-4-fixture"
    checked = {}
    for name, expected in PINS.items():
        path = fixture / name
        if path.is_symlink() or path.resolve(strict=True) != path or pin(path.read_bytes()) != expected:
            raise ValueError("Exact Task4 fixture wiring pin differs: " + name)
        checked[name] = path.read_bytes()
    helper = data / "apply-justfile-insertions.py"
    if helper.is_symlink() or helper.resolve(strict=True) != helper or pin(helper.read_bytes()) != HELPER_PIN:
        raise ValueError("Exact generic recipe helper pin differs")
    target = root / "scripts/ci/run_retained_dtq_authenticated_fixture_contract.sh"
    if target.exists() or target.is_symlink() or target.parent.resolve(strict=True) != target.parent:
        raise ValueError("New fixture CI shell destination must be absent")
    justfile = root / "justfile"
    metadata = json.loads(checked["task-4-fixture-justfile-insertions.json"])
    if justfile.is_symlink() or pin(justfile.read_bytes()) != metadata["before"]:
        raise ValueError("Exact final Task5 justfile before-pin differs")
    namespace = {"__name__": "ci_recipe_insertions"}
    exec(compile(helper.read_bytes(), str(helper), "exec"), namespace)
    namespace["apply_insertions"](justfile, checked["task-4-fixture-justfile-insertions.json"])
    with target.open("xb") as destination:
        destination.write(checked["run_retained_dtq_authenticated_fixture_contract.sh"])
    print("Task4 fixture CI wiring installed; authenticated acceptance NOT RUN")

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
