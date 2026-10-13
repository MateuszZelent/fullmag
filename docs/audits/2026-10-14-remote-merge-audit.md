# Audyt pobrania merge PR — 14 października 2026

## Zakres i wynik

Pobrano wszystkie aktualne referencje `origin` przez `git fetch origin --prune`. Audyt dotyczy remote `e40295e419aaf212fb69885c573ac6d6e60c9e69` względem bazy `7224c257b36ca1ed6dc6c54290ddedbf14caf73d`. Lokalny HEAD: `e1ff1a7af12b7077bc6f5f6043fc061ceab4ce35`.

Liczba 1775 była liczbą commitów osiągalnych z remote i nieosiągalnych z lokalnego HEAD. Kolejny merge PR #23 zwiększył ją do 1778. Nie jest to liczba PR-ów: przyrost głównej linii to 22 wpisy (20 merge PR i dwa commity README). PR #97 wniósł 1298 commitów, PR #147 — 339. Sumowanie przyrostów poniżej daje dokładnie 1778.

Struktura Git nie wskazuje utraty historii: wspólny korzeń, poprawna connectivity (`git fsck --connectivity-only --no-dangling`, exit 0), scalenie lokalnego commita z przypiętym remote przez `git merge-tree --write-tree --messages` bez konfliktów. Nie zmieniono plików checkoutu ani jego HEAD.

## Inwentaryzacja merge

| Commit | Cel | Nowe osiągalne commity | Zmiana wobec pierwszego rodzica |
|---|---|---:|---|
| `c3dbcfebfbb010221f9d81ad1821365d327f744a` | Merge pull request #153 from MateuszZelent/dependabot/npm_and_yarn/next-16.3.8 | 4 | 3 files changed, 148 insertions(+), 1893 deletions(-) |
| `e9f93cfd9719ca8731b7239680247fdb51c9d947` | Merge pull request #73 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/tailwindcss/postcss-4.3.3 | 2 | 1 file changed, 1 insertion(+), 1 deletion(-) |
| `3e42164564e282453839eb3884dbf07610ab9fc0` | Merge pull request #72 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/typescript-7.0.2 | 2 | 1 file changed, 1 insertion(+), 1 deletion(-) |
| `bafe9960f0c5ca07719f472710b8aac3cc24c5f9` | Merge pull request #71 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/storybook-10.5.10 | 2 | 1 file changed, 1 insertion(+), 1 deletion(-) |
| `4a97059a08173ae646bd7013c0c7eb9e9b810a5f` | Merge pull request #67 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/radix-ui-90679e2b0b | 2 | 1 file changed, 15 insertions(+), 15 deletions(-) |
| `2f64ec3987f878c1c8ac327d4156db7e9a72c41f` | Merge pull request #62 from MateuszZelent/plan/airbox-dynamic-stray-field | 4 | 1 file changed, 1375 insertions(+) |
| `4b2301f457de3d2235fe4edbcd961b0a3a4a9d93` | Merge pull request #76 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/lucide-react-1.38.0 | 5 | 2 files changed, 983 insertions(+), 975 deletions(-) |
| `cb8bfeb6c04c66aa8c72f1889a8029fbf5299ed3` | docs: sync README version dashboard | 1 | 1 file changed, 2 insertions(+), 2 deletions(-) |
| `30fc632be820d620b65ba63fc6c7a4fa364e0eb7` | Merge pull request #75 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/tailwind-merge-3.6.0 | 5 | 2 files changed, 6 insertions(+), 6 deletions(-) |
| `0c8e0abef0b7a20f56f9d90e0410993299e95e65` | Merge pull request #74 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/tanstack/react-virtual-3.14.10 | 5 | 2 files changed, 10 insertions(+), 10 deletions(-) |
| `13a3f79b401e6b4e85787bd292971f3bd94154c9` | Merge pull request #79 from MateuszZelent/dependabot/npm_and_yarn/vitest-4.1.11 | 4 | 2 files changed, 49 insertions(+), 63 deletions(-) |
| `a5243ffa43438bebd9b4726592092ee021b4305d` | Merge pull request #70 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/types/node-26.4.0 | 3 | 2 files changed, 42 insertions(+), 42 deletions(-) |
| `5aa3ed8cc950774b6aa1d7de787867d8c3a27cd5` | Merge pull request #68 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/dev-tooling-c4d180bc30 | 3 | 2 files changed, 391 insertions(+), 489 deletions(-) |
| `13d113b77473156b9b047a6a160d170613f74596` | Merge pull request #101 from MateuszZelent/dependabot/npm_and_yarn/apps/control-room/react-three-851256e135 | 3 | 2 files changed, 81 insertions(+), 86 deletions(-) |
| `ad8f80079de047c6f00f9ed288facd5de6fd715b` | docs: sync README version dashboard | 1 | 1 file changed, 2 insertions(+), 2 deletions(-) |
| `834b20271b3bb51dfb58fc9781b3ed3e6bcf7cb3` | Merge pull request #155 from MateuszZelent/codex/simulation-mode-consistency-20261013 | 16 | 93 files changed, 5299 insertions(+), 593 deletions(-) |
| `aaec483e96e5f1430edfb8734d7ef8c68bacc242` | Merge pull request #147 from MateuszZelent/codex/microwave-antenna-latest-20260909 | 339 | 727 files changed, 153776 insertions(+), 3653 deletions(-) |
| `911902d6d545d1471c77290eedef1a1b6937fb62` | Merge pull request #97 from MateuszZelent/codex/eigensolve-dispersion-plan-20260912 | 1298 | 1064 files changed, 408821 insertions(+), 53092 deletions(-) |
| `e340e58f3ec5764fc60c2bf01aeffdeccd0d9efb` | Merge pull request #98 from MateuszZelent/codex/bimeron-rdmi-frozen-spins | 48 | 71 files changed, 5720 insertions(+), 412 deletions(-) |
| `b6719859379cd3fe1ef3461354a0e670545a6f47` | Merge pull request #96 from MateuszZelent/codex/frontend-bugfix-integration-20260920 | 11 | 18 files changed, 348 insertions(+), 98 deletions(-) |
| `51743e6385ba82e84a9c5e383eefaf0cb8ea6c83` | Merge pull request #57 from MateuszZelent/audit/fem-fdm-3d-visualization-2026-08-24 | 17 | 5 files changed, 1071 insertions(+), 6 deletions(-) |
| `e40295e419aaf212fb69885c573ac6d6e60c9e69` | Merge pull request #23 from MateuszZelent/dependabot/cargo/quinn-proto-0.11.16 | 3 | 1 file changed, 55 insertions(+), 36 deletions(-) |

