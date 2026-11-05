# Wydajność bimeronu i pomiary każdego przebiegu — plan implementacji

> **For agentic workers:** Use subagent-driven-development for the independent implementation slices below. Root owns integration, review and managed runtime qualification.

**Cel:** usunąć potwierdzone koszty BB i schedulera oraz zapisywać powtarzalne pomiary wydajności symulacji razem z danymi do wykresów i raportu.

**Architektura:** wektory BB i obliczenia pól pozostają na GPU; CPU steruje małym pakietem skalarów i publikuje tylko wymagane obserwacje. Scheduler oddziela szybkie sprawdzenie procesu od pełnej kontroli admission. Lekki rejestrator przebiegu zbiera czasy monotoniczne i liczniki, a niezależny sampler odczytuje zasoby z ograniczoną częstotliwością. Szczegółowy opt-in SolverProfile zachowuje swój kontrakt.

**Technologie:** Rust, CUDA FP64/cuFFT, istniejący Docker DEV, Python do analizy artefaktów i wykresów.

**Specyfikacja:** audyt `bimeron-cylinder-relax/qualification/performance-20261102/AUDYT_WYDAJNOSCI.md` w katalogu dokumentów użytkownika oraz polecenie użytkownika z 2 listopada 2026.

## Granice

- Istniejący worktree `frontend-refresh-reconcile-20261030`; owner `/root`; baza pracy `0476236916525fe63dc237b2712e6527d78ea5b0`.
- Jedyna grupa aplikacji: `fullmag-worktree-fullmag-cfc887ff26db7673`; zachować wyniki i pozostałe grupy.
- Brak hostowego Cargo/CMake i kompilacji unit testów. Produkcyjny build i próby runtime przez zarządzaną grupę.
- Bez zmiany Hamiltonianu, precyzji, tolerancji, masek, lokalnych materiałów, rDMI filmu, Armijo, rollback i semantyki Stop/completion.
- GPU utilization oznacza obserwację całego urządzenia, nie occupancy ani wykorzystanie wyłącznie procesu. Brak odczytu ma jawny powód; zero nie zastępuje braku pomiaru.
- Czas urządzenia, czas hosta, fazy inkluzywne oraz publikacja są oddzielne. Pomiary nie dodają synchronizacji GPU co krok.

## Etapy i odpowiedzialność

- [x] GPU worker: najpierw wyeliminować niepotrzebne CPU FFT/Newell w obserwacji; następnie GPU gradient/retraction/historia/redukcje BB, liczniki i walidacja parytetu. Właściciel: CUDA FDM, `multilayer*.rs`, ABI, nota naukowa 0501.
- [x] Scheduler worker: ograniczyć pełny przebieg admission/discovery podczas pracy; zachować szybki process-exit, Stop, fencing i trwałość. Właściciel: `accepted_scheduler_main.rs` i wąski regression check.
- [x] Recorder worker: moduł `run_performance.rs`: strumieniowane CSV, ograniczona kolejka, agregaty, błędy i pokrycie, bez kopii pól. Root: integracja wejść runnera, odczyty GPU, wykresy, dokumentacja.
- [ ] Root: review, źródłowe kontrole, zarządzany build bez unit targets, krótkie próby poprawności i terminalnego wyniku, porównanie tej samej geometrii i warunków początkowych.
- [ ] Root: benchmark przed/po (monotoniczny czas, accepted steps, próby odrzucone, energie/torque, CPU, GPU, transfery, narzut pomiaru), wykresy i aktualizacja raportu. Wzrost steps/s bez zgodności fizyki nie jest sukcesem.
- [ ] Root: wznowienie nowego przebiegu bimeronu z rDMI; kwalifikacja UI oddzielnie od fizyki; commity etapów, PR i integracja zgodnie z governance albo dokładnie zapisana blokada.

## Punkt odniesienia

Istniejący, nieinwazyjny pomiar: 249600 komórek, BB FP64, 242 zaakceptowane kroki / 120.00065 s monotonicznych = 2.0167 kroku/s; średnio 23.85% GPU, worker 2.52 rdzenia CPU, scheduler 0.843 rdzenia. UTC wykazywał skoki; porównania szybkości używają zegara monotonicznego. Ten pomiar dotyczy późnego fragmentu relaksacji; dodatkowy benchmark ze wspólnego stanu początkowego musi jawnie rozdzielać ten czynnik.

## Kryteria odbioru

