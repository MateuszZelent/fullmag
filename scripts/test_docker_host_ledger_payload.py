#!/usr/bin/env python3
"""Focused regression for host-ledger owner-marker publication bytes."""
from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path


HELPER = Path(__file__).with_name("lib") / "docker_host_ledger.sh"


def _inline_python_snippets() -> list[str]:
    source = HELPER.read_text(encoding="utf-8")
    marker = "python3 -c '"
    snippets = re.findall(r"python3 -c '([^']*)'", source, flags=re.DOTALL)
    if len(snippets) != source.count(marker):
        raise AssertionError("could not extract every inline python3 -c snippet")
    if len(snippets) < 7:
        raise AssertionError(f"unexpectedly few inline python snippets: {len(snippets)}")
    return snippets


def _assert_inline_python_parses() -> None:
    for index, snippet in enumerate(_inline_python_snippets(), start=1):
        try:
            ast.parse(snippet, filename=f"docker_host_ledger.sh:inline-python-{index}")
        except SyntaxError as error:
            raise AssertionError(f"inline Python snippet {index} does not parse: {error}") from error


def _shell_function(source: str, name: str, next_name: str) -> str:
    start = source.index(f"{name}() {{")
    end = source.index(f"\n{next_name}() {{", start)
    return source[start:end]


def _shell_function_to_end(source: str, name: str) -> str:
    start = source.index(f"{name}() {{")
    end = source.index('\n}\nmain "$@"', start) + 2
    return source[start:end]


def _run_mount_receipt_probe() -> None:
    source = HELPER.read_text(encoding="utf-8")
    read_mount_state = _shell_function(source, "read_mount_state", "verify_image_file")
    emit_receipt = _shell_function(source, "emit_receipt", "cleanup")
    probe = textwrap.dedent(
        f"""
        set -Eeuo pipefail
        host() {{
            [[ "$1" == "findmnt" ]] || {{ echo "unexpected host command: $*" >&2; return 99; }}
            printf '%s\\n' '/dev/loop5 ext4 11111111-1111-1111-1111-111111111111'
        }}
        MOUNT_ROOT='/mnt/fullmag-host-ledger-fullmag-test'
        MOUNT_ACTIVE=0
        MOUNT_SOURCE=''
        LOOP_DEVICE=''
        FILESYSTEM_UUID=''
        MOUNT_TARGET='/host-ledger'
        IMAGE_SIZE_BYTES=134217728
        PROFILE='host-ledger-v1'
        PROJECT_ID='fullmag-test'
        BACKING_IMAGE='/storage/build-volumes/fullmag-host-ledger-v1.ext4'
        {read_mount_state}
        {emit_receipt}
        read_mount_state
        emit_receipt validated 0
        """
    )
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "host-ledger-loop-receipt-probe.sh"
        script.write_text(probe, encoding="utf-8")
        result = subprocess.run(
            ["bash", str(script)], check=True, text=True, capture_output=True
        )
    receipt = json.loads(result.stdout)
    if receipt.get("loop_device") != "/dev/loop5":
        raise AssertionError(f"receipt lost the full loop device path: {receipt!r}")
    if receipt.get("mount_active") is not True or receipt.get("state") != "validated":
        raise AssertionError(f"mount-state probe did not produce a validated receipt: {receipt!r}")


def _run_recovery_probe(root: Path, expected_success: bool) -> None:
    source = HELPER.read_text(encoding="utf-8")
    inspect_recovery_mount_root = _shell_function(
        source, "inspect_recovery_mount_root", "admit_existing_mount"
    )
    probe = textwrap.dedent(
        f"""
        set -Eeuo pipefail
        fail() {{ echo "$*" >&2; exit 2; }}
        host() {{ "$@"; }}
        MOUNT_ROOT="$1"
        LEDGER_CHILD_NAME='ledger'
        LEDGER_ROOT="$MOUNT_ROOT/ledger"
        {inspect_recovery_mount_root}
        inspect_recovery_mount_root
        """
    )
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "host-ledger-recovery-probe.sh"
        script.write_text(probe, encoding="utf-8")
        result = subprocess.run(
            ["bash", str(script), str(root)], text=True, capture_output=True
        )
    actual_success = result.returncode == 0
    if actual_success != expected_success:
        raise AssertionError(
            f"recovery probe result mismatch for {root!r}: "
            f"expected success={expected_success}, returncode={result.returncode}, "
            f"stderr={result.stderr!r}"
        )


