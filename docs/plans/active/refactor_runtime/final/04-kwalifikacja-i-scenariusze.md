# Kwalifikacja produkcyjna i scalone scenariusze odbioru

Status: **specyfikacja bramek z aktualizacją checkpointu 21.09.2026**. W momencie tworzenia audytu testy aplikacji i runtime były `NOT_RUN`; późniejsze autoryzowane wyniki są przypięte w [P0](p0/03-implementation-status.md) i [P1](p1/README.md). Brak receiptu dla konkretnego przypadku nadal oznacza `NOT VERIFIED`, a sama lista scenariuszy nie jest wykonawczym unified gate.

## 1. Rejestr wyników wymagany w P0

P0 tworzy wykonywalny rejestr przypadków: `case_id`, pakiet planu, fixture path/hash, source SHA i dirty state, schema/ABI, producer versions, host/OS, requested/resolved/executed engine/device/precision/mode, command/recipe i args, status/exit code, elapsed, log/manifest/artifact refs oraz wynik orakla. Nazwa `cae-qualification-manifest` jest propozycją nowego artefaktu, nie istniejącą receptą.

Każdy case ma stan PLANNED, NOT_RUN, BLOCKED, PASS, FAIL albo NOT_APPLICABLE z uzasadnieniem. Capability zachowuje własne normatywne słownictwo; wynik testu nie zmienia go automatycznie. Skipped GPU nie zalicza wiersza GPU. Test poprawnej odmowy dowodzi wyłącznie odmowy, nie wykonania solvera.

Wpis zawiera również test owner, oczekiwany rezultat i tolerancję, aktualnie istniejący runner albo `TEST_TO_IMPLEMENT`, zależności oraz termin bramki. P0 musi zapewnić executable mapping dla każdego wymaganego case przed jego fazą; brak harnessu nie może ujawnić się dopiero na P8.

## 2. Poziomy dowodów

| Poziom | Co udowadnia | Czego nie udowadnia |
|---|---|---|
| Dokument/source review | Istnienie symbolu, kontraktu, gałęzi i zależności | Wyniku wykonania i czasu. |
| Source/contract checks | Schema, invariants, fixtures i architekturę objętą testem | Managed runtime i fizykę. |
| Managed build | Powstanie zgodnych artefaktów z określonego source/profile | Poprawnego solve ani WebGL. |
| Runtime integration | Wykonany scenariusz na konkretnym urządzeniu | Nauki bez metryk i referencji. |
| Browser/WebGL | Widok, interakcję, lifecycle i rendering | Scientific parity. |
| Scientific qualification | Metryki, konwergencję, reference/analytical comparison | Całego wydania poza zakresem macierzy. |
| Release | Złożenie wymaganych dowodów, packaging, migracja i rollback | Dowolnej nieprzetestowanej kombinacji. |

Wersja audytowa z 20.09 zawierała zakaz kompilacji testów jednostkowych i dlatego oznaczała zależne bramki jako `BLOCKED`. Użytkownik później jawnie autoryzował testowanie; wykonano ograniczone regresje P0/P1, managed smoke API/WebSocket/active-run, testy wejść CLI/Python oraz browser smoke. Nie wykonano pełnej macierzy solverów, power-loss, operacji GC na danych użytkownika ani kwalifikacji naukowej/release. Doc-only diff/link/coverage checks nadal potwierdzają wyłącznie dokumentację.

## 3. Zachowane CAE-01–60 i przypisanie do etapów

Pełne warunki i oczekiwane wyniki bazowe zachowano poniżej z [materiału wejściowego](../04-scenariusze.md). Rozstrzygnięcia finalne: „bez solvera” oznacza zero wywołań solve podczas Open/Save/read, a nie zakaz jawnego derived compute. Stary wynik zachowuje własną poprawność i provenance. CAE-27/28 testują wykonanie wyłącznie wspieranego zakresu; dla unsupported wymagany osobny test odmowy.

