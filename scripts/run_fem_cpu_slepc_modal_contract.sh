#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == slepc-modal ]] || {
  echo 'expected slepc-modal scenario' >&2
  exit 2
}
: "${FULLMAG_FEM_SLEPC_MODAL_BUILD_ROOT:?managed private build root required}"
: "${FULLMAG_FEM_SLEPC_MODAL_REPORT_ROOT:?managed report root required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
build_dir="$FULLMAG_FEM_SLEPC_MODAL_BUILD_ROOT"
report_dir="$FULLMAG_FEM_SLEPC_MODAL_REPORT_ROOT/slepc-modal"

# The entrypoint supplies a private build mount. Refuse a broad or unexpected
# path before using it, and preserve an existing private cache for auditability.
case "$build_dir" in
  /workspace/.fullmag-build/*) ;;
  *)
    echo 'SLEPc modal build root must stay below /workspace/.fullmag-build' >&2
    exit 2
    ;;
esac

if [[ -L "$build_dir" || ( -e "$build_dir" && ! -d "$build_dir" ) ]]; then
  echo 'SLEPc modal build root must be a regular directory' >&2
  exit 2
fi
mkdir -p "$build_dir" "$report_dir"
status=fail

modal_target=fem_poisson_airbox_modal_eigen_slepc_contract
floquet_targets=(
  fem_floquet_magnetic_operator_contract
  fem_floquet_bloch_scalar_contract
  fem_floquet_airbox_operator_contract
  fem_floquet_dynamic_demag_k_contract
  fem_floquet_waveguide_demag_k_contract
  fem_floquet_waveguide_cross_section_contract
  fem_floquet_modal_solver_contract
)
targets=("$modal_target" "${floquet_targets[@]}")
ctest_regex='^fem_(poisson_airbox_modal_eigen_slepc|floquet_(magnetic_operator|bloch_scalar|airbox_operator|dynamic_demag_k|waveguide_demag_k|waveguide_cross_section|modal_solver))_contract$'

cmake_attestation="$report_dir/cmake-attestation.json"
runtime_probe="$report_dir/fullmag-fem-availability.json"
runtime_stderr="$report_dir/fullmag-runtime.stderr.log"
runtime_attestation="$report_dir/runtime-attestation.json"
dependency_attestation="$report_dir/dependency-attestation.json"
resolution_attestation="$report_dir/resolution-attestation.json"
junit_attestation="$report_dir/ctest-junit-attestation.json"
runtime_fem_lib=""
CTEST_COMPLETED=0

write_result() {
  RESULT_PATH="$report_dir/result.json" \
  STATUS="$status" \
  BUILD_DIR="$build_dir" \
  SOURCE_COMMIT="${FULLMAG_SOURCE_GIT_COMMIT:-unknown}" \
  SOURCE_SNAPSHOT="${FULLMAG_SOURCE_SNAPSHOT_SHA256:-unknown}" \
  CMAKE_ATTESTATION="$cmake_attestation" \
  RUNTIME_ATTESTATION="$runtime_attestation" \
  DEPENDENCY_ATTESTATION="$dependency_attestation" \
  RESOLUTION_ATTESTATION="$resolution_attestation" \
  JUNIT_ATTESTATION="$junit_attestation" \
  RUNTIME_LIBRARY="$runtime_fem_lib" \
  CTEST_COMPLETED="$CTEST_COMPLETED" \
  python3 -c '
import json
import os
from pathlib import Path


def load(path):
    if not path:
        return {}
    candidate = Path(path)
    try:
        value = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        return {"status": "unavailable", "path": str(candidate), "error": str(error)}
    return value if isinstance(value, dict) else {"status": "unavailable", "path": str(candidate), "error": "attestation is not an object"}

cmake = load(os.environ.get("CMAKE_ATTESTATION", ""))
runtime = load(os.environ.get("RUNTIME_ATTESTATION", ""))
dependency = load(os.environ.get("DEPENDENCY_ATTESTATION", ""))
resolution = load(os.environ.get("RESOLUTION_ATTESTATION", ""))
junit = load(os.environ.get("JUNIT_ATTESTATION", ""))
status = os.environ["STATUS"]
resolved = {
    "backend": None,
    "device": None,
    "precision": None,
    "slepc": None,
    "fallback_used": None,
}
if (
    status == "pass"
    and os.environ.get("CTEST_COMPLETED") == "1"
    and resolution.get("status") == "pass"
    and isinstance(resolution.get("resolved"), dict)
):
    resolved = resolution["resolved"]

payload = {
    "schema": "fullmag.fem.cpu.slepc_modal_contract_result.v1",
    "scenario": "slepc-modal",
    "status": os.environ["STATUS"],
    "scope": "managed_fem_cpu_slepc_modal_and_floquet_contracts",
    "requested": {
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "slepc": True,
    },
    "resolved": resolved,
    "build": {
        "directory": os.environ["BUILD_DIR"],
        "options": [
            "-DFULLMAG_ENABLE_CUDA=ON",
            "-DFULLMAG_ENABLE_FEM_GPU=OFF",
            "-DFULLMAG_USE_MFEM_STACK=ON",
            "-DFULLMAG_FEM_WITH_SLEPC=ON",
        ],
        "modal_target": "fem_poisson_airbox_modal_eigen_slepc_contract",
        "floquet_targets": [
            "fem_floquet_magnetic_operator_contract",
            "fem_floquet_bloch_scalar_contract",
            "fem_floquet_airbox_operator_contract",
            "fem_floquet_dynamic_demag_k_contract",
            "fem_floquet_waveguide_demag_k_contract",
            "fem_floquet_waveguide_cross_section_contract",
            "fem_floquet_modal_solver_contract",
        ],
        "ctest_regex": os.environ.get("CTEST_REGEX", ""),
        "ctest_completed": os.environ.get("CTEST_COMPLETED") == "1",
        "executed_targets": ([
            "fem_poisson_airbox_modal_eigen_slepc_contract",
            "fem_floquet_magnetic_operator_contract",
            "fem_floquet_bloch_scalar_contract",
            "fem_floquet_airbox_operator_contract",
            "fem_floquet_dynamic_demag_k_contract",
            "fem_floquet_waveguide_demag_k_contract",
            "fem_floquet_waveguide_cross_section_contract",
            "fem_floquet_modal_solver_contract",
        ] if os.environ.get("CTEST_COMPLETED") == "1" else []),
    },
    "source": {
        "commit": os.environ["SOURCE_COMMIT"],
        "snapshot_sha256": os.environ["SOURCE_SNAPSHOT"],
    },
    "runtime_library": os.environ.get("RUNTIME_LIBRARY", ""),
    "attestation": {
        "cmake": cmake,
        "runtime": runtime,
        "dependency": dependency,
        "resolution": resolution,
        "ctest_junit": junit,
    },
}
path = Path(os.environ["RESULT_PATH"])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
'
}

trap write_result EXIT

cmake -S native -B "$build_dir" \
  -DFULLMAG_ENABLE_CUDA=ON \
  -DFULLMAG_ENABLE_FEM_GPU=OFF \
  -DFULLMAG_USE_MFEM_STACK=ON \
  -DFULLMAG_FEM_WITH_SLEPC=ON \
  2>&1 | tee "$report_dir/configure.log"

CMAKE_ATTESTATION="$cmake_attestation" python3 - "$build_dir/CMakeCache.txt" <<'PY'
import json
import os
from pathlib import Path
import sys

cache_path = Path(sys.argv[1])
if not cache_path.is_file() or cache_path.is_symlink():
    raise SystemExit(f"CMake configure did not publish a regular cache: {cache_path}")
expected = {
    "FULLMAG_ENABLE_CUDA": "ON",
    "FULLMAG_ENABLE_FEM_GPU": "OFF",
    "FULLMAG_USE_MFEM_STACK": "ON",
    "FULLMAG_FEM_WITH_SLEPC": "ON",
}
observed = {}
for line in cache_path.read_text(encoding="utf-8", errors="replace").splitlines():
    if not line or line.startswith("//") or line.startswith("#") or ":" not in line or "=" not in line:
        continue
    name, remainder = line.split(":", 1)
    value_type, value = remainder.split("=", 1)
    if name in expected:
        observed[name] = {"type": value_type, "value": value}
missing = sorted(set(expected) - set(observed))
if missing:
    raise SystemExit("CMake cache is missing required options: " + ", ".join(missing))
wrong = [name for name, value in expected.items() if observed[name]["value"].upper() != value]
if wrong:
    details = ", ".join(f"{name}={observed[name]['value']}" for name in wrong)
    raise SystemExit("CMake resolved options do not match the CPU/SLEPc contract: " + details)
output = {
    "schema": "fullmag.fem.slepc_modal.cmake_attestation.v1",
    "status": "pass",
    "cache_path": str(cache_path),
    "options": observed,
}
Path(os.environ["CMAKE_ATTESTATION"]).write_text(
    json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-1}" \
  cmake --build "$build_dir" --target "${targets[@]}" \
  2>&1 | tee "$report_dir/build.log"

runtime_root="$repo_root/.fullmag/local"
runtime_bin="$runtime_root/bin/fullmag-bin"
runtime_lib_dir="$runtime_root/lib"
if [[ ! -x "$runtime_bin" ]]; then
  echo "managed fullmag-bin is missing or not executable: $runtime_bin" >&2
  exit 1
fi
runtime_fem_lib="$(find "$runtime_lib_dir" -maxdepth 1 -type f -name 'libfullmag_fem.so*' -print -quit 2>/dev/null || true)"
if [[ -z "$runtime_fem_lib" ]]; then
  echo "managed runtime FEM library is missing below: $runtime_lib_dir" >&2
  exit 1
fi

export FULLMAG_REPO_ROOT="$repo_root"
# libCEED in the managed image has a CUDA-driver dependency even for this
# CPU/SLEPc contract.  Use the image's compatibility driver at runtime; this
# keeps the CPU lane explicit while avoiding a host-driver fallback.
export LD_LIBRARY_PATH="$runtime_lib_dir:$build_dir/backends/fem:/usr/local/cuda/compat:/opt/fullmag-deps/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if ! "$runtime_bin" runtime fem-availability --json \
  >"$runtime_probe" 2>"$runtime_stderr"; then
  echo 'managed fullmag-bin FEM availability probe failed' >&2
  exit 1
fi

python3 - "$runtime_probe" "$runtime_stderr" "$runtime_attestation" <<'PY'
import json
from pathlib import Path
import sys

probe_path, stderr_path, output_path = map(Path, sys.argv[1:])
try:
    availability = json.loads(probe_path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, ValueError) as error:
    raise SystemExit(f"invalid fullmag-bin FEM availability JSON: {error}")
if not isinstance(availability, dict) or availability.get("native_fem_cpu_available") is not True:
    raise SystemExit("fullmag-bin did not attest native FEM CPU availability")
stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
stamp = next((line.strip() for line in stderr.splitlines() if line.startswith("[fullmag] build:")), "")
if not stamp or "source snapshot:" not in stamp:
    raise SystemExit("fullmag-bin startup stamp lacks source snapshot identity")
output = {
    "schema": "fullmag.fem.slepc_modal.runtime_attestation.v1",
    "status": "pass",
    "binary": str(Path.cwd() / ".fullmag/local/bin/fullmag-bin"),
    "availability": availability,
    "startup_stamp": stamp,
}
output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

python3 - "$runtime_fem_lib" "$dependency_attestation" <<'PY'
import ctypes
import json
from pathlib import Path
import sys

library_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])

class DependencyInfo(ctypes.Structure):
    _fields_ = [
        ("petsc_available", ctypes.c_int),
        ("slepc_available", ctypes.c_int),
        ("modal_eigen_native_cpu_slepc_available", ctypes.c_int),
        ("petsc_version", ctypes.c_char * 64),
        ("slepc_version", ctypes.c_char * 64),
        ("petsc_pkgconfig_dir", ctypes.c_char * 256),
        ("slepc_pkgconfig_dir", ctypes.c_char * 256),
        ("petsc_find_module_file", ctypes.c_char * 256),
        ("slepc_find_module_file", ctypes.c_char * 256),
        ("petsc_library_path", ctypes.c_char * 256),
        ("slepc_library_path", ctypes.c_char * 256),
        ("reason", ctypes.c_char * 256),
        ("diagnostics_json", ctypes.c_char * 1024),
    ]

def text(value):
    return bytes(value).split(b"\0", 1)[0].decode("utf-8", "replace")

try:
    library = ctypes.CDLL(str(library_path))
except OSError as error:
    raise SystemExit(f"cannot load managed FEM library for dependency attestation: {error}")
query = library.fullmag_fem_get_frequency_domain_dependency_info
query.argtypes = [ctypes.POINTER(DependencyInfo)]
query.restype = ctypes.c_int
info = DependencyInfo()
return_code = int(query(ctypes.byref(info)))
if return_code != 0:
    raise SystemExit(f"FEM dependency info query failed with return code {return_code}")
fields = {
    "petsc_available": int(info.petsc_available) == 1,
    "slepc_available": int(info.slepc_available) == 1,
    "modal_eigen_native_cpu_slepc_available": int(info.modal_eigen_native_cpu_slepc_available) == 1,
    "petsc_version": text(info.petsc_version),
    "slepc_version": text(info.slepc_version),
    "petsc_pkgconfig_dir": text(info.petsc_pkgconfig_dir),
    "slepc_pkgconfig_dir": text(info.slepc_pkgconfig_dir),
    "petsc_find_module_file": text(info.petsc_find_module_file),
    "slepc_find_module_file": text(info.slepc_find_module_file),
    "petsc_library_path": text(info.petsc_library_path),
    "slepc_library_path": text(info.slepc_library_path),
    "reason": text(info.reason),
}
if not fields["petsc_available"] or not fields["slepc_available"] or not fields["modal_eigen_native_cpu_slepc_available"]:
    raise SystemExit("managed FEM library did not attest PETSc/SLEPc CPU modal capability")
if not fields["petsc_version"] or not fields["slepc_version"]:
    raise SystemExit("managed FEM library did not attest PETSc/SLEPc versions")
try:
    fields["diagnostics"] = json.loads(text(info.diagnostics_json))
except ValueError:
    fields["diagnostics"] = text(info.diagnostics_json)
output = {
    "schema": "fullmag.fem.slepc_modal.dependency_attestation.v1",
    "status": "pass",
    "library": str(library_path),
    "return_code": return_code,
    "dependency": fields,
}
output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

export CTEST_REGEX="$ctest_regex"
ctest --test-dir "$build_dir/backends/fem" \
  --output-on-failure \
  --verbose \
  --no-tests=error \
  --output-junit "$report_dir/test.junit.xml" \
  --tests-regex "$ctest_regex" \
  2>&1 | tee "$report_dir/test.log"


python3 - "$report_dir/test.junit.xml" "$junit_attestation" "${targets[@]}" <<'PY'
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ElementTree

junit_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
expected = list(sys.argv[3:])
try:
    root = ElementTree.parse(junit_path).getroot()
except (OSError, ElementTree.ParseError) as error:
    raise SystemExit(f"invalid CTest JUnit output: {error}")
cases = list(root.iter("testcase"))
names = [case.attrib.get("name", "") for case in cases]
skipped = list(root.iter("skipped"))
failures = list(root.iter("failure")) + list(root.iter("error"))
if len(cases) != len(expected) or sorted(names) != sorted(expected):
    raise SystemExit(
        "CTest JUnit did not execute exactly the required targets: "
        + json.dumps({"expected": expected, "observed": names}, sort_keys=True)
    )
if skipped or failures:
    raise SystemExit(
        "CTest JUnit contains skipped or failed targets: "
        + json.dumps({"skipped": len(skipped), "failures": len(failures)}, sort_keys=True)
    )
output = {
    "schema": "fullmag.fem.slepc_modal.ctest_junit_attestation.v1",
    "status": "pass",
    "path": str(junit_path),
    "testcase_count": len(cases),
    "skipped_count": len(skipped),
    "failure_count": len(failures),
    "testcases": names,
}
output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

export CTEST_COMPLETED=1

python3 - "$runtime_attestation" "$dependency_attestation" "$junit_attestation" "$resolution_attestation" <<'PY'
import json
from pathlib import Path
import sys

runtime_path, dependency_path, junit_path, output_path = map(Path, sys.argv[1:])
runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
dependency = json.loads(dependency_path.read_text(encoding="utf-8"))
junit = json.loads(junit_path.read_text(encoding="utf-8"))
if runtime.get("status") != "pass" or dependency.get("status") != "pass" or junit.get("status") != "pass":
    raise SystemExit("runtime/dependency attestations are not complete")
availability = runtime.get("availability")
deps = dependency.get("dependency")
if not isinstance(availability, dict) or availability.get("native_fem_cpu_available") is not True:
    raise SystemExit("runtime attestation does not prove native FEM CPU execution")
if not isinstance(deps, dict) or deps.get("modal_eigen_native_cpu_slepc_available") is not True:
    raise SystemExit("dependency attestation does not prove native CPU SLEPc modal execution")
precision = {
    "value": "double",
    "basis": "modal CTest compiled with PETSC_USE_REAL_DOUBLE and static_assert(sizeof(PetscReal) == sizeof(double))",
    "ctest_attestation": str(junit_path),
}
resolved = {
    "backend": "fem",
    "device": "cpu",
    "precision": precision["value"],
    "slepc": bool(deps["modal_eigen_native_cpu_slepc_available"]),
    "fallback_used": False,
}
output = {
    "schema": "fullmag.fem.slepc_modal.resolution_attestation.v1",
    "status": "pass",
    "resolved": resolved,
    "precision": precision,
    "fallback_basis": {
        "fem_gpu_disabled_by_cmake": True,
        "runtime_cpu_available": True,
        "slepc_dependency_attested": True,
    },
}
output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

status=pass
