from __future__ import annotations

import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "docker" / "fem-gpu" / "normalize_cuda_dpkg_lists.sh"
DOCKERFILE = REPO_ROOT / "docker" / "fem-gpu" / "Dockerfile"
NVIDIA_SOURCE = REPO_ROOT / "docker" / "fem-gpu" / "nvidia-entrypoint"
EXPECTED_NAMES = (
    "cuda-libraries-12-4.list",
    "cuda-libraries-12-4.md5sums",
    "cuda-nvrtc-12-4.list",
    "cuda-nvrtc-12-4.md5sums",
    "cuda-nvtx-12-4.list",
    "cuda-nvtx-12-4.md5sums",
    "cuda-opencl-12-4.list",
    "cuda-opencl-12-4.md5sums",
    "libcublas-12-4.list",
    "libcublas-12-4.md5sums",
    "libcufft-12-4.list",
    "libcufft-12-4.md5sums",
    "libcufile-12-4.conffiles",
    "libcufile-12-4.list",
    "libcufile-12-4.md5sums",
    "libcufile-12-4.postinst",
    "libcufile-12-4.prerm",
    "libcurand-12-4.list",
    "libcurand-12-4.md5sums",
    "libcusolver-12-4.list",
    "libcusolver-12-4.md5sums",
    "libcusparse-12-4.list",
    "libcusparse-12-4.md5sums",
    "libnccl2.list",
    "libnccl2.md5sums",
    "libnccl2.shlibs",
    "libnccl2.triggers",
    "libnpp-12-4.list",
    "libnpp-12-4.md5sums",
    "libnvfatbin-12-4.list",
    "libnvfatbin-12-4.md5sums",
    "libnvjitlink-12-4.list",
    "libnvjitlink-12-4.md5sums",
    "libnvjpeg-12-4.list",
    "libnvjpeg-12-4.md5sums",
)
EXPECTED_NVIDIA_NAMES = (
    "entrypoint.d/10-banner.sh",
    "entrypoint.d/12-banner.sh",
    "entrypoint.d/15-container-copyright.txt",
    "entrypoint.d/30-container-license.txt",
    "entrypoint.d/50-gpu-driver-check.sh",
    "entrypoint.d/80-internal-image.sh",
    "entrypoint.d/90-deprecated-image.sh",
    "nvidia_entrypoint.sh",
)


