# Checkpoint zewnętrznego audytu eigensolve — 11.10.2026

Repo: MateuszZelent/fullmag; branch: codex/eigensolve-dispersion-plan-20260912; PR97.
Ostatni source commit przed tym dokumentacyjnym checkpointem: `1c398528a762ced690fb09cf00082619c4031bc8`.
Ten checkpoint nie zmienia kodu. Kod solvera należy oceniać na pełnym wynikowym SHA checkpointu, bez zastępowania go masterem.

## Tożsamość i zakres

Dedykowany worktree: eigensolve-dispersion-plan-20260912. Lokalny historyczny HEAD1827c3436f80ff17396c285d13c0e269eecf4b25, indeks i stash pozostają zachowane; źródła tego zadania publikowano jako pełne snapshoty commitowane na branchu GitHub. Dirty status względem lokalnego HEAD nie oznacza braku na remote. Porównano153zmienione/nowe pliki:146identycznych po normalizacji UTF8/BOM/CRLF;7różnic z innych prac zachowano poza publikacją eigensolve. Nie stwierdzono brakujących nowych plików.

Poniższe lokalne różnice nie są częścią tego checkpointu. Reviewer ocenia ich wersje na GitHubie i sprawdza, czy starsze cytaty/hash-reference w raporcie nie odnoszą się do innego snapshotu:

- `apps/runner-console/src/views/PoliciesView.js`
- `apps/runner-console/src/views/StorageView.js`
- `docs/physics/0102-airbox-mesh-grading-geometric.md`
- `docs/physics/0102-airbox-mesh-grading-geometric.source-map.json`
- `docs/physics/0833-fem-waveguide-25d-normalization.md`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`

## Dowody

- [Pełna suite38154212824](https://github.com/MateuszZelent/fullmag/actions/runs/38154212824): source1c398528..., SUCCESS;1616runner tests PASS,1ignored,38scientific documentation contracts PASS.
- [Scoped pool38153749586](https://github.com/MateuszZelent/fullmag/actions/runs/38153749586): sourcea848dce7..., SUCCESS;56tests PASS.
- [UI38152887838](https://github.com/MateuszZelent/fullmag/actions/runs/38152887838):196tests/14files,typecheck/architecture PASS; workflow FAIL wReact Doctor617diagnostics semantycznie identycznych z wcześniejszym baseline. Browser NOT VERIFIED.
- [API38150465728](https://github.com/MateuszZelent/fullmag/actions/runs/38150465728):114tests PASS,wtym5nowych hysteresis source/path cases.
- [Native38153278619](https://github.com/MateuszZelent/fullmag/actions/runs/38153278619): source9c82dca6..., build completed, CTest7/12PASS,5FAIL: full modal,mixed dense i3borrowed-Pmat fault/pattern cases. Nowe rowfault diagnostics wskazują dwa falsechecks dotyczące unchangedphi rhs/solution; sprawdzić brak dowodu versus faktyczne naruszenie. Patternfixture correction nie zamknęła testu.

Nie przenosimy dowodów na zmienione wejścia/źródła bez porównania. Zielone fixture/source tests nie dowodzą native runtime, nauki, kompletności widma, convergence ani CPU/GPU parity. Runtime/private attestation i scientific/GPU qualification pozostają NOT VERIFIED.

## Decyzje i otwarte kontrakty

Spectrum scope zatwierdzony11.10: per_sample daje osobno adresowalne widmo każdego k; global kolekcję całego sweepa. Częstotliwości pozostają przypisane do konkretnego k; bez uśredniania lub jednego wspólnego operatora. Implementacja Python→activeIR→writers→API/UI nadal otwarta; szczegóły:2026-10-09-eigen-spectrum-scope-contract.md.

Canonical dataset identity nie może aliasować stage/artifact IDs. CSV-backed dispersion nie ma aktualnie potwierdzonego cross-file generation fence z modal Results dataset: source_artifacts zawiera spectrum JSON, nie dokładny digestCSV. Artifact_set_id hashuje ścieżkę katalogu. Konieczna atomowa publikacja/source membership/generation; nie wprowadzono fałszywego trustedjoin.

Adaptacyjna pula zachowuje Pause/Stop,prefix,plannedlabels i rawcheckpoints; serial worker Stop-before-reap oraz portable worker-log paths pozostają odrębnym follow-up. Full P0–P10 nie są ukończone. Read-only audit ma zweryfikować również niezależnie wszystkie inne otwarte uwagi w rejestrze.