| Zakres | Najwcześniejsza bramka | Wymagane ponowne sprawdzenie przy cutover |
|---|---|---|
| CAE-01–04 | P1 | P8 migracja/packaging |
| CAE-05–12 | P2 | P8 roundtrip |
| CAE-13–16 | P4 | B-FDM/B-FEM i P8 |
| CAE-17–20 | P3; CAE-20 również P2 | P5/P8 wszystkie command surfaces |
| CAE-21–24 | B-WORKFLOW/P6 | P7/P8 science |
| CAE-25–28 | P7 | P8 |
| CAE-29–36 | P3/P5/B-STATE | P8 |
| CAE-37–40 | P6 | P8 headless/packaging |
| CAE-41–44 | P1/P3a/P6 | P7/P8 |
| CAE-45–48 | P0 storage + P5 runtime | P8 fault/recovery |
| CAE-49–52 | P2 | P7/P8 |
| CAE-53–56 | Właściwy B lane/P5/P6 | P8 |
| CAE-57–60 | P1/P7 | P8 |

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-01 | Uruchom aplikację bez sesji i bez GPU; utwórz projekt. | Dostępne definitions, geometry i Save; zero uruchomień solvera. |
| CAE-02 | Dodaj bryłę bez materiału i study; Save/Close/Open. | Niekompletny model zachowany; Compute wyjaśnia brakujące definicje. |
| CAE-03 | W polu pozostaw `sin(`; zapisz draft i ponownie otwórz. | Tekst odzyskany jako draft, niepoprawne AST nie trafia do IR. |
| CAE-04 | Otwórz legacy `.fms`, wykonaj migrację do nowej kopii. | Raport migracji, zachowany oryginał, brak cichej utraty danych/źródeł. |
| CAE-05 | Zmień parametr szerokości zależnej geometrii. | Zmienione tylko zależne realizacje; definicja nie wymaga solve. |
| CAE-06 | Zmień nazwę parametru/obiektu. | Referencje ID i AST pozostają poprawne; brak nieuzasadnionego remeshu. |
| CAE-07 | Wprowadź cykl parametrów i błędny wymiar jednostki. | Czytelna ścieżka błędu; zapis draftu możliwy, Compute blokowane. |
| CAE-08 | Build to Selected, potem błąd późniejszej cechy CSG. | Poprzedni etap geometrii dostępny; dokładny węzeł błędu, bez globalnego modalu. |
| CAE-09 | Operacja dzieli wybraną powierzchnię na dwie. | Zachowanie zgodne z selection policy albo jawna ambiguity; brak losowego wyboru. |
| CAE-10 | Move/rotate tekstury regionalnej. | Zmiana tekstury nie przesuwa maski regionu; clipping i frame zachowane. |
| CAE-11 | Aktywuj Frozen Spins z predykatu zapisanego pola. | Przypięty source state i activation ID; kolejne klatki nie zmieniają samoczynnie maski. |
| CAE-12 | Usuń obiekt użyty przez źródło, materiał i study. | Impact report i transakcyjna decyzja; zachowana historia istniejących rozwiązań. |
| CAE-13 | Utwórz FDM grid dla geometrii. | Grid/masks powstają bez żądania FEM policy i bez Gmsh, jeśli lane tego nie wymaga. |
| CAE-14 | Ten sam model ma recepturę FDM i FEM. | Przełączenie study reference nie usuwa drugiej receptury, materiałów ani wyników. |
| CAE-15 | FEM build zwraca zły marker lub nieakceptowany certyfikat. | Brak publikacji jako kwalifikowany mesh; Problems i edytor nadal dostępne. |
| CAE-16 | FDM multilayer wykorzystuje dodatkowy carrier demag. | Warstwy, support i carrier mają osobne identity; brak podszywania się jednego gridu pod drugi. |
| CAE-17 | Ten sam model ma dwa studies o innych solver configs. | Zmiana tolerancji jednego nie zmienia drugiego bez jawnego wspólnego reference. |
| CAE-18 | Regeneruj preset z ręcznymi override. | Diff i zachowanie ręcznych ustawień albo jawne rozstrzygnięcie konfliktu. |
| CAE-19 | GPU wymuszone dla nieobsługiwanej konfiguracji. | Preflight/Compute odrzuca z przyczyną; brak cichego CPU fallbacku. |
| CAE-20 | Compute przy widocznych, niezastosowanych zmianach formularza. | Commit + ACK przed snapshotem albo błąd pola; nie liczymy po cichu starej wartości. |
| CAE-21 | Relaxation kończy się przez max_steps bez spełnienia kryterium. | Technical completion oddzielne od equilibrium qualification; zależne eigen sprawdza evidence. |
| CAE-22 | Eigen i response korzystają z tego samego linearization state. | Wspólne jawne wejście; odrębne wyniki, residuals i interpretacja. |
| CAE-23 | Mod zapisano w bazie stycznej/FEM DOF, otwórz animację. | Rekonstrukcja według wskazanej bazy; brak interpretacji współczynników jako gotowego m. |
| CAE-24 | Dispersion przechodzi przez bliskie/degenerujące mody. | Zachowane k/normalization/branch evidence; ambiguity nie ukryta indeksem sortowania. |
| CAE-25 | Histereza z kontynuacją stanu. | Punkt n+1 korzysta z wyniku n; scheduler nie równolegli zależnych punktów. |
| CAE-26 | Niezależny sweep geometrii na kilku workerach. | Case IDs i seedy stabilne; każdy przypadek ma własne wejście i wynik. |
| CAE-27 | Przekaż pole/prąd między różnymi dyskretyzacjami. | Jawna projekcja, support, jednostki i wymagane bilanse; nie tylko dopasowanie shape. |
| CAE-28 | Dwukierunkowe sprzężenie wymagające iteracji. | Wersjonowana convergence policy i raport; nie arbitralne jednokrotne przejście po grafie. |
| CAE-29 | Edytuj geometry revision 42, gdy run używa 41. | Run nie jest zabity ani zmieniony; wynik nadal wskazuje wejście 41. |
| CAE-30 | Podwójny klik Compute i utrata odpowiedzi POST. | Jeden przyjęty intent/run; reconciliation po idempotency key. |
| CAE-31 | Ten sam klucz idempotency z innym payloadem. | Jawny konflikt, nie zwrot niepasującego wykonania. |
| CAE-32 | Stary worker publikuje po utracie lease. | Odrzucony ownership epoch; nowy attempt nie jest zanieczyszczony. |
| CAE-33 | Cancel równocześnie z ukończeniem zadania. | Jedno spójne terminalne rozstrzygnięcie i historia request/ACK. |
| CAE-34 | Wznowienie po zmianie engine/precision lub braku historii integratora. | Odpowiednia RestoreClass; bez fałszywej gwarancji ExactResume. |
| CAE-35 | Apply live field na wspieranym runtime. | Steering ACK z krokiem/czasem, segmentem i wymaganym cache reset; draft osobny. |
| CAE-36 | Odrzucony adaptacyjny krok przy thermal/constraints. | Accepted state, RNG/history/constraints i checkpoint pozostają zgodne z kontraktem metody. |
| CAE-37 | Otwórz solved archive na hoście bez dostępnego solvera. | Geometria wyniku, datasets i wykresy działają z zapisanych danych. |
| CAE-38 | Zmień tylko plot scale/component/cut. | Brak ponownego rozwiązania; nowe zapytanie tylko do potrzebnych danych. |
| CAE-39 | Zażądaj pola, którego nie zapisano. | `not_recorded`/właściwy powód; brak fizycznego zera lub podmiany na m. |
| CAE-40 | Porównaj pola FDM/FEM na różnych siatkach. | Jawna ilościowa projekcja i kontekst; brak odejmowania niezgodnych tablic. |
| CAE-41 | Zerwij WS podczas liczenia i przywróć połączenie. | Workspace nie jest odmontowany; run status uzgodniony z backendem. |
| CAE-42 | Przełącz projekt A→B, gdy trwa decode pola A. | Odpowiedź A nie trafia do widoku/cache B. |
| CAE-43 | Otwórz historyczny dataset przy aktywnym live runie. | Dane i kamera nie są samoczynnie przejmowane przez live update. |
| CAE-44 | Menu, ribbon, shortcut i Python wykonują tę samą akcję. | Zgodne availability i preconditions; brak bypassu przez inną powierzchnię. |
| CAE-45 | Przerwij zapis przed commit manifestu. | Poprzednia wersja pozostaje czytelna; staging nie udaje kompletnego wyniku. |
| CAE-46 | Brak miejsca w trakcie zapisu trajectory. | Jawny błąd i manifest coverage; utracone próbki nie udają kompletnego datasetu. |
| CAE-47 | GC przy aktywnym workerze i przypiętym starym solution. | Zachowane wszystkie referencje/leases; brak usunięcia potrzebnych danych. |
| CAE-48 | Reopen po awarii koordynatora. | Reconciliation istniejących runów; brak automatycznego dublowania wszystkich tasków. |
| CAE-49 | Ten sam model przez GUI, deklaratywny Python i headless. | Zgodna znormalizowana semantyka/IR oraz wymagane provenance. |
| CAE-50 | Otwórz plik Python z efektami ubocznymi. | Brak wykonania bez jawnego intentu; script-owned workflow opisany. |
| CAE-51 | Import modelu z nieznanym modułem fizyki. | Payload zachowany lub import odrzucony z raportem; nigdy silently dropped. |
| CAE-52 | Dwa konteksty Python równocześnie. | Brak współdzielonego globalnego state między projektami. |
| CAE-53 | Reprezentatywne porównania FDM CPU/GPU i FEM CPU/GPU. | Wykonane właściwe lane’y i error metrics; brak utożsamienia zgodności z bitwise equality. |
| CAE-54 | Długi solve z bardzo wolnym klientem UI. | Throughput solvera nie zależy od odbioru wszystkich preview frames. |
| CAE-55 | Powtarzane otwieranie projektów/wyników i zmiany quantity. | Pamięć/worker leases/listeners wracają do ustalonych budżetów. |
| CAE-56 | Reuse kolejnych zgodnych kroków na GPU. | Zweryfikowana poprawność cache i brak zbędnych pełnych transferów per timestep. |
| CAE-57 | Archiwum z traversal, nadmiernym rozpakowaniem lub złą checksumą. | Bezpieczne odrzucenie przed publikacją projektu. |
| CAE-58 | Otwarcie nowego schematu starszym klientem. | Read-only/odrzucenie z komunikatem; brak uszkadzającego zapisu. |
| CAE-59 | Remote worker zgłasza inne capabilities niż żądane. | Brak niejawnego fallbacku, właściwy status i receipt. |
| CAE-60 | Package/Archive projektu z brakującym assetem zewnętrznym. | Raport braku; brak deklaracji kompletnego przenośnego projektu. |

