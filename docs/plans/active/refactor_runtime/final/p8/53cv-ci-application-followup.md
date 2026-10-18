# P8 — odbiór meshera i kolejne błędy CI aplikacji

Data: 15.10.2026. Produkcyjna poprawka meshera z 53CU została opublikowana
na `origin/master` jako `6b58b6f1058d9dbe9bca7e673c06c7ec490b2082`.
Review przydzielonego diffu nie znalazł konkretnej regresji P0–P2; ograniczenie
grouped ring-hole pozostaje jawne. Brak pełnej kwalifikacji solver/device.

## CI dla poprzedniej poprawki fixture

[Run 38692932218, job 116282794328](https://github.com/MateuszZelent/fullmag/actions/runs/38692932218/job/116282794328)
zakończył się failure w `Run application materialization and eigen selector contracts`.
Poprzednie błędy importów i brakującego inventory nie blokują już kompilacji.
Biblioteka aplikacji: **101 PASS / 9 FAIL**, exit 101; pozostałe zielone kroki
nie zmieniają tej bramki w PASS.

| Grupa | Liczba | Pierwotna diagnoza | Następny krok |
|---|---:|---|---|
| Batch replay | 1 | różny `source_run_sha256`; fixture każdorazowo tworzy losowy RunId | przypiąć RunId testowego captured intent, zachować pełną równość replay |
| Batch tampering | 1 | assertion oczekuje `the axis position`, walidator zwraca `its axis position` | dopasować pełny konkretny komunikat bez osłabienia odmowy |
| Zhang–Li materialization | 1 | legacy moduł ma pola canonical identity/target/operator/lande_g | sprawdzić fixture i wymagany wariant kanoniczny, nie osłabiać walidatora |
| RunIntent materialization | 3 | FEM `strip` wymaga precomputed MeshIR, którego fixture preparation nie ma | ustalić granicę accepted preparation versus wykonanie; nie podmieniać żądanego FEM na FDM |
| Antenna replanning | 3 | authored `first-inspection` nie jest enabled stage według walidatora | prześledzić stage snapshot i IR pipeline; diagnoza przed zmianą kontraktu |

Dwie pierwsze poprawki są lokalnym WIP w `batch_expansion_tests.rs`.
`RunSpecification::new` tworzy losowy RunId, a fingerprint wiąże całe intent;
stały RunId fixture przywraca identyczne wejście testu, nie usuwa pola z hasha.
Diff check PASS. Rustfmt parser przetwarza plik, ale check kończy się 1 z powodu
wcześniejszych różnic formatowania poza tym fragmentem; pliku nie formatowano.
Lokalnych testów Rust nie kompilowano; odbiór nowych poprawek wymaga CI.

## Ponowna próba pakietu Windows

`just windows-workspace-build dev dev 3197 auto`, sesja `48562`, terminalny
exit 2: `Bounded wait expired before starting`. Zarządzana trasa odczekała
120 s na zajęty zasób. Odczyt procesów wykazał aktywną inną pracę, której
nie zatrzymywano; nie wywodzono jej właściciela wyłącznie ze ścieżki.
Nie rozpoczęto nowej kompilacji i nie ma nowego kompletnego pakietu.
Nie uruchamiano drugiego ciężkiego buildu poza blokadą ani UI z częściowego EXE.

Nie usuwano cache, danych ani wcześniejszych runtime. Dowody nieudanego
buildu z 53CT oraz terminalne receipty 53CU pozostają zachowane.
Pełny plan P0–P8 pozostaje **IN PROGRESS**; nie podnoszono procentów na
podstawie samych poprawek fixture lub oczekiwania na zasób.
