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

## Retained graph i cleanup

Blokada pojedynczego solve nie wystarcza dla reusable Floquet context zachowywanego między podoknami. Owner musi rejestrować jego żywy graf CPU pod wspólną blokadą, odmawiać globalnej finalizacji do zakończenia życia grafu i wyrejestrowywać go dopiero po bezpiecznym cleanupie. Publiczny destruktor zdobywa lease, a wewnętrzny cleanup już posiadający lease nie zdobywa go ponownie. Quarantine nie jest zwolnieniem żywego grafu.

Każdy GPU cleanup, w tym cache atexit i ścieżka externally initialized, sprawdza PetscFinalized przed niszczeniem obiektów PETSc. Błąd zapytania lub już zakończony runtime oznacza zachowanie cache/własności bez wywołania Mat/Vec/KSPDestroy. Nie wolno traktować samego braku aktywnego solvera jako braku żywych obiektów.

## Obowiązki implementacji

Objąć generic SLEPc, native Floquet, PA-E2, PA-E3, CPU sparse-direct i GPU modal PETSc/SLEPc. Zbadać wszystkie inicjalizatory i finalizatory, włącznie z błędami inicjalizacji i cleanupem cache. Przetrzymywane obiekty i ścieżki quarantine muszą mieć jawny kontrakt; brak takiego dowodu nie pozwala ogłosić bezpieczeństwa pełnego shutdownu.

## MPI i granice dowodu

Wspólny mutex nie podnosi poziomu wątkowego istniejącego MPI. Test wielowątkowy jawnie inicjalizuje MPI na głównym wątku z MPI_THREAD_SERIALIZED i sprawdza otrzymany poziom przed SLEPc. Dowód tego harnessu nie kwalifikuje automatycznie wielowątkowego użycia runtime zainicjalizowanego gdzie indziej jako MPI_THREAD_SINGLE/FUNNELED ani nakładających się obcych wywołań MPI/PETSc poza granicą Fullmag. Taka trasa pozostaje NOT VERIFIED do sprawdzenia inicjalizatora i tożsamości wątku aplikacji.

## Testy i kwalifikacja

Wymagane są rzeczywiste równoczesne entrypointy Gamma/Floquet i porównanie wyników do wywołań sekwencyjnych, kontrola podokien PA-E3, zwalniania lease po błędzie/anulowaniu i odrzucenia runtime po terminalnej finalizacji. Sam test wspólnego mutexu nie dowodzi pokrycia rodzin. GPU runtime wymaga własnego dowodu; test CPU lub kompilacja bez GPU go nie zastępują. Lokalna kompilacja i testy pozostają zakazane; wykonania zlecamy GitHub Actions. Brak dowodu oznacza NOT VERIFIED.

## Wycofanie

Powrót do niezależnych mutexów przywraca potwierdzony race, więc nie jest bezpiecznym fallbackiem. Jeśli CI wykaże brakującą granicę lub deadlock, poprawiamy zakres lease i wstrzymujemy kwalifikację, zachowując dane i historię. Rozwiązanie nie wymaga migracji zapisanych wyników ani kontraktów użytkownika.


## Admission po kwarantannie — korekta 2026-10-09

Globalny latch odczytujemy pod wspólnym ownerem przed pierwszym zapytaniem
PETSc, również przed PetscFinalized. Kwarantanna blokuje nowe solve/init,
nie tylko końcową finalizację i teardown. Odmowa CPU ma przyczynę
petsc_runtime_unsafe i nie zawiera zaakceptowanych modów; sparse-direct
zachowuje swój istniejący kanał błędu, a istniejący kod GPU pozostaje zgodny.
PA-E3 borrower korzysta z outer ownera bez ponownego locka.

Testy, które świadomie zatruwają proces, mają osobne procesy CLI/CTest.
Nie resetujemy latcha w celu uzyskania kolejnego zielonego testu. Dodatkowa
regresja cross-family Gamma/Floquet zatrzaskuje rzeczywisty scalar ownera
przed inicjalizacją i wymaga odmowy bez pośredniej inicjalizacji MPI.

GHA37959833852 na bee2ef37b potwierdziło bounded CPU concurrency i real KSP,
ale pełny profil miał 2/4. Admission i izolowane terminalne cases po tej
korekcie wymagają nowego hosted dowodu. Wynik CPU nie kwalifikuje GPU,
PA-E3, destrukcji z fault injection ani innych trybów MPI aplikacji.
