# Raport Task 1 — odtwarzalny baseline FEM/BEM GPU

## Status

**DONE_WITH_CONCERNS**

Task 1 jest ukończony na poziomie źródła, pełnego kontraktu CPU solve,
kontraktu GPU initialize→apply i kanonicznego Windows build. Zamrożony baseline
został zachowany w pierwszym commicie, a poprawki po review mają osobny commit.
Ścisły managed receipt świadomie kończy się fail-closed, ponieważ wejście i
wyjście z Hypre wykonuje dwie auditowane synchronizacje hosta. Managed runtime,
parity i walidacja fizyczna pozostają `NOT VERIFIED`.

## Commity

- `9476914fe03c507b7693a18aef29ccb11cd29eaa` — `feat(fem): import reproducible GPU FEM-BEM baseline`
- `25c04ee42f3858a3967b7a8a4fc799fd3d0c845a` — `docs(sdd): record FEM-BEM GPU task 1 evidence`
- `e834f7c1a8f4837ceb39a8b4559bdf66dafde788` — `fix(fem): close FEM-BEM GPU review gaps`

Raport jest śledzony od commitu
`25c04ee42f3858a3967b7a8a4fc799fd3d0c845a`; niniejsza aktualizacja dodaje
dowody poprawek po review. Nie przypisuje pliku wyłącznie do pierwszego commitu
implementacyjnego.

## Zmienione pliki

- `backends/fem/CMakeLists.txt`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp`
- `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu`
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp`
- `backends/fem/gpu/cuda/demag_poisson/operators.cpp`
- `backends/fem/gpu/cuda/demag_poisson/operators.hpp`
- `backends/fem/gpu/cuda/transfer/transfer_audit.cpp`
- `backends/fem/gpu/cuda/transfer/transfer_audit.hpp`
- `backends/fem/tests/demag_fem_bem_contract.cpp`
- `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`
- `crates/fullmag-fem-sys/src/lib.rs`
- `docs/audits/2026-09-02-fem-gpu-solver-audit.md`
- `docs/physics/fem_demag_fem_bem.md`
- `docs/physics/fem_demag_fem_bem.source-map.json`
- `docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md`
- `justfile`
- `native/include/fullmag_fem.h`
- `scripts/test_fem_gpu_full_potential_contract.py`
- `.superpowers/sdd/task-1-report.md` — raport śledzony od commitu `25c04ee42f3858a3967b7a8a4fc799fd3d0c845a`

`.superpowers/sdd/progress.md` był wcześniej zmodyfikowany przez koordynatora i
nie został przeze mnie wystage'owany ani zawarty w commicie.

## TDD i weryfikacja — fala baseline

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
   - był to wynik fali baseline. Po review specyfikację poprawiono, hash
     manifestu zaktualizowano, a końcowy `git diff --cached --check` przeszedł
     bez błędów.

10. `sphinx-build --version`
    - polecenie niedostępne w środowisku hosta; ścisły build Sphinx nie został
      wykonany.

## Self-review

- Zakres commitu porównano z briefem; commit zawiera wyłącznie baseline Task 1,
  task-specific hunki operatora/workspace, niezbędne podłączenie CMake/just,
  minimalny wpis enum ABI oraz dokumentację kontraktu.
- Commit baseline zachowuje dokładne hashe wymagane przez brief. Bieżący test
  manifestu zamraża jawnie wersje plików po remediation, więc pierwotna
  tożsamość nie została utracona, a aktualna nie jest deklarowana jako baseline.
- CPU operator/workspace odzyskano semantycznie hunkami; nie kopiowano ogólnych
  plików z brudnego checkoutu. Porównanie ignorujące wyłącznie końce linii nie
  wykazało różnic treści.
- `mfem_bridge.cpp` i `Context` nie otrzymały nowej fizyki ani stanu.
- Dokumentacja rozdziela status `source/contract VERIFIED` od nieudowodnionych
  `managed runtime` i `physics`, zgodnie z kontraktem publikacyjnym.
- Dwa kontrakty wykonywalne przeszły po pełnym linkowaniu `fullmag_fem` w
  kontenerze z CUDA 12.4.131 i MFEM; kontrakt GPU obejmuje teraz pełne
  initialize→apply oraz fail-closed receipt. Nie jest to jednak promocja
  capability ani dowód produkcyjny.

## Poprawki po review — TDD i dowody

### Zakres zmian

- `AcaHMatrixDemagBemOperator::apply` bezpiecznie nadaje rozmiar pustemu
  outputowi; wykonywalny test uruchamia cały CPU initialize→solve i sprawdza
  skończone pole oraz energię.
- Domyślny CPU workspace ponownie używa kwalifikowanego
  `DenseDemagBemOperator`. ACA H-matrix jest budowany jawnie wyłącznie przez
  ścieżkę GPU i nie jest automatycznym zamiennikiem bez A/B/parity.
- Dodano dedykowany `build_fredkin_koehler_demag_operators`; ogólny mixed
  builder nadal odrzuca Fredkin–Koehler.
- Inicjalizacja GPU alokuje i uploaduje `d_boundary_tdofs`, uwzględnia bajty
  i korzysta z istniejącego cleanupu. Test wykonuje pełne initialize→apply.
- Fingerprint `fullmag.fem.bem.aca_hmatrix_operator.v1` obejmuje geometrię
  granicy, typed connectivity komórek i powierzchni, permutację, klastry,
  wartości near, czynniki U/V, błędy bloków i wszystkie opcje. Test perturbacji
  geometrii oraz opcji wymusza zmianę fingerprintu.
