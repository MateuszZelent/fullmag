<!-- integration-current-evidence-20261004 -->
## Bieżący stan przed integracją — 2026-10-04

Ten checkpoint zastępuje niższe deklaracje bieżącej liczby punktów,
aktywnych jobów i lokalnych/niewypchniętych zmian. Zachowujemy je jako
datowaną historię, także tabelę statusu wykonania i końcowe wpisy #219.

Istnieje 15 rzeczywistych punktów DE (14 nonzero z managed#228 oraz
Gamma selected-only #227) i dwa osobne dodatnie refinements air1,15.
Raport: [baseline15](../../raports/2026-10-04-de-signed15-runtime.md),
[air refinement](../../raports/2026-10-04-de-air-grading-two-points.md).
Nie są to ukończony wspólny signed15 ani serial/adaptive parity; Gamma
full window, convergence, GUI i A1/COMSOL pozostają OPEN. Wyniki są
completed_unqualified, bez promocji GPU lub produkcyjnego waveguide.

Użytkownik zlecił commit/push całości worktree, synchronizację najnowszego
origin/master i integracjęPR97. Ten etap Git nie kończy naukowego S00–S12.
Runner jest idle/healthy, około1,80GiB wolnego; nie ma aktywnej symulacji
ani nowego buildu nearest. Kompilowane unit tests nadal NOT RUN.

# Adaptacyjne obliczenia dyspersji — wykonanie i bramki

<!-- eps-dimensions-analytic-checkpoint-20261004 -->
## Aktualny checkpoint — wymiary EPS i analityka Γ

Odczyt 2026-10-04T05:29:59.287034+00:00. Całe S00–S12 pozostają OPEN; ten etap nie dodaje zaakceptowanych punktów ani nowego wykresu.

- Commit źródeł `d95053982f3b0447d81df240663d1c9bec721b79` zapisuje rzeczywisty EPSGetDimensions (NEV/NCV/MPD) w istniejących fazach diagnostyki. Signed zera i sentinele są zachowane, nieudany odczyt daje false/null. Odbiornik zachowuje opcjonalne dane osobno w raporcie globalnym, próbce i każdym podoknie; brak historycznego pola nie tworzy pomiaru. Wymiary mogą różnić się między oknami. Operator, konfiguracja EPS/KSP, residual i kryteria akceptacji nie zostały zmienione.
- Natywne oraz Python source review: brak nowych P1/P2. Dokładnie staged nota/mapa naukowa, Python AST i whitespace PASS. 19 interpretowanych testów Pythona PASS; nowe przypadki wykrywają brak zachowania danych w starym odbiorniku (oczekiwany RED). Test C++ actual formattera przygotowano bez kompilacji zgodnie z zakazem. Native getter, świeży pakiet i managed runtime tego przyrostu NOT VERIFIED.
- Niezależna kontrola wcześniejszego Γ #226: raw 9,299249697068216 GHz wobec analityki jednorodnej warstwy 9,299249697068401 GHz, różnica około −0,000185 Hz. Referencja używa tego samego t=10 nm, p=2 µm po każdej stronie, B=0,1 T, Ms=800 kA/m i demag Nz=2p/(2p+t). Model otwartej nieskończonej warstwy daje 9,309813711433354 GHz i nie jest tym samym warunkiem brzegowym. Zgodność częstotliwości nie dowodzi tożsamości modu, nonzero-k ani zbieżności. Kandydat pozostaje odrzucony przez pierwotną bramkę μ₀; artefaktów ani tolerancji nie zmieniono.
- Runner po zgłoszonym restarcie: running=True, worker_alive=True, accepting_jobs=True, worker_error=None. Wolne 2110935040 B (~1.97 GiB) wobec progu 8 GiB; aktywne joby [], ostatni stan koordynatora waiting_for_disk. Ten sam #227 ma stan obserwatora `queued` / `waiting_for_build`. Żywy uchwyt 81829/PID 243032 potwierdzono; nie zgłoszono duplikatu i nie usuwano danych.
- #227 pozostaje przypięty do a8d67ac92002b884799119578a054b518cf40cbf, digest e848950d7d555f4d70d27a71421803fd2566d7e2f57d7e05b22f05da8123e8e6: zawiera poprawkę μ₀, bez późniejszych EPS termination/dimensions ani S09. Po terminalnym sukcesie publiczny managed dry-run ma poprzedzić pojedynczy Γ nearest; przyjęcie wymaga rzeczywistych artefaktów. Pełne frequency_window wymaga później świeżego pakietu z diagnostyką i kontrolowanego strojenia.
- S09 pozostaje OPEN: atomiczny typed cutover musi objąć ProblemIRV04/Wire.study, StudyIR wraz z pozostałymi payloadami, migrację i round-trip, obecność BC, planner, geometryczne certyfikaty siatki/regionów/ramy oraz MFEM 2.5D. Dotychczasowe guardy i propozycje kontraktu nie są produkcyjnym providerem. API/UI/FMS/WebGL, serial/adaptive parity i pomiar puli, signed15, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR97/integracja nadal OPEN.

Dowody w katalogu preview-state-checkpoint wizualizacji wątku: eps-dimensions-final-staged-validation.json, eps-dimensions-native-review.md, eps-dimensions-consumer-review.md, eps-dimensions-consumer-source.md, eps-dimensions-regression-baseline.json, gamma226-finite-air-analytic-comparison.json i gamma226-finite-air-analytic-audit.md. To osobne dowody źródeł i kontroli wcześniejszego raw wyniku, bez nowej kwalifikacji solvera.


<!-- eps-termination-spatial-checkpoint-20261004 -->
## Aktualny checkpoint — diagnostyka podokien i S09 na remote

Odczyt 2026-10-04T04:47:21.413299+00:00. S00–S12 pozostają OPEN; nowych zaakceptowanych punktów jest zero.

- Poprawka EPS `091a046970b2256c85813c5ea4761377496c5e57` zachowuje rzeczywisty signed kod zakończenia i liczbę iteracji osobno dla każdego podokna; dostępny kod błędu 0 nie usuwa zmierzonych danych. Brak odczytu, hard error oraz nieważny kontekst pozostają false/null. Review: jeden P2 zamknięty źródłowo, bez nowych P1/P2; dokładnie staged dokumentacja naukowa i whitespace PASS. Regresja rzeczywistego formattera przygotowana, niekompilowana zgodnie z zakazem. Native/runtime NOT VERIFIED. Nie zmieniono operatora, tolerancji, budżetów ani kryteriów akceptacji.
- S09 `c667a41779a6cba20d917983b674563b1e3f929f`: historyczne readery/migratory odrzucają obecność spatial_representation, także null, zamiast tracić intent. Nowa nota 0833 i specyfikacja 2.5D są propozycją kontraktu; typed ProblemIRV04 i produkcyjny provider MFEM 2.5D nadal OPEN. Kontrole naukowe, parser Rust bez kompilacji i review źródeł PASS; siedem wcześniejszych niezmienionych kontroli algebraicznych pozostaje aktualne. Nie uznano tego za kwalifikację solvera 2.5D.
- Korekta diagnozy Γ #226: układ split ma 1312 stopni swobody, magnetyczne q ma 656; limit dokładnego preconditionera 512 sprawdza split_count. Nearest i frequency_window różniły się również KSP/preconditionerem oraz NEV/NCV, więc nie stanowią kontrolowanego A/B. Z brakujących kodów podokien nie można wywieść rzeczywistej przyczyny siedmiu slepc_diverged. Pełne okno nadal OPEN; kandydat nearest 9,299249697068216 GHz został odrzucony przez bramkę μ₀ i nie jest nowym zaakceptowanym punktem.
- Runner po restarcie: worker_alive=True, accepting_jobs=True, worker_error=None; wolne 2184069120 B (~2.03 GiB), próg admission 8 GiB. Job #227 `d2a6c2dd0c3c4a66a1e05fce10bb32c7` ma stan `queued`. Nie zgłoszono duplikatu, nie usuwano danych ani cache.
- Jeden żywy kontroler sesji 81829 (PID 243032) obserwuje job #227; faza `waiting_for_build`. Po succeeded/exit0 i publicznym managed dry-run uruchomi tylko nową próbę nearest Γ 9,3 GHz na modelu 71ba0d18225ffcc83f7f18e676de8dc051e87fd1, L2/t3. Wynik wymaga walidacji artefaktów, μ₀, demaga, residualu i binding. Kontroler nie kwalifikuje pełnego okna ani 15-punktowego sweepu.
- Ważna tożsamość źródeł: #227 kompiluje commit a8d67ac92002b884799119578a054b518cf40cbf z poprawką μ₀; nie zawiera S09 ani nowej diagnostyki EPS. Następny eksperyment całego okna wymaga świeżego pakietu tej diagnostyki po zakończeniu bieżącej bramki; queued nie oznacza wykonania. API+UI/FMS/WebGL, serial/adaptive parity i pomiary CPU/RAM, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR #97/integracja pozostają OPEN. Wykres nie otrzymał nowych punktów.

Dowody w katalogu evidence wątku: `preview-state-checkpoint/eps-termination-staged-validation.json`, `eps-subwindow-termination-review.md`, `spatial-contract-staged-validation.json`, `spatial-presence-guard-review.md`, `gamma226-window-convergence-audit.md`, `eps-plan-live-checkpoint.json`, `gamma227-nearest-controller-state.json`.

Data: 2026-10-02. Zakres: FEM CPU, niezależne punkty k na jednej przyjętej równowadze. Status: implementacja; runtime, GUI i kwalifikacja wydania pozostają otwarte.

## Decyzja i semantyka

Właścicielem solvera pozostaje MFEM/PETSc/SLEPc w backends/fem. Rust orkiestruje oddzielne procesy, ponieważ współdzielenie kontekstów natywnych pomiędzy wątkami nie jest bezpiecznym sposobem równoległego liczenia k. Nie zmieniamy demaga, tolerancji residualu, operatora ani precyzji.

Polityka `parallel_execution` należy do `runtime_metadata.runtime_selection` ProblemIR i jest jawnie zachowana w skrypcie oraz zasobie Study. Pola: mode serial/adaptive, max_cpu_percent 90, max_memory_percent 80, memory_reserve_bytes 1073741824, max_workers null, threads_per_worker 1. Brak polityki zachowuje historyczne wykonanie szeregowe. Wybór adaptive uruchamia pomiary i pulę procesów.

CPU percent oznacza procent efektywnego przydziału Fullmaga: minimum affinity, limitów CPU cgroup i alokacji zadania HPC. Jest to **docelowy limit dopuszczania pracy**, nie gwarancja twardego pułapu chwilowego użycia CPU. Twarde limity systemu lub kontenera są nadrzędne. UI musi podać to rozróżnienie. Domyślne wartości są polityką wykonania, nie stałymi fizycznymi.

## Harmonogram

1. Odczytaj rzeczywisty przydział CPU, pamięci, zużycie i źródła ograniczeń. Brak, błędny lub nieaktualny pomiar zamyka admission, zamiast oznaczać pusty host.
2. Uruchom jeden punkt kalibracyjny w osobnym procesie. Ustaw wszystkie obsługiwane pule wątków zgodnie z threads_per_worker. Zachowuj szczytowe CPU i RSS przez wszystkie fazy; nie zastępuj szczytu próbką z bezczynnego solvera.
3. Dopiero po zakończeniu pierwszego punktu oszacuj pojemność CPU i RAM. Dodaj 10% do zmierzonego szczytu CPU i 25% do szczytu pamięci, odejmij rezerwę oraz obciążenie innych konsumentów. Respektuj max_workers.
4. Zwiększaj pulę najwyżej o jeden proces na 5 sekund. Przy wzroście obciążenia wstrzymaj nowe przyjęcia i pozwól aktywnym obliczeniom zakończyć się. Nie zabijaj zaakceptowanych punktów tylko dlatego, że zmienił się cel CPU.
5. Każdy worker dostaje niezmienne, zweryfikowane źródło równowagi i siatki, osobny namespace artefaktów, sample_index oraz identyczne polityki solvera. Nie relaksuje ponownie modelu. Bias-field continuation pozostaje szeregowe.
6. Agreguj zaakceptowane wyniki w kolejności zadanych k, a następnie zastosuj istniejące śledzenie pasm. Kolejność zakończenia procesów nie może zmieniać tożsamości modów.
7. Zapisz requested policy, resolved allocation, historię admission, szczyty, liczbę procesów i przyczyny wstrzymania. Błąd jednego punktu zachowuje logi oraz wyniki, ale nie staje się wynikiem fizycznym.

## Etapy i kryteria akceptacji

| Etap | Kryterium | Stan |
|---|---|---|
| Typ polityki i walidacja | finite procenty (0,100], dodatnie limity procesów/wątków, zachowanie requested | Źródła gotowe; Python PASS; kompilacja #211 PASS, runtime failed |
| Pomiar alokacji | affinity, hierarchiczne cgroup CPU/RAM, HPC allocation; jawne unavailable | Źródła i review gotowe; runtime otwarty |
| Admission | jedna kalibracja, szczyty, RAM margin, cooldown, brak admission przy braku pomiaru | Źródła i review gotowe; runtime otwarty |
| Worker procesowy | izolacja kontekstu, immutable equilibrium, cancellation i czyste namespaces | Źródła i review gotowe; runtime otwarty |
| Python/IR/UI round-trip | ustawienie UI trafia do skryptu, IR i wykonania | Python i produkcyjny TypeScript PASS; OpenAPI/build/browser otwarte |
| Telemetria UI | obciążenie, resolved workers, target i powód oczekiwania | Źródła i produkcyjny TypeScript PASS; managed UI/browser otwarte |
| Managed build | build produkcyjny bez kompilowania unit tests, źródło przypięte | #211 native-build PASS, availability timeout120s; #213 cancelled exit143; nowe sparowane obrazy wdrożone, #216 zgłoszony |
| Runtime parity | serial/adaptive ten sam model i k: residual, częstotliwości, hashe siatki/równowagi | Otwarte |
| Browser proof | działające ustawienia i rzeczywiste wyniki, widoczny canvas/WebGL | Otwarte |
| Wydajność | porównanie czasu i szczytu RAM; brak deklaracji speedup bez pomiaru | Otwarte |

Testy kompilowanych jednostek pozostają zakazane zgodnie z AGENTS.md. Można zapisać regresje, wykonywać lekkie testy Pythona i kwalifikować produkcyjny build przez FIFO runnera.

## Odniesienie do COMSOL

COMSOL rozdziela liczbę równoległych zadań i rdzeni na zadanie oraz wymaga, żeby modele mieściły się w pamięci. Nasza polityka pomiarowego admission jest własnym rozwiązaniem Fullmaga; nie twierdzimy, że COMSOL stosuje identyczny regulator 90%.

Źródła: [Batch/cluster sweeps](https://www.comsol.com/support/knowledgebase/1250), [Multithreading](https://www.comsol.com/support/knowledgebase/1096), [Równoległe modele i pamięć](https://www.comsol.com/support/knowledgebase/866).

## Odrębne problemy bieżącej kampanii

Wyniki +10 i -10 rad/µm są zaakceptowane przez obecne bramki residualu; nie stanowią pełnej zbieżności siatki/airboxu ani walidacji COMSOL A1. Pierwsze nowe ±2 nie przeszły shift-invert GMRES, więc kampania zatrzymała się po pierwszej parze. Zrównoleglenie nie naprawia tej awarii numerycznej. Potrzebny jest nowy managed SLEPc runtime z aktualną poprawką i ponowienie w osobnym katalogu prób. Build #207 dotyczy pary API/UI czytającej rzeczywiste FMS; nie zastępuje builda solvera SLEPc.
## Checkpoint implementacji źródłowej

Polityka IR, pomiary Linux cgroup/affinity/HPC, admission oraz ustawienia
Python/API/UI są zapisane w worktree. Review ujawniło problemy świeżości i
zakresu alokacji; poprawki zamykają admission przy braku wiarygodnej próbki,
używają rzeczywistego dostępnego RAM i zachowują limity nadrzędne. Pierwsza
próbka cgroup wymaga pełnego przedziału czasowego; nie oznacza wolnego CPU.

React Doctor lokalnej wersji, scope changed dla czterech zmienionych plików
panelu, zakończył się kodem 0 bez nowych problemów. Regresje kompilowane
pozostają niewykonane. Trwa review process-pool, w tym sukces kalibracji,
bootstrap zaakceptowanego handoffu Relax i działanie workera z CLI oraz API.
Nie przedstawiamy źródeł jako zaliczonego managed runtime.

Build GUI #207 zakończył się błędem TypeScript; poprawkę zapisał commit
5fa251fb184f31ac39144afda082af5b0fddcbef, production-module type check PASS.
#208 e29bc7499aad4377ad0a9ff58975edff zakończył się terminalnym sukcesem (exit 0): backend i frontend produkcyjny PASS. Nie zawiera niezatwierdzonych zmian adaptacyjnych. Build SLEPc adaptacyjnego wykonania #209 został zgłoszony po review źródeł. Kolejka jest zdrowa i przyjmuje zadania.

### Publiczne ustawienia

W istniejącym skrypcie modelu, przed uruchomieniem zadania:

```python
fm.engine("fem")
fm.device("cpu")
fm.parallel_execution(
    mode="adaptive",
    max_cpu_percent=90.0,
    max_memory_percent=80.0,
    memory_reserve_bytes=1024**3,
    max_workers=None,
    threads_per_worker=1,
)
```

Pierwszy zakres adaptive wymaga jawnie wybranego FEM CPU; ustawienie auto,
FDM lub GPU nie otrzymuje cichej zmiany realizacji. Ustawienia dotyczą
kolejnego zaakceptowanego uruchomienia niezależnego k-path
FEM CPU. Nie mutują polityki już uruchomionej kampanii ani tolerancji solvera.
`max_workers=None` pozwala regulatorowi oszacować liczbę procesów; nie oznacza
nieograniczonej liczby równoległych solverów. UI prezentuje rezerwę w MiB,
a skrypt/IR zachowują jednostkę bytes. Nie pomijamy nieznanych pól ani nie
zaokrąglamy błędnych limitów do poprawnych wartości.

Dla pierwszego uruchomienia telemetry Linux wymaga cgroup v2 i skończonego
limitu pamięci cgroup lub potwierdzonego limitu Slurm. PBS/SGE bez poprawnego
cgroup RAM pozostają unavailable; pamięć całego współdzielonego węzła nie
jest zastępczą alokacją zadania. Cgroup v1 i natywny Windows wymagają osobnego
samplera; obecne wykonanie FEM odbywa się w managed Linux.

Potwierdzone lekkie bramki: 3 testy Python polityki i round-trip, 11 subcases
walidacji (PASS). Pierwsza lokalna kontrola typów dotarła do brakujących deklaracji
zależności. Późniejsza kontrola produkcyjnego frontendu z rzeczywistymi
deklaracjami zakończyła się PASS (szczegóły na końcu tego checkpointu).
Managed build i browser proof pozostają otwarte. Nie kompilowano testów
jednostkowych.

### Review granic wykonania i zasobów

Mapa redukcji Floqueta jest tworzona osobno dla każdego planu Single k,
włącznie z bootstrapem Relax→Eigen; mapa dla całego Path była błędem i
została usunięta. Wspólny guard trzech wejść runnera odrzuca adaptive dla
nieobsługiwanych workflow przed wejściem do solvera. Single k i wymagany
Relax mają jawne szeregowe rozstrzygnięcie, a nie deklarację wielu procesów.

React Doctor po ostatniej korekcie rezerwy RAM: 4 pliki, exit 0, bez usterek.
Brama natywna puli nadal wymaga managed builda i rzeczywistego porównania
serial/adaptive. Pierwszy punkt jest kalibracyjny: przed jego zakończeniem
nie znamy szczytowego working set. Dostępny RAM, rezerwa i twardy limit
cgroup chronią przydział, ale nie stanowią dowodu, że sam probe nie ulegnie
OOM przy zbyt małej pamięci. Nie deklarujemy gwarancji uniknięcia OOM ani
twardego chwilowego limitu CPU 90%.

### Zamrożony build #209 i kolejna bramka

Job `21f2ba8564ce47f4a1a167f374948113`, profil
`fem-cpu-slepc-runtime-v2`, był uruchomiony w pierwszym checkpointcie.
Zakończył się błędem kompilacji opisanym poniżej; aktualnym retry jest #211.
Nie uruchamiano ciężkiego builda poza kolejką.
Źródła są niezmiennym snapshotem:
`d3744ef4a9f3dc66616098baf009cb55f364fbe586523d8cfddf6ea135363db4`;
native source identity:
`9c723105a11e0bc04fda61462aaba3f7e80f0caee5d4b1cd2ed81b86a492ef67`.
Kapsuła: `cb130fd577d548bcaf1aede92df88ed4/source/tree`.

W snapshotcie są izolowane procesy, walidacja ich binariów i wejść, pomiary
CPU/RSS (w tym VmHWM i terminalne getrusage), kalibracja udanego punktu,
stopniowe admission oraz ograniczony dziennik decyzji. Źródła ustawień
Python/API/UI są przygotowane. To nie jest jeszcze zaliczony runtime ani
wdrożony panel: wymagane są terminalny receipt, rzeczywisty eksport OpenAPI,
regeneracja klienta, build produkcyjnego GUI i kontrola w przeglądarce.

Po buildzie porównamy serial/adaptive na tych samych certyfikatach,
wektorach k i tolerancjach. Najpierw mała kampania z poprawnie policzonymi
±10 rad/µm, co najmniej trzy punkty oraz przydział pozwalający na dwa
procesy. Powtórzone k w teście wykonania nie będą prezentowane jako nowe
punkty dyspersji. Obowiązkowe dowody: rzeczywiste nakładanie czasu procesów,
zgodność częstotliwości i residualu, identyczność równowagi/siatki, kolejność
sample_index, peak RAM oraz wall time. Cancel i presja zasobów wymagają
odrębnych prób; brak speedup jest poprawnym wynikiem pomiaru.

W aktualnym readerze #208 potwierdzono import rzeczywistego wyniku +10,
30012 elementów FEM, częstotliwość 11.205285324 GHz i działający WebGL.
Import wymagał kopii archiwum z usuniętym wyłącznie odtwarzalnym cache
preview; oryginał i wyniki nie zostały zmienione. Błąd deserializacji
numerycznych kluczy domen w tagowanym PreviewState został poprawiony w
źródłach po zamrożeniu #209 i wymaga kolejnego buildu oraz importu oryginału.
Podgląd authoring sceny i ustawienia adaptacyjne nie są jeszcze zaliczone.
### Wynik kompilacji #209

Job zakończył się `failed`, exit 2. Natywna kompilacja dotarła do Rust
fullmag-runner, który zgłosił osiem błędów wynikających z czterech przyczyn:
brak importu HashSet w prywatnym module artefaktów, brak importów typów
SingleKModeResult/SingleKSolveResult, zbyt wąska widoczność helpera planu
Single k dla sibling process-pool oraz brak mut w callbacku progress.
Przyczyny poprawiono w bieżących źródłach bez zmiany operatora fizycznego,
listy punktów i tolerancji. Błędy oraz failed capsule pozostają zachowane.
Źródłowe review i nowy produkcyjny build są wymagane; #209 nie jest runtime
ani kwalifikowanym bundlem i nie zostanie użyty do solvera.
### Retry #211 i poprawka danych viewportu

Job `c554c5361f014228a301380b8ed3487c`, sequence 211, został przyjęty do
FIFO jako `queued`, za aktywnym #210 z głównego checkoutu. Runner jest
zdrowy, bez worker_error. Nie zmieniono kolejności zadań ani nie uruchomiono
budowania poza koordynatorem.

Source digest: `b85acbd0d354acf7f554f72e8697c06c1508de8ff9d51fcbd8831aa38aad452c`.
Native snapshot: `501308a35be5cfd1fafbbb83831f48efbef988ddd0d5dadf5ec33e0f18cd30ca`.
Kapsuła: `0e2f657589ad4c23b3e7a574505849c0/source/tree`.
Zawiera cztery poprawione przyczyny błędów Rust oraz poprawkę PreviewState.
Źródłowe review zmian kompilacji: PASS, brak zmiany operatora/tolerancji.

Read-only pomiar GUI pokazał poprawny binary topology (1391984 B) oraz
katalog pola m. Pięciosekundowy deadline kończył sekwencję header/full/decode
przed przyjęciem topologii. Lokalna polityka topology ma teraz 15 s; globalny
limit pozostaje 5 s, cancellation i granice sesji nie zostały poluzowane.
Timeout opcjonalnego overlay periodic-pairs zachowuje stan error i
diagnostykę, lecz nie emituje toasta awarii całego viewportu; inne błędy
pozostają widoczne. Są zapisane regresje, ale nie kompilowano ich zgodnie z
zakazem. React Doctor: 10 zmienionych plików, exit 0, bez usterek. Produkcyjny
frontend i post-fix browser proof wciąż wymagają osobnej bramki.
### Produkcyjna kontrola typów frontendu

Kontrola `tsc --noEmit` dla StudyGlobalAuthoringModel, StudyInspectorPanel,
useResource, studyRuntimeResources i viewport3dResources wraz z ich
produkcyjnymi importami zakończyła się exit 0. Wykorzystano rzeczywiste
zainstalowane deklaracje: React 19.2.4 i TypeScript 5.8.3 zgodne z package.json;
React/Three mapują do deklaracji @types, bez atrap modułów. Tymczasowa
konfiguracja jest poza repo w katalogu wizualizacji i nie zmienia projektu.
Sprawdzono listę wejść: brak źródeł testowych. Wcześniejsze błędy missing
React były błędem diagnostycznego rozwiązywania zależności, a nie zielonym
wynikiem; poprawny finalny przebieg ma exit 0. Kontrola typów nie zastępuje
managed frontendu, aktualizacji OpenAPI ani post-fix browser proof.
### Przygotowanie porównania serial/adaptive

Sterownik zamkniętej próby `run-de-smoke-parallel-probe` przypina runtime
#211, model oraz manifest wejściowy. Każdy wariant ma trzy próbki
[-10, +10, -10] rad/µm, jeden mod na próbkę, identyczne parametry materiału,
siatkę i tolerancje. Powtórzenie -10 służy kontroli powtarzalności i nie
stanowi dodatkowego punktu dyspersji. Kontener próby ma przydział 4 CPU i
8 GiB RAM; polityka adaptive: cel CPU 90%, RAM 80%, rezerwa 1 GiB,
maksymalnie 2 procesy, jeden wątek na proces.

Kontrole interpretowane: 9 nowych regresji oraz 31 istniejących regresji
pilota PASS. Walidator sprawdza oba pola source_hash, kanoniczną politykę
runtime oraz dokładnie jeden mod raw_mode_index=0. Dry-run recepty wskazuje
#211 i właściwy wariant. Cleanup obejmuje oba zewnętrzne mounty read-only.
Artefakt równowagi jest wejściem solvera; sidecar linearization_state.v6
pozostaje referencją provenance, a linearizacja nowego k jest obliczana
ponownie. Te kontrole nie dowodzą równoległego wykonania ani przyspieszenia.
Build #211 nadal queued; oba rzeczywiste przebiegi i porównanie wyników
pozostają NOT VERIFIED.

Osobno dodano obserwację konfiguracji KSP przed EPSSolve, aby zachować
informację o stronie preconditionera i normie po twardej awarii solvera.
Zmiana nie modyfikuje operatora ani tolerancji. Przygotowana regresja
natywna nie została skompilowana; ten późniejszy kod nie należy do
zamrożonej kapsuły #211 i wymaga kolejnego managed buildu.
### Aktualizacja kolejki

Ostatni odczyt koordynatora: #211 zmienił stan na running, exit_code=null,
error=null. Powyższy zapis queued jest wcześniejszym checkpointem. Build nie
został jeszcze zakończony ani zakwalifikowany do próby runtime.

### Checkpoint: domeny CPU, telemetria i zamknięta próba

Review źródłowe samplera i admission nie znalazło blokera. Dostępna
pojemność CPU jest przecięciem wolnych rdzeni affinity i ograniczeń cgroup;
procent zajętości dotyczy przydziału procesu. Admission korzysta z minimum
wolnej pojemności i headroom do celu CPU, bez odejmowania własnego zużycia
z innego interwału. Pole cpu_available_cores jest przeprowadzone do UI.
W środowisku HPC wymagany jest zgodny cpuset/cgroup; zmienne schedulera
stanowią konserwatywny limit, nie dowód placementu wielozadaniowego.

Aktualna kontrola produkcyjnych typów frontendowych: exit 0, 799 wejść,
zero test/spec, identyczne hashe siedmiu źródeł przed i po sprawdzeniu.
Dowód: adaptive-live-telemetry-production-types.json w katalogu wizualizacji
wątku. Generacja OpenAPI, managed frontend i browser proof pozostają otwarte.

Sterowniki wykonania: 64 interpretowane regresje PASS (10 probe, 22 cleanup,
32 pilot). Cleanup odczytuje tmpfs z HostConfig.Tmpfs, zgodnie z rzeczywistym
Docker inspect; bind mounts pozostają sprawdzane osobno. To nie jest zgoda
na usunięcie kontenera ani dowód równoległego wykonania.

#211 pozostaje running. Sprawdzono rzeczywisty kontener i żywe procesy
produkcyjnego make/cargo/rustc. Późniejsza korekta domen CPU oraz live
telemetry nie należą do jego kapsuły i wymagają następnego managed buildu.
Próba serial/adaptive może rozpocząć się dopiero po poprawnym terminalnym
receipcie; przyspieszenie, nakładanie procesów i zachowanie pod presją RAM
pozostają NOT VERIFIED. Fizyczny próg residualu 1e-8 jest niezmieniony.

### Nowa kapsuła #213

Aktualne źródła adaptacyjnego admission, pomiaru domen CPU i live telemetry
zostały przyjęte do FIFO jako job #213:
9e4d278669bc4d92a8895294b7e19db6, profil fem-cpu-slepc-runtime-v2.
Source digest: 24c6ca1a1f4ac258e720411fe31491c86626f529d33a665d25f27bac12095332.
Native snapshot: 15cfdc198ffab5ece678df3be63dac19a4b9f155ff18f4561ed4e97257c49f53.
Kapsuła: bbb9a501a6c649618732f6321f344952/source/tree.
Stan przyjęcia: queued. Profil kompiluje produkcyjny runtime bez testów
jednostkowych i bez frontendowego bundla. Nie zatrzymano #211 ani nie
zmieniono kolejności FIFO. #213 nie jest jeszcze dowodem runtime.

Dodatkowo ponownie przeszły trzy interpretowane testy publicznego Python DSL:
kopiowanie runtime selection, walidacja polityki i round-trip scene document.

### Terminalny wynik #211 i bramka miejsca — 2026-10-03

#211 zakończył się failed/exit2. Kompilacja produkcyjna native-build przeszła
(exit0), lecz `fullmag-bin runtime fem-availability --json` przekroczył
120s. Nie wykonano próby serial/adaptive na failed receipcie. Proces był
rzeczywiście żywy i zużywał około jednego CPU przed timeoutem; timeout
pochodzi z executora, a nie z obserwatora. #203 miał ten sam image i MFEM
4.10.0 CPU, więc brak podstaw do przypisania regresji samej aktualizacji MFEM.

Poprawka zachowania partial stdout/stderr w trusted helperze jest w lokalnym
commicie 4bb7c3736808ca7e194782292cc9beda99e0356f. 42 interpretowane regresje
PASS; timeout120s i twarda bramka pozostają. `exited_zero` oznacza wyłącznie
proces, nie zaliczenie atestacji; `validation=not_assessed`. Helper nie jest
wdrożony w aktualnym coordinator image, nie ma go w trusted bundle #211/213.

Runner health: worker_alive=true, accepting_jobs=true, bez worker_error i
bez aktywnego joba; last_result=waiting_for_disk. Wolne storage6793510912B,
pod progiem8GiB. #212 i #213 są queued. Nie usunięto żadnych danych;
operator został poproszony o dodatkowe miejsce. Pełny cel pozostaje active.

Sonda Schura ma opcjonalny sterownik `--schur-action-diagnostic`; domyślnie
wyłączona i niedopuszczona dla zamkniętej próby #211. Limit mierzonego
`action_count` to dokładnie9; failed/unavailable zachowują częściowe0..9 i
nie otrzymują statusu pass. Poprawka unavailable przed setupem jest późniejsza
od kapsuły #213. To obserwacja operatora, nie fizyczny certyfikat.

### Review admission po anulowaniu — 2026-10-03

Poprawiono bramkę między callbackiem Stop/Pause a uruchomieniem workera.
Jeśli callback zażąda anulowania, dodatni budget nie uruchamia już nowego
procesu w tej samej iteracji; istniejąca ścieżka cancellation kończy aktywne
procesy. Rustfmt oraz interpretowana kontrola kolejności source PASS.
Regresja Rust została przygotowana, lecz nie była kompilowana ani uruchamiana.
Zmiana jest późniejsza od kapsuły #213 i wymaga przyszłej weryfikacji runtime.

Ostatni odczyt runnera: 6765400064 B wolnego, waiting_for_disk, zero aktywnych
jobów. Nie zmieniono FIFO ani danych. CPU90% pozostaje celem admission,
nie gwarancją twardego limitu chwilowego zużycia procesora.

### Pojedynczy snapshot dostępności FEM

Lokalny commit 3ccd540c22b2ef2c848f5424b724af9f00d9a837 używa jednego
NativeFemGpuStatus do CPU i GPU w odpowiedzi runtime fem-availability.
Pola JSON pozostają identyczne; oba konstruktory fixture typu zaktualizowano.
Jednorazowa kontrola źródeł2/2 i staged diff check PASS. Nie kompilowano
testów Rust. Globalny rustfmt --check trzech plików zgłosił istniejące
rozbieżności formatowania; formattera nie uruchomiono na pozostałych zmianach.
Nie twierdzimy, że usunięcie drugiego probe rozwiązuje hang #211.


### Review zasobów i zabezpieczenia puli — 2026-10-03

W kolejnym review źródeł poprawiono:

- Limit wątków jest przekazywany przez środowisko dziecka przed exec, aby
  konstruktory bibliotek także widziały budżet. Wspólna lista obejmuje
  OMP_THREAD_LIMIT, OMP_DYNAMIC=FALSE i MKL_DYNAMIC=FALSE; nie modyfikuje
  środowiska rodzica.
- Odczyt końcówki logu używa seek/take i alokuje najwyżej 1 MiB, zamiast
  czytać cały plik do RAM. Limit dotyczy końcowego dowodu, nie rozmiaru
  pliku podczas aktywnego wykonania.
- Kolejne błędy rozgrzewania/resetu telemetrii mają 30 s limitu ponawiania.
  Poprawny pomiar resetuje ten licznik. Przekroczenie zamyka admission;
  aktywne procesy kończą się, a pozostałe próbki nie są uruchamiane.
  To limit operacyjny samplera, bez zmiany tolerancji solvera.
- Terminalny CPU getrusage jest średnią interwału, a RSS szczytem procesu.
  Jeśli brak okresowej próbki CPU krótkiego workera, admission rezerwuje
  pełny budżet jego wątków przyjęty przez rodzica. Nie nazywa średniej
  zmierzonym szczytem. Brak terminalnych danych nadal blokuje kalibrację.
- Provenance uwzględnia cgroup_v2_cpu_usage także przy cpu.max=max.
  Limit pamięci ze zmiennych Slurm wymaga SLURM_JOB_ID.

Rustfmt trzech zmienionych plików oraz git diff --check PASS. Regresje Rust
zapisano, ale zgodnie z zakazem nie kompilowano ani nie wykonywano ich.
Zmiany są późniejsze od kapsuły #213. Managed runtime, pomiar przyspieszenia,
serial/adaptive parity i nowe ustawienia w działającym GUI pozostają otwarte.

Rzeczywista diagnostyka startupu #211 wykazała timeout także dla --help,
przed stemplem wejścia do main; log loadera kończy się na inicjalizacji
cublasLt. Nie dowodzi to błędu operatora eigensolve ani wewnętrznej przyczyny
NVIDIA. Szczegóły: [audyt zależności startupu](../../audits/2026-10-03-fem-cpu-startup-cuda-dependency-audit.md).
Rozszerzenie o izolowane CDLL CUDA/HYPRE odrzucił auto-review jako dodatkowy
zakres; pytanie o jawne zatwierdzenie jest otwarte. Nie obchodzono odmowy.

Bieżący runner health: worker_alive/accepting_jobs=true, brak aktywnych
jobów, waiting_for_disk, storage_free_bytes=6782971904. Kolejka FIFO nie
została zmieniona. Nie usunięto danych. Źródła nie są dowodem wdrożonego UI.

Końcowy read-only review przyrostu admission nie znalazł nowego P1/P2.
Budżet CPU krótkiego workera pochodzi z wartości zapisanej przez rodzica;
przy natychmiastowym zamknięciu telemetrii journal zachowuje przyczynę.
CPU90% pozostaje celem alokacji Fullmaga, nie globalną gwarancją użycia
całego węzła przez wszystkich konsumentów. Regresje Rust pozostają nieuruchomione.

Lokalny checkpoint diagnostyki: 237243e13e665fee237513da480e0e656066615d (5 plików).
Osiem interpretowanych regresji PASS; walidacja realnego zatrzymanego
kontenera Docker PASS bez startu i bez nowych sond. Nie opublikowano
niezweryfikowanego przyrostu adaptive; full runtime/UI/science nadal otwarte.

Live admission jest samplowany także po przyjęciu ostatniego punktu,
a ostatnie zdarzenie puli ma aktualne active/pending counts. Review nie
wykazał ryzyka dodatkowego spawn/indexowania przy pending=0. Jeśli końcowy
pomiar jest niedostępny, raport zachowuje terminal_telemetry_unavailable;
nie tworzy sztucznego CPU/RAM. Przygotowano regresję no_pending_samples,
bez kompilacji. UI review wskazało stale dane podczas invalidation oraz
maskowanie malformed import — poprawki źródłowe są w toku. Wygenerowany
OpenAPI wymaga przyszłego eksportu z nowego managed API i nie jest
ręcznie podmieniany. Browser/runtime pozostają NOT VERIFIED.


### Końcowy checkpoint źródeł UI/API — 2026-10-03

Poprawiono stale zasób etapów: loading/stale/error wygasza dane, a ready
wymaga zgodnych session_id/session_epoch/run_id. Backend publikuje te
identyfikatory z tego samego snapshotu co stage records; wspólny helper
zachowuje dotychczasową semantykę epoch. Brak identity w starym API jest
niedostępnością, nie podstawą do wymyślania identyfikatorów klienta.
Review źródłowe identity/epoch/scope PASS. Regresje API/React przygotowano,
ale zgodnie z zakazem nie kompilowano ani nie wykonywano ich.

Malformed policy import pozostaje błędem: bool/whitespace/zły kształt/
nieznany mode nie stają się domyślnym serial ani liczbą. UI wyjaśnia,
że CPU/RAM/reserve/workers sterują wyłącznie adaptive i następnym runem.
W trakcie kontroli produkcyjnej poprawiono brakującą nazwę zmiennej
w komponencie (używa stageExecution zwróconego już po scope guardzie).

Produkcja TypeScript PASS: 799 plików, zero test/spec, niezmienione hashe
czterech źródeł w trakcie kontroli. Zachowano poprzedni failed wynik.
Dowód: adaptive-ui-scope-production-types-20261003-v2.json w wizualizacjach
wątku. React Doctor 0.9.12, scope changed vs HEAD: exit0, complete=true,
14 źródeł (lint/AST, bez kompilacji testów), brak nowych diagnostyk; brak
sieci i wysyłania telemetrii. Dowód: adaptive-ui-react-doctor-20261003.json.

Generated OpenAPI JSON/types nadal nie zawiera nowych identity/pól
parallel_execution/schematu telemetry. To blocker zgodności kontraktu,
nie naprawiamy go ręcznie. Wymaga eksportu z nowego managed API.
#213 nie zawiera późniejszych poprawek admission ani identity; przyszła
kwalifikacja musi przypiąć nową kapsułę aktualnych źródeł. Nie wykonano
serial/adaptive runtime, nowego browser proof ani pomiaru przyspieszenia.
Pełny cel S00–S12 pozostaje aktywny; dwa punkty ±10 nie są pełną dyspersją.

### Kontrakt tożsamości OpenAPI — 2026-10-03

Odczyt kodu generatora utoipa 5.5.0 potwierdził, że `serde(default)` oraz
`Option` domyślnie wyłączają wymagalność pola w schemacie. Dodano jawne
`schema(required = true)` dla session_id/session_epoch/run_id zasobu
StageExecutionResource; run_id pozostaje nullable i jest zawsze serializowane.
Historyczny odczyt przez serde nadal akceptuje brakujące pola, natomiast żywe
UI wymaga pełnej tożsamości. Przygotowano regresję schematu; nie kompilowano
ani nie uruchamiano testów jednostkowych. Eksport z nowego produkcyjnego API
oraz regeneracja klienta pozostają NOT VERIFIED; nie edytowano ręcznie
wygenerowanych plików.

### Warunek kwalifikacji runtime — 2026-10-03

Lokalny commit c8394a502f4326f83808e9cd537fb717a5af6cd5 domyka pełny stos modalny CPU w operatorowym wrapperze i kontraktach receiptów; 67 lekkich kontroli PASS. Nie wdrożono obrazu. Adaptacyjny scheduler i ustawienia UI pozostają źródłowo przygotowane, bez dowodu działania nowych procesów, eksportu OpenAPI, browsera i przyspieszenia. Aktualny blocker wykonania: waiting_for_disk (6,656 GB, próg 8 GiB). CPU 90% pozostaje miękkim celem w alokacji Fullmaga, nie twardym limitem całego węzła.

### Zachowanie pomiarów admission — 2026-10-03

W raporcie adaptive znaleziono utratę danych: deduplikacja porównywała obciążenie CPU i RAM, lecz pomijała cpu_available_cores i worker_peak. Zmiana wolnej mocy w hierarchii cgroup albo nowy peak CPU/RSS mogła więc nie trafić do raportu, choć live callback dostawał próbkę. Wydzielono same_admission_state, który uwzględnia te wielkości; same timestampy nadal są deduplikowane, a limit 2048 zdarzeń pozostaje.

Parser rustfmt PASS; przygotowano regression admission_deduplication_retains_free_capacity_and_worker_peak_changes (timestamp-only, free cores, pojawienie peak, zmiana CPU i RSS). Nie kompilowano ani nie uruchomiono testu Rust. Dowód source-change: adaptive-admission-report-dedup-20261003.json. Przyrost jest częścią niezakwalifikowanego pakietu adaptive, bez osobnego commita oderwanego od zależności. Runner nadal waiting_for_disk (6 649 659 392 B); nowe obliczenia i browser proof pozostają OPEN.

### HPC: nieograniczony przodek cgroup — 2026-10-03

Sampler przypisywał nieograniczonemu przodkowi pojemność leaf affinity i odejmował usage wszystkich jego potomków. Dla alokacji 4 CPU i 12 CPU zużytych przez obce zadania poza affinity dawało to fałszywe zero. Dokumentacja jądra potwierdza, że cpu.stat obejmuje potomków, a cpu.max=max nie jest skończonym limitem. Źródła teraz rozróżniają leaf accounting i przodków z finite quota; konkurencja na przydzielonych rdzeniach pozostaje mierzona przez proc/stat affinity. Wszystkie skończone limity CPU i limity pamięci pozostają obowiązujące. Historia usuniętej quota jest odrzucana; ponowne włączenie finite wymaga nowego okresu pomiaru.

Parser Rust PASS; native regression przygotowana, bez kompilacji/runtime. Źródłowe review wcześniejszej poprawki deduplikacji raportu: bez P1/P2; rozszerzono test także o append, limit 2048, events_truncated i zachowanie pierwszego/najnowszego zdarzenia. Nowe review HPC trwa. Dowód: adaptive-hpc-cpu-scope-20261003.json. Zaktualizowano ADR 0034 zgodnie z semantyką kernel. Brak nowych wyników dyspersji; zdrowy runner nadal waiting_for_disk (6 644 613 120 B).

### Review HPC/admission — 2026-10-03

Niezależne review zakończone: brak P1/P2 dla selekcji domen CPU, zachowania finitequota i wszystkich limitów pamięci oraz resetu historii po zmianie quota. Potwierdzono też bezpośrednią regresję append_admission_event: deduplikacja, 2048 zdarzeń, events_truncated, first/latest. Dowód: adaptive-hpc-cpu-scope-20261003-reviewed.json. Nadal source-only: test Rust niekompilowany, nowy obraz, solver, serial/adaptive i GUI NOT VERIFIED.

### Korekta pełnego budżetu puli — 2026-10-03

W `AdaptiveAdmission::decide` historyczna reguła `active + floor(current_headroom / worker_peak)` pozwalała przyjmować dodatkowe procesy podczas niskiego chwilowego zużycia aktywnych workerów. Dodano równorzędny limit całej puli: `floor(cpu_target_cores / (peak_cpu * 1.10))` oraz `floor((memory_target_bytes - reserve_bytes) / (peak_rss * 1.25))`. Aktualny headroom i ograniczenia domen nadal obowiązują; nie odejmujemy niesynchronizowanych próbek własnego CPU/RSS od obciążenia hosta. Wyjątek jednego niepodzielnego workera na małym przydziale zachowuje wcześniejsze guardy presji. Zmniejszenie desired_workers nie zabija aktywnych punktów.

Przykłady algebraiczne odtworzyły problem: 7 idle workerów przy przydziale 8 CPU i celu 90% mogło dopuścić ósmy mimo skalibrowanego kosztu 1.1 CPU; limit całej puli wynosi 6. Dla przydziału 16 GiB, celu 80%, rezerwy 1 GiB i peak envelope 5 GiB limit wynosi 2, choć chwilowe zwolnienie stron dopuszczało trzeci proces. To kontrola przykładów, nie wykonanie regulatora Rust.

Dodano dwie regresje Rust `idle_active_workers_cannot_overcommit_the_calibrated_cpu_envelope` i `idle_active_workers_cannot_overcommit_the_calibrated_memory_envelope`. `rustfmt --check` PASS. Regresje pozostają nieskompilowane zgodnie z AGENTS.md; managed runtime/parity/browser nadal NOT VERIFIED. Odczyt runnera z 2026-10-03 01:44 UTC: worker_alive=true, accepting_jobs=true, active_jobs=[], waiting_for_disk, 6 350 381 056 B wolnych poniżej 8 GiB. Nie zgłoszono kolejnego starego buildu ani nie zmieniono kolejki. Nowa poprawka wymaga kapsuły po wdrożeniu kompletnego stosu CPU.


### Bieżący szczyt aktywnego procesu — 2026-10-03

Znaleziono opóźnienie adaptacji: `record_peak` zbierał CPU/RSS aktywnych workerów, lecz envelope regulatora i raport `worker_peak` były aktualizowane dopiero po zakończeniu procesu. Nowy punkt k o większym workspace mógł więc dopuścić kolejne zadanie z kosztem starego punktu kalibracyjnego. Wspólny `observe_admission_peak` aktualizuje oba stany bezpośrednio po poprawnym pomiarze procesu, przed reapingiem i kolejną decyzją. Scalenie końcowe zachowuje pomiar terminalny i jawny fallback CPU krótkiego procesu. Pomiar live nie zatwierdza kalibracji: pierwszy punkt nadal musi zakończyć się poprawnie.

Przygotowano regresję `live_worker_peak_closes_admission_before_completion_and_keeps_calibration_closed`: większy live peak zamyka nowe admission przed zakończeniem, późniejsza bezczynność nie obniża szczytu, a NaN nie zmienia raportu. Parser Rust PASS, bez kompilowania testów jednostkowych. Kontrole interpretowane Python: 68 PASS. Hashe czterech źródeł UI są zgodne z wcześniejszym produkcyjnym TypeScript PASS; nie ponawiano niezmienionej kontroli.

Odczyt runnera 2026-10-03: zdrowy worker, 17 916 764 160 B wolnych, obcy build #212 running. Poprzedni blocker miejsca ustąpił; aktualizacja obrazu czeka na pusty aktywny slot. Nie wdrożono nowego obrazu, nie wygenerowano OpenAPI i nie wykonano serial/adaptive parity ani browser proof. Źródła ustawień CPU 90%, RAM 80%, rezerwy, liczby procesów i wątków są przygotowane, ale funkcja nie jest jeszcze zakwalifikowana runtime. Dowód: `adaptive-live-peak-source-20261003.json` w wizualizacjach wątku.


### Domknięcie review zasobów — 2026-10-03

Niezależne review zaakceptowało live peak, rozdzielenie domen CPU i limity całej puli. Wskazało dwa P2, które poprawiono:

- Dodatni, ale krótki pomiar CPU nie wystarcza już do obniżenia kosztu workera. Prywatny `WorkerCpuCoverage` wymaga co najmniej trzech poprawnych interwałów o łącznej długości co najmniej jednej sekundy; pojedynczy interwał musi być dodatni i nie dłuższy niż jedna sekunda. Pierwszy odczyt liczników ma interval=None. Przy braku takiego pokrycia koszt obejmuje cały rzeczywisty resolved_threads oraz pomiar terminalny. To polityka jakości obserwacji schedulera, nie tolerancja solvera ani gwarancja wykrycia krótszych pików. Parametry CPU 90% pozostają miękkim celem.
- `execute` porównuje pełną politykę każdego requestu z polityką poola przed utworzeniem journala, katalogów i procesów. Różny mode, CPU/RAM, rezerwa, limit procesów lub threads powoduje błąd zamiast rozbieżnego raportu i wykonania.

Raport puli ma `cpu_observations` dla każdego zakończonego punktu: sample_index, valid_intervals, observed_seconds, demand_source, sampled_peak_cpu_cores, terminal_average_cpu_cores, resolved_threads i demand_cpu_cores. Odnotowuje też zespół każdego workera w thread_bindings. Zespół może być zmniejszony przy wzroście puli; koszt wyznaczony z pierwszego punktu jest konserwatywnym envelope dla późniejszych mniejszych zespołów. Zmiana nie dodaje endpointu ani nie zmienia fizyki/IR.

Przygotowano regresje krótkiego dodatniego pomiaru, niewłaściwej długości interwału, warunku pokrycia i mismatch polityki. Parsowanie trzech plików Rust PASS; testy Rust pozostają nieskompilowane. Re-review nie wykryło P1/P2 w poprawkach. Hipotetyczny finding dotyczący null został wycofany: rzeczywisty typed SceneStudyState i adapter nie mają wskazanego surowego bypassu. Nie wprowadzono na tej podstawie zbędnej migracji API. Runtime/build, serial/adaptive parity, eksport OpenAPI i browser pozostają OPEN.


### Adaptive: aktualny build i próba porównawcza — 2026-10-03

Próba `de-smoke-parallel-probe` nie jest już związana z historycznym jobem #211.
Wymaga jawnego `--probe-build-source-digest <SHA256>` zgodnego z wybranym,
zweryfikowanym managed kontekstem, profilu CPU `fem-cpu-slepc-runtime-v2`
i obecności sześciu źródeł adaptive w niezmiennej kapsule. Oba uruchomienia
serial/adaptive muszą wskazać ten sam job i digest. Model, siatka, equilibrium,
manifest wejściowy i polityka próby zachowują dotychczasowe hashe i parametry.
Historyczny commit modelu jest provenance wejścia, nie wersją runtime.

Naprawiono też brakujący import `PARALLEL_PROBE_VECTORS_RAD_PER_M`: jego użycie
w walidacji po zakończeniu solvera powodowałoby NameError. `_parallel_probe_root`
używa kanonicznego `fullmag_storage.validate_path`, który odrzuca przekierowanie
przez symlink/junction, także w pośrednim katalogu. Regresja symuluje przekierowany
ancestor; nie jest dowodem utworzenia rzeczywistego Windows junction.

Kontrole interpretowane: 13 testów probe + 36 drivera PASS. Zachowany aktualny
wynik 58 testów walidatora wierszy PASS; jego źródło i zależności walidacyjne
nie zmieniły się po tym wykonaniu. Razem 107 kontroli. Próba unittest dla pliku
pytest zgłosiła NO TESTS RAN; następnie właściwe pytest wykonało wszystkie 58.
Review nie wykryło P1; finding P2 dotyczący storage naprawiono. Żaden test
jednostkowy Rust/native/React nie został skompilowany.

#212 zakończył się `succeeded`, exit0. Wstrzymano admission na czas autoryzowanej
aktualizacji obrazu i anulowano wyłącznie własny nieaktualny #213; journal
potwierdza `cancelled`, exit143. Dane obu zadań zachowane. Przed budową obrazu
potwierdzono brak aktywnych jobów, brak worker_error i 14 364 770 304 B wolnych.
Worker nie działa podczas świadomej pauzy; nie oznaczamy tego jako worker_alive PASS.

Uruchomiono `just runner-build-image` z CPU_MFEM_ONLY=1. Bazowy obraz:
`sha256:8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89`,
lokalny alias `fullmag/toolchain-pinned:8a508319a68c-adaptive-20261003`.
Docelowy tag: `fullmag/local-runner-build:slepc-cpu-complete-adaptive-20261003`.
Dwie próby zakończyły się przed kompilacją: BuildKit nie obsługuje bridge jako
build network, a surowe sha256 w FROM interpretował jako repozytorium.
Właściwa próba używa network=default i zweryfikowanego lokalnego aliasu.
Build obrazu trwa (sesja narzędzia 82647); hypre CPU rozpoczął kompilację.
Nie ma jeszcze końcowego ID/receiptu obrazu ani aktualnego builda Fullmaga.

Następne kroki: odczytać terminalny wynik budowy obrazu, zweryfikować immutable ID,
skonfigurować runtime-v2 zachowując pozostałe profile, wznowić FIFO i zgłosić
aktualny snapshot ze wszystkimi wymaganymi untracked wejściami. Następnie
wyeksportować OpenAPI, zregenerować klienta, uruchomić identyczne wejścia
serial/adaptive i sprawdzić wyniki, raport procesów, faktyczną równoległość,
zużycie zasobów oraz UI. Kampanijne skrypty plan-only w storage nadal wymagają
aktualizacji wywołania (digest zamiast #211); nie wolno traktować ich jako wykonanego runtime.
Managed runtime, browser proof, przyspieszenie i pełny cel S00–S12 pozostają OPEN.

Re-review poprawki ścieżki: P2 zamknięte, brak nowych P1/P2. Budowa obrazu przeszła hypre i libCEED; konfiguracja PETSc zakończona, trwa kompilacja jego biblioteki. Sesja 82647 pozostaje aktywna; nie ma jeszcze końcowego sukcesu obrazu ani nowego runtime Fullmaga.

## Adaptacyjne wykonanie — wdrożenie pary obrazów, 2026-10-03

Obraz CPU `sha256:7139ca2622b622ca934e53a573372b41c3c2c48b7ba67bc128883b36eb541d6e` zbudowano z kodem po poprawce prefix-based SLEPc (lokalny commit `fc3d8246db2f3f77f830d97a95197222b0a2de02`). Koordynator `sha256:9923f33b147b52b6534a9f2161bf4a00c4b138679575035676bffb52512da0db` zachowuje guard ograniczonych instancji browser oraz pozostałe profile; guard/executor: 26 interpretowanych kontroli PASS. Wymianę wykonano przy pustym aktywnym slocie i wstrzymanym przyjmowaniu. FIFO wznowiono; nie zmieniono kolejności obcych zadań. Runtime-v2 zachował limit buildu 2 CPU/8 GiB.

Nowy build **#216**: `a1d3dfd0c1914c5bb63d0179c113d01b`, digest kapsuły `8dda784a98471ee52e4e09b6cabb00a80bf5eb565c30673f0dd9bbe98b49f960`, snapshot HEAD `fc3d8246db2f3f77f830d97a95197222b0a2de02` z bieżącymi zmianami i jawnymi nowymi źródłami adaptive. Stan przy przyjęciu: queued. Recepta próby wymaga teraz jawnego job_id oraz source_digest zamiast starego nieudanego #211; probe/driver: 49 interpretowanych kontroli PASS.

Budowa obrazu nie dowodzi jeszcze działania Fullmaga ani scheduler parity. Następnie: terminalny receipt #216 i CPU dependency closure, eksport OpenAPI/client, rzeczywiste serial/adaptive z tymi samymi wejściami, raport puli z dowodem równoległości i obciążenia, managed UI/browser. Brak nowych punktów naukowych; pełne S00–S12 pozostają otwarte. Log obrazu i stan przejścia zapisano w wizualizacjach wątku.

## Kontrola raportu adaptacyjnego — checkpoint lokalny, 2026-10-03

Commit `51da8c43b0e3e3f5fc375d269ca9963ac240847b` dodaje wyłącznie interpretowany walidator rzeczywistego ProcessPoolReportV1 i admission journal oraz jego regresje (12 PASS). Kontrola obejmuje bounded JSON, politykę, bindingi, CPU coverage/envelope, zgodność resolved threads i status wykonania. Timestamped active_workers≥2 dowodzi wyłącznie chwilowej współaktywności procesów schedulera; nie dowodzi overlap EPSSolve ani speedup. Bezpośredni raport nie zawiera terminal_state, więc wymaga osobnego powiązania z zakończonym execution — nadal OPEN. Serial może nie emitować raportu puli; porównanie częstotliwości/mesh/equilibrium korzysta z rzeczywistych artefaktów benchmarku, bez syntetycznego serial reportu.

#216 pozostaje queued za #214/#215 według ostatniego odczytu. Nowy commit jest hostowym narzędziem analizy po przechwyceniu kapsuły; nie zmienia przypiętego HEAD/digestu ani źródeł natywnego buildu #216. Brak nowych punktów solvera, kwalifikacji adaptive i browser proof. Wykryty HTTP500 pełnej historii dotyczy starszego /jobs; stronicowane /api/v1/jobs działa. Klient CLI pełnej historii wymaga osobnej korekty, bez zwiększania limitów odpowiedzi.


### 2026-10-03 — priorytet użytkownika: adaptacyjna kampania i rzeczywiste punkty

Brak nowych wyników: na dotychczasowym wykresie pozostają dwa zaakceptowane punkty ±10 rad/µm. Przygotowany backend puli nie jest jeszcze dowodem równoległego wykonania. Dotychczasowy zewnętrzny kontroler signed15 wykonywał pojedyncze piloty seryjnie; został zastąpiony nową trasą jednej grupowanej ścieżki.

Model `71ba0d18225ffcc83f7f18e676de8dc051e87fd1` definiuje 15 punktów DE: −25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25 rad/µm. Jawne `--parallel-mode adaptive` uruchamia publiczną pulę; limit CPU 90%, RAM 80%, rezerwa 1 GiB, jeden wątek na proces i dobór liczby procesów przez pomiary. Sterownik wiąże wersję modelu i digest buildu; wynik ma zawierać rzeczywisty raport puli z SHA256. Nie rozluźniono residualu 10⁻⁸ ani kontroli demag przy Gamma. Lekkie kontrole: 52 sterownika/probe, 4 modelu oraz 59 kontroli wierszy PASS.

Build #216 (`a1d3dfd0c1914c5bb63d0179c113d01b`) jest aktywny; jego kontener rozpoczął pracę o 04:51 UTC. Jednorazowy kontroler (sesja 34636) oczekuje na sukces i weryfikację receipt; następnie uruchomi `signed15-adaptive-v1` w kanonicznym storage. Pierwsza próba kontrolera zakończyła się przed wywołaniem solvera; poprawiona v2 sprawdza stan przez API i nie powiela buildu. Symulacja i nowy wykres pozostają OPEN.

Kontynuacja: terminalny build → rzeczywiste 15 próbek → kontrola artefaktów i pomiarów puli → wykres scatter oraz analityka → oddzielny parytet serial/adaptive i dowód GUI. S09/2.5D zachowano jako WIP poza kapsułą #216; parser/review nie dowodzą kompilacji ani runtime. Pozostałe S00–S12, zbieżność, COMSOL, GPU i integracja PR #97 pozostają otwarte.


## Checkpoint wykonania — 2026-10-03, 05:40 UTC

Ten wpis zastępuje wcześniejsze deklaracje bieżącego stanu #216. Pełny cel S00–S12 pozostaje otwarty.

- #216 zakończył się failed/exit 2: E0063, brak cpu_observations w FEM serial_bootstrap_only. Dodano pustą listę, bo ta gałąź nie uruchamia procesu potomnego. Parser i niezależne review PASS; nowa kompilacja nadal OPEN.
- Aktualny snapshot #219: 358349e2f1d74e6c9c4cb6af148d47b0, digest 8bdb22ee937e3c16bdebd080c0239296da03d8834cb42fea461ee5b709e34267, profil fem-cpu-slepc-runtime-v2, model commit 71ba0d18225ffcc83f7f18e676de8dc051e87fd1. Job queued; nie wystartowała symulacja.
- Współdzielony runner został wymieniony zewnętrznie: obecny kontener 7f20873de2b1e21335b7399afa8436ce6ed0e0503dcd69d2fa366917fa3bdef2, obraz sha256:1aa31b600114e35dac112821bfe0ee1317a00641077bf4ecee546e0747550665. Health: worker_alive=true, accepting_jobs=true, worker_error=null, brak aktywnych jobów, waiting_for_disk; wolne 8 080 265 216 B, wymagane co najmniej 8 589 934 592 B. Nie zmieniono konfiguracji ani FIFO.
- Obserwator #219 v2 zakończył się przy WinError 10061 podczas wymiany runnera. V3 ponawia wyłącznie odczyty po błędach transportu; nie ponawia błędów autoryzacji ani nie zgłasza/anuluje jobów. Cztery regresje PASS. Aktualny uchwyt obserwatora: 75831; renderer oczekujący na rzeczywisty wynik: 11268.
- Naprawiono model_source_commit (rzeczywisty klucz commit) oraz walidację orientation/sampling/k_vectors dla signed-fifteen. Kontrole interpretowane driver/probe/rows/model/plot/parity: 131 PASS +45 subtests; pomocnicza obsługa kontenera: 22 PASS +15 subtests. To dowody źródeł, nie wykonania solvera. Testów jednostkowych Rust/native/React nie kompilowano.
- Generator scripts/plot_signed_de_campaign.py zapisuje PNG/PDF/receipt dopiero po zaakceptowaniu 15 rzeczywistych wierszy; bez lustrzanego kopiowania FEM lub interpolacji. Jest przygotowany, ale nowy wykres nie powstał. Nadal dostępne są wyłącznie dwa wcześniejsze punkty ±10 rad/µm.

Następna sekwencja: zwolnienie miejsca przez operatora → terminalny sukces i atestacja #219 → jedna adaptacyjna kampania 15 punktów → rzeczywisty raport puli i artefakty solvera → wykres i kontrola renderu → parytet serial/adaptive oraz GUI. Zbieżności, COMSOL, GPU, S09/2.5D i integracja PR #97 pozostają OPEN. Nie usunięto żadnych danych; operator został poproszony o zwolnienie miejsca.


Checkpoint źródeł: commit `c1ec5c797730430d95738912260017cc5417f9d7` obejmuje 11 skryptów/testów kampanii, bound receipt, serial/adaptive parity i generatora. Review korekt P1/P2 oraz helpera cleanup PASS. 153 testy interpretowane +60 subtests PASS; kompilacji unit tests nie wykonywano. Commit nie zastępuje wykonania #219 i nie zmienia jego modelu/digestu. Nie wykonano push/merge; wymagane bramki runtime/UI/nauki pozostają otwarte.
