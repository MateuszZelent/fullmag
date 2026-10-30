# Kolejne poprawki materiałów i granic — FEM i Inspector

Kontynuacja PR #337 i #338. Baza etapu:
`9f6505a1ee428d84bbd5626dee0e522326dc37b9`.
Wykorzystano istniejący worktree `material-boundaries-p1-20261029`, branch
`codex/material-boundaries-p2-20261029`; cudzych zmian w głównym checkoutcie
nie włączono do tego etapu.

## Naprawione błędy

| Obszar | Przyczyna i wynik |
|---|---|
| Metadane FEM Aex/Ms | Planner deklarował `Node` także dla rozwiązanego współczynnika elementowego. Writer wybierał przez to nieistniejący wektor węzłowy i pomijał artefakt. Lokalizacja, metoda i statystyki opisują teraz faktyczny wektor `Element`; pola węzłowe i eigen zachowują poprzednią reprezentację. |
| Cel STT/SOT FEM | Odczyt pierwszej mesh part ownera pomijał część węzłów dalszych regionów. Maska obejmuje connectivity wszystkich elementów segmentów wybranego obiektu, niezależnie od kolejności markerów. Rozłączny drugi owner pozostaje poza maską. |
| Dziedziczone Ku1 | Inspector odczytywał tylko właściwości materiału. Po uwzględnieniu nadrzędnego material field czyta zapisane `uniaxial_anisotropy.params.ku1` właściwego ownera. Zachowuje jawne zero oraz wartość wyłączonego modułu; odczyt ani override nie włączają anizotropii. |

Wskazanie `region_id` dla torque nadal kończy się jawnym błędem. Nie rozszerzono
capability kontaktów, regionalnego DMI/Ku ani legalności współczynników DG0.
Wartość „Inherited parent” oznacza zapisaną wartość authoringu, a nie deklarację
aktywnego wkładu energii w solverze.

## Commity

- `8e935e09841cce9fc7651393a809f6e8178c30e1`: Ku1, DOM, fixture przeglądarkowa i jej uruchomienie w istniejącym CI.
- `86680bf9f987e178e0cd474e93f45b2e6d86c0fc`: metadane i artefakty FEM, maski STT/SOT, regresje i noty naukowe.

## Weryfikacja

Grupa: `fullmag-worktree-fullmag-033f6660666cdc47`, port `3356`.
Zarządzany start: attempt `3d5124bbee3b4f71baa51248de1151ae`, config SHA
`f02132479b2c7a142d3963010ae563ae875cb1800a7091a6c6e62ee6aa960f1d`.
Testy Rust kompilowano w stałym backendzie tej grupy, z live źródeł
`/opt/fullmag/source`, do prywatnego `/build/material-audit-target`.
Testy UI wykonano w jej frontendzie.

| Kontrola | Wynik |
|---|---|
| `fullmag-plan --lib` | **623 PASS**, w tym Aex/Ms × obie kolejności regionów oraz STT/SOT × obie kolejności markerów i odrębny owner |
| Artefakty materiałowe runnera | **2 PASS**: serializacja pola elementowego i istniejący zapis pola węzłowego |
| Vitest regionów | **39 PASS**: 10 DOM, 22 testy modelu regionów, 7 testów modelu pól |
| TypeScript | `tsc --noEmit`: **PASS** |
| Dokumentacja naukowa | Obie source-map i changed-docs: **PASS**; tooling: **41 PASS** |
| Kontrakty aplikacji i przykłady | Strict contract guard i publiczne przykłady Python: **PASS** |
| Formatowanie | `git diff --check`, składnia smoke oraz rustfmt nowego pliku testów: **PASS** |

RED: planner **23 PASS / 2 FAIL** przed poprawkami (Node zamiast Element;
pominięty węzeł ownera); DOM **7 PASS / 2 FAIL** (0 zamiast 42000/31000).
Po poprawkach dodano także przypadek braku wpisu anizotropii.
React Doctor w katalogu paneli zgłasza 6 istniejących ostrzeżeń; wskazane
efekty i klucze komponentu nie należą do zmienionych linii. Skan skryptów nie
zgłasza diagnostyki dla zmienionego `smoke-inspector.mjs`.

Logi Rust: `/build/material-p2-{plan-red,metadata-green,plan-final,artifact,artifact-nodal}.log`.
Logi UI: `/state/development/material-p2-{ku1-red,ku1-green,typecheck,doctor}.log`.
Logi i cache pozostają w named volumes; retencja podlega końcowej kontroli
aktywnych konsumentów i przypiętemu receipcie grupy.

## Granice dowodu

Pierwsze CI PR #342 ujawniło również stare fixture obecne już na bazie etapu:
13 testów admission dawało 2 FAIL, a 53 testy stopki — 3 FAIL. Test cold start
uwzględnia teraz istniejącą kolejność pull przed konstrukcją kontrolera i
mockuje statyczny pomiar fizycznego storage na klasie. Fixture stopki używa
obecnego `ScalarWindowResource` z `current_observation`, etykiety zaakceptowanej
obserwacji i formatu sześciu miejsc dziesiętnych. Po korekcie: **13 + 53 PASS**.
Nie zmieniono produkcyjnej ochrony 32 GiB ani kodu stopki. Kolejność Windows
nie była wykonywana na lokalnym Linuxie; test statycznego progu używa mocka.

Dalszy krok CI ujawnił niepełną fixture abrupt-stop. Uzupełniono projekt
kontrolera i jawne niepowodzenia obu dowodów izolacji; nieudowodniony obcy
konsument nadal musi blokować recovery (**38 PASS**). Sprawdzono także
pozostałe 73 pliki tego kroku, obejmujące 1347 przypadków. Poprawiono dwie
stare fixture: test skanowania Windows dopuszcza provider wyłącznie w
ograniczonej gałęzi reparse (**56 PASS**), a test cleanupu helpera browser QA
podaje zgodną komendę Compose/inspect (**31 PASS**). Pozostały błąd ACL wynikał
z przestrzeni użytkowników sandboxa; wszystkie **7 testów** przeszło na
rzeczywistym hoście we własnych katalogach tymczasowych, bez zmiany kodu.
Produkcji recovery i izolacji storage nie zmieniano.

Start DEV zbudował pakiet bazowy przed finalnymi poprawkami Rust. Nie jest to
dowód uruchomienia finalnego solvera. Nowa walidacja dynamiki, energii,
parytetu CPU/GPU ani wykonania na urządzeniu: **NOT VERIFIED**.

Regresja przeglądarkowa korzysta z fixture API i sprawdza dziedziczenie Ku1,
brak włączenia modułu oraz stabilność panelu przy mutacji. Lokalny frontend
nie zawiera wymaganej przeglądarki; wykonanie dodano do istniejącej bramki CI.
Jej wynik, kontrole PR, merge i końcowa retencja są zapisywane w PR oraz
rejestrze operacyjnym; sama obecność skryptu nie stanowi dowodu przeglądarkowego.
