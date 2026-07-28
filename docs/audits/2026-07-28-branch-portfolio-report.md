# Raport portfela gałęzi — 2026-07-28

## Wniosek wykonawczy

Nie należy obecnie wykonywać bezwarunkowego merge żadnej gałęzi produktu do
`master`.  Dla wszystkich otwartych PR-ów GitHub zwraca
`mergeStateStatus=UNKNOWN` i nie udostępnia udanych kontroli CI.  Gałęzie
zawierające fizykę, runtime lub Control Room są ponadto od 45 do 275 commitów
za `origin/master`; wymagają rebase'a, selektywnego review i aktualnych bramek,
nie merge'a całego historycznego snapshotu.

Można natomiast od razu usunąć referencje, które są już w całości osiągalne z
`origin/master` (sekcja 5).  Nie usuwać żadnej niezmargowanej gałęzi przed
zachowaniem jej unikalnego patcha albo świadomą decyzją właściciela.

## Zakres i metoda

Stan został pobrany 2026-07-28 z `origin` przez `git fetch --prune origin`.
Punktem odniesienia jest `origin/master` na
`dc7bade161e53a47c9409a1de6489d23189214e2`.

Dla każdej lokalnej gałęzi i referencji `origin/*` sprawdzono:

1. osiągalność tipa z `origin/master` (`git merge-base --is-ancestor`),
2. liczbę commitów przed/za `origin/master` (`git rev-list --left-right --count`),
3. zakres plików (`git diff --name-only origin/master...<branch>`),
4. relację przodek–potomek pomiędzy niezmargowanymi snapshotami,
5. otwarte PR-y przez GitHub CLI.

To jest klasyfikacja portfela, a nie potwierdzenie naukowe ani runtime'owe.
Historyczne raporty i testy zapisane na gałęzi nie zastępują świeżych bramek po
rebase.

Lokalny worktree ma niezależne zmiany submodułów `external_solvers/3` oraz
`external_solvers/tetmag`; nie były zmieniane podczas audytu.

## 1. Merge po krótkiej, konkretnej bramce

Nie ma gałęzi kwalifikującej się do merge bez testu. Poniższe PR-y są małe i
stanowią jedyne sensowne kandydatury do szybkiego, **pojedynczego** merge po
zielonej weryfikacji:

