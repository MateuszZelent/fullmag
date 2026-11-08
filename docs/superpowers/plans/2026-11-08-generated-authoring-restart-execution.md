# Wdrożenie preflightu wygenerowanego authoringu — 08.11.2026

Użytkownik zatwierdził projekt, testy oraz jedną sekwencję:
aktualizacja3203 → Prepare corner25 → warunkowe V/J/H.
Projekt:2026-11-08-generated-authoring-restart-preflight-proposal.md,
SHA256 e9307db2649cbc2f052c23ccf9f7f1fbad90a7ea6ce345cfd43f2095e2ee34c8.

## Zmiana i stan odbioru

Nowy addytywny checkpoint fullmag.saved-generated-authoring-restart.v1
wiąże kanoniczny scene_document.py z hashami, rozmiarem, kopią w FMS,
metadanymi API, sesją oraz obserwacją pliku przed/po.
Legacy v1 i empty zachowują odmowy. Dotychczasowe recovery nie otrzymują
nowej autoryzacji: allow_generated domyślnieFalse, True tylko w zwykłym
wejściu saved-authoring restart. Bez nowej ścieżki recovery.

scripts/docker_saved_authoring_generated.py jest właścicielem tych pinów;
scripts/docker_volume_dev.py deleguje walidację i wstrzykuje ten sam kod
odczytu do istniejącej próby gościa. Nie wykonuje ani nie importuje źródła.
Zachowano wszystkie dotychczasowe bramki drain, historii, lease i publikacji.
Nie zmieniono fizyki, limitów, .env lub istniejących wyników.

6 nowych testów PASS (0.121s) i65 regresji PASS (5.484s), istniejący backend,
interpretowany Python3.10.12. Pierwszy test przed implementacją odmówił
importu nowego modułu zgodnie z oczekiwaniem. Lokalnych testów Rust nie kompilowano.
Niezależny przegląd dokładnego diffu względem pierwotnego blobu
3a02dbbe4f29fd326bee442e59c0d7d6815d0f5a nie znalazł blokera.
Sześć nowych testów sprawdza część gościa i ręczny proof oddzielnie;
pełne spięcie sprawdził rzeczywisty odczytowy preflight opisany poniżej.

## Trwały projekt i rzeczywisty preflight

Publiczne persistence/projects/authoring utworzyło nowy FMS, bez zmiany
bieżącej sesji. Projekt project-12a89e5144084a5ab7bf501d1593cf56,
revision6, scena nadal revision1 i dokładnie zgodna bajtowo po kanonizacji:
5a78f67548162c0e33c78324573ebf680b9bf6f4de9d0cd2aa0cc6600173c864.
Zachowano oryginalny FMS, pierwotne źródło i jego historię.

Nowy FMS16091B:
0e2ff84b68beb5910d779d623fbd793e5b44a58151f544aca36ab1984f197318.
Na ext4 WSL, UID1000,0600:
 /home/kking/git/storage/runtimes/antenna-transport-e2e-20261011-5d5deadcd16e0fb1/docker-volume-dev/09064b744fb045bea6ffff853dd25c1f/runs/projects/gsg-generated-authoring-prebuild-0e2ff84b68beb591.fms

Wygenerowane źródło5483B, SHA256:
d6c8d55caf95638089ba71b5a0f326f7f00094520bf79bd810f0f4aa7c0b2e94.
Pełny _SAVED_AUTHORING_PROBE_SCRIPT i wszystkie walidatory przeszły.
Źródło przed/po ma identyczne bajty, inode, device, mtime i ctime.
Dwa lease są released, kolejka/polecenia puste, run=null, zachowany katalog
zakończonego runu zgodny. Nie wykonano Start lub Solve podczas preflightu.

Pierwsze narzędzie porównujące zapis checkpointu błędnie oczekiwało braku
końcowego LF po BuildControl.write. Rzeczywisty preflight już wtedy przeszedł;
odczyt potwierdził identyczny JSON i kontrakt write=canonical+LF.
Nie było odmowy lifecycle ani ponowienia aktualizacji. Do dalszego CAS
używamy SHA rzeczywistych zapisanych bajtów.

Prefiks control:verification/generated-authoring-restart-20261108/.
approved-checkpoint.json:
dcc5779988b5dc099fda3043602cfa0cdb7d169a272bbb444ca0e5f52c2cb78e.
approved-preflight.json zachowuje pełny odczyt. red/green/regression
stdout/stderr.log zachowują testy. authoring-update-response.json zawiera
kanoniczny wynik publicznego zapisu.

## Pozostałe kroki tej jednej sekwencji

Managed restart/build nie został jeszcze uruchomiony w chwili tego checkpointu.
Następnie odbiór pakietu i danych, jedno Prepare corner25 oraz jedno V/J/H
tylko po pełnym odbiorze Prepare. Bez retry, H-only, LLG, nowego recovery,
kasowania kontenerów/danych lub podnoszenia limitów. Odmowa kończy zakres.
Nie deklarujemy nowej wartości eta/I/H ani reprodukcji publikacji.
