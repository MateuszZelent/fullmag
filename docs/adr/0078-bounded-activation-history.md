# ADR 0078: ograniczona historia zakończonych aktywacji

Status: wdrażane; uruchomienie na danych użytkownika wymaga osobnej kwalifikacji.

## Kontekst

`BuildControl.operation_script()` dopuszcza najwyżej 64 katalogi prób w fazie.
Zakończone aktywacje pozostają w tej samej puli. Po 64 próbach grupa SP4
odmawia kolejnej aktywacji przed Solve, mimo braku aktywnej operacji.
Inwentaryzacja z 5.11.2026 wykazała 54 succeeded, 10 failed-confirmed,
829538 bajtów łącznie i najwyżej 32209 bajtów w jednym katalogu.
Podnoszenie limitu odsuwa problem; usuwanie katalogów traci dowody recovery.

## Decyzja

Limit 64 pozostaje granicą puli roboczej `activation/attempts`. Oddzielne,
ograniczone `activation/history-v1/<attempt>` zachowuje oryginalne pliki
zakończonej próby. Logiczne ścieżki, identyfikatory, hashe i bajty rekordów
nie zmieniają się. Wspólny czytnik kontrolny obsługuje obie lokalizacje.
Archiwum nie jest cache do usunięcia i nie jest drugą grupą Compose.

V1 kwalifikuje tylko zgodne receipt/terminal o stanie succeeded oraz wynik
activated z tym samym run/session/request/source. Sukces przyjęcia nie dowodzi
zakończenia obliczeń: wymagane są osobno terminalny katalog runu, zgodny
RunIntent, zwolnione lease oraz zachowane dane/provenance na WSL lub w Zarr.
Unknown, failed, niekompletne lub niespójne wpisy pozostają w puli roboczej.
Current, verified, bieżący poprzednik, aktywne operacje oraz domknięcie ich
referencji pozostają chronione. Sam wiek rekordu nie jest kwalifikacją.

Każdy katalog historii zawiera `.history.json` z pinami planu i dowodów oraz
`.history.sha256`. Indeks ma nagłówek `fullmag.activation-history.v1 <attempt>`
i uporządkowane wiersze `<sha256> <liczba-bajtów> <nazwa>`. Obejmuje wszystkie
pliki, w tym `.history.json`, oprócz samego indeksu. Czytnik odrzuca linki,
niezindeksowane pliki, duplikaty, niezgodne hashe/rozmiary i jednoczesny wpis
live/archive. Kod 44 oznacza wyłącznie rzeczywisty brak; uszkodzone archiwum
nie staje się opcjonalnym brakiem rekordu.

Granice pojedynczego wpisu: 32 pliki, indeks 16 KiB, dokument 8 MiB, log
32 MiB, całość 64 MiB. Zachowują istniejące budżety dokumentów/logów i zostawiają
zapas wobec zaobserwowanych 7 plików/próbę. Cała historia: 4096 prób i 256 MiB;
przy obserwowanym rozmiarze 64 prób odpowiada to około 53 MiB. To jawny limit,
nie obietnica bezterminowej retencji ani zgoda na automatyczne kasowanie.
Przekroczenie odmawia archiwizacji i wymaga kolejnej decyzji o zachowaniu danych.

## Publikacja i awarie

Preview jest tylko do odczytu. Apply wymaga hasha planu oraz świeżej kontroli
referencji, procesów, zadań, lease i tożsamości grupy. Używa istniejącej blokady
`operation.lock`, tego samego inode i namespace. Nie zmienia ownerów ani
markerów operacji. Od zebrania dowodów do zakończenia publikacji utrzymuje
również współdzielone blokady istniejących `WRITER.lock` SessionStore i ledgeru.
Aktywny writer powoduje odmowę; sam JSON o zwolnionym ownerze nie wyklucza
nowego zapisu. `HOST_INVENTORY_OWNER.lock` może pozostać w posiadaniu zdrowego
API: chroni czas życia właściciela, a publikacja jego pomiarów oraz zmiany
rezerwacji wymagają osobnej, wykluczonej tutaj blokady writer ledgeru.
Archiwizacja nie wycofuje ani nie zastępuje tego właściciela. Pin ledgeru
obejmuje cały dokument poza `runtime_state.snapshot_sha256`, czyli hashem
próbki telemetrycznej aktualizowanej co pięć sekund. Readiness, polityki,
rezerwacje i wszystkie pozostałe pola nadal unieważniają zmieniony plan.
Publikuje niezmienne metadane i indeks, fsync, a następnie
atomowo przenosi cały katalog w obrębie tego samego filesystemu i synchronizuje
oba katalogi nadrzędne. Żaden istniejący rekord nie jest przepisywany.