- Obie jawne `cudaStreamSynchronize` wokół Hypre są naliczane jako compute host
  sync. Ścisły receipt odrzuca próbę i ustawia klasę wykonania `Unknown` zamiast
  publikować fałszywe zero-sync/device-resident.
- Nazwy źródłowe, kernel, dokumentacja i provenance używają uczciwego
  `hierarchical_aca_hmatrix`; implementacja nie twierdzi już, że jest H2.

### RED

1. Focused Docker CTest, sesja `99715`:
   - `fem_demag_fem_bem_contract` RED: pełny CPU solve trafił w pusty output
     wymagający wcześniejszego rozmiaru;
   - `fem_demag_fem_bem_gpu_contract` PASS dla dotychczasowego kernel smoke.

2. Po przywróceniu dense CPU default, sesja `62762`:
   - oczekiwany compile RED: kod GPU próbował eksportować dane H-matrix z
     dense operatora workspace.

3. Pierwszy pełny initialize→apply, sesja `31867`:
   - GPU PASS;
   - CPU full-solve RED: niezależnie obliczony residual równy zero nie był
     oznaczony jako certyfikowany, gdy solver nie ustawił własnej flagi
     convergence.

4. Po certyfikacji niezależnego residualu, sesja `38376`:
   - CPU solve przeszedł dalej i ujawnił brak `mfem_lumped_mass` w fixture
     energii; fixture otrzymał dokładne wagi jednostkowego TET4: `4 × 1/24`.

### GREEN

1. `just --shell "C:\\Program Files\\Git\\bin\\bash.exe" --shell-arg -lc verify-fem-demag-fem-bem-native-contract`
   - końcowa sesja `51355`, exit `0`, build 100%;
   - `fem_demag_fem_bem_contract` PASS (`1.02 s`);
   - `fem_demag_fem_bem_gpu_contract` PASS (`0.77 s`);
   - CTest `2/2`, 100%, razem `1.80 s`.

2. `python scripts/test_fem_gpu_full_potential_contract.py`
   - exit `0`; `Ran 1 test in 0.009s`, `OK`;
   - manifest zamraża wersję po remediation i sprawdza dense default,
     dedykowany builder FK, upload true-DOF, sync audit, nazwę ACA H-matrix i
     pola fingerprintu.

3. `python .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/fem_demag_fem_bem.source-map.json --repo-root .`
   - exit `0`.

4. `python -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'`
   - exit `0`; `Ran 29 tests in 13.269s`, `OK`.

5. `rustfmt --edition 2021 --check crates/fullmag-fem-sys/src/lib.rs`
   - exit `0`.

6. `git diff --check -- . ':(exclude).superpowers/sdd/progress.md'` oraz
   `git diff --cached --check`
   - exit `0`; brak błędów whitespace w zakresie Task 1.

7. `rg -n "HierarchicalDemag|hierarchical_h2|hierarchiczny H2|hierarchia H2|H2 source|CPU H2" ...`
   - brak dopasowań w zmienionych źródłach, testach i dokumentacji Task 1
     (`rg` exit `1`, zgodnie z oczekiwaniem dla pustego wyniku).

8. `just windows-build backend=fem device=gpu frontend=static`
   - sesja `45770`, exit `0`;
   - ukończono release build `fullmag-cli` z `cuda fem-gpu`, `fullmag-api`,
     native Python core, Next.js/TypeScript i statyczne strony `5/5`;
   - wynik: `Windows FEM gpu container build is ready`;
   - image:
     `fullmag/fem-gpu:windows-local-fem-gpu-full-potential-20260902-d9bc7c003c8f4f58`;
   - jest to dowód kompilacji kanoniczną trasą Windows, nie managed runtime
     receipt ani dowód fizyki.

### Self-review po poprawkach

- Staged diff przed commitem zawierał dokładnie 19 plików Task 1; osobny
  `git diff --cached --name-only` potwierdził brak
  `.superpowers/sdd/progress.md`.
- `mfem_bridge.cpp` i `Context` nie otrzymały nowej fizyki ani stanu.
- Dense CPU default, diagnostyczny ACA H-matrix GPU, dedykowany builder FK,
  lifetime `d_boundary_tdofs` i fail-closed sync audit są rozdzielone zgodnie z
  ownership modułów.
- Dokumentacja rozdziela source/contract, kanoniczny build, managed receipt,
  parity i fizykę; żadna brakująca lane nie została promowana.

## Concerns

1. `rebuild-fem-runtime` i `ensure-managed-fem-runtime` zatrzymały się na
   ograniczeniach integracji Windows/WSL przed kompilacją. Nie ma świeżego
   zarządzanego manifestu z pełnym SHA gałęzi ani runtime receipt; managed
   runtime pozostaje `NOT VERIFIED`.
2. Nie uruchomiono filmu 500 x 500 x 10 nm, parity CPU/GPU, porównania z FDM ani
   MuMax3. Poprawność fizyczna i production qualification pozostają
   `NOT VERIFIED`.
3. Target GPU potwierdza pełne initialize→apply i nalicza dwie synchronizacje
   Hypre. Ścisły receipt zgodnie z założeniem kończy się fail-closed; trwały
   managed receipt z requested/resolved device, precision i source identity
   pozostaje `NOT VERIFIED`.
4. `sphinx-build` nie jest zainstalowany w środowisku hosta, więc nie wykonano
   ścisłego renderowania Sphinx z warnings-as-errors; walidator źródła i jego
   29 testów przeszły.
5. ACA H-matrix nadal nie ma bramy A/B ani parity z dense dla zakresu
   produkcyjnego i nie jest H2. Dlatego pozostaje diagnostyczny; dense jest
   domyślnym wariantem CPU.
