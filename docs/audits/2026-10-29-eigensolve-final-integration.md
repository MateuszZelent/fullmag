# Domknięcie integracji eigensolve i UI — checkpoint

## Cel i warunki zakończenia

Użytkownik zlecił dokończenie planu, integrację z masterem i sprzątnięcie worktree.
Nie utożsamiamy ukończonego R6 ze scaleniem PR ani pełną kwalifikacją naukową.
Kolejność: uzgodnienie źródeł → review i CI → weryfikacja zintegrowanego runtime
→ merge PR → aktualizacja mastera przy zachowaniu WIP → drain grupy i cleanup
wyłącznie zweryfikowanego worktree i prywatnych zasobów. Bez kasowania wyników.

## Aktualna baza

- Gałąź: `codex/eigensolve-integration-ui-20261026`, PR #262.
- Początek etapu: `6a71b3142d666989408d0db68f787b2fa36ca26e`.
- Pobrany master: `c276a163ba` (pełny SHA w merge commicie).
- Rozbieżność początkowa: master 369 / branch 176 commitów; 419 plików PR.
- 14 plików wcześniejszego WIP worktree i 20 plików współdzielonego mastera
  skopiowano wraz z hashami do zewnętrznego checkpointu `final-integration-20261029`.
  Nie stage'owano ich ani nie resetowano głównego checkoutu.

## Rozwiązania konfliktów (29 plików)

- Frontend: zachowano modalne sterowanie i nowsze helpery geometrii bez pola.
  Duży konflikt testu był głównie formatowaniem; trzy wersje sparsowano
  TypeScript-em i znormalizowano bez kompilacji. Zachowano testy obu gałęzi.
- Telemetria: zwijane metryki w wynikach oraz nowe postępy anten z mastera.
- Timeout proxy: budżet faz z mastera, limit archiwum FMS z brancha; oba testy.
- Runner: Relax handoff i Frozen Spins mają odrębne argumenty oraz guardy.
  Centralny materializator runtime-control rozpoznaje dokładny port certyfikatu
  równowagi FEM; wrapper API deleguje do wspólnej implementacji.
- Retirement: nowszy importer-issued observation proof z mastera zastępuje
  starszą lokalną implementację imported_read_only; zachowano bounded retry
  otwarcia store/ledger. Nie omijamy dowodu importera ani lease.
- Przygotowanie: masterowy spójny dowód nieudanej preparacji i wcześniejsze
  helpery/regresje diagnostyczne; porty modalne i publikacja zachowane.
- FMS: zachowano staged/spawn_blocking import, modalną walidację, nowszą
  projekcję zaakceptowanej definicji i prywatny dowód geometrii anten.
  Testy Compact/Solved oraz pustych CAS assets pozostają niezależne.
- Launcher: zachowano exact failed-worker recovery i nowsze preowner/catalog
  recovery; wielozadaniowy katalog jest walidowany, nie zredukowany do 1 zadania.
- Diagnostyka: redagowany structured worker observation, reporty MFEM/MPI,
  guard brakującej próbki zasobów oraz oryginalna granica worker error chain.

## Stan dowodów

Składnia wszystkich konfliktowych Rust/TS/Python PASS (parsery, bez lokalnej
kompilacji testów). `git diff --check` PASS. To nie zastępuje kompilacji,
review ani uruchomienia po scaleniu; wymagane są aktualne CI w GitHub Actions.

R1–R6 mają wcześniejsze dowody UI, w tym 14 rodzajów operacji podczas realnego
solvera w dwóch kwalifikujących przebiegach. Wymagają oceny wpływu integracji.
Pozostałe stare fragmenty solvera I1/I6 oraz kwalifikacja I7 mają oddzielne
otwarte pozycje w planie; nie oznaczono ich jako ukończonych przez ten merge.
PR pozostaje draftem; cleanup nie został uruchomiony.


Uwaga o współbieżności: podczas etapu zewnętrzny writer zmienił lokalny
`FooterTelemetry.tsx` w głównym checkoutcie. Oryginalna kopia pozostaje
zachowana, a bieżący plik mastera nie był przez ten wątek zapisywany.
Staged diff merge'a zawiera też wcześniejsze whitespace w dokumentach
pochodzących z mastera; nie przerabiano historycznych plików patch.


## Pierwsze pełne CI po merge

UI: 1459 testów PASS / 1 FAIL — ujawniono ciche nadpisanie budżetu proxy
przez transport FMS. Naprawa łączy oba ograniczenia w jednej konfiguracji.
Pełny lint ujawnił synchroniczne odtwarzanie preferencji w efekcie; użyto
leniwego odczytu i useSyncExternalStore z serwerowym snapshotem hydracji.
Rust: uzgodniono brakujące/nadmiarowe argumenty łączące Relax i Frozen Spins,
identyczny helper fixture'u FMS zduplikowany przez scalanie testów oraz nowy
opcjonalny external_cas w fixture ArchiveWalker. Python: usunięto podwójne
zadeklarowanie --stop-only. Nie osłabiono oczekiwań, progów ani testów.
Kompilowane testy pozostają wyłącznie w GitHub Actions.