## 4. CAE-61–70: przyjęte i skorygowane rozszerzenia Claude

| ID | Fixture i akcja | Orakl finalny | Bramka |
|---|---|---|---|
| CAE-61 | Nowy modal/response artifact, odczyt manifestu i otwarcie pod innym active project | Referencje zasobowe mają semantic IDs/content identity, bez routowalnego `current`; klient używa przypiętego ownera. Opisowy URL/DOI nie jest zakazany. | P3a/P6 |
| CAE-62 | Syntetyczny store: checkpoint descriptor/chunks, recovery, active run, pinned solution i osobny garbage blob | Dry-run domyślny; dokładnie rozpoznane unreachable garbage, wszystkie live roots zachowane. Apply ma jawny scope i authorization, a zmieniona generation unieważnia plan. Dla wariantu bez garbage zero kandydatów. | P0-B |
| CAE-63 | Kontrolowane WEBGL_lose_context dla aktywnego 3D, potem restore | Powłoka i draft trwają, kamera/dataset odtworzone; run bez zmiany. Przetestować także brak możliwości restore i widoczną diagnostykę. Nie wywoływać realnego OOM na danych użytkownika. | P6-D |
| CAE-64 | Fault injection przed/po durable file barrier, atomic rename, parent-directory durability według platform profile, state write, manifest commit i catalog update | Po restart tylko kompletne checkpointy dostępne do resume, poprzedni commit czytelny; partial ma diagnostykę. Sam flush nie zalicza trwałości. Windows/network FS mają osobne capabilities; process-crash i power-loss to osobne klasy dowodów. | P0-C |
| CAE-65 | Dwa procesy/hosty próbują zapisu na danym profilu filesystemu | Jeden writer; cudzy host lock nie jest usuwany na podstawie lokalnego PID. Niekwalifikowane SMB read-only/odmowa. | P0-C/P1 |
| CAE-66 | Dwa GPU runy, potem utrata heartbeat pierwszego workera | Drugi queued/blocked bez fallbacku; ponowny lease dopiero po potwierdzeniu zwolnienia/izolacji urządzenia. OOM jest testowany jako typed failure, nie obiecuje się jego niemożliwości. | P5-B/P7 |
| CAE-67 | 3D → inna centralna karta → 3D, warm i expired cache | Nieaktywny 3D ma zero canvas/root i aktywnych zasobów. Kamera/dataset zachowane. Brak zbędnego fetch przy ważnym cache; legalny scoped refetch po eviction. | P6-D |
| CAE-68 | Zmiana Ms/Aex i initial state z gotowym FEM mesh | Domyślnie mesh niezmieniony; coefficients/initial state invalidowane właściwie. Remesh tylko przy jawnej zależności recipe uwzględnionej w fingerprint. | P2/P4 |
| CAE-69 | Compute dla typowanej definicji: cold process, warm runtime, zgodny/niezgodny cache | Zmierzyć od admission do pierwszego accepted kroku, osobno queue/prep/import/solve. Brak zbędnej generacji skryptu w typed path. Script-owned nie podlega zakazowi Pythona; brak wymyślonego celu <5 ms. | P0-E/P5-A |
| CAE-70 | Legacy archive z resource keys; migracja, przerwanie i powtórzenie | Nowe immutable manifesty i mapa old hash→new hash; oryginały identyczne. Nieznane referencje dają jawny status, bez string-replace wszystkich danych. | P1/P6 |