1. Źródła i wykonywalna próba potwierdzają brak odtwarzania CPU FFT w GPU evaluate.
2. Parytet energii składowych, gradientu/torque i accept/reject dla małej nierównej geometrii z rDMI wyłącznie w filmie; poprawne Stop i completion.
3. Pełne przebiegi schedulera mają ograniczoną częstotliwość, a zakończenie procesu nadal szybko zwalnia zasoby.
4. Każdy objęty punkt wejścia runnera zapisuje zidentyfikowany raport wydajności; pokrycie, batch steps, utracone rekordy, niedostępne metryki i narzut są jawne.
5. Powtórzony pomiar ma identyfikację buildu/runu/GPU, surowe dane, wykresy oraz porównanie z ograniczeniami. Dopiero wynik uzasadnia deklarację przyspieszenia.

## Stan

2 listopada: istniejący worktree i aktywna grupa zweryfikowane, rejestr uaktualniony. Audyt dostępny. Wyniki kolejnych etapów i przebiegów opisano w checkpointach poniżej.


## Checkpoint wykonania i dowody (2 listopada)

Zarządzany backend `fullmag-worktree-fullmag-cfc887ff26db7673` zbudowano bez
kompilowania unit targets. Snapshot `026a10e0ac33fadd918832c60117d7032289fa00d70165b006288035a3db55ef`
potwierdził GPU validation 62/0/0 i parytet CPU/GPU 125/0/0, w tym pola, energie,
torque oraz poprawne lokalne indeksy autosave. Próby completion wykazały osobno
`true/torque` i `false/max_steps`. Kontrolowane Stop zachowało wyniki i zakończyło
worker; ostatnia akceptacja HTTP200 zajęła 0,814 s.

Commity ukończonych fragmentów:

- `26746919d85fcfbef477caf4ba642c5f1b5eae1f`: scheduler cadence oraz fencing Stop;
  147 interpretowanych kontroli źródeł i rzeczywisty Stop.
- `83da5cd3dab1c5e67917fa473d2bfe2c96ca3feb`: rezydentna algebra/redukcje BB CUDA;
  production build i mały parytet CPU/GPU.
- `0c80ebeb691617ef882dde955a9faa1756a67042`: indeksy udanych wierszy per pole;
  GPU 62/0/0 i CPU/GPU 125/0/0; stary błędny artefakt pozostaje niezmieniony.
- `22672e379e52797f2ac1477be0cfb012245e3906`: automatyczny bounded recorder,
  zasoby NVML, pokrycie wejść runnera i raport; 4 interpretowane testy analizatora.
- `57cada853a5db16accfce714b015016b5c9a0993`: zweryfikowany zasób API, hook i panel;
  managed codegen, source typecheck, lint, architecture i API hygiene PASS.
- `40da42b3fff60b5764af884a03460d16aee06e15`: wykonywalny scenariusz browser QA;
  próba `ae11383376064c06bb6db12746d11395` PASS na terminalnym CPU, canvas617×527,
  kontekst WebGL2 niezagubiony, wykres327×109 i wartości panelu zgodne z API.

Najmocniejsze porównanie: identyczny backend plan SHA256
`a445031276fbf93c38fed992a56583ffbd0d1bfbf095669385cdfffb250678ed`, indeks20685,
czas pętliBB 10861,202→1357,373 s (8,0016×). Oddzielne120s okna pokazały
2,0167→15,2000 kroku/s i GPU23,85→91,04%; świeższy snapshot026 dał15,7249 kroku/s,
GPU95,82%, zero strat. Okna dotyczą różnych fragmentów relaksacji, GPU całego
urządzenia. Nie jest to dowód czasu do tolerancji. Callback recorder narzut0,04423%
nie obejmuje pracy niezależnego samplera.

Artefakty naukowe, surowe pomiary, hashe i wykresy:
`/mnt/c/Users/Mateusz/Documents/ChatGPT/Fullmag/bimeron-cylinder-relax/qualification/performance-20261102/`.
Receipty/logi techniczne pozostają w prywatnym wolumenie grupy, w tym browser QA
`/opt/fullmag/control/browser-qa/attempts/ae11383376064c06bb6db12746d11395/result.json`.
Automatyczna retencja po publikacji snapshot026 zakończyła się succeeded,
zachowując current/direct-rollback i usuwając zastąpioną generację; nie wykonano
manualnego prune ani usuwania wyników.

### Ostatnia wykryta poprawka i integracja

