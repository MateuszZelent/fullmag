"""Exercise build policy without compiling Rust or CUDA unit tests."""
from pathlib import Path
import re
import shutil
import subprocess
import tomllib

import pytest

ROOT = Path(__file__).resolve().parents[1]
MACRO = "FULLMAG_FDM_GPU_TRANSPORT_BUILD_DIGEST_HEX"


def test_backend_dev_keeps_incremental_compilation_and_optimized_cpu_kernels():
    workspace = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    profile = workspace["profile"]["backend-dev"]
    assert profile["inherits"] == "dev"
    assert profile["incremental"] is True
    assert profile["lto"] == "off"
    assert profile["opt-level"] == 1
    assert profile["package"]["fullmag-engine"]["opt-level"] == 3
    assert profile["package"]["fullmag-fdm-demag"]["opt-level"] == 3


@pytest.mark.skipif(not shutil.which("cmake"), reason="CMake required")
def test_cuda_source_digest_changes_only_its_consumer_compile_definition(tmp_path):
    source = (ROOT / "backends/fdm/CMakeLists.txt").read_text(encoding="utf-8")
    commands = re.findall(
        r"(?:target_compile_definitions\(fullmag_fdm PRIVATE|"
        r"set_property\(SOURCE gpu/cuda/transport/context\.cu)"
        r"[^)]*FULLMAG_FDM_GPU_TRANSPORT_BUILD_DIGEST_HEX[^)]*\)",
        source,
    )
    assert len(commands) == 1, "Expected one owning build-digest definition"
    script = tmp_path / "CMakeLists.txt"
    # A language-free configure inspects source properties without detecting
    # a compiler, CUDA toolkit, compiling, or linking any executable.
    script.write_text('''
cmake_minimum_required(VERSION 3.20)
project(FullmagBuildIdentityScope LANGUAGES NONE)
function(target_compile_definitions target)
  set_property(GLOBAL PROPERTY old_target_definitions "${ARGN}")
endfunction()
set(FDM_GPU_TRANSPORT_BUILD_DIGEST "''' + "a" * 64 + '''")
''' + commands[0] + '''
get_source_file_property(context_defs gpu/cuda/transport/context.cu COMPILE_DEFINITIONS)
get_source_file_property(exchange_defs gpu/cuda/interactions/exchange_fp64.cu COMPILE_DEFINITIONS)
get_property(target_defs GLOBAL PROPERTY old_target_definitions)
if(NOT context_defs MATCHES "''' + MACRO + '''=.*aaaaaaaa")
  message(FATAL_ERROR "Digest must be available to its context.cu consumer")
endif()
if(exchange_defs MATCHES "''' + MACRO + '''" OR target_defs MATCHES "''' + MACRO + '''")
  message(FATAL_ERROR "Digest must not invalidate unrelated translation units")
endif()
set(FDM_GPU_TRANSPORT_BUILD_DIGEST "''' + "b" * 64 + '''")
''' + commands[0] + '''
get_source_file_property(changed_defs gpu/cuda/transport/context.cu COMPILE_DEFINITIONS)
if(NOT changed_defs MATCHES "''' + MACRO + '''=.*bbbbbbbb")
  message(FATAL_ERROR "Changed source identity was not published to its consumer")
endif()
''', encoding="utf-8")
    result = subprocess.run(["cmake", "-S", str(tmp_path), "-B", str(tmp_path / "build")],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    # Adding another consumer requires updating the production owner and this
    # scope gate, rather than silently restoring a target-wide compiler flag.
    consumers = [p for p in (ROOT / "backends/fdm").rglob("*")
                 if p.suffix in (".cu", ".cpp", ".hpp", ".h")
                 and MACRO in p.read_text(encoding="utf-8")]
    assert consumers == [ROOT / "backends/fdm/gpu/cuda/transport/context.cu"]