## 5. Dodatkowe testy wynikające z finalnej syntezy

| ID | Sprawdzany problem | Oczekiwany dowód | Bramka |
|---|---|---|---|
| FINAL-01 | Request A opóźniony przed/po await, zmiana current na B | Read/write/publication pozostają A; niedozwolony cross-project access odrzucony. | P3a |
| FINAL-02 | Request zakończony, ale decode A spóźniony po przejściu do B | Context fence odrzuca wynik bez wpisania do cache/render B. | P3a/P6 |
| FINAL-03 | ContextVar z odziedziczonym mutable state, nesting i exception | Dwa niezależne contexts nie współdzielą stanu; token resetowany; legacy single-context zgodny. | P2-C |
| FINAL-04 | Nieparsowalny checkpoint.json, run manifest, recovery manifest, tensor descriptor albo nieznany schema/root | GC plan oznaczony partial/unknown/corrupt; zero sweep, zachowane dane; diagnostyka wskazuje korzeń. | P0-B |
| FINAL-05 | Nowy root/lease powstaje po mark GC | Stary plan apply odrzucony lub ponowny mark w poprawnym protokole single writer. | P0-B |
| FINAL-06 | Import projektu kontra jawne RestoreRuntime | Open bez candidate runtime/solve; Restore buduje izolowanego kandydata i atomowo promuje po weryfikacji. | P1/P5 |
| FINAL-07 | Równe długości pól, różne space/order/orientation/carrier | Przed decode/evaluation odrzucić niezgodną parę; projekcja tylko jawna i qualified. | P4/P6 |
| FINAL-08 | Nowy parser/ABI ze starym klientem i odwrotnie | Negotiated compatibility albo odmowa przed zapisem/alokacją; brak silent field drop. | B-ABI/P8 |
| FINAL-09 | Dane real/imag, basis modalna, harmonic convention i slicing | Roundtrip bez zgubienia osi/precision/basis; renderer nie używa coefficients jako magnetyzacji. | P6-B |
| FINAL-10 | Mixed sources: ekran historii i live demand innych widoków | Brak swap live; sum demand prawidłowa; historical source nie przejmuje publishera. | P5/P6 |
| FINAL-11 | Błędny prepared candidate, old worker complete, cancel race | Jedno legalne terminal/publication outcome; stary artefakt nienaruszony; brak dwóch właścicieli. | P4/P5 |
| FINAL-12 | Migracja starych plots/monitors/results/sweep | Stable dataset/sample/mode IDs, bounded histories, przypięte źródła i poprawne unit labels. | P6/P7 |
| FINAL-13 | Klawiatura/focus, Object/Airbox Inspector, display units i theme | Apply/Undo bez zgubienia focus/draft, Mocha/Latte czytelne, reduced motion i dostępne controls. | P2/P6 |
| FINAL-14 | FDM CPU dispatch przed/po ekstrakcji | Ta sama jawna implementacja i reference policy; brak nieuzgodnionej zmiany authority. | P0-D/B-CORE |
| FINAL-15 | Wrong GPU device/precision/strategy lub brak certyfikatu | Typed rejection, zachowany requested intent, brak CPU/hybrid/demag-model fallbacku. | B/P5/P8 |
| FINAL-16 | Zamknięcie desktop/serwera podczas active run | Zachowanie zgodne z supervisor mode; resume tylko zgodnej klasy; brak fikcyjnego survived status. | P7/P8 |
| FINAL-17 | Capture primary/aux → pack → unpack → restore na syntetycznym store | Odtworzone rzeczywiste bajty primary/aux, complete transitive refs; nie tylko zgodność JSON deskryptora. Brak common state/blob/aux/RNG/backend payload obniża do legalnej RestoreClass albo blokuje Resume; brak wymaganych danych blokuje Solved/Resume. | P0-B/P1 |
| FINAL-18 | Poprawny namespace ZIP, niebezpieczny `session_id` wewnątrz manifestu | Odrzucenie przed publikacją i zapisem poza staging; typed-ID walidacja i containment również w repository. | P0-F/P1 |