Aktywny duży run ujawnił deterministyczny409, którego terminalne próby nie
obejmowały: helper odczytu claimu żądał writera pod utrzymywaną shared read fence.
Poprawka zachowuje fence i weryfikuje dokładny lease przypięty receiptem zamiast
wywoływać helper writer/recovery. Production rebuild `f2ca9a76d13a43128e6aaed7ec9ee75c` zakończył się succeeded; snapshot `e59f47e3a52d2dec4963f0b7ab7d42901e581e1bece01f69793b662d02ba067e` wiąże tę poprawkę z bazą Git `40da42b3fff60b5764af884a03460d16aee06e15`. Aktywny run `run-live-be9d7ca7ea46858a1a81b77fe7ebd9b4f95eb952b67475f5c1ebf9995a598faa` potwierdził wzrost kroków538→605 i sekwencji48→53 oraz ETag304; trzy przejściowe busy odczyty zostały prawidłowo odróżnione od deterministycznego self-conflict. Dowód w `live-api-proof.json`. Browser QA aktywnego runu jest w toku.
Regresja Running pod rzeczywistą shared fence dodana do źródeł; Rust unit NOT RUN
na etapie, gdy obowiązywał jeszcze zakaz kompilacji unit testów (odwołany w dalszym checkpoincie).

PR/merge pozostają zablokowane przez ten zakaz: `.github/workflows/bootstrap.yml`
i `eigensolve-method-contracts.yml` uruchamiają `cargo test` przy otwarciu PR,
także draft. Nie dodajemy skipów i nie osłabiamy CI. Branch można bezpiecznie
wypchnąć (push workflows ograniczają się do master/main). Następny krok po
odwołaniu zakazu: PR do master, wymagane kontrole/review, merge oraz FF głównego
checkoutu. Główny checkout ma obcą zmianę `external_solvers/3` — zachować ją.
Aktywna grupa bimeronu korzysta z worktree i blokuje jego usunięcie; cleanup
końcowy dopiero po kontrolowanym drain i spełnieniu cyklu integracji.


### Odwołanie zakazu i dalsza integracja (3 listopada)

Użytkownik jawnie odpowiedział „Tak — uruchom wymagane CI i integrację” na pytanie
o odwołanie tymczasowego zakazu unit testów. Historyczna blokada powyżej już nie
obowiązuje. Nowe selektory CI obejmują `accepted_run_performance::tests` i dokładny
przypadek `tests::accepted_task_stop_waits_for_writer_before_recovery_without_duplicating_stop`.
Istniejący workflow eigensolve-method-contracts wykonuje pełny `fullmag-runner --lib`.
DEV nie ma jeszcze zgodnej recepty targeted Rust units w stałym backendzie;
wykorzystujemy jawną, autoryzowaną bramkę GitHub CI, bez hostowego Cargo ani
uruchamiania zastępczego kontenera. Root zlecił finalne CI/PR/merge.

Przegląd pięciu commitów mastera (do `8fc1ccb94635370a0b577b9124f8cdf800865aff`)
nie wykazał konfliktów tekstowych ani blokady tego układu: nowe gate RES dotyczą
DMI przez zerowe exchange między aktywnymi sąsiadami jednej siatki i T1/full
boundary correction. Bimeron ma oddzielne siatki ze szczeliną, dodatnie A i scoped
rDMI filmu. Zachować gate oraz wymagane testy RES. Po integracji odrębnie sprawdzić
build i mały parytet CPU/GPU na zintegrowanych źródłach.


### Granica dowodu browser i etykieta fazy

Dwie próby dużego aktywnego modelu (`28cdc6f7bce947da82eec5ad5e69b92e`,
`4d5f0d8001d146b3a188669032c5f0e1`) zakończyły się failed-confirmed w SwiftShader:
pierwsza na DOM viewportu, druga na kliknięciu Engine. Obie miały wcześniej
widoczny canvas617×527, WebGL2 bez utraty kontekstu i brak błędów HTTP/console/page.
Nie uznajemy tego za pełny dowód wizualizacji dużego modelu ani odświeżania jego
panelu. API live oraz terminalny mały browser są oddzielnymi, pozytywnymi dowodami.
Walidator live dopasowuje atomowe odczyty panelu do maksymalnie8 zweryfikowanych
rewizji jednej próby i wymaga dwóch postępujących rewizji. Wyłącznie w jego
performance-only scope pomija jawnie niepowiązane DOM/model-adoption probes,
zachowując Home i canvas checks; nie ukrywa niepowodzeń tych kontroli.

Etykieta „Line search wall” precyzuje, że pole transportowe o historycznej nazwie
`latest_evaluate_host_wall_ns` zawiera inkluzywną fazę line search, nie izolowany
czas pojedynczego evaluate/kernela. Managed frontend source checks po tej zmianie
ponownie przeszły (typecheck, lint, architecture, API hygiene). Nie zmieniono
fizyki, precyzji, tolerancji ani częstotliwości autosave dla uzyskania przyspieszenia.
