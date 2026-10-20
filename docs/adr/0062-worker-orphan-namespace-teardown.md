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