| PR | Gałąź | Zakres | Decyzja |
|---|---|---|---|
| [#23](https://github.com/MateuszZelent/fullmag/pull/23) | `dependabot/cargo/quinn-proto-0.11.16` | 1 commit, tylko `Cargo.lock` | Merge po `cargo test` dla zależnego workspace'u i sprawdzeniu lockfile. |
| [#22](https://github.com/MateuszZelent/fullmag/pull/22) | `dependabot/cargo/serde_with-3.21.0` | 1 commit, tylko `Cargo.lock` | Merge po właściwym Rust gate. |
| [#25](https://github.com/MateuszZelent/fullmag/pull/25) | `dependabot/npm_and_yarn/next-16.2.11` | 1 commit, Control Room + lockfile | Merge po `pnpm --dir apps/control-room typecheck`, `lint -- --max-warnings=0` i `test`. |
| [#19](https://github.com/MateuszZelent/fullmag/pull/19) | `dependabot/npm_and_yarn/echarts-6.1.0` | 1 commit, Control Room, legacy web, lockfile | Merge po powyższych gate'ach oraz chart/browser smoke. |
| [#24](https://github.com/MateuszZelent/fullmag/pull/24) | `dependabot/npm_and_yarn/postcss-8.5.18` | 1 commit, legacy web + lockfile | Merge po instalacji i odpowiednim frontendowym gate; nie mieszać z innymi upgrade'ami. |

`dependabot/cargo/pyo3-0.29.0` (PR [#18](https://github.com/MateuszZelent/fullmag/pull/18)) nie jest szybkim merge: zmienia `pyo3` z 0.24.2 do 0.29.0, więc wymaga osobnej kompatybilności Python/Rust i pełnej kwalifikacji bindingów.

## 2. Kontynuować, ale skonsolidować do jednego właściciela

| Gałąź / artefakt docelowy | Stan względem `master` | Rekomendacja |
|---|---:|---|
| `codex/fem-mixed-prism-pyramid` | 15 ahead, 45 behind, 146 plików | Aktywna praca z 27–28 lipca. Kontynuować w tej jednej gałęzi; przed PR usunąć artefakty `.superpowers/sdd`, zrebase'ować i uruchomić kontrakty meshing/FEM. |
| `codex/eigensolve-k0-demag` | 24 ahead, 257 behind, 43 pliki | Kontynuować jako wydzielony program K0/eigensolve. Najpierw rebase i ponowne potwierdzenie capability/runtime; nie merge'ować zestawu planów i UI bez świeżej kwalifikacji. |
| `codex/fem-oersted-oef1` | 86 ahead, 267 behind, 187 plików | Kontynuować, ale rozbić na małe PR-y: physics/IR, planner/runtime, backend FEM i Control Room. To jest szeroki spin-transport snapshot, nie atomowy merge. |
| `codex/spin-transport-m0-m3` | 109 ahead, 267 behind, 265 plików | Jedyny kandydat na gałąź integracyjną dla łańcucha `spin-*`. Kontynuować tylko po rebase; wydzielać kwalifikowane pionowe slice'y M0–M3. Nie promować do produkcji bez managed-runtime i device evidence. |
| `codex/llg-time-domain-remediation-clean` | 22 ahead, 237 behind, 158 plików | Zachować jako główny snapshot LLG po porównaniu z `-recovery`; zrebase, zredukować zakres i odtworzyć bramki time-domain. |
| `codex/llg-time-domain-remediation-recovery` | 3 ahead, 237 behind, 68 plików | Zdecydować, czy 3 dodatkowe commity są potrzebne w `-clean`; po cherry-pick/rebase usunąć jeden z dwóch równoległych snapshotów. |
| `feature/boundary-faces` | 5 ahead, 275 behind, 6 plików | Mały, nadal wartościowy slice API. Rebase, odtworzyć testy routera v2 i browser/resource smoke, potem osobny PR. |
| `codex/regional-field-drive` | 1 ahead, 267 behind, 62 pliki | Recovery snapshot. Porównać patch z aktualnym regional-field/authoring code; albo wyciągnąć jeden zamierzony commit do nowej gałęzi, albo archiwizować. |

## 3. Nie rozwijać osobno — gałęzie pośrednie do konsolidacji

Poniższe gałęzie są przodkami późniejszych snapshotów tego samego programu.
Nie należy ich dalej rozwijać ani osobno mergować. Zachować do czasu, aż
docelowy branch przejmie wymagane commity, następnie usunąć.

- LLG: `codex/llg-time-domain-remediation` (przodek `-clean` i `-recovery`).
- Spin M1/M3: `codex/spin-control-room`, `codex/spin-m1-public`,
  `codex/spin-m1-fdm-cuda`, `codex/spin-m1-fem-canonical`,
  `codex/spin-m3-cpu`, `codex/spin-m3-stage-owner`, `codex/m3-stage-owner-fixes`,
  `codex/m3-final-fixes`, `codex/m1-fem-review-fix`, `codex/m1-fem-final-fix`,
  `codex/m1-fem-publication-fix`, `codex/m1-fem-critical-fixes`,
  `codex/m1-ui-review-fixes`, `codex/m1-ui-final-review-fixes`,
  `codex/m1-ui-final-fix2`.
- `origin/codex/spin-transport-m0-m3` jest starszym zdalnym snapshotem lokalnego
  `codex/spin-transport-m0-m3`; po wypchnięciu/ustaleniu finalnego tipa należy
  zaktualizować albo skasować tę referencję, nie traktować ich jako dwóch prac.

Pozostałe równoległe gałęzie `spin-*` (`spin-m0-*`, `spin-m1-fdm-cpu`,
`spin-m1-fem-transport`, `spin-m1-review-fixes`, `spin-m1-runtime-wiring`,
`spin-m2-*`, `spin-sot-cuda-review-fixes`, `slonczewski-remediation`) nie są
przodkami aktualnego `spin-transport-m0-m3`, ale nakładają się domenowo na te
same backendy, IR i API. Nie kontynuować ich niezależnie. Właściciel programu
powinien porównać ich unikalne patche z gałęzią integracyjną, cherry-pickować
tylko brakujące kontrakty/testy, a potem je archiwizować/usunąć.

Tak samo traktować trzy dokumentacyjne forki `spin-transport-pr00-contract`,
`spin-transport-pr00-physics` i `spin-transport-pr00-reconcile`: treść ma
trafić do kanonicznych notatek przez review, nie przez merge historycznych
branchy dokumentacyjnych.

## 4. Stare, niezmargowane: nie kasować automatycznie

| Gałąź | Stan | Decyzja |
|---|---:|---|
| `restore/fem-dynamics-only` / `origin/restore/fem-dynamics-only` | 1 ahead, 674 behind, ostatni commit 2026-06-23 | Stary recovery slice frequency-domain. Najpierw stworzyć patch/tag archiwalny i porównać z bieżącym FEM; potem usunąć albo odtworzyć na świeżym branchu. |
| `origin/codex/review-airbox-gradient-mesh-implementation-1zpjla` | 1 ahead, 984 behind, draft PR #7 od kwietnia | Nie merge'ować. Dotyka legacy `apps/web` oraz Python meshing; sprawdzić, czy 3 pliki nadal są potrzebne. Jeśli tak, nowy mały PR; jeśli nie, zamknąć draft i usunąć branch. |
| `codex/comsol-cross-section-2d` | już merged | Myląca nazwa: tip jest już osiągalny z `master`; należy usunąć referencję (sekcja 5), nie rozwijać.

## 5. Usunąć teraz: tip już jest w `origin/master`

Poniższe referencje mają **0 unikalnych commitów** względem `origin/master`.
Usunięcie ich nazw nie usuwa kodu z `master`.

### Lokalne

- `codex/airbox-accounting-identity-fix`
- `codex/airbox-demag-live-fix`
- `codex/analysis-workbench-refactor`
- `codex/comsol-cross-section-2d`
- `codex/fdm-production-completion`
- `codex/fem-gpu-end-to-end-remediation`
- `codex/frontend-3d-visualization-remediation`
- `codex/frontend-v2-phase-1`
- `codex/inspector-2-refactor`
- `codex/live-m-source-resolution`
- `codex/llg-time-domain-remediation-phase2`
- `codex/mesh-production-integration`
- `codex/mesh-production-remediation-20260714`
- `codex/simulation-preparation-progress`
- `codex/sp4-fem-validation`
- `salvage/mixed-fem-viewport-35232294`

### Zdalne (po usunięciu lokalnych duplikatów albo gdy lokalnej nazwy nie ma)

- `origin/codex/airbox-accounting-identity-fix`
- `origin/codex/fix-javascript-errors-in-frontend`
- `origin/codex/fix-javascript-errors-in-frontend-00jx1m`
- `origin/codex/fix-javascript-errors-in-frontend-xs9ltm`
- `origin/codex/frontend-v2-phase-1`
- `origin/codex/inspector-2-refactor`
- `origin/codex/review-airbox-gradient-mesh-implementation`
- `origin/codex/review-airbox-gradient-mesh-implementation-ls92rg`
- `origin/salvage/mixed-fem-viewport-35232294`

## Zalecana kolejność wykonania

1. Zmergować pojedynczo tylko te aktualizacje zależności z sekcji 1, które
   przejdą wskazane gate'y i mają potwierdzony mergeability/CI.
2. Wyznaczyć właściciela dla czterech programów: mixed FEM, K0 eigensolve,
   LLG oraz spin transport. Każdy rebase'uje tylko swoją gałąź docelową i
   publikuje małe PR-y.
3. Z `spin-*` i LLG wyciągać commity do gałęzi docelowych; nie scalać
   równoległych snapshotów merge commitami.
4. Utworzyć tagi/patche archiwalne dla dwóch pozycji z sekcji 4, podjąć decyzję
   o ich ekstrakcji, a potem skasować.
5. Dopiero wtedy usunąć referencje z sekcji 5. Przed zdalnym usunięciem ponowić
   `git fetch --prune origin` i `git merge-base --is-ancestor <branch> origin/master`.

## Komendy kontrolne przed kasowaniem

```bash
git fetch --prune origin
git merge-base --is-ancestor codex/analysis-workbench-refactor origin/master
git rev-list --left-right --count origin/master...codex/analysis-workbench-refactor
git branch -d codex/analysis-workbench-refactor
git push origin --delete codex/analysis-workbench-refactor
```

`git branch -d` jest celowo bez `-D`: ma przerwać operację, jeśli gałąź przestanie
być osiągalna z aktualnego `master`. Dla zdalnych nazw wykonywać usunięcie tylko
po tej samej ponownej kontroli i po upewnieniu się, że nie jest to aktywny PR.
