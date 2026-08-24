# Plan czystej odbudowy i scalenia PR #56

**Cel:** odbudować PR #56 jako minimalny, zweryfikowany delta na aktualnym
`master`, naprawić pełną bramkę lintowania i zamknąć wszystkie zasadne uwagi.

## Zadanie 1: kontrakt bootstrap — TDD

1. Dodać negatywne testy parsera `uses:` dla zmienionej nazwy kroku i starej
   wersji akcji; uruchomić je w stanie RED.
2. Dodać negatywne testy `.gitmodules` dla pustego URL i zduplikowanej ścieżki;
   uruchomić je w stanie RED.
3. Zaimplementować małe, zależne wyłącznie od standardowej biblioteki helpery.
4. Zmienić kontrakt repozytorium tak, aby porównywał dokładny zbiór gitlinków z
   kompletnymi rekordami `.gitmodules`.
5. Dodać uruchomienie kontraktu do workflow i usunąć oba przypadkowe gitlinki.
6. Ustawić `run_frontend3d_required_gate.sh` na `100755` oraz poprawić oczekiwanie
   `preset_version: 2`.
7. Weryfikacja: pełny `scripts/test_bootstrap_workflow_contract.py`, skierowany
   test Python, audyt indeksu i `git diff --check`.

## Zadanie 2: asercja FEM DMI — TDD

1. Uruchomić dokładny test kontraktu i zachować błąd RED.
2. Zmienić wyłącznie asercję źródłową w `dispatch.rs`, aby sprawdzała oba etapy
   mapowania dla `HDmi` i `HDmiBulk`.
3. Uruchomić skierowany test Rust przez właściwą bramkę repozytorium; natywną
   weryfikację wykonywać przez kontenerowe przepisy `just`, nie host-first.

## Zadanie 3: pełny lint Control Room — TDD

1. Uruchomić pełny lint i zachować dokładny stan RED.
2. Dodać test DOM w `SelectionExpressionBuilder.test.tsx`: wprowadzić błędny
   szkic, zachować referencję i fokus inputu, zmienić prop nadrzędny, potwierdzić
   reset tekstu/błędu bez remountu.
3. Uruchomić nowy test przed zmianą produkcyjną i potwierdzić RED.
4. Wprowadzić cztery minimalne poprawki opisane w zatwierdzonej specyfikacji.
5. Uruchomić skierowane testy, lint plików, pełny lint i typecheck.
6. Uruchomić React Doctor, bramki `check:api-hygiene` i
   `check:architecture-hygiene` oraz browser smoke viewportu.

## Zadanie 4: publikacja i review

1. Sprawdzić diff wyłącznie względem aktualnego `origin/master`; rootowy
   `package.json`, lockfile i trzy pliki ACK/Inspektora nie mogą być w diffie.
2. Uruchomić komplet lokalnych bramek możliwych na Windows; brakujące dowody
   Linux/native uzyskać z GitHub Actions i zarządzanych przepisów `just`.
3. Pobierać aktualny zdalny SHA gałęzi PR i wypchnąć przez dokładne
   `--force-with-lease=<ref>:<sha>`.
4. Po publikacji rozwiązać tylko wątki faktycznie naprawione lub oznaczone jako
   nieaktualne przez nowy diff.
5. Poczekać na wszystkie checki; przy błędzie naprawić przyczynę i powtórzyć.
6. Scalić #56 dopiero po zielonym CI i braku nierozwiązanych uwag.

## Zadanie 5: porządkowanie kolejki PR

1. Zamknąć #30 jako zastąpiony przez `master` i #56; osobno naprawić brak
   `manifold3d` w `packages/fullmag-py/uv.lock`.
2. Zamknąć #50 jako zastąpiony przez scalony #49.
3. Przebudować #46 jako świeży, źródłowo mapowany audit delta.
4. Skorygować i ponownie zweryfikować #48 zgodnie z kontraktem dokumentacji
   naukowej.
5. Zmaterializować właściwy kod #53 na aktualnym `master` zamiast payloadów.
