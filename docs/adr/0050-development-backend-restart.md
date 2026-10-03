# ADR 0050 — kontrolowane zastosowanie backendu dev

Status: accepted jako cel i kontrakt; implementacja restartu planned, runtime NOT VERIFIED.
Data: 03.10.2026.

## Kontekst

Jedno `just windows-ui dev` ma uruchamiać frontend z HMR i przyrostową
kompilację backendu. Nowy EXE nie zmienia kodu już załadowanego przez proces.
Automatyczne zamknięcie backendu mogłoby przerwać symulację lub zgubić szkice
Inspectora. Obecny zapis dokumentu projektu nie synchronizuje pełnego modelu
runtime; import FMS `resume` zwraca `checkpoint_restore_unsupported`.

## Decyzja

Kompilacja i zastosowanie wersji są odrębnymi operacjami. Watcher buduje
nową wersję, a działające procesy używają zweryfikowanej kopii EXE.
UI pokazuje stan kompilacji i komendę „Uruchom nową wersję”. Sam zakończony
build nie wywołuje restartu.

Status jest cienkim zasobem platformowym v2, dostępnym wyłącznie dla
zarządzanego launchera dev. Zawiera tożsamość bieżącej i gotowej wersji,
rewizję, stan i powód blokady. Nie zawiera ścieżek hosta, sekretów ani
modelu projektu. Generated transport, centralna facade i resource hook
obsługują jeden workspace; React nie czyta lokalnych plików.

Komenda restartu musi:

1. Zablokować albo rozwiązać wszystkie znane lokalne szkice. Nie stosuje
   cichego Discard. Dirty dokument i szkice geometrii są odrębnymi właścicielami.
2. Atomowo zamknąć admission mutacji na czas handoffu, zaczekać na zakończenie
   już przyjętych mutacji i ponownie sprawdzić autorytatywny stan obliczeń.
   Running, paused, przyjęte/oczekujące zadania, aktywne preparation/mesh oraz
   nierozstrzygnięty stan blokują restart. Sam warunek disabled w UI nie wystarcza.
3. Zapisać zweryfikowany handoff w kanonicznym storage: pełny `SceneDocument`,
   dane edytora, stan UI i tożsamość dokumentu projektu, z hashami oraz
   powiązaniem API/session/build. `ScriptBuilderState` nie zastępuje sceny.
   Referencje assetów muszą pozostać rozwiązywalne; brak assetu blokuje sukces.
4. Potwierdzić zapis przed kontrolowanym zamknięciem własnych procesów.
   Właściciel zaakceptowanych zadań z ADR 0049 pozostaje odrębną granicą.
5. Uruchomić zweryfikowaną nową kopię, odtworzyć edytowalny model i workspace,
   a dopiero potem potwierdzić zakończenie handoffu. Nieudane odtworzenie
   zachowuje kopię danych i jawny błąd; puste UI nie oznacza sukcesu.

Nowe API otrzymuje nowy UUID. Wyłącznie jawny handoff może ustanowić świeży
pin klienta. Zwykły reconnect nadal odrzuca obcą instancję. Wyniki i artefakty
zachowują pierwotną provenance; odtworzenie modelu authoring nie jest
wznowieniem checkpointu ani kontynuacją kroku solvera. Requested intent
backend/device/precision/mode pozostaje w kanonicznej scenie; nowy proces
nie może przypisać starym wynikom swojej wersji lub rozstrzygnięcia urządzenia.

## Obowiązki implementacji i migracja

P8-52 obejmuje profil kompilacji, watcher, integralność kopii EXE i lease
procesów. P8-53 obejmuje nowy zasób/komendę v2, generację OpenAPI, facade/hook,
guardy szkiców i admission, trwały handoff, odtworzenie i kontrolę nowego pina.
Szczegóły źródeł i bramek są w
[planie P8-53](../plans/active/refactor_runtime/final/p8/53-development-restart-workspace.md).

Prywatny kanał supervisor–launcher pozostaje wewnętrznym protokołem dev,
związanym z jednym worktree, lease i losowym identyfikatorem generacji.
Nie jest publicznym endpointem kill/restart dowolnego procesu. Właścicielem
jego usunięcia przy wspólnym lifecycle produktu jest P7-C. Release i brak
zarządzanego launchera nie udostępniają tej komendy.

Rollback wyłącza komendę zastosowania wersji, pozostawiając kompilację w tle
i ręczne zamknięcie/uruchomienie. Nie usuwa handoffów, wyników ani cache.

## Weryfikacja

Wymagane są: zgodność generated API, regresje błędnego/starego handoffu,
odrzucenie aktywnego solve i wyścigu Start, ochrony szkiców i awarii restore,
a także rzeczywisty przebieg Windows i przeglądarki z niepustą geometrią,
regionami oraz materiałami. Nowy API UUID i hash modelu trzeba potwierdzić
po restarcie. Te bramki pozostają NOT VERIFIED do wykonania.
