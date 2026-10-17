# ADR 0061 — budowanie i uruchamianie developerskiego backendu w jednym kontenerze

Status: decyzja użytkownika przyjęta; implementacja i runtime **NOT VERIFIED**.
Data: 2026-10-17.

## Kontekst

Development ma być widoczny w Docker Desktop jako jedna grupa wybranego
checkoutu z usługami `frontend` oraz `backend`. Dotychczasowy launcher buduje
backend w jednorazowym kontenerze, publikuje pakiet w storage Windows, a potem
uruchamia osobny kontener runtime. Rozdziela to logi i wydłuża iteracje przez
kopiowanie dużych artefaktów. Użytkownik wymaga jednego stałego kontenera
backendu, który buduje kod i następnie uruchamia aplikację.

## Decyzja

W trybie dev dokładnie dwie stałe usługi aplikacji należą do projektu
`fullmag-master` lub `fullmag-worktree-<worktree_id>`:

- `frontend` uruchamia Next.js dev i HMR z wybranego checkoutu Windows;
- `backend` przy starcie wykonuje zweryfikowany, przyrostowy build, a następnie
  w tym samym kontenerze uruchamia API i nadzorowany native runtime.

Decyzja użytkownika z 17.10.2026: frontend DEV domyślnie uruchamia Node Inspector
na loopback wewnątrz kontenera. Nie publikuje portu debuggera na hoście i nie czeka
na podłączenie klienta przed startem aplikacji. Log wskazuje adres właściwego
procesu Next.js. Ten tryb dotyczy serwera Node.js; release pozostaje bez Inspectora.

Docker Desktop i `docker logs` pokazują pełen przebieg backendu: przygotowanie
źródeł, kompilację, publikację wyniku i uruchomienie usług. Tryb dev nie tworzy
osobnego `backend-build` i nie przenosi dużego pakietu między kontenerami przez
storage Windows. Toolchain pozostaje przypiętym obrazem Docker; jawne buildy
release i kwalifikacja CI zachowują odrębne procedury.

Źródła są montowane readonly. Kompilator pracuje na zweryfikowanym cieniu ext4
z utrwalonym cache Cargo/CMake/CUDA. Backend obejmuje FDM CPU, FDM GPU, FEM CPU
i FEM GPU; wybór realizacji pozostaje w authored intent i plannerze. Wymuszone
GPU nie ma fallbacku CPU. Zmiana mechaniki budowania nie poszerza kwalifikacji
fizyki ani wspieranych kombinacji modelu.

Każdy start backendu, także zwykły restart w Docker Desktop, samodzielnie sprawdza
aktualne zamontowane źródła i zależności, przygotowuje spójne wejście kompilacji
i korzysta z trwałego cache. Bez zmian uruchamia istniejący wynik; po zmianach
przebudowuje tylko to, co wymaga kompilator. Nie ma dodatkowej czynności użytkownika
odświeżającej manifest na hoście. Manifest i provenance powstają wewnątrz kontenera
z rzeczywistego wejścia danego buildu. Edycja podczas kompilacji nie miesza wersji.

Przed restartem użytkownik zapisuje projekt i kończy aktywną symulację. Zatrzymanie
backendu zachowuje potwierdzony native drain. Przy zgodnym obrazie i mountach
restart używa tego samego container ID, a frontend pozostaje uruchomiony. Zmiana
obrazu lub mountów może wymagać odtworzenia usługi. Nie wolno zastępować kontenera
na podstawie timeoutu ani uznawać utraty obserwacji za potwierdzenie zatrzymania.
Niepotwierdzony owner wymaga kanonicznego recovery przy ponownym użyciu jego
store. Świeży start tworzy osobny namespace; zachowuje dawny store i nie resetuje
jego ownera. Nadal wymaga kanonicznej walidacji wspólnego ledgeru i release proofs.

Kompilację chroni blokada per trwały cache wewnątrz backendu, także bez launchera
na hoście. Odrębne grupy z własnymi cache mogą budować równolegle; nie współdzielą
mutowalnych katalogów Cargo/CMake. Hostowy heavy lock obejmuje przygotowanie
obrazów/toolchaina i hostowych receiptów, a kończy się przed uruchomieniem usług.
Nie traktujemy Win32 lock i Linux flock na bindzie Windows jako wspólnej blokady.
Wspólny host ledger nadal chroni przydział fizycznych CPU/GPU podczas symulacji.

Budowanie odbywa się przed startem API; nie podmienia plików wykonywanych przez
aktywną symulację. Nieudany build zachowuje logi i receipt, pozostawia backend
niegotowy i nie uruchamia API z częściowo opublikowanym pakietem. Zachowujemy
ostatni zweryfikowany pakiet, cache i dowody; brak automatycznego resetu stanu.

Sesje i wyniki nadal leżą w fizycznym storage Windows. Ustawienia i historia
pozostają w osobnej bazie grupy. Backend nie publikuje portu hosta; frontend
łączy się z `backend:8081` przez prywatną sieć grupy i udostępnia jeden wybrany
port loopback. Home może działać podczas budowania lub niedostępności API.

Opcjonalny plik `.py` pozostaje wejściem startowym tego samego launchera:
publikuje aktywny model i zachowuje automatyczne Solve albo trwałe oczekiwanie
`wait_for_solve`. Restart backendu nie jest nowym, niejawnym poleceniem Solve.

