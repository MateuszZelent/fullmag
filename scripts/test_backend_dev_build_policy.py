"""Exercise build policy without compiling Rust or CUDA unit tests."""
from pathlib import Path
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
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


def test_docker_backend_build_selects_backend_dev_profile_and_separate_target_tree():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    start = makefile.index("install-cli install-cli-dev install-cli-static:\n")
    end = makefile.index("\nshow-cli-path:", start)
    recipe = makefile[start:end]
    backend = (ROOT / "docker/all-in-one/backend_dev.py").read_text(encoding="utf-8")
    assert 'BACKEND_CARGO_PROFILE = "backend-dev"' in backend
    assert 'SUPPORTED_CARGO_PROFILES = frozenset({"backend-dev", "release"})' in backend
    assert '"FULLMAG_BACKEND_CARGO_PROFILE": cargo_profile' in backend
    assert 'make_target = "install-cli-dev" if cargo_profile == "backend-dev" else "install-cli"' in backend
    assert 'cargo_profile = _validate_cargo_profile(cargo_profile)' in backend
    assert '"cargo_profile": cargo_profile' in backend
    assert '"cargo_target_profile_dir": cargo_profile' in backend
    assert 'backend-dev) cargo_profile_args="--profile backend-dev"' in recipe
    assert 'cargo_target_profile_dir="$$cargo_target_dir/$$cargo_profile_dir"' in recipe
    assert '"$$cargo_target_profile_dir/fullmag-api"' in recipe
    assert '"$$cargo_target_dir/release/' not in recipe
    assert '"$$cargo_target_profile_dir/build"' in recipe
    assert 'if [ "$$cargo_profile_dir" = "backend-dev" ]; then' in recipe
    assert 'backend-dev FEM source snapshot is required' in recipe
    assert 'select_managed_fem_library.py --cargo-target \"$$cargo_target_dir\" --snapshot \"$$fem_snapshot\" --profile \"$$cargo_profile_dir\"' in recipe
    assert 'backend-dev FEM native root is required' not in recipe
    compose = (ROOT / "compose.dev.yaml").read_text(encoding="utf-8")
    assert 'FULLMAG_BACKEND_CARGO_PROFILE: ${FULLMAG_BACKEND_CARGO_PROFILE:-backend-dev}' in compose


def test_direct_compose_keeps_native_fem_release_for_backend_dev():
    build_script = (ROOT / "crates/fullmag-fem-sys/build.rs").read_text(encoding="utf-8")
    assert "fn native_cmake_build_type(cargo_profile: &str, direct_compose: bool) -> &'static str" in build_script
    assert 'if direct_compose || cargo_profile == "release" {' in build_script
    assert (
        'let direct_compose = explicit_env_flag("FULLMAG_DIRECT_COMPOSE").unwrap_or(false);'
        in build_script
    )
    assert (
        'let cmake_build_type = native_cmake_build_type(&cargo_profile, direct_compose);'
        in build_script
    )
    assert '"FULLMAG_DIRECT_COMPOSE": "1"' in (
        ROOT / "docker/all-in-one/backend_dev.py"
    ).read_text(encoding="utf-8")


