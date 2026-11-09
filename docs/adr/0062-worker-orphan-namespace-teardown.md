# ADR 0062 — odzyskanie zasobów po zakończeniu prywatnego środowiska workera

Status: decyzja użytkownika przyjęta 17.10.2026; implementacja w toku, runtime **NOT VERIFIED**.

## Kontekst

Worker może zostać utworzony, a nadzorca zakończyć się przed publikacją jego
trwałego exit receiptu. Bramka `Consumed` oznacza wtedy, że proces mógł wykonać
część pracy. Brak procesu podczas późniejszej obserwacji nie jest dowodem
`WorkerNoSpawn` ani podstawą do syntetycznego PID, heartbeat acknowledgement
lub wyniku symulacji. Rezerwacja pozostaje zajęta i blokuje kolejne uruchomienia.

## Decyzja

Dodajemy jawne odzyskiwanie jednej przypiętej rezerwacji po autorytatywnym
zatrzymaniu jej prywatnego środowiska przez Docker Engine. Operacja jest
narzędziem operatora; zwykły start, restart i `service-ensure` jej nie wykonują.
Nie zmienia Python DSL, `ProblemIR`, wyboru FDM/FEM CPU/GPU ani OpenAPI.

Przed zatrzymaniem operator przypina request, konfigurację, surowy owner,
claim/lease, rezerwację, token `Consumed`, runtime generation, host storage,
Docker Engine, pełny container ID, image ID oraz konfigurację i mapowanie GPU.
Natywny runtime pod blokadami startup, launch, istniejącego ownera oraz
host→store zapisuje niemutowalny intent i kwarantannę. Capacity pozostaje zajęte.

Następnie host zatrzymuje wyłącznie wskazany kontener. Dowód wiąże ten sam
Engine i konfigurację, terminalny stan `exited`, PID 0, czas zakończenia oraz
prywatny PID namespace i wszystkie procesy potomne. Dedykowany kontener
backendu może stanowić `sole_worker_scope`; nie wymaga odtwarzania utraconego
PID workera. Współdzielony/hostowy PID namespace, privileged container,
nieznany wynik stop, zmienione mapowanie GPU i niezgodne piny blokują release.

Finalizacja natywna ponownie sprawdza piny i zapisuje osobny typed proof
`WorkerOrphanTeardown`. Zwalnia wyłącznie dokładny lease i host reservation.
Historyczna bramka pozostaje `Consumed` z tym samym tokenem. Nie powstaje
worker exit receipt, `Started`, heartbeat acknowledgement ani ponowienie Solve.
Task pozostaje `Reconciling`, a jego wynik jest nieznany. Wyniki i journale
pozostają zachowane; ponowne obliczenie wymaga osobnej decyzji.

## Granica zaufania i wykonanie

Hostowy adapter sprawdza rzeczywiste odpowiedzi Docker Engine. Dokumentuje
oddzielnie autoryzację storage i dowód zatrzymania; certyfikat storage sam nie
poświadcza zakończenia procesów. Używa istniejącej granicy zaufania narzędzia
operatora, bez nowego serwera podpisującego ani interpretowania tekstu logów.

Dwie stałe usługi aplikacji nadal nazywają się `frontend` i `backend`.
Techniczna finalizacja może użyć krótkotrwałej usługi `backend-recovery` w tej
samej grupie Compose, po zatrzymaniu docelowego backendu. Nie kompiluje kodu,
nie uruchamia API ani solvera, nie publikuje portów i nie ma sieci ani GPU.
Korzysta z wcześniej zweryfikowanego pakietu w trwałym cache. Brak zależności
linkera lub dowodu izolacji kończy operację bez zwolnienia capacity.

Obecna binarka administracyjna linkuje bibliotekę FEM/CUDA również wtedy,
gdy nie uruchamia solvera. Bez GPU może używać wyłącznie przypiętej po SHA-256
biblioteki stub z CUDA SDK w tym samym niemutowalnym obrazie. Adapter udostępnia
ją jako `libcuda.so.1` tylko procesowi administracyjnemu i dopuszcza jedynie
probe loadera oraz dwa polecenia orphan teardown. Zwykły start runtime i solvera
jest zabroniony w tej ścieżce. Brak urządzeń GPU sprawdza przed wywołaniem.
Nie jest to dowód działania CUDA ani fallback obliczeń; normalny backend nadal
korzysta z prawdziwego sterownika. Dowód loadera i jego digest pozostają
w manifeście operatora. Probe jest tylko do odczytu i poprzedza mutacje intentu
oraz zatrzymanie wskazanego backendu.

