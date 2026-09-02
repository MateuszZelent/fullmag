# Raport Task 1 — odtwarzalny baseline FEM/BEM GPU

## Status

**DONE_WITH_CONCERNS**

Task 1 jest ukończony na poziomie źródła i wykonywalnego kontraktu natywnego.
Zamrożony baseline został zachowany z wymaganymi SHA-256, podłączony do CMake,
a kontrakty CPU oraz CUDA przeszły w repozytoryjnym kontenerze FEM. Nie udało
się utworzyć ani zweryfikować zarządzanego bundle runtime z pełną tożsamością
źródła, dlatego managed runtime i walidacja fizyczna pozostają `NOT VERIFIED`.

## Commit

- `9476914fe03c507b7693a18aef29ccb11cd29eaa` — `feat(fem): import reproducible GPU FEM-BEM baseline`

Niniejszy raport zapisano po commicie implementacyjnym, aby mógł zawierać jego
pełny, niekołowy identyfikator. Plik raportu nie należy do commitu powyżej.

## Zmienione pliki

- `backends/fem/CMakeLists.txt`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp`
- `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`
- `crates/fullmag-fem-sys/src/lib.rs`
- `docs/audits/2026-09-02-fem-gpu-solver-audit.md`
- `docs/physics/fem_demag_fem_bem.md`
- `docs/physics/fem_demag_fem_bem.source-map.json`
- `docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md`
- `justfile`
- `native/include/fullmag_fem.h`
- `scripts/test_fem_gpu_full_potential_contract.py`
- `.superpowers/sdd/task-1-report.md` — raport po commicie, niecommitowany

`.superpowers/sdd/progress.md` był wcześniej zmodyfikowany przez koordynatora i
nie został przeze mnie wystage'owany ani zawarty w commicie.

## TDD i weryfikacja

1. `python scripts/test_fem_gpu_full_potential_contract.py`
   - RED przed podłączeniem baseline: exit `1`; brak
     `gpu/cuda/demag_fem_bem/fem_bem.cpp` w CMake.
   - po odzyskaniu hunków i podłączeniu CMake: exit `0`; `Ran 1 test`, `OK`.
   - drugi RED po dodaniu kontraktu ABI: exit `1`; brak
     `FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM = 3` w nagłówku C.
   - po minimalnym rozszerzeniu enum C/Rust: exit `0`; `Ran 1 test`, `OK`.
   - świeży wynik końcowy po implementacji: exit `0`; `Ran 1 test in 0.005s`,
     `OK`. Test sprawdza osiem wymaganych SHA-256 oraz wpisy CMake i ABI.

2. `just rebuild-fem-runtime`
   - exit `1`, przed kompilacją;
   - `mkdir: cannot create directory '/mnt': Permission denied`;
   - `setsid: command not found`; recipe zakończyła się kodem `127`.

3. `just ensure-managed-fem-runtime`
   - exit `1`, przed kompilacją;
   - `[managed_fem_build_policy] Windows worktree gitdir is unavailable in WSL: /mnt/c/git/fullmag/fullmag/.git/worktrees/fem-gpu-full-potential-20260902`;
   - recipe zakończyła się kodem `2`.

4. `just --shell "C:\\Program Files\\Git\\bin\\bash.exe" --shell-arg -lc verify-fem-demag-fem-bem-native-contract`
   - pierwsze wywołanie w sandboxie: brak dostępu do named pipe Docker Desktop;
   - pierwsze zatwierdzone wywołanie dotarło do 59% i ujawniło rzeczywisty błąd
     kompilacji: niezadeklarowane
     `FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM`;
   - po TDD naprawie ABI końcowe wywołanie: exit `0`, build 100%;
   - CTest: `fem_demag_fem_bem_contract` PASS (`1.49 s`) oraz
     `fem_demag_fem_bem_gpu_contract` PASS (`0.39 s`), `2/2`, 100%, razem
     `1.88 s`.

5. `python .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/fem_demag_fem_bem.source-map.json --repo-root .`
   - exit `0`.

6. `python -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'`
   - exit `0`; `Ran 29 tests in 13.907s`, `OK`.

7. `rustfmt --edition 2021 --check crates/fullmag-fem-sys/src/lib.rs`
   - exit `0`.

8. `git diff --no-index --ignore-cr-at-eol <worktree-file> <shared-checkout-file>`
   dla czterech odzyskanych plików operatora/workspace CPU
   - exit `0` dla każdego; brak różnic treści po pominięciu CRLF/LF.

9. `git diff --cached --check`
   - wskazał wyłącznie dwie końcowe spacje w zamrożonym pliku
     `docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md`;
   - spacje pozostawiono świadomie, ponieważ zmiana złamałaby wymagany SHA-256
     `6c978a7805d806df80f0801b9c3c685e2a56ff3541987158b21e2f4d86b5d674`;
   - pozostały staged diff nie zawiera błędów whitespace.

10. `sphinx-build --version`
    - polecenie niedostępne w środowisku hosta; ścisły build Sphinx nie został
      wykonany.

## Self-review

- Zakres commitu porównano z briefem; commit zawiera wyłącznie baseline Task 1,
  task-specific hunki operatora/workspace, niezbędne podłączenie CMake/just,
  minimalny wpis enum ABI oraz dokumentację kontraktu.
- Zamrożone pliki GPU, test, audit i spec zachowują dokładne hashe wymagane przez
  brief; weryfikuje to test manifestu.
- CPU operator/workspace odzyskano semantycznie hunkami; nie kopiowano ogólnych
  plików z brudnego checkoutu. Porównanie ignorujące wyłącznie końce linii nie
  wykazało różnic treści.
- `mfem_bridge.cpp` i `Context` nie otrzymały nowej fizyki ani stanu.
- Dokumentacja rozdziela status `source/contract VERIFIED` od nieudowodnionych
  `managed runtime` i `physics`, zgodnie z kontraktem publikacyjnym.
- Dwa kontrakty wykonywalne przeszły po pełnym linkowaniu `fullmag_fem` w
  kontenerze z CUDA 12.4.131 i MFEM; nie jest to jednak promocja capability ani
  dowód produkcyjny.

## Concerns

1. `rebuild-fem-runtime` i `ensure-managed-fem-runtime` zatrzymały się na
   ograniczeniach integracji Windows/WSL przed kompilacją. Nie ma świeżego
   zarządzanego manifestu z pełnym SHA gałęzi ani runtime receipt; managed
   runtime pozostaje `NOT VERIFIED`.
2. Nie uruchomiono filmu 500 x 500 x 10 nm, parity CPU/GPU, porównania z FDM ani
   MuMax3. Poprawność fizyczna i production qualification pozostają
   `NOT VERIFIED`.
3. Target GPU potwierdza wykonywalny kontrakt kernela w kontenerze, ale nie
   zapisuje odrębnego, trwałego receipt z requested/resolved device, precision,
   source identity i licznikami hot-loop.
4. `sphinx-build` nie jest zainstalowany w środowisku hosta, więc nie wykonano
   ścisłego renderowania Sphinx z warnings-as-errors; walidator źródła i jego
   29 testów przeszły.
5. Zamrożona specyfikacja zawiera dwie końcowe spacje wymagane do zachowania
   dokładnego SHA-256; jest to znane, ograniczone odstępstwo od `git diff --check`.