## 6. Cztery lane’y i orakle naukowe

| Lane | Wymagane osobno | Stan w tym audycie |
|---|---|---|
| FDM CPU | Dispatch authority, istniejące interaction/workflow fixtures, reference/energy/stop evidence | NOT VERIFIED |
| FDM GPU | Faktyczne device i precision, parity double, single tylko według kwalifikacji, no fallback, transfer/residency | NOT VERIFIED |
| FEM CPU | Managed MFEM/hypre/libCEED, mesh/space/BC/demag strategy, residuals i convergence | NOT VERIFIED |
| FEM GPU | Managed CUDA realization, device-resident prerequisites, CPU/GPU parity i strict rejection | NOT VERIFIED |

Macierz P0 rozszerza każdy wiersz o interaction × workflow × precision × BC/demag × topology × target. Nie oczekujemy wykonania nieistniejącej capability, lecz wymagamy zachowania i weryfikacji całego dotychczas wspieranego zakresu dotkniętego refaktorem. Wiersza FAIL nie wolno usunąć przez zmianę etykiety na unsupported bez odrębnej decyzji zakresowej.

Obowiązkowe klasy orakli: energia–pole/gradient tam, gdzie istnieje energia; residual i linearyzacja; torque/stopping; BC/constraints; refinement przestrzenne i czasowe; reference CPU/GPU; RNG/rejected-step/checkpoint. Dla thermal potrzebne właściwe miary/statystyki zamiast dowolnego bitwise parity. Tolerancje, konwencje i parametry pochodzą z kanonicznej noty/scenariusza, są przypięte przed oceną i nie zmieniają się po obejrzeniu wyniku.

