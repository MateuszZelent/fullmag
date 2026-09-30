# S04/S07 — kompletność pól opublikowanych modów

## Błąd i poprawka

validate_smoke_potential_fields sprawdzał wszystkie znalezione vector.bin oraz pokrycie próbek, lecz nie porównywał pełnego zbioru opublikowanych modów z pełnym zbiorem pól. Dwa opublikowane mody w jednej próbce i pole tylko pierwszego mogły przejść odbiór. Nie dowodziło to kompletności pól ani rekonstrukcji potencjału każdego modu.

Odbiór wymaga teraz równości zbiorów (sample directory, raw mode directory) z eigen/modes oraz eigen/mode_fields. Odrzuca brakujące i nieopublikowane pola oraz niekanoniczne ścieżki tożsamości. Dopiero potem przechodzi dotychczasową kontrolę tożsamości siatki, operatora i fazy oraz gradientu potencjału dla każdego modu. Nie zmieniono fizyki, częstotliwości ani progów residuali.

## Dowody

- RED: rzeczywista regresja brakującego drugiego pola nie zgłaszała błędu przed poprawką; 1 failure/19 testów.
- GREEN: 19 testów pilota PASS, obejmują oba kierunki różnicy zbiorów. 19 testów potencjału PASS; diff check PASS.
- Osiem rzeczywistych archiwalnych przypadków #173 (DE/BV k7 i k25, dostępne poziomy siatki): kompletność, tożsamość i rekonstrukcja consistent. Raport w scientific-batches/published-mode-completeness-20260930/historical-job-173.json wiąże hash producenta i raporty poszczególnych modów.
- To dowody spójności artefaktów; nie certyfikują Poissona, widma, zbieżności ani całej implementacji.

## Bieżąca kapsuła i dalszy krok

#184 pozostaje niezmieniony i używa wcześniejszego odbioru. Nie restartowano builda ani nie zmieniono kapsuły. Jego zaakceptowane wyniki muszą dodatkowo przejść aktualny walidator z worktree. Pełne S00–S12, bieżące obliczenia, nauka, browser, GPU i integracja pozostają otwarte.
