# Dokończenie retained frontend refresh po odtworzeniu kontenera

Zakres: jednorazowe, typowane domknięcie dokładnie wskazanego refreshu;
bez ponownego stop/start/recreate, Solve, resetu ownera lub usuwania danych.
User jawnie zlecił rebuild backend/frontend i ponowienie bimeronu.

## Stan i przyczyna

Development attempt `55680639a0ec435090bebc89ee13cdda` jest unknown po
udanym odtworzeniu nowego, zdrowego frontendu. Backend pozostał niezmieniony.
Guard porównał daemonową ścieżkę WSL z odziedziczonym hostowym pinem Compose.
Host/backend/frontend mają tę samą tożsamość plików; dotychczasowego receiptu
nie wolno ręcznie poprawiać ani powtarzać mutacji.

## Kontrakt procedury

Nowy zarządzany helper `scripts/docker_volume_frontend_refresh_reconcile.py`
działa w grupowym BuildControl wybranego app checkoutu. Oddzielne prepare
oraz apply, z hashem kanonicznego requestu. Request i wszystkie dowody
wyłącznie w control volume. Prepare nie mutuje usług ani istniejących dowodów.

Wymagane piny: source root/commit; dokładny attempt unknown i SHA jego
receipt/active; oryginalny Compose SHA; backend/frontend container IDs,
StartedAt, image i config fingerprint; package/provenance/binary hashes;
retained state/owner/certificate; frontend seed/input hashes i native source.
Nie dopuszczać innej klasy unknown niż post-recreation frontend refresh.

Przed apply powtórzyć wszystkie odczyty pod istniejącym, dokładnym lease/CAS.
Nie otwierać konkurencyjnej operacji i nie usuwać markerów ręcznie. Użyć
istniejących mechanizmów reconcile/BuildControl do publikacji i zwolnienia
własnego helpera. Każda niezgodność zachowuje stan i kończy się błędem.

## Dowód źródeł i bindów

Walidacja całego Compose i usług pozostaje ścisła. Rozbieżność namespace WSL
może być zaakceptowana tylko przez niezależny dowód: oczekiwane host source
jest identyczne, backend ma już zaufany daemon pin, frontend ma ten sam
daemon source (albo poprawną tożsamość podkatalogu) oraz zgodne read-only
mount type/target; host i oba kontenery mają zgodne dev/inode i hashe
oznaczonych plików. Nie wystarcza basename, podobna ścieżka ani obserwacja
samego nowego kontenera. Nie zmieniać globalnego validatora na permissive.

Zachować oryginalny Compose/receipt. Zapis nowego jawnie wyprowadzonego
Compose z daemon pinami ma własny hash i witness do poprzedniego stanu.
Po tym wykonać istniejące pełne kontrole zdrowia, source/package/storage,
source-view i terminal publication. Domknięcie nie twierdzi, że wykonano
nowy backend build albo Solve. Nie zgłaszać zbieżności fizycznej.

Jeśli dodanie helpera zmienia build-input snapshot, nie wolno ignorować
rozbieżności `_source_matches`. Wykorzystać istniejący jawny helper/frozen
source-transition contract lub wskazać konieczny osobny helper checkout;
nie zmieniać app źródeł ani fałszować źródłowego receiptu dla obejścia guardu.

## Własność i odbiór

Worker Sol: wyłącznie nowy helper i nowy interpretowany moduł regresji.
Root: CLI/just integracja, przygotowanie requestu, review i apply.
Luna osobno poprawia forward pinning w normalnym refresh path.
Testy: wyłącznie interpretowane Python, bez kompilacji unitów i bez usług.
Pokryć obce/stale piny, złą klasę unknown, brak zgodności plików, częściową
publikację, retry tego samego requestu i zachowanie oryginalnych dowodów.
Live apply wymaga review konkretnego requestu i pełnego rezultatu.