Zachować oddzielność canonical µMAG/SP4 oraz istniejącego benchmarku warstwy sinc. Nie podstawiać jednego pod drugi. Porównanie FDM/FEM nie odejmuje surowych tablic z różnych siatek: wymaga wspólnego eksperymentu, jawnej projekcji i raportu błędu. Widoczny podobny obraz nie zalicza parytetu.

## 7. Istniejące punkty wejścia do weryfikacji

Poniższe nazwy odczytano z bieżącego `justfile` oraz `apps/control-room/package.json`. W audycie wejściowym **nie uruchomiono ich**; aktualny wykonany podzbiór i jego receipty są opisane w P0/P1. Pozostałe trasy są kandydatami do reuse, nie obietnicą że wszystkie mają obecnie działający preflight/harness. Przed wykonaniem sprawdzić args, zależności, source/runtime identity i zakres testów.

| Warstwa | Istniejące punkty wejścia | Zastosowanie |
|---|---|---|
| UI contracts | `check:architecture-hygiene`, `check:api-hygiene`, `typecheck`, `lint` | Moduły, facade i types; nie dowodzą runtime. |
| OpenAPI | `generate:api`, `generate:openapi-v2` | Druga recepta wywołuje `cargo run`; nie traktować jako czysty parser. Użyć zatwierdzonej trasy buildowej. |
| UI interaction | `smoke:inspector`, `smoke:study-authoring-ui`, `smoke:study-runtime-control`, `smoke:results-mode-sweep`, `smoke:live-charts` | Rozwinąć o nowe project/run contexts. |
| Viewport | `audit:viewport-main-tab-memory`, `audit:viewport-3d-memory-churn`, `validate:viewport-proof`, `smoke:viewport-3d`, `smoke:viewport-2d` | Aktywny canvas, WebGL context i drawing buffer, nieaktywne zasoby, memory churn. |
| FDM | `verify-fdm-relaxation-qualification-release`, `verify-fdm-relaxation-qualification-cuda-release`, `verify-fdm-multilayer-demag-production`, `verify-fdm-gpu-transaction-contract` | Zachowane właściwe lane/precision i profile; zbadać zależności testów. |
| FEM | `verify-fem-relaxation-qualification-release`, `verify-fem-relaxation-qualification-cuda-release`, `verify-fem-llg-time-domain-qualification-production`, `verify-fem-mixed-prism-airbox-runtime` | Managed runtime, native model i source receipts. |

