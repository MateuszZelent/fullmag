# ADR 0055 — procesowa serializacja PETSc/SLEPc

Status: accepted w zakresie autoryzowanej naprawy review 4060116271. Implementacja i dowody runtime pozostają w toku.
Data: 2026-10-09.

## Kontekst

Wywołania FEM Gamma, native Floquet, PA-E2, PA-E3, sparse-direct oraz GPU korzystają z jednego runtime PETSc/SLEPc w procesie, lecz mają osobne mutexy. GPU może zainicjalizować runtime używany następnie przez CPU. Finalizacja GPU nie może nakładać się na operacje CPU. Nie odtworzono crashu; bieżące źródła dowodzą braku wspólnej synchronizacji.

## Decyzja

- Prywatny owner w `backends/fem/core/petsc_slepc_runtime` udostępnia jedną procesową, nierekurencyjną granicę synchronizacji. Jest zdefiniowany raz w bibliotece; jego czas życia obejmuje callbacki atexit. Istniejące scoped lock guards są lease'ami operacji, nie tworzymy nowej publicznej konfiguracji.
- Wszystkie sześć rodzin obejmuje tą samą granicą sprawdzenie i inicjalizację runtime, operacje oraz teardown uchwytów. Dotyczy to także jawnego finalizatora GPU i atexit.
- PA-E3 zachowuje jawne pożyczenie aktywnego operatora w rekurencji podokien. Ścieżka pożyczająca nie zdobywa ponownie mutexu; kontekst jest ograniczony do wątku i czasu życia zewnętrznej operacji. PA-E2 dispatchuje do PA-E3 przed zdobyciem lease. Nie używamy recursive_mutex jako maskowania wywołań zagnieżdżonych.
- Procesowy owner zachowuje trwały quarantine latch dla niebezpiecznych retained grafów generic, native Floquet i PA-E3. Jawny GPU finalizer odmawia globalnej finalizacji, a atexit pomija ją, jeśli którykolwiek taki graf pozostaje; nie próbujemy sprzątać go wbrew kontraktowi awarii. Stan wymaga restartu procesu.
- Zachowujemy GPU rozróżnienie własnej i zewnętrznej inicjalizacji oraz dotychczasowy brak finalizacji runtime przez CPU. Jawna finalizacja własnego runtime jest terminalna; następne entrypointy wykrywają PetscFinalized i zwracają błąd dostępności zamiast używać lub ponownie inicjalizować zakończony runtime. Jeśli Fullmag nie jest właścicielem inicjalizacji, nie finalizuje cudzej biblioteki.
- Nie zmieniamy równań, residual gates, request/resolved lane, Python/ProblemIR, ABI ani fallbacków. Wspólna blokada nie serializuje różnych procesów puli; każdy proces posiada swój runtime.

## Obowiązki implementacji

Objąć generic SLEPc, native Floquet, PA-E2, PA-E3, CPU sparse-direct i GPU modal PETSc/SLEPc. Zbadać wszystkie inicjalizatory i finalizatory, włącznie z błędami inicjalizacji i cleanupem cache. Przetrzymywane obiekty i ścieżki quarantine muszą mieć jawny kontrakt; brak takiego dowodu nie pozwala ogłosić bezpieczeństwa pełnego shutdownu.

## Testy i kwalifikacja

Wymagane są rzeczywiste równoczesne entrypointy Gamma/Floquet i porównanie wyników do wywołań sekwencyjnych, kontrola podokien PA-E3, zwalniania lease po błędzie/anulowaniu i odrzucenia runtime po terminalnej finalizacji. Sam test wspólnego mutexu nie dowodzi pokrycia rodzin. GPU runtime wymaga własnego dowodu; test CPU lub kompilacja bez GPU go nie zastępują. Lokalna kompilacja i testy pozostają zakazane; wykonania zlecamy GitHub Actions. Brak dowodu oznacza NOT VERIFIED.

## Wycofanie

Powrót do niezależnych mutexów przywraca potwierdzony race, więc nie jest bezpiecznym fallbackiem. Jeśli CI wykaże brakującą granicę lub deadlock, poprawiamy zakres lease i wstrzymujemy kwalifikację, zachowując dane i historię. Rozwiązanie nie wymaga migracji zapisanych wyników ani kontraktów użytkownika.
