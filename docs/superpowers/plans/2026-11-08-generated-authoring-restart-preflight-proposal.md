# Restart po eksporcie sceny do kanonicznego Pythona — diagnoza i zakres naprawy

Data: 08.11.2026. Dokument operacyjny; nie zmienia fizyki, solvera ani progów
kwalifikacji. Stan: projekt do decyzji. Żaden patch bramki nie został wdrożony.

## Wynik zatwierdzonej kontroli przed aktualizacją

Użytkownik zatwierdził jedną aktualizację/build grupy3203, jedno Prepare corner25
i warunkowo jedno V/J/H. Kontrola tylko do odczytu odmówiła przed restartem:
Saved authoring restart: UI authoring owner/status/source-kind changed.

Liczba wywołań recept: restart/build0, Prepare0, Submit0. Nie zatrzymano usług.
Nie utworzono zatwierdzonego checkpointu, operacji iteration ani nowego runu.
Powstał wyłącznie jawnie nazwany draft checkpointu i odczytowy raport.
Scena jest dokładnie równa scenie w zachowanym FMS; nie utracono danych.

Obecna sesja session-18e5e104d696c55200004eab pozostaje awaiting_command,
run=null, kolejka pusta, active_workers0, brak aktywnej operacji control.
Backend i frontend zachowują dotychczasowe tożsamości i pakiet.

## Potwierdzona przyczyna

Publiczny model/syncs, wykonany wcześniej do sprawdzenia round-trip, utworzył
kanoniczny, edytowalny skrypt w workspace bieżącej sceny:
 /opt/fullmag/runtime-control/local-live/current/scene_document.py
SHA256 d6c8d55caf95638089ba71b5a0f326f7f00094520bf79bd810f0f4aa7c0b2e94.

GET sessions/current poprawnie zgłasza script.origin=generated i writable=true.
Nie jest to dowód uruchomienia skryptu. Jednocześnie
scripts/docker_volume_dev.py::_saved_authoring_validate_probe wymaga
script=null i pustego script_path. Dlatego zwykły eksport blokuje późniejszy
restart, chociaż nie istnieje run, przygotowanie ani wykonane polecenie.

Istniejąca kanoniczna kontrola API
crates/fullmag-api/src/router_v2/handlers/platform/development_restart.rs::is_idle_scratch
już odróżnia dokładnie workspace/scene_document.py od skryptu wejściowego.
crates/fullmag-api/src/script.rs::sync_current_live_script_with_request jest
właścicielem tego eksportu. Launcher ma więc węższy, niespójny warunek.
Nie wolno usuwać skryptu, wyzerować jego metadanych ani zmieniać sesji tylko
po to, żeby przejść starą bramkę.

## Proponowana naprawa

Zachować odmowy i format istniejących checkpointów v1. Dodać jawny wariant
checkpointu dla wygenerowanego źródła authoringu, obsługiwany przez tę samą
receptę docker-dev-restart-saved-authoring, bez nowego mechanizmu recovery.

Wariant obejmuje wyłącznie:
- źródło generated, writable=true, dokładną ścieżkę scene_document.py
  w kanonicznym workspace tej samej sesji; nigdy exports/, ścieżkę zewnętrzną
  lub dowolny skrypt oznaczony jako generated;
- jawne piny ścieżki, SHA256 i rozmiaru wygenerowanego źródła oraz jego
  zachowaną kopię w FMS przez istniejący publiczny przepływ projektu;
- sprawdzenie zwykłego pliku bez symlinków i hardlinków, ograniczonego do8MiB,
  zgodności bajtów z archiwum oraz zgodnych metadanych przed/po próbie;
- wszystkie dotychczasowe kontrole sceny, epok, kontenerów, pakietu,
  pustej kolejki/poleceń, braku runu/przygotowania/meshu, zwolnionych lease,
  katalogów zakończonych runów oraz natywnego drain.

Nie wykonywać ani nie importować kodu Pythona podczas restartu. Historyczny
FMS i pierwotny skrypt pozostają. Nowy checkpoint musi wskazywać bieżącą,
trwale zabezpieczoną scenę i źródło; żadnego przepisywania starego dowodu.

Alternatywa: ponownie utworzyć sesję authoringu bez eksportu. Usunęłaby objaw
tylko do kolejnego eksportu i nie naprawiłaby niespójności. Rekomendowana jest
naprawa preflightu, z zachowaniem bieżącej sesji i jej źródła.

## Weryfikacja przed wykonaniem

1. Regresja: istniejący v1 odrzuca sesję z wygenerowanym skryptem jak dotychczas;
   nowy wariant przyjmuje wyłącznie kompletny, poprawny dowód eksportu.
2. Odmowy: skrypt użytkownika, zła ścieżka/origin/hash/rozmiar, symlink/hardlink,
   zmiana źródła lub sceny podczas kontroli, inna sesja/epoka/pakiet/kontener.
3. Zachowanie odmów: aktywny run, Prepare, polecenie, lease, nieznana historia,
   zły katalog zachowanych wyników i nieprawidłowy drain.
4. Lekka grupa Python dla saved-authoring, retained-history, preclaim oraz
   konsumenta drained-successor. Bez lokalnej kompilacji testów Rust.
5. Rzeczywisty odczytowy preflight nowego dowodu na grupie3203. Dopiero PASS
   pozwala uruchomić jedną aktualizację przez istniejące just w WSL.

Po zgodzie zakres obejmuje projekt powyżej, implementację, review i testy,
jeden zarządzany build/aktualizację3203, odbiór nowego pakietu i przywrócenia,
jedno Prepare corner25 oraz jedno V/J/H wyłącznie po pełnym odbiorze Prepare.
Bez automatycznych retry, H-only, LLG, nowego recovery, usuwania kontenerów,
zmiany .env, geometrii, tolerancji lub limitów. Odmowa kończy wykonanie.
Pozostają parametry i piny fizyczne z zatwierdzonej propozycji selektora.

## Piny i dowody

Poprzednia propozycja:
2026-11-08-antenna-selector-update-and-corner25-proposal.md,
SHA256 6e4e54134d7e10f24be6576b5be26b3dcbdb60d2f54dd3e191894f760a8805f8.
HEAD źródeł podczas diagnozy: 3c8ae4eb05afc01e092fa8444d5162ca55daaa76.

Prefiks w prywatnym wolumenie control:
verification/antenna-selector-update-20261108/approved-execution-v1/
- fresh-checkpoint-draft.json:
  828d3b68aea8f7f3e0f26d815bbaa91ad739f7795bba540d63f39a7eb2d8f2d4
- read-only-preflight.json:
  1db0a8f5f218b95b625a000d12beac631928cc46f17187ba25facfb1d850d186
- preflight-refusal.json: wynik audytu; native/build/prepare/submit0.

To diagnoza i projekt, nie wdrożona poprawka ani nowy wynik fizyczny.
Powód decyzji: przekazane przez użytkownika AGENTS.md §8 wymaga pytania,
gdy zmiana dotyka chronionego lub wersjonowanego kontraktu. Ostatnia zgoda
obejmowała użycie istniejącej bramki, nie jej rozszerzenie.