def run_normalizer(info_root: Path) -> subprocess.CompletedProcess[str]:
    alternatives_root = info_root / "alternatives"
    alternatives_root.mkdir(exist_ok=True)
    nvidia_root = info_root / "nvidia"
    nvidia_root.mkdir(exist_ok=True)
    environment = os.environ.copy()
    environment["FULLMAG_DPKG_INFO_ROOT"] = str(info_root)
    environment["FULLMAG_DPKG_ALTERNATIVES_ROOT"] = str(alternatives_root)
    environment["FULLMAG_NVIDIA_ROOT"] = str(nvidia_root)
    return subprocess.run(
        ["bash", str(SCRIPT)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )


def test_healthy_metadata_is_unchanged(tmp_path: Path) -> None:
    healthy = tmp_path / "healthy.list"
    healthy.write_bytes(b"/usr/lib/example.so\n")

    result = run_normalizer(tmp_path)

    assert result.returncode == 0, result.stderr
    assert healthy.read_bytes() == b"/usr/lib/example.so\n"
    assert "no normalization required" in result.stdout


def test_exact_known_nul_corruption_is_normalized(tmp_path: Path) -> None:
    healthy = tmp_path / "healthy.list"
    healthy.write_bytes(b"/usr/lib/example.so\n")
    for index, name in enumerate(EXPECTED_NAMES, start=1):
        (tmp_path / name).write_bytes(b"\0" * index)
    alternative = tmp_path / "alternatives" / "cufile.json"
    alternative.parent.mkdir()
    alternative.write_bytes(b"\0")
    nvidia_paths = []
    for index, name in enumerate(EXPECTED_NVIDIA_NAMES, start=1):
        path = tmp_path / "nvidia" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\0" * index)
        nvidia_paths.append(path)

    result = run_normalizer(tmp_path)

    assert result.returncode == 0, result.stderr
    assert healthy.read_bytes() == b"/usr/lib/example.so\n"
    assert all(not (tmp_path / name).exists() for name in EXPECTED_NAMES)
    assert not alternative.exists()
    assert all(not path.exists() for path in nvidia_paths)
    assert (tmp_path / ".fullmag-cuda-dpkg-reinstall-required").is_file()
    assert "package reinstall required" in result.stdout


def test_unknown_invalid_file_fails_without_mutation(tmp_path: Path) -> None:
    original = {name: b"\0" * (index + 1) for index, name in enumerate(EXPECTED_NAMES)}
    for name, contents in original.items():
        (tmp_path / name).write_bytes(contents)
    unexpected = tmp_path / "unexpected.list"
    unexpected.write_bytes(b"\0")
    alternative = tmp_path / "alternatives" / "cufile.json"
    alternative.parent.mkdir()
    alternative.write_bytes(b"\0")
    nvidia_paths = {}
    for index, name in enumerate(EXPECTED_NVIDIA_NAMES, start=1):
        path = tmp_path / "nvidia" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        contents = b"\0" * index
        path.write_bytes(contents)
        nvidia_paths[path] = contents

    result = run_normalizer(tmp_path)

    assert result.returncode == 2
    assert "unexpected invalid dpkg metadata count" in result.stderr
    assert all((tmp_path / name).read_bytes() == contents for name, contents in original.items())
    assert unexpected.read_bytes() == b"\0"
    assert alternative.read_bytes() == b"\0"
    assert all(path.read_bytes() == contents for path, contents in nvidia_paths.items())
    assert not (tmp_path / ".fullmag-cuda-dpkg-reinstall-required").exists()


def test_non_nul_corruption_fails_without_mutation(tmp_path: Path) -> None:
    original = {name: b"\0" * (index + 1) for index, name in enumerate(EXPECTED_NAMES)}
    original[EXPECTED_NAMES[-1]] = b"corrupt"
    for name, contents in original.items():
        (tmp_path / name).write_bytes(contents)
    alternative = tmp_path / "alternatives" / "cufile.json"
    alternative.parent.mkdir()
    alternative.write_bytes(b"\0")
    nvidia_paths = {}
    for index, name in enumerate(EXPECTED_NVIDIA_NAMES, start=1):
        path = tmp_path / "nvidia" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        contents = b"\0" * index
        path.write_bytes(contents)
        nvidia_paths[path] = contents

    result = run_normalizer(tmp_path)

    assert result.returncode == 2
    assert "unexpected invalid dpkg metadata count" in result.stderr
    assert all((tmp_path / name).read_bytes() == contents for name, contents in original.items())
    assert alternative.read_bytes() == b"\0"
    assert all(path.read_bytes() == contents for path, contents in nvidia_paths.items())
    assert not (tmp_path / ".fullmag-cuda-dpkg-reinstall-required").exists()


def test_dockerfile_reinstalls_exact_installed_cuda_package_versions() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "COPY --chmod=755 docker/fem-gpu/normalize_cuda_dpkg_lists.sh "
        "/usr/local/sbin/"
    ) in dockerfile
    assert "reinstall_specs+=(\"${package}=$(dpkg-query -W -f='${Version}'" in dockerfile
    assert '--reinstall "${reinstall_specs[@]}"' in dockerfile


def test_dockerfile_restores_pinned_nvidia_entrypoint_sources() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    source_note = (NVIDIA_SOURCE / "SOURCE.md").read_text(encoding="utf-8")

    assert "COPY --chmod=755 docker/fem-gpu/nvidia-entrypoint/nvidia_entrypoint.sh" in dockerfile
    assert "COPY --chmod=644 docker/fem-gpu/nvidia-entrypoint/entrypoint.d/" in dockerfile
    assert "53a6a109a87bc28f63ab0e8a17a89113bd7ba4f4" in source_note


def test_unknown_nul_nvidia_file_fails_without_mutation(tmp_path: Path) -> None:
    unexpected = tmp_path / "nvidia" / "unexpected.sh"
    unexpected.parent.mkdir()
    unexpected.write_bytes(b"\0")

    result = run_normalizer(tmp_path)

    assert result.returncode == 2
    assert "unexpected invalid NVIDIA entrypoint count" in result.stderr
    assert unexpected.read_bytes() == b"\0"
