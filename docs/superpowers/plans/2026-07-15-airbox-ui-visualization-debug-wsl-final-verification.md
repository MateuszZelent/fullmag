# Airbox UI, Visualization Debug i launcher WSL — raport końcowy

**Data:** 2026-07-15

**Status:** PASS / niezależny review: APPROVE

**Repozytorium:** `/home/kkingstoun/git/fullmag/fullmag`

**Gałąź:** `master`

**Bazowy HEAD:** `2e1347ca574df2ef4d343d27047beccb9d21a2a0`

**Plan wykonawczy:** [Airbox UI and Visualization Debug Inspector Implementation Plan](2026-07-14-airbox-ui-and-visualization-debug-inspector.md)

## 1. Wynik

Rozbudowa Airbox i inspektora `Visualization > Debug` jest domknięta na
resource-first API v2. Debug obserwuje dokładnie ten zdekodowany bufor FMVP, który
został przyjęty przez zunifikowany viewport. Nie wykonuje drugiego ciężkiego fetchu,
nie przechowuje pełnych typed arrays w Inspectorze, nie uruchamia pętli renderowania
w idle i nie tworzy alternatywnego backendowego endpointu diagnostycznego.

Równolegle naprawiono uruchamianie Control Room z WSL. Launcher nie rozwiązuje już
`pnpm` przez Windows, więc `cmd.exe` nie dostaje katalogu roboczego UNC
`\\wsl.localhost\...` i nie próbuje otwierać nieistniejącego
`C:\home\kkingstoun\git\fullmag`.

## 2. Kontrakt UI i danych diagnostycznych

Explorer udostępnia jedną semantyczną gałąź Airbox oraz osobne widoki Inspectora dla
parametrów siatki, quality gates, statystyk, topologii, build/provenance i
wizualizacji. Węzeł `Debug` istnieje pod `Visualization` dla:

- Airbox: canonical target `airbox`, data-plane carrier `part:__air__`;
- obiektu: canonical target `object:<canonical-object-id>`;
- regionu: canonical target `region:<canonical-object-id>:<encoded-region-id>`.

Panel pokazuje ograniczony snapshot obejmujący:

- target, carrier i pełną tożsamość query;
- exact resource key, request, ETag, status, czas i liczbę bajtów;
- backend response metadata i zdekodowany layout FMVP;
- dimensions, point/value/component counts i indexing;
- wartości minimalne, maksymalne, średnie, percentyle, non-finite i zero counts;
- przykładowe wartości wraz z indeksami;
- pamięć `owned`, `referenced`, `shared` i `estimated`;
- faktycznie przyjęte surface/vector render-passy i ich buffer identity;
- rewizje pola, domeny, topologii, cache, requestu i adopcji renderera;
- freshness oraz jawne problemy quantity/scope/count/topology/revision/render.

Statystyki z różnych źródeł nie są mieszane. Snapshot rozróżnia
`backend-meta`, `decoded-payload`, `render-derived`, `transport`, `cache`,
`webgl-shared` i `ui-derived`. Nieporównywalne dane pozostają `unknown` z podanym
powodem zamiast otrzymywać fałszywy wynik zgodności.

## 3. Budżety pamięci i lifecycle

| Budżet | Zweryfikowany wynik |
|---|---:|
| Dodatkowe field-vector requests po otwarciu Debug | 0 |
| Idle viewport frames po settle | 0 |
| Idle scans / publishes / Debug requests | 0 / 0 / 0 |
| Maksymalny serializowany snapshot | 65 536 B UTF-8 |
| Próbki punktów | maks. 12 |
| Składowe na próbkę | maks. 8 |
| Wiersze transportu | maks. 8 |
| Stress zmian target/quantity/resource/revision | 50 |
| Stress mount/open/close/unmount | 50 cykli |
| Stan końcowy demand/publishers/pending/snapshots | 0 / 0 / 0 / 0 |
| Aktywne object URLs / feedback timers po dispose | 0 / 0 |
| Ledger geometrii/materiałów WebGL po cleanup | 2 -> 0 |

Eksport JSON jest zawsze bounded i non-throwing. Przy zbyt dużym, cyklicznym lub
niebezpiecznym modelu przechodzi do ograniczonego evidence summary zamiast kopiować
nieograniczone identyfikatory, issues lub pełne dane pola.

## 4. Naprawa WSL i pin runtime

### Przyczyna

Na Linuksie launcher uruchamiał gołe `pnpm`. W WSL `PATH`/`PNPM_HOME` mogły wskazać
Windowsowy shim `pnpm.cmd`. To uruchamiało `cmd.exe`, który nie obsługuje katalogu
roboczego UNC WSL, przechodziło do katalogu Windows i kończyło się `ENOENT` dla
`C:\home\...`.

### Implementacja

Resolver launchera:

1. kanonikalizuje `process.execPath` i sąsiedni Corepack przez `realpath`;
2. w WSL używa wyłącznie Corepack obok aktywnego, natywnego Linux Node;
3. ignoruje `PNPM_HOME` w WSL;
4. odrzuca `.exe`, `.cmd`, `.bat`, drive paths, UNC, `/mnt/<drive>` i custom
   automount roots po rozwiązaniu symlinków;
5. na natywnym Windows zachowuje `pnpm.cmd` i `shell: true`;
6. kończy się czytelnym błędem, zamiast wracać do przypadkowego shimu z `PATH`.

Repozytorium i obrazy są przypięte do Node `24.18.0`. Dockerfile pobiera oficjalny
tarball dla architektury i sprawdza SHA-256:

- Linux x64: `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`;
- Linux arm64: `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6`.