def _assert_recovery_mount_guards() -> None:
    with tempfile.TemporaryDirectory() as directory:
        parent = Path(directory)

        empty = parent / "empty"
        (empty / "lost+found").mkdir(parents=True)
        (empty / "ledger").mkdir()
        _run_recovery_probe(empty, True)

        unexpected = parent / "unexpected"
        (unexpected / "lost+found").mkdir(parents=True)
        (unexpected / "ledger").mkdir()
        (unexpected / "extra").touch()
        _run_recovery_probe(unexpected, False)

        newline_name = parent / "newline"
        (newline_name / "lost+found").mkdir(parents=True)
        (newline_name / "ledger").mkdir()
        (newline_name / "unexpected\nentry").touch()
        _run_recovery_probe(newline_name, False)

        real_root = parent / "real-root"
        (real_root / "lost+found").mkdir(parents=True)
        (real_root / "ledger").mkdir()
        root_symlink = parent / "root-symlink"
        root_symlink.symlink_to(real_root, target_is_directory=True)
        _run_recovery_probe(root_symlink, False)

        nonempty_child = parent / "nonempty-child"
        (nonempty_child / "lost+found").mkdir(parents=True)
        (nonempty_child / "ledger").mkdir()
        (nonempty_child / "ledger" / "data\nentry").touch()
        _run_recovery_probe(nonempty_child, False)


def _owner_marker_writer() -> str:
    source = HELPER.read_text(encoding="utf-8")
    function_start = source.index("write_owner_marker() {")
    command_prefix = "  python3 -c 'import os, sys\n"
    command_start = source.index(command_prefix, function_start) + len("  python3 -c '")
    command_end = source.index("\n' \"$(host_root_path", command_start)
    command = source[command_start:command_end]
    return command


def _run_writer(command: str, marker: Path, temporary: Path, payload: str) -> None:
    # The maintenance image runs as root.  The local regression remains
    # executable as an ordinary user by making only chown a no-op when needed;
    # publication and byte-level checks still execute the embedded code.
    wrapper = (
        "import os\n"
        "if not hasattr(os, 'O_NOFOLLOW'): os.O_NOFOLLOW = 0\n"
        "if getattr(os, 'geteuid', lambda: 1)() != 0: os.chown = lambda *_args: None\n"
        f"exec(compile({command!r}, '<host-ledger-owner-marker>', 'exec'))\n"
    )
    subprocess.run(
        [sys.executable, "-c", wrapper, str(marker), str(temporary), payload],
        check=True,
    )


