# P6 / P4 — wykonywalna bramka accepted FEM CPU

Data: 02.10.2026. Status: implementacja drivera i regresje interpretowane;
rzeczywisty managed runtime **NOT VERIFIED**. Pełny plan P0–P8 pozostaje aktywny.

## Zakres

`verify_accepted_fem_preparation_runtime.py --execute-solver` rozszerza tryb
gotowego pakietu o wykonanie solvera. Flaga jest odrzucana dla legacy buildu
przed utworzeniem katalogów lub uruchomieniem procesu. Konsument pakietu
sprawdza dodatkowe binaria resource pool, accepted scheduler i accepted worker;
po całym scenariuszu ponownie kontroluje niezmienność pakietu.

`accepted_fem_cpu_runtime.py` jest kontynuacją tego samego prywatnego runu:

1. Publikuje rzeczywisty wykryty zasób CPU; wymaga budżetu z RunSpec i zerowej
   pamięci GPU. Wykrycie zasobu nie jest dowodem wykonania solvera.
2. Uruchamia produkcyjny accepted scheduler/worker dla dokładnego runu,
   z jedną egzekucją, bez automatycznego retry i bez zamiany urządzenia.
3. Wymaga ukończenia dokładnego tasku, zwolnienia właściwego CPU lease,
   worker-originated HeartbeatAck i durable process-exit evidence.
4. Sprawdza metadata attemptu: `fem_cpu_native`, effective/resolved
   i authored `fem/cpu/double/strict`, resolution exact, brak fallbacku.
   Metadata należy do dokładnej ścieżki run/task/attempt/epoch; jego plan
   ma fingerprint zgodny z fenced completed/start receipt. Kanonikalizacja
   zachowuje oryginalne tokeny liczb zapisane przez serde, bez zmiany wykładników.
5. Odczytuje trwały run przez publiczne HTTP API po ponownym starcie prywatnego
   API; wymaga succeeded i zgodności accepted state z run/step/ownership epoch.
6. Kontroluje completed-worker receipt, claim/lease, porty final_state i
   total_energy, kanoniczne kodeki oraz rozmiary i SHA-256 obiektów CAS.
   Wymaga zgodności z jednym journal Start i pełnej tożsamości próby.
   Resource lease ma właściwy schema, run/task/attempt/epoch, ścieżkę/token
   i niezmienione bytes. Scalar energii jest bounded-decode jako E_total/J,
   z finite value/time i końcowym krokiem accepted state.
7. Odczytuje SolutionSet, member, artifacts i MaterializedDataset przez publiczne
   API, zachowując pełne revision u64 i sprawdzając project/run/member ownership.
   Oba typed outputs muszą istnieć również publicznie, z właściwymi CAS,
   codec@version i długościami. State zachowuje accepted state; scalar Table
   ma accepted_state null zgodnie z kontraktem producenta.
8. Zapisuje PinnedSolutionTensorSource z odpowiedzi API i uruchamia produkcyjny
   `fullmag runtime verify-saved-fem-snapshot` dla tego źródła i final-state
   artifact. Wymaga pass oraz native values/node-map/indexed-geometry receipts.

Kolejne polecenia mają zapisane argumenty, PID, logi i stan w receipcie drivera.
Upływ czasu obserwacji zachowuje proces i zapisuje
`observation_timeout_process_retained`; nie wywołuje kill ani ponownego solve.
Wynik nieznany wymaga odczytu tego samego procesu/store przed dalszym działaniem.

## Dowody i ograniczenia

60 nowych regresji konsumenta wyników oraz 25 regresji pakietu/trasy: **85 PASS**
(60 w aktualnym module wyników; dotychczasowe 23 i późniejsze trzy przypadki
granicy procesu/legacy PASS, w tym dwa nowe). Testy używają kontrolowanych fixtures,
rzeczywistych hashów plików CAS i mocka czasu obserwacji; nie uruchamiają
solvera. Oddzielne 32 niezmienione regresje archive drivera zachowują dowód
z poprzedniego przyrostu. Dwa prawdziwe procesy wykonują wyłącznie izolowane
polecenie Pythona: kontrolują terminalne exit 0/2, zapis PID/logów i ich hashy,
bez uruchomienia Fullmag. Testów jednostkowych Rust nie kompilowano.
Niezależne review wykryło trzy luki w wiązaniu prób i publicznych wyników;
po ich naprawie końcowe re-review: **brak P0/P1**. Nie jest to dowód runtime.

Nowy kod nie jest jeszcze podłączony do managed runtime wrappera z inspekcją
rzeczywistego obrazu i preflightem hostowego mapowania storage. Nie uruchamiać
go jako zastępczej kwalifikacji bez tej bramki. Build 210 pozostaje konkretnym
wejściem; odebrano terminalny SUCCEEDED/exit 0 i zweryfikowano pakiet,
osiem binariów oraz trzy aliasy biblioteki FEM. Szczegóły: [build 210](../p8/11-current-master-managed-build-210.md).
Ten odbiór nie zastępuje brakującego wrappera i rzeczywistego wykonania drivera.

Ten driver nie kwalifikuje fizyki, FEM GPU, FDM, wydania Windows ani migracji.
Nie wykonuje jeszcze FMS export/import. Archive gate P6-61 wymaga rzeczywistego
źródła oraz kompletnego projektu z kanonicznym main.py; sam fixture przygotowania
nie dowodzi spełnienia tego kontraktu. Nie tworzyć pozornego skryptu ani wyniku
zamiast brakującego eksportu publicznego DSL.

## Następne kroki

Terminalny odbiór job210 → pinned image/runtime wrapper → wykonanie tego drivera
→ zachowane źródło/pin i receipts → rzeczywisty archive roundtrip oraz HTTP/CAS
i browser proof. Wynik rzeczywistego uruchomienia może ujawnić błąd producenta;
wtedy naprawić przyczynę, zachowując dowód pierwszego niepowodzenia.

Sesja użytkownika na 3104 pozostaje oddzielną starą instancją i nie jest
restartowana ani zastępowana przez ten test.