Przerwanie przed rename pozostawia wpis live; po rename pozostawia kompletny
wpis historyczny. Wznowienie sprawdza dokładne piny i aktualny stan, nigdy nie
powtarza Solve. Metadane przygotowane przed awarią nie są dowodem zakończonej
archiwizacji. W V1 nie ma automatycznego restore ani zapisu do historii.

## Zgodność i odbiór

Zmiana dotyczy wyłącznie zarządzania historią Docker DEV. Python DSL,
ProblemIR, wybór FDM/FEM CPU/GPU, API naukowe, wyniki i Zarr pozostają poza
mutacją. Własne guest readers/writers recovery wymagają osobnego audytu:
cel chroniony pozostaje live albo czytnik obsługuje historię; historyczny cel
zapisu odmawia przed skutkami ubocznymi. Nie wystarcza zmienić samo `read()`.

Implementacja obejmuje `docker_activation_history_reader`, kwalifikator
historii, wspólny `docker_build_control` i zarządzaną receptę preview/apply.
Recepta `just docker-dev-archive-activation <source-root> <activation>` wybiera
istniejącą, zdrową parę usług, również po zweryfikowanym resume/iteration.
Preview montuje control tylko do odczytu od pierwszego odczytu namespace;
`... true <plan_sha256>` może zmienić wyłącznie historię w tym samym wolumenie.
Oba tryby montują źródła, historyczny SessionStore i katalog wyników jako RO
przez bind odmawiający przy braku katalogu źródłowego. Historyczne bindy
`/state`, `/user-data`, źródeł, control i ledgeru są uwierzytelnione hashem
Compose z aktywacji i jej terminalnym receiptem development. Dokładne rekordy
kwalifikacji są ponownie sprawdzane pod blokadą przed publikacją.
V1 wymaga Linux/WSL, jawnego literalnego celu `.zarr` pod `/user-data/`
(także w podkatalogu), sąsiedniego
skryptu o oryginalnym hashu oraz eksportu oryginalnych rekordów aktywacji.
Pusty katalog runu nie wystarcza: wymagane są metadane Zarr, terminalny manifest
runu i zachowane artefakty wskazane przez jego deklarację output storage.
Brak pól przestrzennych jest dozwolony dla zapisu wyłącznie tabelarycznego.
Pierwsza kwalifikowana postać wyniku to pojedynczy leaf `reversal-attempt-1`
z tabelarycznym lub polowym autosave Zarr. Inne nazwy lub wiele leafów
wymagają rozszerzenia walidatora; nie są pomijane podczas kontroli.
Nie uzupełnia tych danych jako ukrytego skutku preview. Zmiana źródeł,
instancji usług, pinów, ledgeru albo zachowanych danych unieważnia plan.

Inwentarz obejmuje dokumenty bieżące i niezamknięte próby wszystkich
rozpoznanych korzeni control. Nieznany korzeń lub konsument odmawia operacji.
Historyczne markery aktywacji/retirement przestają być żywymi pinami wyłącznie
po powiązaniu z pasującym succeeded terminalem. Wyłączenie obejmuje tylko
uwierzytelniony plik markera; dodatkowe rekordy w jego katalogu pozostają
objęte kontrolą referencji. Bieżące wskaźniki zachowują
bezpośredniego poprzednika; dalsze domknięcie obejmuje jawne piny attempt/path,
a nie cały łańcuch historycznych `retirement.run_id`. Root-owned marker
własności wolumenu jest odczytywany osobno, bez zmiany uprawnień, walidowany
według dokładnego schematu i kontrolowany przez pin inode/stat w helperze.
W jedynym bieżącym `runtime-control/runtime-services/OWNER.json` pin pomija
`heartbeat_at` po potwierdzeniu zdrowego schematu, czasu UTC i zgodności
wszystkich pozostałych pól z niezmiennym `docker-client-<owner_token>.json`.
Pełny dokument nadal podlega wykrywaniu referencji, a niezmienny rekord Ready
jest pinowany w całości. Zmiana ownera, procesu, dzieci lub stanu unieważnia plan.

Wymagane są wykonywalne regresje czytnika, planu/CAS, ochrony referencji,
limitów, wyścigów i awarii. Próba 64 wpisy → archiwizacja → nowa aktywacja
musi zachować bajty i dostęp po starym ID. Test źródeł nie jest dowodem
archiwizacji grupy SP4 ani zakończenia symulacji.

Rollback źródeł sprzed obsługi historii po pierwszej archiwizacji jest
niedozwolony bez uprzedniego odtworzenia chronionych ścieżek i kwalifikacji
ich konsumentów. Do pierwszego apply zmiana nie przenosi żadnych danych.
