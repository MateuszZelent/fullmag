#!/usr/bin/env python3
"""Interactive host configuration for Fullmag Docker; never builds or starts jobs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

import fullmag_storage as storage

SCHEMA = "fullmag.docker-host-setup.v1"
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


def validate_port(value: str | int) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise SetupError("Port musi być liczbą") from error
    if not 1024 <= port <= 65535:
        raise SetupError("Port musi należeć do zakresu 1024–65535")
    return port


def probe(command: list[str], timeout: int = 15) -> dict:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=timeout, text=True)
    except (OSError, subprocess.TimeoutExpired):
        return {"state": "unavailable"}
    if result.returncode:
        return {"state": "failed", "exit_code": result.returncode}
    return {"state": "available", "value": result.stdout.strip()[:4096]}


def host_checks() -> dict:
    is_wsl = os.name != "nt" and (bool(os.environ.get("WSL_DISTRO_NAME"))
        or "microsoft" in __import__("platform").release().lower())
    docker = ["docker"] + (["--context", "desktop-linux"] if os.name == "nt" else [])
    checks = {
        "platform": "windows" if os.name == "nt" else "wsl" if is_wsl else "linux",
        "python": {"state": "available", "version": __import__("platform").python_version()},
        "git": probe(["git", "--version"]),
        "just": probe(["just", "--version"]),
        "docker": probe([*docker, "version", "--format", "{{.Server.Version}}"]),
        "compose": probe([*docker, "compose", "version", "--short"]),
        "docker_os": probe([*docker, "info", "--format", "{{.OSType}}"]),
        "nvidia": probe(["nvidia-smi", "--query-gpu=name,uuid,driver_version", "--format=csv,noheader"]),
        "gpu_container_execution": "NOT VERIFIED",
    }
    checks["application_launcher"] = "windows-folder-v1" if os.name == "nt" else "not_qualified_for_this_platform"
    return checks


def plan(repo: Path, storage_root: str, source_root: str, port: int) -> dict:
    context = checkout_context(repo)
    root = validate_storage_root(storage_root, context)
    validate_windows_volume(root)
    source = storage.absolute(source_root, "source checkout")
    if source not in context["checkouts"] or not source.is_dir():
        raise SetupError("Źródła muszą być zarejestrowanym checkoutem tego projektu")
    env_path = context["main"] / ".env"
    original = bounded_file(env_path) if env_path.exists() else None
    template = context["main"] / ".env.example"
    base = original if original is not None else bounded_file(template)
    # Never replace a nonempty operator credential, including on partial setups.
    updates = {"FULLMAG_PROJECT_STORAGE_ROOT": root.as_posix()}
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
    validate_windows_volume(root)
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
        print("\nKonfigurujesz powłokę Linux/WSL. Launcher dwóch usług wymaga obecnie "
              "natywnego Windows i checkoutu/storage NTFS/ReFS. Zapis ustawień nie "
              "kwalifikuje startu aplikacji z WSL; użyj PowerShell dla tej trasy.")
    print("  Wykonanie GPU w kontenerze: NOT VERIFIED; widoczność nvidia-smi nie jest testem solvera.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--check", action="store_true", help="Tylko odczyt; bez zapisu i pytań")
    parser.add_argument("--storage-root", help="Jawny, bezwzględny storage tego hosta")
    parser.add_argument("--source-root", help="Zarejestrowany checkout źródeł; domyślnie główny")
    parser.add_argument("--port", type=int, default=3197)
    args = parser.parse_args(argv)
    try:
        context = checkout_context(args.repo_root)
        checks = host_checks()
        show_checks(checks)
        compose = context["repo"] / "compose.dev.yaml"
        print("  compose.dev.yaml: " + ("obecny" if compose.is_file() else "brak w tym checkoutcie"))
        env_path = context["main"] / ".env"
        configured = dotenv_values(bounded_file(env_path)) if env_path.exists() else {}
        if args.check:
            root_value = configured.get("FULLMAG_PROJECT_STORAGE_ROOT")
            if not root_value:
                raise SetupError("Brak FULLMAG_PROJECT_STORAGE_ROOT; uruchom kreator w PowerShell")
            root = validate_storage_root(root_value, context)
            validate_windows_volume(root)
            storage.resolve_layout(context["repo"], "docker-all-gpu")
            for key in ("POSTGRES_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"):
                if not configured.get(key):
                    raise SetupError(f"Brak {key}; uzupełnij konfigurację kreatorem")
            required = ("git", "just", "docker", "compose", "nvidia")
            if any(checks[name].get("state") != "available" for name in required):
                raise SetupError("Brak wymaganych narzędzi; sprawdź wyniki powyżej")
            if checks["docker_os"].get("value") != "linux" or not compose.is_file():
                raise SetupError("Wymagany silnik Docker Linux i aktualny compose.dev.yaml")
            print("Konfiguracja hosta poprawna. Build i wykonanie Fullmaga: NOT VERIFIED.")
            return 0
        if checks["platform"] != "windows":
            raise SetupError("Otwórz PowerShell w checkoutcie Windows i uruchom: "
                             "python -B scripts/setup_docker.py. Repo pod ~/git w WSL "
                             "nie jest checkoutem Windows. Instrukcja: docs/guides/docker-new-windows-host.md")
        if not sys.stdin.isatty():
            raise SetupError("Uruchom kreator w terminalu interaktywnym albo użyj --check")
        print("\nKreator nie kompiluje ani nie uruchamia kontenerów. Nie usuwa istniejących danych.")
        default_storage = configured.get("FULLMAG_PROJECT_STORAGE_ROOT", "")
        prompt = "Pełna ścieżka lokalnego storage" + (f" [{default_storage}]" if default_storage else "") + ": "
        chosen_storage = args.storage_root or input(prompt).strip() or default_storage
        if not chosen_storage:
            raise SetupError("Wybór storage jest wymagany")
        source = args.source_root or str(context["main"])
        chosen_source = input(f"Checkout źródeł [{source}]: ").strip() or source
        chosen_port = validate_port(input(f"Port frontendu [{args.port}]: ").strip() or args.port)
        prepared = plan(context["repo"], chosen_storage, chosen_source, chosen_port)
        print("\nDo zapisania:")
        print(f"  .env: {prepared['env_path']}\n  storage: {prepared['storage_root']}")
        print(f"  źródła: {prepared['source_root']}\n  port: {prepared['port']}")
        if input("Zapisać te ustawienia? [t/N]: ").strip().lower() not in {"t", "tak", "y", "yes"}:
            print("Anulowano; nie zapisano ustawień.")
            return 0
        result = apply_configuration(prepared)
        print(f"Zapisano konfigurację: {result['settings_path']}")
        print("\nDalej: konfiguracja lokalnego toolchaina i Fullmag_build_runner, build backendu, "
              "składanie obrazu oraz start frontend/backend. Instrukcja: "
              "docs/guides/all-in-docker-windows.md. GPU/runtime nadal NOT VERIFIED.")
        source_argument = "'" + str(prepared["source_root"]).replace("'", "''") + "'"
        print("Po przygotowaniu koordynatora zbuduj wybrane źródła poleceniem:")
        print("  just docker-all-dev-backend-build " + source_argument)
        print("Wybrane źródła i port są zapisane w settings; podaj je jako jawne argumenty "
              "docker-all-dev przy uruchomieniu.")
        return 0
    except (SetupError, storage.StorageError, OSError, ValueError, EOFError) as error:
        print(f"Konfiguracja Docker: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