## Dowody i ograniczenia

- Różnica baza→remote: 1783 pliki, 554342 dodane i 37621 usuniętych linii; 960 nowych plików, zero usuniętych plików.
- Brak znaczników konfliktów w przeszukanych plikach kodu oraz wersjonowanych EXE/MSI/DLL/PDB/WIXPDB w remote.
- Parser AST: 409 zmienionych plików Python; parser JSON: 7. Wszystkie poprawne. TOML: NOT VERIFIED (brak tomllib w hostowym Pythonie).
- `git diff --check` po uwzględnieniu CRLF zgłasza ostrzeżenia whitespace, m.in. końcowe puste linie i spacje w Markdown. To nie jest dowód błędów wykonania.
- Nie kompilowano testów jednostkowych ani nie uruchamiano ciężkiego buildu/runtime. Wyniki CI odczytano z już istniejących przebiegów.

## Kontrole GitHub

[Przebieg ostatniego mastera](https://github.com/MateuszZelent/fullmag/actions/runs/38478916706) zakończył się `failure`. Czerwone są: python-contracts, browser-fixture-smoke, control-room-contracts, fdm-relaxation-qualification, rust-contracts, generated-api-determinism i checkpoint-windows-contracts. Nie można uznać pobranego kodu za zweryfikowany.

Sprawdzono istniejące kontrole dla każdego z 22 wpisów. Przy bazie czerwony był python-contracts. Po PR #153 brak zakończonych czerwonych kontroli; po PR #73 pojawiają się czerwone kontrole frontend/API/browser. Po PR #97 pojawia się dodatkowa grupa błędów. Same wyniki CI nie ustalają przyczyny ani poprawności wszystkich ścieżek; wymagają odczytu logów i konkretnych miejsc w kodzie.

## Integracja lokalna — BLOCKED

Główny checkout ma 59 zmienionych śledzonych plików, a 17 pokrywa się ze zmianami remote. Indeks był pusty. Lokalny commit `e1ff1a7af12b7077bc6f5f6043fc061ceab4ce35` pozostaje zachowany. Użytkownik wcześniej nakazał utrzymać równoległą pracę; nie wykonano stash/reset ani podmiany jej plików. Fetch jest zakończony, aktualizacja plików i merge lokalnego mastera pozostają niewykonane.

Pliki pokrywające się z remote:

- `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/apiPaths.ts`
- `apps/control-room/src/kernel/api/apiTypes.ts`
- `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- `crates/fullmag-api/src/openapi_v2.rs`
- `crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs`
- `crates/fullmag-api/src/router_v2/mod.rs`
- `crates/fullmag-api/src/router_v2/tests/project_documents.rs`
- `crates/fullmag-api/src/schemas/mod.rs`
- `crates/fullmag-api/src/schemas/projects.rs`
- `crates/fullmag-runner/src/lib.rs`
- `crates/fullmag-session/src/lib.rs`
- `docs/plans/active/refactor_runtime/final/p8/53bm-camera-preservation.md`
- `docs/specs/compute-resource-execution-v1.md`

Następny krok: rozliczyć/ustabilizować zmiany właścicieli w 17 nakładających się plikach, wykonać merge zachowujący lokalny commit dokumentacyjny, a przed kwalifikacją naprawić i zweryfikować przyczyny czerwonego CI.

## Potwierdzone regresje — frontend i granica API

1. **Blocker — PR #72:** `apps/control-room/scripts/typecheck-control-room.mjs:18–22` wywołuje `require.resolve("typescript/bin/tsc")`. Manifest podniósł TypeScript do `7.0.2`, który nie eksportuje tego entrypointu. CI kończy się `ERR_PACKAGE_PATH_NOT_EXPORTED`. [Log kontroli](https://github.com/MateuszZelent/fullmag/actions/runs/38478916706/job/115576401742).
2. **Blocker — wynik merge PR #98:** `apps/control-room/src/modules/field-map/fieldMapCommands.ts` zachował oba warianty zawężenia wejść: podwójne deklaracje `monitorId` (około linii 373/380) i `newName` (453/461). Webpack zgłasza ponowną deklarację identyfikatora. [Log browser smoke](https://github.com/MateuszZelent/fullmag/actions/runs/38478916706/job/115576401793).
3. **Blocker — integracja PR #97 z PR #147 / backend:** `crates/fullmag-runner/src/lib.rs:2605` nie obsługuje nowego `BackendPlanIR::AntennaExternalLeadInspection(_)`; błąd kompilatora `E0004` zatrzymuje generowanie API. [Log generatora](https://github.com/MateuszZelent/fullmag/actions/runs/38478916706/job/115576401573).
4. **Required — PR #68:** manifest deklaruje Vite `8.3.2`, lecz override/importer/rezolucja `pnpm-lock.yaml` wskazują `8.0.16`. To niespójność deklarowanych i faktycznie instalowanych zależności; sama nie wyjaśnia błędu parsera browser smoke.

Przegląd frontendowy nie wykazał późniejszego odwrócenia zmian PR #96 ani cofnięcia nowych modułów/API przez wskazane stare branche. PR #57 jest docs-only. Pośrednie rozbieżności lockfile po merge package-only zostały częściowo wyrównane przez kolejne merge; finalna rozbieżność Vite pozostaje.

Jest to przegląd celowany na ryzyko merge i rzeczywiste błędy CI, nie pełny przegląd każdej z ponad 500 tysięcy dodanych linii ani dowód działania runtime.

## Uzupełnienie backendowe

Błąd `E0004` pochodzi z połączenia nowego wariantu antenowego PR #147 z matchem adaptacyjnego wykonania przejętym ze starszej gałęzi PR #97. Końcowy blob runnera zachowuje ten brak. Ten sam błąd blokuje co najmniej cztery joby: Rust, kwalifikację FDM, deterministyczne API oraz kontrakty Windows. Nie są to cztery niezależne awarie solvera.

Dodatkowo `scripts/test_bootstrap_workflow_contract.py` nie odpowiada aktualnemu bootstrapowi:

- około linii 241–246 wymaga bezpośredniego sąsiedztwa kroków, mimo dodanych pomiędzy nimi kontraktów; log zgłasza różnicę `Run complete session reachability and archive contracts` / `Run Rust quantity, API and CLI contracts`;
- około linii 295–302 liczy display name `Setup Node.js`, pomijając instalację dla retention o innej nazwie; log zgłasza `6 != 5`.

PR #62 dodaje wyłącznie plan dokumentacyjny; PR #23 zmienia wyłącznie `Cargo.lock`. Celowany przegląd backendu PR #98 i #155 nie wykazał dodatkowej potwierdzonej regresji; ich kwalifikacja wymaga odblokowania kompilacji i właściwych bramek runtime.

## Build i launcher

Przegląd build/CI potwierdził wspólny blocker `E0004` dla kontraktów Windows. Nie wykazał dodatkowej potwierdzonej regresji routingu w `run_fullmag.ps1`; zachowany `run_fullmag_wsl.ps1` jest adapterem zgodności, a jego implementacja nie uruchamia `wsl.exe`. Przegląd per-merge w tym obszarze zakończono po deterministycznym blockerze, więc nie stanowi pełnej kwalifikacji wszystkich tras build/runtime.