Nowe testy transakcji/GC/identity/fencing nie mają jeszcze jednego unified runnera w tym pakiecie. P0/P1/P3a/P5 muszą go dostarczyć wraz z implementacją. Nie uruchamiać zbiorczo całego `just test`; wybierać adekwatny zakres i zachować rozdział source/managed/browser/science.

## 8. Budżety wydajności i soak

P0-E definiuje klasy mały/średni/duży model na reprezentatywnych hostach oraz konkretną fixture, rozdzielczość viewportu, liczbę widocznych glyphów, cold/warm cache i profil obliczeń. Mierzymy shell-open, projekt-open, edycję/Apply, queue/admission, preparation, pierwszy accepted step, time-to-tolerance, quantity switch, history open i export. CPU/RAM/VRAM/bytes/allocations oraz liczbę aktywnych subscriptions/RAF/workers zapisujemy obok czasu.

Przed oceną nowego kodu rejestr ustala dla każdej miary baseline, liczbę powtórzeń, p50/p95, rozrzut i akceptowalny próg regresji. Bez takiego rekordu performance gate ma BLOCKED. Nie wpisujemy 600 ms–2.5 s, <5 ms, 4–8 GB ani marginesu 2 GB jako potwierdzonych danych Fullmag.

Soak obejmuje wielokrotne Open/Close, A↔B, quantity changes, 3D↔plots, reconnect, wolnego klienta i błędy zapisów. Budżet pamięci musi być skończony; cache może się ewakuować, z legalnym ponownym pobraniem. Solver nie czeka na render ACK. Testy nie wyczerpują produkcyjnego dysku/GPU: używają limitowanego syntetycznego środowiska i fault injection.