Dla `windows-folder-v1` każda faza administracyjna wystawia własny grant
storage w swojej przestrzeni montowania. Korzysta z przypiętego issuer'a
`windows_folder_probe`, pełnych prób operacyjnych i hostowego certyfikatu.
Grant poprzedniego backendu nie jest dowodem bieżącego namespace. Natywne
sprawdzenie inode namespace pozostaje obowiązkowe. Przed rotacją adapter
potwierdza brak writerów poza terminalnym keeperem, a helper ponownie wiąże
request, konfigurację, Failed ownera i jego dwa terminalne procesy potomne.
Dowód rotacji jest przypięty do fazy i tego samego requestu.

Przerwanie przed potwierdzonym prepare nie zmienia UUID requestu. Jawny
parametr `--resume-before-stop` pozwala ponowić wyłącznie administracyjne
prepare z identycznym requestem i pins. Nowe próby tylko do odczytu mają
oddzielny katalog dowodów; poprzednie rekordy nie są nadpisywane. Istniejący
dowód prepare lub zatrzymania blokuje tę ścieżkę. Nie jest to wznowienie
symulacji ani dowód wyjścia workera. Domyślne wywołanie nadal odmawia
powtórzenia przy istniejącym request i działającym kontenerze.

## Zgodność i migracja

Nowy proof ma odrębną semantykę i wersję. Nie kodujemy go jako `Worker`,
`WorkerNoSpawn` ani brak admission. Przed pierwszą publikacją należy zatrzymać
pozostałych klientów tego samego host ledgeru i zaktualizować ich do wersji
rozumiejącej nowy proof. Starszy klient ma odmówić odczytu, zamiast ignorować
nieznany dowód. Nie obiecujemy wstecznej zgodności tej nowej operacji.

Dotychczasowe proofy zachowują swoje bajty i walidację. Exact replay kończy
wyłącznie ten sam intent; niezgodne requesty są odrzucane. Awaria pomiędzy
release lokalnego lease a publikacją ledgeru zachowuje capacity i pozwala
dokończyć ten sam proof. Nie usuwamy wpisów historii ani nie cofamy ownera.

## Obowiązki implementacji i weryfikacja

Typed request, intent, attestation i proof należą do native host ledgeru;
CLI odpowiada za istniejące runtime guards. Hostowy adapter i jawna recepta
`just` odpowiadają za piny kontenera i kontrolowany teardown. Dokumentacja
architektury i specyfikacja runtime opisują ten sam protokół.

Wymagane regresje obejmują zgodną finalizację i replay, zmienione piny,
Consumed token, shared/privileged namespace, brak dowodu GPU/Engine,
niepewny stop, częściową publikację oraz zachowanie journalu i nieznanego
wyniku bez replayu Solve. Testy Rust wykonuje CI zgodnie z wyjątkiem użytkownika;
lokalny build nie kompiluje testów. Rzeczywisty test Docker pozostaje osobnym
dowodem. Brak tej weryfikacji oznacza **NOT VERIFIED**.

## Rozszerzenie po ENOSPC: rozpoczęty claim bez receiptu wyjścia

Status rozszerzenia: projekt przyjęty do implementacji 05.11.2026; źródła,
zarządzane testy i wykonanie **NOT VERIFIED**. Dotychczasowy protokół V1
zachowuje odmowę dla trwałego `Started` i wszystkie dotychczasowe bajty.

W DEV potwierdzono przypadek: zadanie ma trwały `Started`, owner jest
`Unknown`, a zapis potwierdzonego wyjścia workera nie powiódł się przez
ENOSPC. Statystyki i częściowe pliki mogą istnieć, ale brak receiptu wyjścia,
końcowego stanu i zwolnienia lease. Obserwacja nieistniejących PID nie
poświadcza zakończenia całej prywatnej przestrzeni procesów. Zwykły restart,
`service-ensure`, nowy request ani ścieżka `WorkerNoSpawn` nie mogą tego naprawić.

Odrębny protokół `claimed_worker_interruption.v1` stosuje następujący kontrakt:

1. Przygotowanie wiąże jeden claim/attempt/epoch, cały katalog i journal,
   trwały `Started`, inbox i właściciela slotu, dokładny ACTIVE lease,
   rezerwację COMMITTED i niezmieniony token Consumed. Wiąże również surowe
   owner/process/launch/config, pakiet, wybrany lokalny ledger DEV, Engine,
   prywatny namespace, kontener oraz manifest zachowanych plików. Stosuje
   dotychczasową kolejność blokad startup/launch/owner oraz host→store.