def _owner_payload(
    *,
    project_id: str = "fullmag-test",
    backing_image: str = "/storage/build-volumes/fullmag-host-ledger-v1.ext4",
    mount_root: str = "/mnt/fullmag-host-ledger-fullmag-test",
    filesystem_uuid: str = "11111111-1111-1111-1111-111111111111",
    owner_token: str = "22222222-2222-2222-2222-222222222222",
) -> bytes:
    return (
        json.dumps(
            {
                "schema": "fullmag.host-ledger-owner.v1",
                "profile": "host-ledger-v1",
                "project_id": project_id,
                "backing_image": backing_image,
                "mount_root": mount_root,
                "filesystem_uuid": filesystem_uuid,
                "image_size_bytes": 134217728,
                "mount_target": "/host-ledger",
                "runtime_uid": 65532,
                "runtime_gid": 65532,
                "owner_token": owner_token,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )


def _write_python_shim(directory: Path) -> Path:
    """Keep the interpreted probe runnable without uid 0 on the host."""
    shim = directory / "python3"
    shim.write_text(
        textwrap.dedent(
            f"""\
            #!{sys.executable}
            import os
            import sys

            real_python = {sys.executable!r}
            arguments = sys.argv[1:]
            if os.geteuid() != 0 and len(arguments) >= 2 and arguments[0] == "-c":
                code = arguments[1]
                if "owner marker ownership or mode mismatch" in code:
                    code = code.replace(
                        "if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or stat.S_IMODE(st.st_mode) != 0o444:",
                        "if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o444:",
                    )
                    arguments[1] = code
                elif "owner marker already exists" in code:
                    arguments[1] = "import os\\nos.chown = lambda *_args: None\\n" + code
            os.execv(real_python, [real_python, *arguments])
            """
        ),
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return shim


def _run_ensure_probe(root: Path, python_shim: Path) -> subprocess.CompletedProcess[str]:
    """Run the real ensure/admission functions against a mocked host namespace."""
    source = HELPER.read_text(encoding="utf-8")
    functions = [
        _shell_function(source, "read_mount_state", "verify_image_file"),
        _shell_function(source, "verify_image_file", "verify_loop_identity"),
        _shell_function(source, "verify_loop_identity", "verify_owner_marker"),
        _shell_function(source, "verify_owner_marker", "verify_runtime_directory"),
        _shell_function(source, "verify_runtime_directory", "inspect_unmounted_mount_root"),
        _shell_function(source, "inspect_unmounted_mount_root", "inspect_recovery_mount_root"),
        _shell_function(source, "inspect_recovery_mount_root", "admit_existing_mount"),
        _shell_function(source, "admit_existing_mount", "acquire_lock"),
        _shell_function(source, "reject_associated_loop", "allocate_and_mount"),
        _shell_function(source, "allocate_and_mount", "write_owner_marker"),
        _shell_function(source, "write_owner_marker", "set_runtime_ownership"),
        _shell_function(source, "set_runtime_ownership", "verify_current_mount"),
        _shell_function(source, "verify_current_mount", "emit_receipt"),
        _shell_function_to_end(source, "main"),
    ]
    probe = textwrap.dedent(
        """
        set -Eeuo pipefail
        fail() { echo "$*" >&2; exit 2; }
        PROFILE='host-ledger-v1'
        PROJECT_ID='fullmag-test'
        BACKING_IMAGE="$2/backing.ext4"
        MOUNT_ROOT="$2/mount"
        OWNER_MARKER="$MOUNT_ROOT/.fullmag-host-ledger-owner.json"
        LEDGER_ROOT="$MOUNT_ROOT/ledger"
        LEDGER_CHILD_NAME='ledger'
        IMAGE_LABEL='fullmag-host-v1'
        IMAGE_SIZE_BYTES=134217728
        MOUNT_TARGET='/host-ledger'
        RUNTIME_UID=65532
        RUNTIME_GID=65532
        MOUNT_ACTIVE=0
        MOUNT_SOURCE=''
        LOOP_DEVICE=''
        FILESYSTEM_UUID=''
        CREATED_IMAGE=0
        ALLOCATED_LOOP=0
        MOUNTED_BY_HELPER=0
        OWNER_MARKER_WRITTEN=0
        SUCCESS=0
        MOCK_MOUNT_ACTIVE=0

        host_root_path() { printf '%s\\n' "$1"; }
        host() {
            local operation="${1:-}"
            shift || true
            case "${operation}" in
                findmnt)
                    if [[ "${MOCK_MOUNT_ACTIVE}" == "1" ]]; then
                        printf '/dev/loop7 ext4 %s\\n' "${EXPECTED_UUID}"
                        return 0
                    fi
                    return 1
                    ;;
                losetup)
                    case "${1:-}" in
                        --associated) return 1 ;;
                        --find) printf '/dev/loop7\\n'; return 0 ;;
                        *) return 99 ;;
                    esac
                    ;;
                mount)
                    MOCK_MOUNT_ACTIVE=1
                    return 0
                    ;;
                test)
                    local last="${!#}"
                    if [[ "${last}" == "/sys/block/loop7/loop/backing_file" && "${1:-}" == "-f" ]]; then
                        return 0
                    fi
                    if [[ "${last}" == "${OWNER_MARKER}" && "${MOCK_MOUNT_ACTIVE}" == "0" ]]; then
                        case "${1:-}" in
                            -e|-f|-L) return 1 ;;
                            '!') [[ "${2:-}" == '-L' ]] && return 0 ;;
                        esac
                    fi
                    command test "$@"
                    ;;
                stat)
                    if [[ "${1:-}" == '-Lc' && "${2:-}" == '%u %g %a' ]]; then
                        case "${3:-}" in
                            "${MOUNT_ROOT}") printf '0 0 755\\n'; return 0 ;;
                            "${LEDGER_ROOT}") printf '65532 65532 770\\n'; return 0 ;;
                        esac
                    fi
                    command stat "$@"
                    ;;
                cat)
                    if [[ "${1:-}" == '/sys/block/loop7/loop/backing_file' ]]; then
                        printf '%s\\n' "${BACKING_IMAGE}"
                        return 0
                    fi
                    command cat "$@"
                    ;;
                blkid)
                    if [[ "${1:-}" == '-s' && "${2:-}" == 'UUID' ]]; then
                        printf '%s\\n' "${EXPECTED_UUID}"
                        return 0
                    fi
                    if [[ "${1:-}" == '-s' && "${2:-}" == 'LABEL' ]]; then
                        printf '%s\\n' "${IMAGE_LABEL}"
                        return 0
                    fi
                    return 99
                    ;;
                find)
                    if [[ "${1:-}" == "${MOUNT_ROOT}" && "${MOCK_MOUNT_ACTIVE}" == "0" ]]; then
                        [[ -d "${MOUNT_ROOT}/lost+found" ]] && printf 'lost+found\\n'
                        return 0
                    fi
                    command find "$@"
                    ;;
                chown|chmod) return 0 ;;
                mkdir|truncate|rm|umount) command "${operation}" "$@" ;;
                *) echo "unexpected mocked host command: ${operation} $*" >&2; return 99 ;;
            esac
        }

        validate_inputs() { :; }
        validate_storage_marker() { :; }
        acquire_lock() { :; }
        create_backing_image_if_needed() { verify_image_file; }
        emit_receipt() { printf 'ready\\n'; }
        EXPECTED_UUID='11111111-1111-1111-1111-111111111111'
        """
    )
    probe += "\n".join(functions)
    probe += textwrap.dedent(
        """

        PATH="__PYTHON_SHIM_DIR__:${PATH}"
        main ensure
        """
    ).replace("__PYTHON_SHIM_DIR__", str(python_shim.parent))
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "host-ledger-ensure-probe.sh"
        script.write_text(probe, encoding="utf-8")
        return subprocess.run(
            ["bash", str(script), "ensure", str(root)],
            text=True,
            capture_output=True,
        )


def _create_sparse_backing(path: Path) -> None:
    path.touch()
    with path.open("r+b") as stream:
        stream.truncate(134217728)


def _assert_persistent_mount_admission() -> None:
    """Exercise main ensure's remount and fresh-admission branches."""
    with tempfile.TemporaryDirectory() as directory:
        parent = Path(directory)
        shim = _write_python_shim(parent)

        valid_root = parent / "valid"
        valid_mount = valid_root / "mount"
        (valid_mount / "lost+found").mkdir(parents=True)
        (valid_mount / "ledger").mkdir()
        (valid_mount / "ledger" / "persistent-data.bin").write_bytes(b"retained ledger data")
        valid_backing = valid_root / "backing.ext4"
        valid_backing.parent.mkdir(exist_ok=True)
        _create_sparse_backing(valid_backing)
        valid_marker = valid_mount / ".fullmag-host-ledger-owner.json"
        valid_bytes = _owner_payload(
            backing_image=str(valid_backing),
            mount_root=str(valid_mount),
        )
        valid_marker.write_bytes(valid_bytes)
        valid_marker.chmod(0o444)
        retained_data = (valid_mount / "ledger" / "persistent-data.bin").read_bytes()
        result = _run_ensure_probe(valid_root, shim)
        if result.returncode != 0:
            raise AssertionError(
                "valid persisted marker was not admitted: "
                f"returncode={result.returncode}, stderr={result.stderr!r}"
            )
        if valid_marker.read_bytes() != valid_bytes:
            raise AssertionError("valid persisted owner marker was rewritten")
        if (valid_mount / "ledger" / "persistent-data.bin").read_bytes() != retained_data:
            raise AssertionError("persisted ledger data changed during remount admission")

        for name, marker_bytes in (
            ("corrupt", b"not-json\\n"),
            (
                "foreign",
                _owner_payload(
                    project_id="foreign-project",
                    backing_image=str(valid_backing),
                    mount_root=str(valid_mount),
                ),
            ),
        ):
            case_root = parent / name
            case_mount = case_root / "mount"
            (case_mount / "lost+found").mkdir(parents=True)
            (case_mount / "ledger").mkdir()
            case_backing = case_root / "backing.ext4"
            case_backing.parent.mkdir(exist_ok=True)
            _create_sparse_backing(case_backing)
            case_marker = case_mount / ".fullmag-host-ledger-owner.json"
            if name == "foreign":
                marker_bytes = _owner_payload(
                    project_id="foreign-project",
                    backing_image=str(case_backing),
                    mount_root=str(case_mount),
                )
            case_marker.write_bytes(marker_bytes)
            case_marker.chmod(0o444)
            result = _run_ensure_probe(case_root, shim)
            if result.returncode == 0:
                raise AssertionError(f"{name} owner marker unexpectedly admitted")
            if case_marker.read_bytes() != marker_bytes:
                raise AssertionError(f"{name} owner marker was overwritten on failure")

        fresh_root = parent / "fresh"
        fresh_mount = fresh_root / "mount"
        (fresh_mount / "lost+found").mkdir(parents=True)
        (fresh_mount / "ledger").mkdir()
        fresh_backing = fresh_root / "backing.ext4"
        fresh_backing.parent.mkdir(exist_ok=True)
        _create_sparse_backing(fresh_backing)
        result = _run_ensure_probe(fresh_root, shim)
        if result.returncode != 0:
            raise AssertionError(
                "fresh mount with ext4 guard directories was not initialized: "
                f"returncode={result.returncode}, stderr={result.stderr!r}"
            )
        fresh_marker = fresh_mount / ".fullmag-host-ledger-owner.json"
        fresh_value = json.loads(fresh_marker.read_text(encoding="utf-8"))
        if fresh_value["schema"] != "fullmag.host-ledger-owner.v1":
            raise AssertionError("fresh mount did not receive the owner marker")
        if fresh_value["owner_token"] == "0" * 36:
            raise AssertionError("fresh mount received an empty owner token")


def main() -> int:
    _assert_inline_python_parses()
    _run_mount_receipt_probe()
    _assert_recovery_mount_guards()
    command = _owner_marker_writer()
    payload = _owner_payload().decode("utf-8").rstrip("\n")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        marker = root / "owner.json"
        temporary = root / "owner.json.tmp"
        _run_writer(command, marker, temporary, payload)
        raw = marker.read_bytes()
        expected = payload.encode("utf-8") + b"\n"
        if raw != expected:
            raise AssertionError(f"published marker bytes differ: {raw!r}")
        if raw.count(b"\n") != 1:
            raise AssertionError("published marker must contain exactly one trailing LF")
        if json.loads(raw.decode("utf-8")) != json.loads(payload):
            raise AssertionError("published marker is not valid JSON")
        if temporary.exists():
            raise AssertionError("temporary owner marker was not removed")
    _assert_persistent_mount_admission()
    print("host-ledger owner marker payload roundtrip: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