## 9. Warunek wydania

Wymagany raport wymienia wykonane scenariusze i lane’y, wszystkie FAIL/BLOCKED/NOT_RUN, zgodność source/ABI, migrację starych danych, rollback, build/packaging, runtime, browser i science. Właściciele application/storage, solverów i frontendu dokonują przeglądu swoich bramek. Brak krytycznego dowodu blokuje odpowiedni rollout; nie jest usuwany z raportu przez ogólny badge „production”.

## 10. Aktualny checkpoint wykonawczy

Poniższe wyniki są późniejsze od audytu bazowego i nie zmieniają normatywnego zakresu scenariuszy:

| Warstwa | Wykonany dowód | Wynik |
|---|---|---|
| P0 storage/session | `just verify-session-persistence`, run `4315e35f99d74ffdb77159aaee82a9f5` | 70 passed, 0 failed, 0 ignored; source unchanged; minimalna bramka P0 zaliczona |
| P0 inventory | `python scripts/audit_refactor_p0.py --check` | 300 operacji OpenAPI, 300 handlerów, 0 unresolved, 2 router-only, 0 OpenAPI-only |
| P1 application/repository | managed `check-project-application` + `verify-project-application` | 6 testów adaptera + 13 lifecycle; receipts `passed` |
| P1 entrypoints | managed CLI/Python/desktop checks and runtime smoke | wspólny Open use case, `runtime=untouched`, receipts `passed` |
| P1 API/transport | managed API restart, empty-session WS reconnect, active-run reconnect | source/runtime identity przypięta; aktywny run zachował `session_id` i `run_id` |
| P1 browser/UI | `smoke:inspector`, project lifecycle, mounted-workspace reconnect | Inspector toggle, New/Open/Save/Close, ten sam workspace/canvas po reconnect; browser smoke `passed` |
| P2-C Python authoring | `final/p2/01-context-isolation.md`, `test_execution_context.py` oraz regresje ProblemIR/script builder/API | nesting/exception/async/thread/capture state i stale-handle fencing; slice `PASS`, P2 overall `IN PROGRESS` |
| P2-A canonical bytes | `final/p2/02-canonical-ir.md`, `model/canonical.py`, helper identity tests | stabilne bajty i digest ProblemIR, odrzucenie nieprzenośnego NaN; slice `PASS`, pełny P2-A `IN PROGRESS` |
| Pozostałe bramki | power-loss, pełna session-recovery, fizyczny Tauri, solver/science/release | `NOT VERIFIED`; nie wolno promować do wydania |

Szczegółowe ścieżki, hashe i granice dowodów pozostają w [statusie P0](p0/03-implementation-status.md) oraz [statusie P1](p1/README.md). Ten checkpoint nie zastępuje osobnych receipts dla czterech lane’ów FDM/FEM.
