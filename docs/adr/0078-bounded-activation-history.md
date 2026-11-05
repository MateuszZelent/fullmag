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
markerów operacji. Publikuje niezmienne metadane i indeks, fsync, a następnie
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
Wymagane są wykonywalne regresje czytnika, planu/CAS, ochrony referencji,
limitów, wyścigów i awarii. Próba 64 wpisy → archiwizacja → nowa aktywacja
musi zachować bajty i dostęp po starym ID. Test źródeł nie jest dowodem
archiwizacji grupy SP4 ani zakończenia symulacji.

Rollback źródeł sprzed obsługi historii po pierwszej archiwizacji jest
niedozwolony bez uprzedniego odtworzenia chronionych ścieżek i kwalifikacji
ich konsumentów. Do pierwszego apply zmiana nie przenosi żadnych danych.