2. Przygotowanie publikuje trwały intent i kwarantannę. Capacity pozostaje
   zajęte, a historyczne Started, heartbeat i Consumed nie zmieniają bajtów.
   Przed kwarantanną zachowuje również oryginalne bajty process receiptu
   w niezmiennym archiwum przypisanym do pełnego SHA żądania. Finalizacja
   sprawdza ten dowód i jego lineage; terminalny zapis PID 1 przy zatrzymaniu
   nie zastępuje historycznego dowodu ani nie unieważnia go samą zmianą pliku.
3. Dopiero attestation rzeczywistego Engine dla tego samego kontenera
   (`exited`, PID 0, zgodne StartedAt/FinishedAt, obraz, konfiguracja i
   sole-worker/private PID namespace) pozwala finalizować przerwanie. Niepewny
   stop, obcy konsument, dodatkowy claim, zmiana pinów lub shared/privileged
   namespace blokują operację.
4. Finalizacja zapisuje oddzielny operacyjny receipt
   `interrupted-no-final-state`, istniejący stan Interrupted i dedykowany
   typed release proof. Nie tworzy worker exit receiptu, exit code, zdarzenia
   zakończenia obliczeń, magnetyzacji końcowej ani dowodu drain. Zwalnia
   wyłącznie dokładny lease i rezerwację, archiwizuje slot i zapisuje własny
   operacyjny dowód przejścia Unknown→Failed.
5. API może prezentować przerwany przebieg jako failed z dokładnym powodem
   braku stanu końcowego. Nie zmienia to fizycznego wyniku na completed ani
   converged. Nie dodajemy nowego enum OpenAPI, Python DSL ani ProblemIR.
   Nowe obliczenie od początku jest osobną jawną operacją; recovery nie
   wywołuje Solve i nie deklaruje ExactResume.

Każda częściowa publikacja pozostawia zachowany intent i capacity do
uzgodnienia. Ponowienie dotyczy tego samego UUID i identycznych pinów;
zmienione wejścia nie tworzą zastępczego dowodu. Żadne istniejące walidatory
orphan V1, reaped-worker z prawdziwym receiptem ani container-recovery V2–V5
nie uzyskują cichego wyjątku.

### Bootstrap naprawy w martwym backendzie

Gdy pakiet nie rozumie nowego protokołu, dopuszczalny jest osobny, jawnie
przypięty tryb **build-only** istniejącego recovery builda. Może obejmować
wyłącznie jeden dokładny martwy claim ze zużytym tokenem, przy zgodnych CAS
store/ledger, fenced API i potwierdzonym braku procesów native. Pozostałe
rezerwacje muszą być zwolnione. Kompilacja pozostaje w tym samym stałym
backendzie i prywatnym wolumenie grupy. Owner pozostaje Unknown, a capacity
pozostaje zajęte. Tryb nie uruchamia API, runtime ani solvera i nie poświadcza
teardown. Brak dowodu któregokolwiek warunku blokuje również build.

Przed wywołaniem nowego narzędzia wymagane może być opublikowanie pakietu
do kanonicznej ścieżki: admission danych DEV wiąże skompilowany kod z current
i jego provenance. Dopuszczalna jest jawna promocja z tym samym dokładnym
permittem martwego claimu, blokadami i CAS przed/po, tylko przy fenced API,
bez procesów native i bez zmiany ownera, lease, journalu ani tokenu Consumed.
Obowiązują istniejący rotation journal, rollback oraz zgodność fresh manifest.
Ogólny tryb diagnostyczny bez takiego claimu nadal nie zezwala na promocję.
Publikacja pakietu nie stanowi gotowości runtime ani dowodu teardown;
administracja używa następnie jawnie wybranego current z przypiętym receiptem.

Po kwalifikacji pakietu przygotowanie i finalizacja używają powyższej
procedury Engine i krótkiej administracyjnej usługi w tej samej grupie,
bez sieci, GPU i kompilacji. Zwykły zarządzany start API jest dopiero następnym
etapem po pełnej weryfikacji release i archiwum. DEV dotyczy lokalnego
`group-ledger-v1`; nie migrujemy ani nie zatrzymujemy cudzych grup. Starsi
czytelnicy tego samego ledgeru muszą odmówić nierozpoznanego proofu.

### Weryfikacja rozszerzenia

Wymagane są sukces i exact replay, odmowy dla każdego zmienionego pinu,
żywego procesu, dodatkowej rezerwacji i obcego namespace, obowiązkowy Started
oraz brak starego exit receiptu, testy przerwania na każdej granicy publikacji,
bajtowa zgodność zachowanych plików i brak replayu, fikcyjnych zdarzeń lub
końcowego stanu. Bootstrap ma osobne testy exact-claim-only i CAS przed/po.
Zarządzane testy Rust/Python, review oraz jedna rzeczywista operacja operatora
są oddzielnymi bramkami; zapis niniejszego kontraktu ich nie zastępuje.