Dostępność API/native runtime i wynik opcjonalnej aktywacji skryptu są odrębne.
Po atestacji i trwałym markerze `started`, konflikt HTTP `409`, błąd serwera lub
utrata transportu pozostawiają wynik `unknown` i blokują ponowienie POST/Solve.
Nadzorca zachowuje działające API i native ownera, publikując osobną diagnostykę.
Launcher nie uznaje takiej aktywacji za udaną kwalifikację. Błędy integralności,
provenance, polityki i kontraktu odpowiedzi pozostają fatalne. Zmiana nie
poszerza listy znanych odrzuceń fizyki i nie resetuje ownera ani historii.

## Retencja technicznych pakietów dev

Decyzja użytkownika z 17.10.2026 rozszerza publikację dev o automatyczne
usuwanie zastąpionych, zweryfikowanych pakietów. Zachowujemy bieżący pakiet
i bezpośredni rollback. O kwalifikacji decydują receipty i łańcuch poprawnie
zakończonych rotacji, nie czas utworzenia ani nazwa katalogu.

Operacja pozostaje w tym samym backendzie i pod blokadą trwałego cache.
Nowy pakiet musi być trwale opublikowany i zweryfikowany przed usunięciem
starszych kopii. Najpierw utrwalamy logi, receipty, metadane rotacji i raport
sprzątania. Nieznane, niespójne lub używane dane są zachowywane z diagnostyką.
Błąd sprzątania nie cofa poprawnej publikacji ani nie usuwa ostatniego rollbacku.

Zakres nie obejmuje mutowalnego cache kompilacji, źródeł, danych użytkownika,
sesji, wyników, ustawień ani historii rezerwacji. Nie zmienia formatu API,
semantyki solverów i reguł aktywacji skryptu. Implementacja dotyczy
`docker/all-in-one/backend_dev.py`, regresji publikacji i tego przewodnika.
Wymaga dowodu retain-current/rollback, ochrony nieudanej publikacji,
zachowania nieznanych danych oraz rzeczywistego odzyskania miejsca w kontenerze.
Do wykonania tych bramek automatyczna ścieżka pozostaje **NOT VERIFIED**.

## Admission storage Windows po przebudowie dev

ADR 0059 pozostaje kontraktem filesystemu, ownera i grantów. Dla live dev host
wydaje dodatkową, opcjonalną delegację `development_build` w readonly certyfikacie:
`fullmag.windows-folder-development-build.v1`, `cargo_profile=backend-dev`,
przypięty `toolchain_image_id`, `group_identity`, kanoniczne `package_root` oraz
`provenance_path`, a także `source_identity` pierwszego zweryfikowanego buildu.
To pole jest zakresem autoryzacji zaufanego buildera tego samego obrazu i grupy;
nie jest drugim pinem blokującym przyszłe zmiany kodu. Bez delegacji zachowujemy
dokładne przypięcie źródeł i binariów z dotychczasowej ścieżki release/static.

Każda nowa binarka nadal sprawdza bieżący compiled commit i własny hash, dane
rzeczywistego receipt/provenance, jego digest, profil i toolchain. Walidacja
nowego pakietu nie może zostać zastąpiona flagą środowiskową. Hostowy certyfikat
nie traci powiązania z image, engine, ownerem, lokalnym NTFS/ReFS, no-reparse,
operacyjnymi próbami storage i readback. Runtime weryfikuje aktualny mount grant.

Pierwszy start ma kolejność: build i receipt → hostowy certyfikat → niezależne
próby storage i readback → `restart_verified` → start API/native runtime.
Backend czeka na tę granicę z ograniczonym czasem, zachowując logi po błędzie.
Host aktualizuje pojedynczy bind certyfikatu in-place z flush/readback, ponieważ
podmiana nazwy pliku nie aktualizuje pewnie istniejącego bind mountu. Przejściowa
różnica samego `restart_verified` między certyfikatem i markerem jest stanem
oczekiwania; inna tożsamość ownera lub obrazu pozostaje błędem.

Kolejny zwykły restart używa tej samej delegacji storage, ale sprawdza nowy
rzeczywisty pakiet i ponawia guest storage preflight. Nie wymaga hostowego
odświeżania certyfikatu dla każdej zmiany kodu. Cofnięcie delegacji wymaga
potwierdzonego zatrzymania i jawnego wdrożenia zgodnego pakietu z dokładnym
certyfikatem; zachowuje sesje, wyniki i dotychczasowe dowody.

## Wdrożenie i weryfikacja

1. Dodać typowane `build-then-serve` w `backend_dev.py`: istniejący lock, Make,
   hash artefaktów, receipt i walidowany handoff do `entrypoint.py`.
2. Przenieść cache, manifest i wejścia Git do stałej usługi `backend`;
   zachować hardening, osobne sieci, frontend HMR oraz storage Windows.
3. Usunąć jednorazowy build z developerskiego `up`; dodać kontrolowany restart
   ze sprawdzeniem aktualnych źródeł wewnątrz kontenera i zachowaniem container ID,
   gdy konfiguracja zgodna; zwykły restart Docker Desktop nie wymaga host-refresh.
   Uaktualnić README, AGENTS i przewodnik; rozdzielić opis dev od release.
4. Wykonać adekwatne regresje Pythona i rzeczywisty start dwóch usług. Sprawdzić
   log kompilacji w `backend`, API/UI, ponowne użycie cache po restarcie, trwałe
   dane oraz start pliku `.py`. Dowód wykonania GPU pozostaje osobną bramką.

Nie kompilujemy lokalnie testów Rust w czasie obowiązywania zakazu użytkownika.
Udany build nie zastępuje dowodu browser/runtime ani wymaganych kontroli PR.
Wycofanie wymaga potwierdzonego zatrzymania własnej grupy i jawnego wskazania
zachowanego, zweryfikowanego pakietu; nie kasuje cache, sesji ani wyników.