CI ma osobny job Ubuntu 22.04 dla realnego ripgrep 13. Przed ograniczeniem `PATH`
zapisuje absolutną ścieżkę Node dostarczonego przez `actions/setup-node` i potwierdza
`v24.18.0`, dlatego nie wraca przypadkiem do systemowego `/usr/bin/node`.

`/etc/wsl.conf` ma obecnie:

```ini
[interop]
appendWindowsPath=false
```

Po tej zmianie należy jednorazowo wykonać w PowerShell:

```powershell
wsl --shutdown
```

Następnie uruchomić nową sesję WSL. Kod launchera jest bezpieczny także przed tym
restartem, ale restart usuwa Windows PATH globalnie z nowych sesji dystrybucji.

## 5. Browser proof

Task 15 zweryfikował Airbox, Object i Region w jednej stronie i jednej sesji FEM:

- canvas widoczny, WebGL nieutracony, drawing buffer `731 x 483`;
- 0 dodatkowych field-vector requests po wejściu w Debug;
- 0 idle frames, scans, publishes i Debug requests po settle;
- canvas przed/po Debug był byte-identical dla wszystkich trzech targetów;
- brak reload/HMR, HTTP >= 400, decode, hydration i context-loss errors;
- pełna obsługa klawiaturą i tekstowy status health.

Końcowy aktywny-session smoke również przeszedł. W ostatnim przebiegu wyłączono
geometry authoring, aby nie modyfikować skryptu i sesji FEM użytkownika.

Deterministyczny screenshot gate na Node `v24.18.0` zakończył się:

| Pomiar | Wynik |
|---|---:|
| `raw_nodal -> surface_faces` | 665 / 8906 pikseli |
| `surface_faces -> thickness_average_z` | 2501 / 8906 |
| `raw_nodal -> thickness_average_z` | 2440 / 8906 |
| Topology refetch po zmianie projekcji | 0 |
| Dimension frame Off -> Floor + vertical | 81 / 8906 |
| Interactive -> Figure | 875 / 8906 |

Harness wybiera teraz semantyczny węzeł obiektu `Visualization`, a nie próbuje
uzyskać panelu Projection przez przypadkowe klikanie canvasa. Fixture preferuje nowy
object override i używa part override tylko jako fallback.

## 6. Końcowa macierz weryfikacji

| Gate | Wynik |
|---|---|
| Pełny Control Room suite | PASS — 350 plików, 3425 testów |
| TypeScript / route types | PASS |
| ESLint `--max-warnings=0` | PASS |
| Architecture hygiene | PASS |
| API hygiene | PASS |
| Idle performance audit | PASS |
| Compute performance audit | PASS |
| Resource-first strict gate | PASS |
| Contract guard strict | PASS |
| Backend focused contracts | PASS — 5/5 |
| Resolver/launcher tests | PASS — 9/9 |
| Runtime/CI contract tests | PASS — 4/4 |
| Workflow YAML parse | PASS |
| Browser smoke | PASS |
| Screenshot gate | PASS |
| `git diff --check` | PASS |
| Niezależny re-review | APPROVE — 0 Critical, 0 Important, 0 Minor |

Końcowy odczyt realnego managed FEM runtime zwrócił HTTP `200`, sesję
`session-1784136769869-1415240`, `discretization=fem`,
`solver_state=awaiting_command` i runtime bundle `2026-07-15`.

Opcjonalny `docker buildx build --check` dla `docker/dev/Dockerfile` przechodzi bez
ostrzeżeń. Analogiczny check FEM GPU poprawnie parsuje zmiany Node, ale kończy się
kodem 1 z powodu dwóch wcześniejszych `UndefinedVar` dla
`${CMAKE_PREFIX_PATH}` (linie 18 i 93). Te linie zostały świadomie zachowane po
review, ponieważ ich zmiana nie należy do naprawy Node/WSL i mogłaby zmienić
dziedziczone środowisko obrazu. Nie są przedstawiane jako zielony gate.

React Doctor `0.7.8`, uruchomiony offline bez telemetry/supply-chain/remote score,
ma **0 blocking findings dla bieżących plików roboczych**. Pokazuje siedem ostrzeżeń
na historycznych liniach plików dotkniętych diffem. Pełny skan całej aplikacji nadal
pokazuje szeroki wcześniejszy dług i wyniki z `.next-audit`; nie jest on przedstawiany
jako zielony baseline i nie był masowo refaktoryzowany w tym zadaniu.

Końcowe wyszukiwania nie znalazły starego `airbox.mesh-quality`,
`model:mesh:airbox-quality`, `AirboxMeshPolicyPanel`, typed arrays przechowywanych w
Debug panel/controller ani pętli `setInterval`/`requestAnimationFrame` w Debug.

## 7. Jawne ograniczenia

- WebGL memory pozostaje dowodem `shared/referenced`; tracker nie dostarcza jeszcze
  wiarygodnego target-specific GPU ownership.
- Backendowe full-vector statistics i renderer-derived orientation/component range
  mogą być semantycznie nieporównywalne; Debug pokazuje wtedy `unknown` z powodem.
- Debug nie mutuje quantity, zakresu, scope, jakości, gęstości glyphów ani fizyki.
- Pełne pola nie trafiają do JSON, clipboard, logów ani snapshotu Inspectora.
- Numeric point probing/interpolation nie należy do tego kontraktu.

## 8. Stan Git

Praca została wykonana bezpośrednio na `master`, w istniejącym współdzielonym dirty
worktree, nie w osobnym worktree. Nie wykonano commita, push ani stage. Przed
ewentualnym commitem trzeba ponownie sprawdzić `git diff --cached --name-only` i
świadomie wydzielić zakres zmian.
