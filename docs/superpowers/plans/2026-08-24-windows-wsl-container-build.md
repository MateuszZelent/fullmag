# Windows WSL2 Container Build — Plan implementacji

> **Dla agentów:** implementować zadanie krok po kroku, utrzymując test-first i weryfikację po każdej zmianie.

**Cel:** Uruchomić z Windows hosta reprodukowalny build i runtime Fullmag FDM GPU w linuxowym kontenerze CUDA przez WSL2/Docker, bez zapisywania ciężkich artefaktów w repozytorium ani na C:.

**Architektura:** `just fullmag windows=True ...` będzie kierował tryb GPU do launchera WSL2/Docker. Kontener `nvidia/cuda` pozostaje właścicielem Rust/CUDA/Python/Node builda i uruchomienia linuxowego binarium; hostowy launcher tylko waliduje środowisko, przygotowuje mounty D: i przekazuje argumenty. Dotychczasowy launcher natywnego Windows pozostanie dostępny przez jawny tryb `native=True`.

**Technologie:** Just, PowerShell, Docker Compose, Docker Desktop WSL2 GPU, `nvidia/cuda:12.4.1-devel-ubuntu22.04`, Cargo nightly, pnpm.

## Ograniczenia globalne

- Linuxowy kontener produkuje i uruchamia ELF Linux; nie jest to natywny `fullmag.exe`.
- Wymuszony `gpu` kończy się błędem przy braku Docker/WSL/GPU; nie wolno używać CPU fallbacku.
- Cargo target, Cargo/Rustup/pnpm/Python/CUDA/TMP/cache/state i raporty kontenera muszą być pod `D:\fullmag-cache` lub `D:\fullmag-build`.
- Nie używać repozytoryjnych `target/`, `cargo-targets/`, `pnpm-store/` ani podobnych katalogów jako trwałego storage.

## Kolejność

1. Dodać kontrakty testowe dla routingu WSL2 i mountów.
2. Dodać Windowsowy override Compose z bind mountami D:.
3. Dodać launcher WSL2/Docker z build/run/fail-closed.
4. Rozszerzyć parser `justfile`, zachowując `native=True`.
5. Uruchomić testy statyczne, parsery i preflighty; realny GPU build wykonać dopiero po dostępności Docker Desktop WSL2 GPU.
