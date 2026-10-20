#!/usr/bin/env python3
"""Interactive host configuration for Fullmag Docker; never builds or starts jobs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tempfile

import fullmag_storage as storage

SCHEMA = "fullmag.docker-host-setup.v1"
GPU_ACCESS_CHOICES = frozenset({"auto", "required", "disabled"})
KEY_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


class SetupError(ValueError):
    pass


def bounded_file(path: Path, maximum: int = 1024 * 1024) -> bytes:
    storage.absolute(path, "configuration file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not __import__("stat").S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise SetupError("Plik konfiguracji nie jest zwykłym, ograniczonym plikiem")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise SetupError("Plik konfiguracji jest za duży")
        return data


def dotenv_values(data: bytes) -> dict[str, str]:
    """Read literals with the same quoting rules as the storage resolver."""
    values = {}
    for line in data.decode("utf-8-sig").splitlines():
        line = line.strip()
        match = KEY_RE.match(line)
        if not match:
            continue
        value = line[match.end():].strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise SetupError(f"Niedomknięty cudzysłów w {match.group(1)}")
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        key = match.group(1)
        if key in values and key in storage.MANAGED_VARIABLES | {"POSTGRES_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"}:
            raise SetupError(f"Usuń duplikaty {key} przed konfiguracją")
        values[key] = value
    return values


def merge_dotenv(original: bytes, updates: dict[str, str]) -> bytes:
    """Change only selected keys; retain comments, secrets and unknown settings."""
    text = original.decode("utf-8-sig")
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    positions: dict[str, list[int]] = {}
    for index, line in enumerate(lines):
        match = KEY_RE.match(line)
        if match:
            positions.setdefault(match.group(1), []).append(index)
    for key, value in updates.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(c in value for c in "\r\n\0'"):
            raise SetupError("Nieprawidłowa wartość konfiguracji")
        if len(positions.get(key, [])) > 1:
            raise SetupError(f"Usuń duplikaty {key} przed konfiguracją")
        # The storage parser accepts quoted literal values, without expansion.
        assignment = key + "='" + value + "'"
        if key in positions:
            lines[positions[key][0]] = assignment
        else:
            lines.append(assignment)
    return (newline.join(lines) + newline).encode("utf-8")


def write_exact(path: Path, data: bytes, expected: bytes | None) -> None:
    """Refuse a changed/symlink destination and atomically publish this update."""
    storage.absolute(path, "configuration destination")
    observed = bounded_file(path) if path.exists() else None
    if observed != expected:
        raise SetupError("Konfiguracja zmieniła się w trakcie kreatora; zachowano ją")
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if (bounded_file(path) if path.exists() else None) != expected:
            raise SetupError("Konfiguracja zmieniła się przed zapisem; zachowano ją")
        if expected is None:
            # Publish a fresh file without ever replacing a concurrent creator.
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
        if os.name != "nt":
            parent = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def checkout_context(repo: Path) -> dict:
    try:
        repo = Path(storage.git(repo, "rev-parse", "--show-toplevel")).resolve()
        records = storage.worktree_records(repo)
        main = storage.absolute(records[0]["worktree"], "main checkout")
        if not main.is_dir():
            raise SetupError("Główny checkout nie istnieje na tym komputerze")
        if Path(storage.git(main, "rev-parse", "--show-toplevel")).resolve() != main:
            raise SetupError("Nieprawidłowa tożsamość głównego checkoutu")
        known = [storage.absolute(record["worktree"], "registered checkout")
                 for record in records if Path(record["worktree"]).is_absolute()]
    except (storage.StorageError, OSError) as error:
        raise SetupError("Nie można odczytać checkoutu Git. Kopia worktree może wskazywać "
                         "poprzedni komputer; użyj poprawnego klona Git.") from error
    return {"repo": repo, "main": main, "project": main.parent, "checkouts": known}


def validate_storage_root(value: str, context: dict) -> Path:
    root = storage.absolute(value, "FULLMAG_PROJECT_STORAGE_ROOT")
    if root == Path(root.anchor) or storage.inside(context["project"], root):
        raise SetupError("Storage nie może zawierać projektu ani być korzeniem dysku")
    for checkout in context["checkouts"]:
        if storage.inside(root, checkout) or storage.inside(checkout, root):
            raise SetupError("Storage musi być poza checkoutem i worktree")
    if root.exists() and not root.is_dir():
        raise SetupError("Storage musi być katalogiem")
    marker = root / ".fullmag-storage.json"
    expected = {"schema": storage.SCHEMA, "project_root": str(context["project"])}
    if marker.exists():
        if json.loads(bounded_file(marker)) != expected:
            raise SetupError("Storage ma marker innego projektu; zachowano wszystkie dane")
    elif root.exists() and any(root.iterdir()):
        raise SetupError("Istniejący niepusty storage nie ma markera. Wybierz nowy katalog "
                         "albo wykonaj jawne odzyskiwanie; kreator go nie przejmie.")
    return root


def validate_windows_volume(root: Path) -> None:
    if os.name != "nt":
        raise SetupError("Ten launcher wymaga PowerShell na Windows; w WSL dostępna jest diagnostyka --check.")
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumePathNameW.restype = wintypes.BOOL
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    volume = ctypes.create_unicode_buffer(32768)
    filesystem = ctypes.create_unicode_buffer(256)
    existing = root
    while not existing.exists():
        if existing.parent == existing:
            raise SetupError("Dysk storage nie istnieje lub jest niedostępny")
        existing = existing.parent
    if not kernel.GetVolumePathNameW(str(existing), volume, len(volume)):
        raise SetupError("Nie można ustalić woluminu storage Windows")
    kernel.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    if kernel.GetDriveTypeW(volume.value) != 3:
        raise SetupError("Storage wymaga lokalnego dysku Windows; UNC i dyski sieciowe są niedozwolone")
    if not kernel.GetVolumeInformationW(volume.value, None, 0, None, None, None,
                                         filesystem, len(filesystem)):
        raise SetupError("Nie można odczytać systemu plików storage")
    if filesystem.value.upper() not in {"NTFS", "REFS"}:
        raise SetupError("Storage tej trasy wymaga NTFS albo ReFS")


def validate_host_volume(root: Path) -> None:
    """Admit host configuration paths without claiming runtime admission."""
    if os.name == "nt":
        validate_windows_volume(root)
        return
    if not sys.platform.startswith("linux"):
        raise SetupError("Konfigurator obsługuje Windows oraz Linux/WSL")
    root = storage.absolute(root, "host configuration path")
    if any(storage.inside(root, Path(prefix))
           for prefix in ("/tmp", "/var/tmp", "/run", "/dev", "/proc", "/sys")):
        raise SetupError("Checkout i storage wymagają trwałego lokalnego katalogu")
    filesystem = storage.filesystem_type(root)
    if filesystem not in {"ext4", "xfs", "btrfs"}:
        raise SetupError(f"Checkout i storage Linux/WSL wymagają lokalnego ext4, xfs albo btrfs; "
                         f"wykryto {filesystem or 'nieznany system plików'} dla {root}")


def validate_source(context: dict, value: str | Path) -> Path:
    source = storage.absolute(value, "source checkout")
    if source not in context["checkouts"] or not source.is_dir():
        raise SetupError("Źródła muszą być zarejestrowanym checkoutem tego projektu")
    validate_host_volume(context["main"])
    validate_host_volume(source)
    return source


def validate_port(value: str | int) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise SetupError("Port musi być liczbą") from error
    if not 1024 <= port <= 65535:
        raise SetupError("Port musi należeć do zakresu 1024–65535")
    return port


def runtime_defaults(repo: Path, *, source_root: str | None = None,
                     port: int | None = None):
    """Resolve the same source/port defaults used by the Docker launcher."""
    try:
        from docker_dev_defaults import resolve_defaults
        return resolve_defaults(repo, source_root=source_root, port=port)
    except Exception as error:
        raise SetupError(f"Nieprawidłowe domyślne źródło lub port: {error}") from error


def probe(command: list[str], timeout: int = 15) -> dict:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=timeout, text=True)
    except (OSError, subprocess.TimeoutExpired):
        return {"state": "unavailable"}
    if result.returncode:
        return {"state": "failed", "exit_code": result.returncode}
    return {"state": "available", "value": result.stdout.strip()[:4096]}


def host_checks(gpu_access: str = "auto") -> dict:
    if gpu_access not in GPU_ACCESS_CHOICES:
        raise SetupError("gpu-access musi być auto, required albo disabled")
    is_wsl = os.name != "nt" and (bool(os.environ.get("WSL_DISTRO_NAME"))
        or "microsoft" in __import__("platform").release().lower())
    docker = ["docker"] + (["--context", "desktop-linux"] if os.name == "nt" else [])
    nvidia = (
        {"state": "not_required", "value": "disabled"}
        if gpu_access == "disabled" else
        probe(["nvidia-smi", "--query-gpu=name,uuid,driver_version", "--format=csv,noheader"])
    )
    checks = {
        "platform": "windows" if os.name == "nt" else "wsl" if is_wsl else "linux",
        "python": {"state": "available", "version": __import__("platform").python_version()},
        "git": probe(["git", "--version"]),
        "just": probe(["just", "--version"]),
        "docker": probe([*docker, "version", "--format", "{{.Server.Version}}"]),
        "compose": probe([*docker, "compose", "version", "--short"]),
        "docker_os": probe([*docker, "info", "--format", "{{.OSType}}"]),
        "nvidia": nvidia,
        "gpu_container_execution": "NOT VERIFIED",
        "gpu_access": gpu_access,
    }
    checks["application_launcher"] = ("windows-folder-v1" if os.name == "nt" else
                                      "linux-native-v1" if sys.platform.startswith("linux") else
                                      "not_qualified_for_this_platform")
    return checks


def plan(repo: Path, storage_root: str, source_root: str, port: int,
         *, gpu_access: str = "auto") -> dict:
    if gpu_access not in GPU_ACCESS_CHOICES:
        raise SetupError("gpu-access musi być auto, required albo disabled")
    context = checkout_context(repo)
    root = validate_storage_root(storage_root, context)
    validate_host_volume(root)
    source = validate_source(context, source_root)
    env_path = context["main"] / ".env"
    original = bounded_file(env_path) if env_path.exists() else None
    template = context["main"] / ".env.example"
    base = original if original is not None else bounded_file(template)
    # Never replace a nonempty operator credential, including on partial setups.
    updates = {
        "FULLMAG_PROJECT_STORAGE_ROOT": root.as_posix(),
        "FULLMAG_GPU_ACCESS": gpu_access,
        "FULLMAG_SOURCE_ROOT": source.as_posix(),
        "FULLMAG_HTTP_PORT": str(validate_port(port)),
    }
    existing = dotenv_values(base)
    defaults = {"POSTGRES_PASSWORD": lambda: secrets.token_urlsafe(24),
                "MINIO_ROOT_USER": lambda: "fullmag",
                "MINIO_ROOT_PASSWORD": lambda: secrets.token_urlsafe(24)}
    for key, generate in defaults.items():
        if original is None or not existing.get(key):
            updates[key] = generate()
    configured = merge_dotenv(base, updates)
    return {"context": context, "storage_root": root, "source_root": source,
            "port": validate_port(port), "env_path": env_path, "original": original,
            "configured": configured}


def apply_configuration(prepared: dict) -> dict:
    context = prepared["context"]
    root = validate_storage_root(str(prepared["storage_root"]), context)
    validate_host_volume(root)
    validate_source(context, prepared["source_root"])
    destination = root / "index" / "docker-host-settings.json"
    previous = bounded_file(destination) if destination.exists() else None
    if previous is not None:
        old = json.loads(previous)
        if not isinstance(old, dict) or old.get("schema") != SCHEMA or old.get("storage_root") != str(root):
            raise SetupError("Istniejące ustawienia Docker nie należą do tego storage")
    root.mkdir(parents=True, exist_ok=True)
    marker = root / ".fullmag-storage.json"
    expected = {"schema": storage.SCHEMA, "project_root": str(context["project"])}
    if not marker.exists():
        write_exact(marker, (json.dumps(expected, indent=2) + "\n").encode(), None)
    # Validate proposed managed settings before replacing the operator's .env.
    proposed = dotenv_values(prepared["configured"])
    environment = {**proposed, **os.environ, "FULLMAG_PROJECT_STORAGE_ROOT": str(root)}
    layout = storage.resolve_layout(context["repo"], "docker-all-gpu", environ=environment)
    write_exact(prepared["env_path"], prepared["configured"], prepared["original"])
    storage.initialize(layout)
    settings = {"schema": SCHEMA, "state": "configured_runtime_not_verified",
                "repo_root": str(context["repo"]), "source_root": str(prepared["source_root"]),
                "storage_root": str(root), "http_port": prepared["port"],
                "application_ready": False}
    write_exact(destination, (json.dumps(settings, indent=2) + "\n").encode(), previous)
    return {**settings, "settings_path": str(destination), "env_path": str(prepared["env_path"])}


def show_checks(checks: dict) -> None:
    print("\nSprawdzenie hosta:")
    for name in ("platform", "python", "git", "just", "docker", "compose", "docker_os", "nvidia"):
        value = checks[name]
        state = value.get("state") if isinstance(value, dict) else value
        detail = value.get("value", value.get("version", "")) if isinstance(value, dict) else ""
        print(f"  {name}: {state}" + (f" — {detail}" if detail else ""))
    if checks["platform"] != "windows":
        print("\nKonfigurator obsługuje Linux/WSL z checkoutem i storage na lokalnym "
              "ext4, xfs albo btrfs. Builder i launcher używają skonfigurowanego "
              "endpointu Docker; build i runtime wymagają osobnej weryfikacji.")
    print(f"  Dostęp urządzenia: {checks['gpu_access']}")
    if checks["gpu_access"] == "disabled":
        print("  GPU host proof: pominięty jawnie; zostanie wybrany profil CPU.")
    elif checks["gpu_access"] == "auto" and checks["nvidia"].get("state") != "available":
        print("  GPU host proof: niedostępny; tryb auto wybierze profil CPU.")
    else:
        print("  Wykonanie GPU w kontenerze: NOT VERIFIED; widoczność nvidia-smi nie jest testem solvera.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--check", action="store_true", help="Tylko odczyt; bez zapisu i pytań")
    parser.add_argument("--storage-root", help="Jawny, bezwzględny storage tego hosta")
    parser.add_argument("--source-root", help="Zarejestrowany checkout źródeł; domyślnie resolver Docker DEV")
    parser.add_argument("--port", type=int, help="Port frontendu; domyślnie resolver Docker DEV")
    parser.add_argument(
        "--gpu-access", choices=sorted(GPU_ACCESS_CHOICES),
        default=os.environ.get("FULLMAG_GPU_ACCESS", "auto"),
        help="wybór dostępu urządzenia: auto, required albo disabled",
    )
    args = parser.parse_args(argv)
    try:
        context = checkout_context(args.repo_root)
        checks = host_checks(args.gpu_access)
        show_checks(checks)
        compose = context["repo"] / "compose.dev.yaml"
        print("  compose.dev.yaml: " + ("obecny" if compose.is_file() else "brak w tym checkoutcie"))
        env_path = context["main"] / ".env"
        configured = dotenv_values(bounded_file(env_path)) if env_path.exists() else {}
        defaults = runtime_defaults(
            context["repo"], source_root=args.source_root, port=args.port,
        )
        if args.check:
            root_value = configured.get("FULLMAG_PROJECT_STORAGE_ROOT")
            if not root_value:
                raise SetupError("Brak FULLMAG_PROJECT_STORAGE_ROOT; uruchom scripts/setup_docker.py")
            root = validate_storage_root(root_value, context)
            validate_host_volume(root)
            validate_source(context, args.source_root or context["main"])
            storage.resolve_layout(context["repo"], "docker-all-gpu")
            for key in ("POSTGRES_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"):
                if not configured.get(key):
                    raise SetupError(f"Brak {key}; uzupełnij konfigurację kreatorem")
            required = ("git", "just", "docker", "compose")
            if args.gpu_access == "required":
                required += ("nvidia",)
            if any(checks[name].get("state") != "available" for name in required):
                raise SetupError("Brak wymaganych narzędzi; sprawdź wyniki powyżej")
            if checks["docker_os"].get("value") != "linux" or not compose.is_file():
                raise SetupError("Wymagany silnik Docker Linux i aktualny compose.dev.yaml")
            print("Konfiguracja hosta poprawna. Build i wykonanie Fullmaga: NOT VERIFIED.")
            return 0
        if not sys.stdin.isatty():
            raise SetupError("Uruchom kreator w terminalu interaktywnym albo użyj --check")
        print("\nKreator nie kompiluje ani nie uruchamia kontenerów. Nie usuwa istniejących danych.")
        default_storage = configured.get("FULLMAG_PROJECT_STORAGE_ROOT", "")
        prompt = "Pełna ścieżka lokalnego storage" + (f" [{default_storage}]" if default_storage else "") + ": "
        chosen_storage = args.storage_root or input(prompt).strip() or default_storage
        if not chosen_storage:
            raise SetupError("Wybór storage jest wymagany")
        source = str(defaults.source_root)
        chosen_source = input(f"Checkout źródeł [{source}]: ").strip() or source
        chosen_port = validate_port(
            input(f"Port frontendu [{defaults.port}]: ").strip() or defaults.port
        )
        prepared = plan(context["repo"], chosen_storage, chosen_source, chosen_port,
                        gpu_access=args.gpu_access)
        print("\nDo zapisania:")
        print(f"  .env: {prepared['env_path']}\n  storage: {prepared['storage_root']}")
        print(f"  źródła: {prepared['source_root']}\n  port: {prepared['port']}")
        if input("Zapisać te ustawienia? [t/N]: ").strip().lower() not in {"t", "tak", "y", "yes"}:
            print("Anulowano; nie zapisano ustawień.")
            return 0
        result = apply_configuration(prepared)
        print(f"Zapisano konfigurację: {result['settings_path']}")
        print("\nDalej: przygotowanie obrazu narzędziowego i bezpośredni start dwóch usług Compose. "
              "Instrukcja: docs/guides/docker-development-architecture.md. "
              "Pełna ścieżka runtime wymaga jeszcze kwalifikacji.")
        source_argument = ("'" + str(prepared["source_root"]).replace("'", "''") + "'"
                           if checks["platform"] == "windows" else shlex.quote(str(prepared["source_root"])))
        print("Uruchom wybrane źródła poleceniem:")
        print("  just docker-dev-toolchain  # z katalogu wybranych źródeł")
        print("  just docker-dev " + source_argument + " " + str(prepared["port"]))
        print("Opcjonalny trzeci argument docker-dev wskazuje skrypt symulacji w tym checkoutcie.")
        print("Skrypt w już działającej grupie: just docker-dev-script 'examples/x.py'")
        print("Jawne piny zachowuje recepta: just docker-dev-script-pinned <attempt> <config_sha256> <source_root> <script>")
        return 0
    except (SetupError, storage.StorageError, OSError, ValueError, EOFError) as error:
        print(f"Konfiguracja Docker: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
