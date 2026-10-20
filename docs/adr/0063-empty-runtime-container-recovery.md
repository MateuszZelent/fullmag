# ADR 0063 — odzyskanie pustego runtime po zakończeniu kontenera

Status: implementacja w toku, runtime **NOT VERIFIED**. Realizacja decyzji
użytkownika o kontrolowanym odzyskiwaniu po zakończeniu środowiska Docker.

## Kontekst

Błąd podczas wywołania natywnego draina może zakończyć PID 1 kontenera,
pozostawiając historyczny descriptor `Ready` i logi dzieci bez `drained`.
Wykryto taki przypadek przy mapowaniu technicznego pina właściciela na alias
accepted store. Poprawienie ścieżki chroni następne zatrzymania, ale nie
odtwarza utraconego dowodu zakończenia poprzedniego runtime.

Istniejące `recover_unknown_empty` wymaga `Unknown` i terminalnych logów.
Nie wolno zmieniać historycznego ownera, dopisywać draina ani uznawać samego
braku odpowiedzi za zakończenie pracy. Potrzebny jest odrębny dowód operatora
oparty na faktycznym zakończeniu całej prywatnej przestrzeni procesów Docker.

## Decyzja

Dodajemy osobny typowany wariant odzyskania **pustego** store. Nie zmienia
semantyki requestów, receiptów ani blokad istniejącego odzyskiwania v1.
Nie służy do odzyskiwania zaakceptowanych runów lub porzuconych lease'ów;
te wymagają własnych kontraktów, w tym ADR 0062.

Jawna operacja przypina konfigurację native, surowy owner i launch record,
tożsamość store i aplikacji, pule schedulerów, ledger oraz zachowany dowód
odrzucenia startupu przed admission. Oddzielna atestacja operatora wiąże
Docker Engine, pełne ID i image ID obu usług, konfigurację, mounty i etykiety,
prywatny PID namespace oraz terminalny stan `exited`, PID 0 i brak potomków.
Hostowy PID namespace, privileged container, współdzielony PID namespace,
Docker socket lub nieznany wynik zakończenia blokują operację.

Operator utrzymuje blokadę lifecycle wybranej grupy przez końcową obserwację,
zastąpienie dokładnie przypiętych kontenerów i publikację natywnego wyniku.
Stare kontenery można usunąć dopiero po zachowaniu ich niezmiennych dowodów
zakończenia. Nie usuwa się wolumenów, cache ani danych użytkownika.
Kompilacja nowej aplikacji nadal odbywa się w stałej usłudze `backend`.

Kolejność jest jawna: zachowanie dowodów starych, zatrzymanych kontenerów;
usunięcie tych dokładnych kontenerów; utworzenie stałego backendu i build
z cache; natywne odzyskanie przed admission; dopiero następnie start API.
Ta kolejność pozwala zbudować nową binarkę administracyjną w docelowym
backendzie i zapobiega ponownemu uruchomieniu starego container ID podczas
odzyskiwania. Awaria buildu zachowuje stary owner i wszystkie jego dowody;
nie jest sukcesem odzyskania.

Native ponownie sprawdza piny pod istniejącymi blokadami startup, launch,
ownera oraz host → store. Własny store musi być pusty według pełnej kontroli
runtime, a wszystkie rezerwacje hosta muszą mieć stan `Released`. Operacja
archiwizuje surowe dowody i publikuje lokalnego ownera `Failed` oraz osobny
idempotentny receipt. Nie publikuje `drained`, zakończenia solvera, wyników,
nowego RunIntent ani ponowienia Solve.

## Współistnienie grup

Nowa bramka hosta może pozostawić działającego inventory ownera innej grupy.
Zakończenie całej prywatnej przestrzeni PID zamyka deskryptory starego
runtime, w tym jego `flock`. Nadal trzymany natywny inventory lock należy
wtedy do procesu spoza zakończonej przestrzeni. Wniosek ten wymaga pełnego
dowodu izolacji i zakończenia; nie dotyczy słabszej obserwacji `Unknown`.

Przez całą publikację lokalnego wyniku trzymany jest host writer. Nowa
bramka nie zmienia host policy, readiness, snapshotu, inventory record,
inventory lease ani historii rezerwacji. Istniejąca bramka v1 nadal wymaga
braku aktywnego inventory ownera. Nie zastępujemy jej słabszym warunkiem.

## Granice danych i startu

Request, atestacja, manifesty i journal operatora pozostają w control volume.
Techniczne archiwum runtime pozostaje w volume-backed `runtime-services`.
Windows zachowuje sesje, wyniki, projekty i ustawienia. Odczyty przez alias
accepted store muszą wskazywać te same bajty, które zapisano przez techniczny
mount; guard CLI wymagający pina wewnątrz accepted store pozostaje aktywny.

Zwykły restart nigdy nie włącza odzyskiwania. Tylko jawne, przypięte wejście
operatora może uruchomić nowy wariant przed startem API. Brak dowodu lub
niezgodność pinu zamyka admission i zachowuje dane. Ponowienie tego samego
requestu sprawdza stan ponownie; zmieniony request albo inna generacja nie
mogą odtworzyć sukcesu starej operacji.

## Obowiązki implementacji i weryfikacja

Native odpowiada za typy, blokady, pusty store, walidację puli i aplikacji,
archiwum oraz publikację `prepared` → `recovered`. Launcher odpowiada za
rzeczywiste obserwacje Docker, granicę mountów, lifecycle lock oraz jawne
uruchomienie w tej samej grupie. Python sprawdza request, atestację i receipt;
nie edytuje ownera samodzielnie. Nie zmienia się Python DSL, ProblemIR,
OpenAPI, wybór CPU/GPU ani struktura workspace.

Regresje obejmują niezgodne piny, aktywny run/rezerwację, niepełny teardown,
niebezpieczny namespace, zachowanie foreign inventory ownera, przerwanie
publikacji i dokładny replay. Rust testuje CI zgodnie z wyjątkiem użytkownika;
lokalny build nie kompiluje testów. Oddzielne dowody są wymagane dla buildu,
rzeczywistego odzyskania, startu API i wykonania symulacji GPU.

Wycofanie nowej ścieżki oznacza jej odmowę oraz zachowanie stanu i archiwów.
Nie wykonuje się automatycznego downgrade'u receiptów, resetu ownera ani
przeniesienia technicznych danych do hostowego storage.