@pytest.mark.skipif(
    os.name == "nt" or shutil.which("bash") is None,
    reason="The extracted Makefile recipe is a Linux-container regression",
)
def test_install_cli_dev_pins_fdm_package_to_explicit_native_root():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    start = makefile.index('\tif [ -n "$${FULLMAG_FDM_NATIVE_BUILD_ROOT:-}" ]; then')
    end = makefile.index('\tif [ "$$build_mode"', start)
    # Execute the recipe fragment itself after undoing Make's dollar escaping.
    recipe = makefile[start:end].replace("$$", "$")

    def run_fragment(case_root, configured_root=None, create_destination=True):
        (case_root / ".fullmag/local").mkdir(parents=True, exist_ok=True)
        if create_destination:
            (case_root / ".fullmag/local/lib").mkdir()
        environment = os.environ.copy()
        environment.pop("FULLMAG_FDM_NATIVE_BUILD_ROOT", None)
        if configured_root is not None:
            environment["FULLMAG_FDM_NATIVE_BUILD_ROOT"] = str(configured_root)
        script = "\n".join(
            (
                "set -eu",
                f"cargo_target_dir={shlex.quote(str(case_root / 'cargo-target'))}",
                "cargo_profile_dir=release",
                "cargo_target_profile_dir=\"$cargo_target_dir/$cargo_profile_dir\"",
                recipe,
            )
        )
        return subprocess.run(
            ["bash", "-c", script],
            cwd=case_root,
            env=environment,
            capture_output=True,
            text=True,
        )

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        selected_case = root / "selected"
        selected = selected_case / "native/backends/fdm/libfullmag_fdm.so.1"
        selected.parent.mkdir(parents=True)
        selected.write_text("selected", encoding="utf-8")
        foreign = selected_case / "cargo-target/release/build/fullmag-fdm-sys-new/out/native-build/backends/fdm/libfullmag_fdm.so.9"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("foreign", encoding="utf-8")

        result = run_fragment(selected_case, selected_case / "native")
        assert result.returncode == 0, result.stderr
        assert (selected_case / ".fullmag/local/lib/libfullmag_fdm.so.1").read_text(encoding="utf-8") == "selected"

        missing_case = root / "missing"
        missing_result = run_fragment(missing_case, missing_case / "does-not-exist")
        assert missing_result.returncode == 2
        assert "no regular libfullmag_fdm.so*" in missing_result.stderr

        relative_case = root / "relative"
        relative_result = run_fragment(relative_case, Path("relative-root"))
        assert relative_result.returncode == 2
        assert "must be absolute" in relative_result.stderr

        copy_failure_case = root / "copy-failure"
        copy_failure_selected = copy_failure_case / "native/backends/fdm/libfullmag_fdm.so.1"
        copy_failure_selected.parent.mkdir(parents=True)
        copy_failure_selected.write_text("selected", encoding="utf-8")
        (copy_failure_case / ".fullmag/local").mkdir(parents=True)
        (copy_failure_case / ".fullmag/local/lib").write_text("destination-is-not-a-directory", encoding="utf-8")
        copy_failure = run_fragment(
            copy_failure_case,
            copy_failure_case / "native",
            create_destination=False,
        )
        assert copy_failure.returncode == 2
        assert "Failed to copy FDM library" in copy_failure.stderr


@pytest.mark.skipif(
    os.name == "nt" or shutil.which("bash") is None,
    reason="The extracted Makefile recipe is a Linux-container regression",
)
def test_native_library_fallback_stays_within_selected_profile():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    start = makefile.index('\tif [ -n "$${FULLMAG_FDM_NATIVE_BUILD_ROOT:-}" ]; then')
    end = makefile.index("\tprintf '%s\\n' \"$$build_mode\"", start)
    recipe = makefile[start:end].replace("$$", "$")

    def run_fragment(case_root):
        (case_root / ".fullmag/local/lib").mkdir(parents=True, exist_ok=True)
        environment = os.environ.copy()
        environment.pop("FULLMAG_FDM_NATIVE_BUILD_ROOT", None)
        environment.pop("FULLMAG_SOURCE_SNAPSHOT_SHA256", None)
        script = "\n".join(
            (
                "set -eu",
                f"cargo_target_dir={shlex.quote(str(case_root / 'cargo-target'))}",
                "cargo_profile_dir=release",
                "cargo_target_profile_dir=\"$cargo_target_dir/$cargo_profile_dir\"",
                "build_mode=cuda-fem-gpu",
                recipe,
            )
        )
        return subprocess.run(
            ["bash", "-c", script],
            cwd=case_root,
            env=environment,
            capture_output=True,
            text=True,
        )

    with tempfile.TemporaryDirectory() as directory:
        case_root = Path(directory) / "foreign-only"
        for family in ("fdm", "fem"):
            foreign = (
                case_root
                / "cargo-target/backend-dev/build"
                / f"fullmag-{family}-sys-foreign/out/native-build/backends/{family}"
                / f"libfullmag_{family}.so.9"
            )
            foreign.parent.mkdir(parents=True, exist_ok=True)
            foreign.write_text("foreign", encoding="utf-8")

        result = run_fragment(case_root)
        assert result.returncode == 0, result.stderr
        assert not list((case_root / ".fullmag/local/lib").glob("libfullmag_*.so*"))


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



@pytest.mark.skipif(
    os.name == "nt" or shutil.which("cmake") is None or shutil.which("make") is None,
    reason="Unix CMake generator required for configure-only source contract",
)
def test_direct_compose_fem_snapshot_header_isolated_from_shared_flags(tmp_path):
    cmake_source = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    function_start = cmake_source.index(
        "function(fullmag_configure_runtime_source_snapshot target)"
    )
    function_end = cmake_source.index("endfunction()", function_start) + len("endfunction()")
    production_function = cmake_source[function_start:function_end]
    template = (ROOT / "backends/fem/cpu/mfem/runtime/runtime_build_info_snapshot.hpp.in").read_text(
        encoding="utf-8"
    )
    runtime = tmp_path / "cpu/mfem/runtime"
    runtime.mkdir(parents=True)
    (runtime / "runtime_build_info.cpp").write_text(
        "int runtime_build_info_fixture() { return 0; }\n", encoding="utf-8"
    )
    (runtime / "runtime_build_info_snapshot.hpp.in").write_text(template, encoding="utf-8")
    (runtime.parent / "other.cpp").write_text(
        "int unrelated_fixture() { return 0; }\n", encoding="utf-8"
    )
    (tmp_path / "CMakeLists.txt").write_text(
        "\n".join(
            (
                "cmake_minimum_required(VERSION 3.20)",
                "project(FullmagFemRuntimeSnapshotScope LANGUAGES CXX)",
                'set(FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 "" CACHE STRING "")',
                'set(FULLMAG_DIRECT_COMPOSE "1" CACHE STRING "")',
                "add_library(fullmag_fem SHARED cpu/mfem/runtime/runtime_build_info.cpp cpu/mfem/other.cpp)",
                production_function,
                "fullmag_configure_runtime_source_snapshot(fullmag_fem)",
                "",
            )
        ),
        encoding="utf-8",
    )

    cmake = shutil.which("cmake")
    build = tmp_path / "build"
    digest_a = "a" * 64
    digest_b = "b" * 64

    def configure(digest, direct="1", build_dir=build):
        result = subprocess.run(
            [
                cmake,
                "-G",
                "Unix Makefiles",
                "-S",
                str(tmp_path),
                "-B",
                str(build_dir),
                "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
                f"-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256={digest}",
                f"-DFULLMAG_DIRECT_COMPOSE={direct}",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr

    configure(digest_a)
    header = build / "generated/fullmag_fem_runtime_source_snapshot.hpp"
    flags = build / "CMakeFiles/fullmag_fem.dir/flags.make"
    assert digest_a in header.read_text(encoding="utf-8")
    header_a_mtime = header.stat().st_mtime_ns
    flags_a = flags.read_bytes()
    flags_a_mtime = flags.stat().st_mtime_ns
    assert digest_a.encode() not in flags_a
    commands = json.loads((build / "compile_commands.json").read_text(encoding="utf-8"))
    runtime_command = next(item["command"] for item in commands if item["file"].endswith("runtime_build_info.cpp"))
    other_command = next(item["command"] for item in commands if item["file"].endswith("other.cpp"))
    generated_include = str(build / "generated")
    assert generated_include in runtime_command
    assert generated_include not in other_command

    configure(digest_a)
    assert header.read_text(encoding="utf-8")
    assert header.stat().st_mtime_ns == header_a_mtime
    assert flags.read_bytes() == flags_a
    assert flags.stat().st_mtime_ns == flags_a_mtime

    configure(digest_b)
    assert digest_b in header.read_text(encoding="utf-8")
    assert digest_a not in header.read_text(encoding="utf-8")
    assert flags.read_bytes() == flags_a
    assert flags.stat().st_mtime_ns == flags_a_mtime

    legacy_build = tmp_path / "legacy-build"
    configure(digest_b, direct="0", build_dir=legacy_build)
    legacy_flags = (legacy_build / "CMakeFiles/fullmag_fem.dir/flags.make").read_text(
        encoding="utf-8"
    )
    assert "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256" in legacy_flags
    assert digest_b in legacy_flags


@pytest.mark.skipif(os.name == "nt" or shutil.which("bash") is None,
                    reason="The extracted Makefile helper is a Linux-container regression")
def test_install_cli_selects_one_package_qualified_cli_api_feature_graph(tmp_path):
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    recipe_start = makefile.index("install-cli install-cli-dev install-cli-static:\n")
    recipe_end = makefile.index("\nshow-cli-path:", recipe_start)
    recipe = makefile[recipe_start:recipe_end]
    helper_start = recipe.index("\tcargo_cli_api_build() { \\\n")
    helper_end = recipe.index("\n\tbuild_mode=\"cpu\";", helper_start)
    helper = recipe[helper_start:helper_end].replace("$$", "$")
    recipe_without_helper = recipe[:helper_start] + recipe[helper_end:]
    assert not re.search(
        r"cargo \+nightly build --locked -p fullmag-(?:cli|api)\b",
        recipe_without_helper,
    )

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_cargo = fake_bin / "cargo"
    fake_cargo.write_text(
        "#!/bin/sh\n"
        "printf '%s\\0' \"$@\" > \"$FULLMAG_CAPTURE\"\n"
        "printf '%s\\0' \"${CARGO_TARGET_DIR-}\" \"${CARGO_INCREMENTAL-}\" "
        "\"${FULLMAG_USE_MFEM_STACK-}\" \"${FULLMAG_FEM_REQUIRE_GPU-}\" "
        "\"${FULLMAG_FEM_REQUIRE_CEED-}\" \"${FULLMAG_CMAKE-}\" "
        "\"${CUDACXX-}\" > \"$FULLMAG_ENV_CAPTURE\"\n",
        encoding="utf-8",
    )
    fake_cargo.chmod(0o755)

    base_environment = os.environ.copy()
    base_environment["PATH"] = str(fake_bin) + os.pathsep + base_environment["PATH"]
    for name in (
        "FULLMAG_USE_MFEM_STACK", "FULLMAG_FEM_REQUIRE_GPU", "FULLMAG_FEM_REQUIRE_CEED",
        "FULLMAG_CMAKE", "CUDACXX",
    ):
        base_environment.pop(name, None)

    def invoke(feature_set, assignments=()):
        capture = tmp_path / "cargo-args"
        env_capture = tmp_path / "cargo-env"
        environment = dict(base_environment)
        environment["FULLMAG_CAPTURE"] = str(capture)
        environment["FULLMAG_ENV_CAPTURE"] = str(env_capture)
        assignment_args = " ".join(shlex.quote(item) for item in assignments)
        script = "\n".join((
            "set -eu",
            f"cargo_target_dir={shlex.quote(str(tmp_path / 'cargo-target'))}",
            "build_incremental=1",
            "cargo_profile_args='--profile backend-dev'",
            helper,
            f"cargo_cli_api_build {shlex.quote(feature_set)} {assignment_args}",
        ))
        result = subprocess.run(
            ["bash", "-c", script],
            cwd=tmp_path,
            env=environment,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        argv = capture.read_bytes().split(b"\0")[:-1]
        observed_env = env_capture.read_bytes().split(b"\0")[:-1]
        return [item.decode() for item in argv], [item.decode() for item in observed_env]

    expected_prefix = [
        "+nightly", "build", "--locked", "-p", "fullmag-cli", "-p", "fullmag-api",
        "--profile", "backend-dev", "--no-default-features",
    ]
    cases = (
        ("", (), expected_prefix),
        (
            "fullmag-cli/fem-gpu fullmag-api/fem-gpu",
            ("FULLMAG_USE_MFEM_STACK=ON", "FULLMAG_FEM_REQUIRE_GPU=0", "FULLMAG_FEM_REQUIRE_CEED=0"),
            expected_prefix + ["--features", "fullmag-cli/fem-gpu fullmag-api/fem-gpu"],
        ),
        (
            "fullmag-cli/cuda fullmag-cli/fem-gpu fullmag-api/cuda fullmag-api/fem-gpu",
            ("FULLMAG_USE_MFEM_STACK=ON", "FULLMAG_FEM_REQUIRE_GPU=1", "FULLMAG_FEM_REQUIRE_CEED=1",
             "FULLMAG_CMAKE=/opt/cmake", "CUDACXX=/opt/nvcc"),
            expected_prefix + ["--features", "fullmag-cli/cuda fullmag-cli/fem-gpu fullmag-api/cuda fullmag-api/fem-gpu"],
        ),
        (
            "fullmag-cli/cuda fullmag-api/cuda",
            ("FULLMAG_CMAKE=/opt/cmake", "CUDACXX=/opt/nvcc"),
            expected_prefix + ["--features", "fullmag-cli/cuda fullmag-api/cuda"],
        ),
    )
    for feature_set, assignments, expected in cases:
        argv, observed_env = invoke(feature_set, assignments)
        assert argv == expected
        assert observed_env[:2] == [str(tmp_path / "cargo-target"), "1"]
        assert all(
            item == "" or item.startswith(("fullmag-cli/", "fullmag-api/"))
            for item in feature_set.split()
        )
    assert "--all-features" not in recipe
    assert recipe.count("-p fullmag-cli -p fullmag-api") == 2
