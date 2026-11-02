# Dokończenie runtime i wizualizacji mastera — plan wykonania

**Cel:** zamknąć sześć punktów z podsumowania: dostęp Docker/WSL, wdrożenie
scalonego mastera, odtwarzanie siatki/pól, aktualna telemetria, optymalizacja
przygotowania oraz odbiór FDM i FEM.

**Architektura:** istniejący launcher i grupa `fullmag-master`; trwały accepted
store i jego zweryfikowane receipty pozostają źródłem prawdy. Odtworzenie
read-modelu korzysta z istniejących artefaktów i nie zwalnia Start ani nie
uruchamia solvera. UI używa wspólnych resource hooks i bieżącej tożsamości runu.

**Specyfikacja:** [aktualny odbiór CoFeB](../../audits/2026-10-29-cofeb-master-current-build.md),
[integracja mastera](../../audits/2026-10-29-master-sync.md),
[izolacja awarii](../../audits/2026-10-29-runtime-failure-isolation.md).

## Ograniczenia

- Główny checkout `/home/kkingstoun/git/fullmag/fullmag`, `master`, baza
  `89e25872cb94c85c8ca77371ecb0bd98780703cd`. Bez nowego worktree i testów
  jednostkowych. Build, statyczne kontrole i odbiór symulacji/przeglądarki
  wyłącznie przez zarządzaną grupę tego checkoutu.
- Zachować cudze zmiany instrukcji/dokumentacji i `external_solvers/3`, wyniki,
  cache przyrostowy, receipty i provenance. Bez reset/stash/globalnego prune.
- FEM/GPU/double/strict pozostaje wymuszone; FDM/GPU ma odrębny odbiór.
  Nie zmniejszać siatki, nie wyłączać walidacji pierwszego wejścia i nie
  zmieniać fizyki, aby poprawić czas.
- Kontrolowane wdrożenie obejmuje wyłącznie naszą grupę. Nie restartować
  Dockera, innych grup ani nie odtwarzać niejednoznacznych komend Solve.
- Kwalifikowana retencja zachowuje current + bezpośredni rollback i dane
  referencjonowane; brak obsługi stanu oznacza jawny `blocked` cleanup.

## Etapy i dowody odbioru

- [x] **1. Dostęp do silnika.** Bieżący `docker info` z WSL odpowiada;
  potwierdzono Docker Desktop 29.9.2, 40 CPU i około 196,6 GiB RAM.
  Oba dotychczasowe kontenery mastera są zatrzymane z exit255 po przerwie
  silnika; nie jest to zgoda na replay ich starego zadania.
- [x] **2. Odtworzenie siatki i pól bez obliczeń.** Root odpowiada za
  `development_accepted_restore/terminal_observation.rs`,
  `live_accepted_projection.rs`, `live_scene_preparation.rs` i wymaganych
  konsumentów. Najpierw prześledzić odmowę publikacji terminalnej domeny.
  Wykorzystać istniejącą projekcję accepted output i zweryfikowaną siatkę;
  zachować run/task/attempt/epoch/plan/topology oraz stan terminalny.
  Dowód: po kontrolowanym odtworzeniu ten sam run i krok, dostępne domena,
  m/H_demag/H_eff, identyczne wartości, brak nowego admission/Start/Solve.
- [x] **3. Telemetria.** Worker `footer_step_authority` zakończył swoją część;
  root integruje stopkę z brakującymi danymi backendu i generowanym kontraktem.
  Nie mieszać prepared scalar z późniejszym zaakceptowanym krokiem.
  Dowód: API i widoczna stopka pokazują ten sam krok i energię po ukończeniu
  i odświeżeniu; brak niepotrzebnego pollingu. Poprawić także potwierdzone
  błędne wartości uptime/nazwy algorytmu i etykietę settlementu, zachowując
  istniejący kształt kontraktu albo regenerując API zarządzaną receptą.
- [x] **4. Czas przygotowania.** Worker `materialization_profile_map` tylko
  mapuje kod i pomiary; root wybiera i wdraża zmianę. Rozdzielić generację,
  certyfikację, encode/decode, native preparation i publikację. Usunąć
  wykazaną pracę powtarzaną przy reuse, zachowując walidację/piny wejścia.
  Dowód: porównanie tego samego workloadu, konfiguracji i fingerprintów
  topologii; podać czasy i faktycznie usuniętą pracę, bez utożsamiania różnych
  etapów pomiaru i bez zmniejszania domeny.
- [x] **5. Wdrożenie scalonych źródeł.** Uzgodnić końcowy stan starego runu
  i ownera po przerwie silnika, zachować dane i użyć istniejącej recepty
  stop/recovery/resume. Zbudować w stałym backendzie, zachować 128 GiB/16 CPU.
  Dowód: źródła/SHA/snapshot, manifest, build receipt, API Ready, mounty,
  requested/resolved GPU/double oraz kwalifikowana retencja tej próby.
- [x] **6. Odbiór obu rodzin.** CoFeB FEM/GPU/double: zgodny Universe i mesh,
  dokładnie 10 nowych zleconych iteracji, skończone m oraz niezerowe
  H_demag/H_eff w Airboxie. FDM/GPU i FDM multilayer: odrębne przypięte
  wejścia, 10 kroków, właściwe mapowanie pól i zakres Airbox.
  Dowód: binarne dane/provenance oraz widoczny canvas WebGL z niezagubionym
  kontekstem i niezerowym drawing buffer. Nie deklarować zbieżności naukowej
  ani kwalifikacji wszystkich backendów na podstawie tych krótkich prób.

## Checkpointy

Pierwotne obce zmiany zabezpieczono jako kopie i manifest w
`/tmp/fullmag-six-points-20261029`. Każdy etap zapisuje przyczynę, zmienione
pliki, weryfikację bez testów jednostkowych, pełny SHA commita i brakujące
dowody. Cel pozostaje aktywny, dopóki którykolwiek z sześciu odbiorów jest
niepełny. Raport końcowy oddziela źródła, build, runtime, render i fizykę.

### Checkpoint po przywróceniu dostępu Docker

- HEAD: `e6a58cc7b12bc92b96c271cacb4cd1e19118659e` — poprawiona kolejność
  pobierania brakującego helpera przed uwierzytelnieniem zachowanego namespace.
  Zwykły commit przeszedł lokalny hook; nie pomijano kontroli commitowania.
- Kolejne lokalne commity: `fcff58ce40ae8405db53284bb81d9f92bb6a0540`
  (odtwarzanie terminalnej domeny/pól i telemetryczny scope) oraz
  `b112a0d137aee132d545fa67c49c834d832bb8ba` (ponowne użycie dekodowania
  mixed-v2 i czasy faz). Nie są jeszcze dowodem wdrożenia aplikacji.
- `just docker-dev-toolchain` zakończył się powodzeniem w `fullmag-master`:
  próba `0ba636f2e89c4784a0ba8a77bed7dd6b`, obraz
  `sha256:efe1c5b5ef051387c4e6b32f960effd382a6e3cbc7de1627c15508be0ac96ebf`.
  Jest to dowód obrazu zależności. Nowa aplikacja backendowa nie została jeszcze
  skompilowana ani uruchomiona.
- W kodzie przygotowano odtworzenie terminalnej domeny i pól, przyjęcie
  końcowych skalarów oraz jawne powiązanie pojedynczego wiersza HTTP z runem
  i `request_scope_epoch`. Generowane API i odbiór UI nadal oczekują na
  działający nowy backend. Nie porównywać tego identyfikatora z publicznym
  `session_epoch` opartym na czasie rozpoczęcia sesji.
- Usunięto powtórny odczyt/dekodowanie tego samego archiwum mixed-v2 przy
  pełnym audycie cache. Dodano pomiary faz Python/native. Nie ma jeszcze
  nowego pomiaru tego samego workloadu: poprawa całkowitego czasu pozostaje
  **NOT VERIFIED**.
- Odtworzenie po przerwie silnika wykryło nieobsłużone przypadki inspekcji:
  pominięte opcjonalne `HostConfig.Mounts`, aliasy dysków Desktop oraz brakujące
  katalogi zatrzymanych historycznych grup Windows. Osobny dowód braku bindu
  wymaga rzeczywistego Win32/DrvFs, zwykłych katalogów nadrzędnych i dokładnie
  zatrzymanego kontenera. Nie wyłącza sprawdzania istniejących ani aktywnych
  konsumentów. Przelotna utrata krótkiego helpera powoduje najwyżej trzy pełne
  odczyty inventory; częściowy wynik nigdy nie jest przyjmowany.
- Potwierdzono odczytowo nietypowe `PATHEXT=.CPL` oraz odmowę `fsutil hardlink
  list` z kodem 50. Dostawca metadanych używa teraz uchwytu Win32
  `OPEN_EXISTING`, desired access `0`, bez czytania zawartości i zmian plików;
  wymóg jednej ścieżki nadal opiera się na natywnej liczbie dowiązań i tożsamości
  pliku. Niestandardowe `DataFolder` pozostają nieobsługiwane; dopuszczony jest
  jedynie zweryfikowany profil WSL z domyślnym ustawieniem legacy Hyper-V.
- Odczytowe preflighty korzystają z krótkich zarządzanych helperów. Nie
  opublikowano jeszcze autoryzacji recovery, nie usunięto ani nie uruchomiono
  stałych kontenerów aplikacji, nie zmieniono ownera i nie powtórzono Solve.
  Siedem plików obcych instrukcji/dokumentacji zachowuje
  hashe kopii początkowej; nie dołączać również obcego submodułu ani nowego
  równoległego audytu do naszych commitów.
- Kontrola składni obejmuje 22 zmienione pliki Rust/Python; `git diff --check`
  przechodzi. Bez testów jednostkowych. Odbiór nowej aplikacji, odtworzenia,
  renderu i nowych obliczeń FEM/FDM nadal pozostaje otwarty.
- Nowszy odczyt wykrył także junction canary starego profilu Windows:
  `.windows-folder-probe/host-junction` wskazuje na `junction-target` wewnątrz
  tego samego rootu. Wersja 2 dowodu/inventory rozróżnia względne LX symlinki
  i natywny directory junction; dla junctiona cel Windows musi odpowiadać
  dokładnie celowi DrvFs wewnątrz rootu. Nadal obowiązują budżety, sprawdzenie
  cykli, urządzenia, zwykłych katalogów nadrzędnych i końcowego katalogu.
  Dowiązania wychodzące poza root oraz nieznane tagi pozostają odrzucone.
- Canary `posix-link` okazał się natywnym Windows SymbolicLink z względnym
  celem `publication.bin`. Wariant `0xa000000c` dopuszcza wyłącznie względny
  cel natywny, zgodny z `readlink`, ograniczony do rootu i właściwego typu
  końcowego. Odczytowy pełny dowód `/state` historycznej grupy
  `awesome-mayer-5cef23-78db87f3557b6306` przeszedł z oboma canary.
  Niezależne review wariantów junction/symbolic zakończyło się PASS źródła.
- Nie tworzyć historycznego preflightu terminalnej sesji z samych pinów
  katalogu runów. Recovery po przerwaniu silnika zachowuje stare wyniki,
  lecz startuje API bez odtwarzania sesji. Odbiór odtwarzania zostanie wykonany
  po nowej, jawnie zleconej próbie CoFeB 10 kroków: rzeczywisty preflight,
  potwierdzony drain, istniejący terminal-observation proof i ponowny start
  obserwacji bez kolejnego Solve.
- Pełny odczytowy preflight przeszedł kontrolę obcych bindów bez zatrzymywania
  cudzych grup. Następna bramka wykryła pominięte referencje przygotowanych
  obserwacji: wszystkie 37 pinów spoza intentów i katalogu artefaktów należą do
  dwóch `task_prepared_observations`. Nie są dowodem utraty lub uszkodzenia
  danych. Wymagają walidacji typowanych rekordów i ich receiptów także w
  terminalnej ścieżce hosta i runtime. Suma 71 obiektów CAS wynosi 231 755 414 B,
  więc dotychczasowy łączny budżet odczytu 128 MiB jest niewystarczający;
  walidacja musi pozostać strumieniowa, ograniczona i sprawdzać wszystkie hashe.
- Naprawa źródłowa terminalnych obserwacji obejmuje hosta i typowany walidator
  Rust. Odczyt rzeczywistych danych potwierdził 42 referencje przygotowanych
  obserwacji, 76 referencjonowanych obiektów CAS i 71 pinów bez niepowiązanych
  pinów. Sprawdzono SHA-256 wszystkich 271 255 118 B referencjonowanych danych
  (piny są podzbiorem); największy pojedynczy obiekt ma 82 261 717 B.
  Budżet terminalny wynosi 1 GiB sumy odczytu, jednostkowy nadal 128 MiB.
  Domyślna ścieżka cancelled nie zmienia budżetu. To odczytowy fragment
  preflightu, bez kompilacji lub dowodu uruchomienia nowego runtime.
- Pełny odczytowy preflight zakończył się `ready` dla obu zachowanych runów.
  Review usunęło powtórne odczyty typed intent/catalog dla każdej obserwacji;
  Rust korzysta z wcześniej zweryfikowanych danych. Host ma dodatkowy wspólny
  budżet 1 GiB na nowe rekordy prepared, obejmujący oba przebiegi odczytu,
  niezależnie od budżetu CAS. Publikacja autoryzacji i wykonanie recovery mają
  ponowić własne kontrole; sam wynik preview nie uruchamia kontenerów.
- Publikacja świeżego dowodu i autoryzacji zakończyła się kodem 0 w operacji
  `011e3832c36e4fe49c2beba630d38ffe`; zapis pozostaje w wolumenie control,
  pod `container-recovery-authorization/attempts/<id>/operator-authorization.json`.
  Sam zapis nie uruchomił ani nie usunął stałych usług aplikacji.
- Remote `dcfc351c86a75e04b5df4e52a65325fbb4dfec07` zawierał 24 nowe commity,
  a lokalny master pięć naszych. Merge zatrzymany przed commitem scalił się
  bez konfliktów; żadna ścieżka incoming nie przecinała cudzych zmian ani
  niezacommitowanej stopki. Kontrola składni 23 Rust / 14 Python zakończyła
  się powodzeniem; poprawiono jedną pustą linię EOF z incoming fixture.
  Review trzech automatycznie scalonych plików API potwierdziło zachowanie
  kontraktów terminal restore, scalar scope i uptime. To dowody źródłowe.
- Windows Computer Use zgłosił błąd `sandboxCwd is not a local file URI` dla
  katalogu WSL. Odbiór renderu ma użyć istniejącej zarządzanej recepty
  `docker_dev_browser_qa.py`. Dotychczasowa flaga Airbox vectors obejmuje
  FDM; nie zaliczać jej jako dowodu FEM. Wymagany jest rzeczywisty wybór
  Airbox H_demag, scoped odczyt i dodatnia liczba adoptowanych segmentów,
  wraz z widocznym canvasem i stanem WebGL. Bez fixture i bez ponownego Solve.
- Merge zapisano jako `6969c58dca1e671e2477c95327b9e6f6e67af7bd`.
  Zwykły hook uruchomił statyczny React Doctor: 9 ostrzeżeń w incoming
  (sekwencyjne pętle smoke, małe lookupy i klucz indeksowy); bez testów.
  Nie zmieniano konfiguracji ani nie wyciszano reguł.
- Pomocniczy host manager publikacji `011e...` pominął terminalny stan
  receipt, przez co jego helper pozostał na `READY/LOGGED` i trzymał lease.
  To błąd wywołania przez root, nie błąd solvera. Odczytowe uwierzytelnienie
  potwierdziło dokładny helper `d588e9ffeeec...`, przypięte SHA receipt/auth/proof,
  pusty log i wyłącznie zakończoną publikację metadanych. Finalizacja zachowała
  poprzedni receipt w journalu, wykonała CAS i zapisała terminalny stan;
  oryginalny helper sam zwolnił marker i zakończył się kodem 0. Terminal SHA:
  `c6ace1c6005e04455fbe2b59135e416fd10a84813b8446d89d994342ecf40bd1`.
  Bez zmiany aplikacji, ownera, sesji lub danych. Pomocniczy skrypt ma już
  jawne `state=succeeded`; nie powtarzać publikacji starej autoryzacji.
- Ponowione `docker-dev-toolchain` po zwolnieniu lease zakończyło się
  powodzeniem: attempt `312ac575ca8c4fdd9820b4091b3d43e4`, cache hit,
  obraz `sha256:efe1c5b5ef051387c4e6b32f960effd382a6e3cbc7de1627c15508be0ac96ebf`.
- Probe dostał opt-in `--expect-fem-airbox-vectors` tylko z
  `--canvas-only --expect-live-field m`. Wymaga live scoped H_demag,
  przyjętego bufora, dodatnich segmentów i niezmienionego runu. Review
  usunęło niekanoniczne aliasy statusu, uzupełniło health w wyniku, wybór
  Radix opiera na etykiecie rzeczywistego katalogu i dodało sprawdzenie Cmd
  helpera względem Compose. Stare opcje FDM/receipty zachowują kontrakt.
  AST Python, `node --check` i diff-check przechodzą; sam probe nie był
  jeszcze uruchomiony i nie stanowi dowodu działania FEM.
- Kanoniczna próba recovery (obserwowana jako sesja `60890`) zakończyła się
  kodem 2 przed operacją development i przed zmianą stałych kontenerów:
  `foreign consumer identity or state changed during overlap proof`.
  Oryginalny komunikat nie podawał ID ani zmienionych pól. Kod przekazywał
  stan z początkowego inventory do dowodu po długim skanie Windows; równoległe
  grupy WSL normalnie startowały/kończyły pracę (m.in. starty 14:46 UTC).
  Dwie kolejne świeże obserwacje 22 konsumentów nie wykazały zmiany kolejności
  mountów; nie zmieniano ich canonicalizacji na podstawie hipotezy.
- Poprawka dopuszcza maksymalnie trzy fizyczne dowody dla jednego aliasu:
  tylko zmiana samego lifecycle wymaga nowego pełnego kernel proof i nowego
  porównania przed/po. ID, obraz i wszystkie metadane montowań pozostają
  ścisłe; ich zmiana, błędny inspect, brak obiektu lub negatywny kernel proof
  kończą operację. Publikacja wyłącznie po zgodnych bieżących pinach.
  Nowe błędy zawierają ID i nazwy zmienionych pól. Review: PASS źródła.
  Istniejąca fixture reprezentuje ciągłą niestabilność wszystkich trzech prób;
  testów nie uruchamiano. AST dwóch Pythonów i diff-check przechodzą.
- Rzeczywisty odczytowy subset po poprawce sprawdził pierwszy alias 22
  konsumentów Linux/WSL: wszystkie fizyczne dowody `disjoint`. Nie zatrzymano
  obcych grup, nie opublikowano dodatkowej autoryzacji i nie uruchomiono solvera.
  Pełny ponowny start, nowa kompilacja i odbiór UI/physics pozostają otwarte.
- Poprawkę lifecycle zapisano jako `9edd3ec7b8af5bc6758d2cf6f01fa9b3e1bedaf2`.
  Kolejne żądania startu były przerywane przez zewnętrzną automatyczną kontrolę
  uprawnień (`model at capacity` / deadline), przed utworzeniem procesu;
  nie obchodzono kontroli. Ostatecznie powstała jedna próba `83097`.
- Próba `83097` zakończyła się kodem 2 przed startem aplikacji: konsument
  Windows `b26b89c335475feeb08715fda3184146ae8b172bba598ed3de8324393dac9943`
  zmienił jedynie `native.candidate.descendants.entries/files/sha256`.
  Oba zachowane katalogi runów nadal mają pierwotne SHA i wszystkie taski
  `Succeeded`; w store pozostają dwa runy. Nie uruchomiono solvera.
- Nowy typ driftu powstaje dopiero po pełnej walidacji obu obserwacji względem
  kontekstu. Caller może maksymalnie trzy razy wykonać cały dowód tylko dla
  różnic `entries/directories/files/sha256`; każda zaakceptowana para nadal
  musi być identyczna. Typed drift innych tożsamości, linków, backing images,
  montowań lub wyczerpany limit kończy operację bez absent-source fallback.
  Pozostałe błędy nie są ponawiane; zachowują dotychczasową ścieżkę typed absence.
  Rzeczywisty brak historycznego źródła nadal wymaga pozytywnego typed absence.
  Review: PASS; ekstrakcję istniejącego walidatora sprawdzono AST jako identyczną
  poza wiązaniem argumentu. Schemat dowodu się nie zmienił, odrzucone próby nie
  są archiwizowane jako dowody izolacji.
- Odczytowe pełne dowody trzech bindów wskazanego konsumenta Windows po
  poprawce: `disjoint` dla script-output, source i source-git. To subset
  preflightu, bez autoryzacji, startu lub zatrzymania obcej grupy. AST trzech
  Pythonów i diff-check przechodzą; istniejąca negatywna fixture uwzględnia
  wcześniejsze odrzucenie niepoprawnego snapshotu. Testów nie uruchamiano.

### Checkpoint: działające API i domknięcie kontraktu stopki

- Kanoniczna próba recovery zakończyła się `succeeded`, kod 0: development
  `62a6ac2bfb2549399ecef3d7c09ef836`, konfiguracja
  `0ed804fb5b3848cd1f9ecb321a8caa8ae0a9a828945ec5498a4a47608da733f3`.
  Toolchain/dev/backend image były cache hit. Pełne kontrole obcych bindów
  przeszły bez zatrzymywania cudzych grup. Długiego czasu tej kontroli
  kontrolera nie przypisywać materializacji modelu ani solverowi.
- Nowa para: backend
  `78c873c76f86b236ee8578bd746cf9c2ce0251f29f13fe1dd4c69cfeb1b5d1b4`,
  frontend `a90e0914a903` (skrót inspekcji). Oba `healthy`.
  Inspekcja backendu potwierdziła Memory `137438953472` B i NanoCpus
  `16000000000`, czyli 128 GiB/16 CPU; kompilator użył `cargo_jobs=16`.
  Zachowano named volumes i grupowy ledger.
- Build aplikacji w stałym backendzie: `make` exit0, `352902` ms, pakiet
  24 plików; gate `linux-native-v1` i `worker-cgroup` zakończone. API i runtime
  zgłosiły Ready o `2026-10-29T16:24:13Z`. Zbudowany commit:
  `d4c925b43d160b99a44bea9715bb157d9fe2c7e7`, snapshot
  `00bdceddb93e8d7432db6945ff7559699ec75e883bc86e37260cbfc24c06d17f`.
  GET health zwrócił `status=ok`, `active_session=false`. To potwierdza
  start API; nie jest odbiorem solvera, odtworzenia sesji ani GPU.
- Kanoniczne `docker-dev-codegen` zakończone `succeeded`; receipt
  `/opt/fullmag/control/backend/codegen/openapi-v2/f86efabaff68f7f37dd0befa8cc2687c4c858b1d76f8dd84f1edf8b35cfb767f.json`.
  Zmienione są schema i typy `ScalarObservationSource/current_observation`;
  wygenerowany klient i ścieżki zachowały identyczne hashe.
- Dalszy remote obejmował trzy commity do
  `455b67be7db2ba5569c902eb6e9e00ec8a868994`. Brak przecięć z cudzym WIP
  i stopką; merge bez konfliktów zapisano jako
  `01fe2cdf8e785c5c324810ebc643d95499755781`. Te nowsze źródła wymagają
  przyrostowej przebudowy przed odbiorem docelowego CoFeB.
- Review stopki wykryło próbkę RT przeżywającą zmianę API scope. Scope jest
  teraz przekazywany z konkretnej, zaakceptowanej konekcji WebSocket przez
  bridge do eventu. Czysty resolver odrzuca null/inny scope przed runem,
  krokiem i arbitrażem rewizji. Nie przypisuje aktualnego scope starej próbce.
  Ograniczone niezależne re-review: PASS, bez dalszych P1/P2.
- Typecheck pierwszej próby wykrył brak scope w istniejącej kontrolowanej
  stronie fixture; uzupełniono jej własną stałą tożsamość. Ponowiony pełny
  typecheck produkcji oraz focused ESLint produkcji i zmienionych fixtures:
  exit0, wejścia i tożsamości usług stabilne. Receipt w wolumenie control:
  `/opt/fullmag/control/backend/source-checks/d7848729f6cd493ba8dca32b4e87b569.json`.
  Nie uruchamiano testów jednostkowych. Nie zaliczać fixture jako dowodu
  rzeczywistego renderu, skalara ani obliczeń.
- Repozytoryjny React Doctor 0.9.12 uruchomiono w stałym frontendzie dla
  dziewięciu staged plików JS/TS, z rozpoznanym projektem Control Room.
  Zgłosił siedem ostrzeżeń o eksportach funkcji z pliku komponentu stopki;
  lista tych eksportów jest identyczna jak w HEAD. Są to istniejące
  ostrzeżenia, nie nowa regresja ani zielony pełny scan. Konfiguracji reguł
  i normalnego hooka Git nie zmieniano; bez instalowania `@latest` na hoście.
- Iteracja `012eb2a58e6143c7b48650a28d93f3b6` zakończona `succeeded`,
  konfiguracja nadal `0ed804fb5b3848cd1f9ecb321a8caa8ae0a9a828945ec5498a4a47608da733f3`.
  Te same kontenery osiągnęły ponownie `healthy` i API Ready; `make` exit0
  w `430960` ms. Zbudowany commit `01fe2cdf8e785c5c324810ebc643d95499755781`,
  dirty snapshot `600d16846362533087aea670fca0d6e3b08bf20e33ec53b26f30baec1a6025ba`.
  Nie uruchomiono jeszcze nowej symulacji.
- Dispatcher `scripts/docker_dev.py` po udanym codegen wywołuje także
  `generate_python_api_models.write_outputs`. Zmiana
  `packages/fullmag-py/src/fullmag/client/_generated/models.py` jest zatem
  wynikiem naszej kanonicznej generacji, nie nieznanym cudzym WIP.
  Obejmuje ten sam `ScalarObservationSource`; check generatora i AST
  potwierdzają spójność. Plik należy do tego fragmentu kontraktu.
- Automatyczny reviewer odrzucił commit z tymczasowym `PATH`, ponieważ zmieniał
  sposób uruchomienia hooka. Commit nie został wykonany. Użytkownik następnie
  jawnie dopuścił jednorazowe uruchomienie istniejącego hostowego skanera
  `pnpm dlx react-doctor@latest`; zwykły commit ma zachować hook i PATH.
- Odtworzenie po nowym runie, pomiar CoFeB, 10 iteracji FEM, 10 kroków obu
  wariantów FDM, odbiór przeglądarki i kwalifikowana retencja nadal oczekują
  na wykonanie. Żaden z tych odbiorów nie wynika z samego builda lub health.

### Checkpoint: rzeczywiste 10 iteracji CoFeB i bieżące braki

- Zwykły commit `4b60cdbfa00a9c219dcb0baf90547b8944fef572` przeszedł hook po
  jednorazowej zgodzie użytkownika i trafił na remote. Następnie lokalny master
  zaktualizowano fast-forward do `9f6505a1ee428d84bbd5626dee0e522326dc37b9`;
  incoming nie przecinał cudzych niezacommitowanych ścieżek. Zachowano także
  równoległe zmiany obu submodułów i audyt materiałów/interakcji.
- Iteracja `4e627e71268548b48614f94b1fc12fc7` zbudowała commit `4b60cdbfa00a`
  w stałym backendzie: make exit0, 88 794 ms, snapshot
  `74838fcf57a27e0ee24c4d53cc5c08a1bad5773d0717c55c444581d6da561871`.
  Kontenery zachowały ID, backend 128 GiB / 16 CPU oraz API Ready.
  Późniejszy fast-forward źródeł nie jest dowodem przebudowania backendu.
- Aktywacja `42873af4f9934a07a5b149ae1d6cad4a` i jeden przyjęty Solve
  `fm-faf0da66-6dce-49c9-a1e2-10e9ed7392e6` zakończyły run
  `run-live-38f03054f1ca457a14dca4a95cbf08006998b8b67bd334a9e6eac017b5f8a0d4`
  w stanie completed, dokładnie 10 iteracji, FEM / GPU / double / strict,
  `fem_native_gpu`. Limit iteracji nie oznacza zbieżności naukowej.
- Siatka: 1 087 250 komórek, 183 764 węzły, fingerprint topologii
  `1a7d1afa1af58fdce2112b1484fd8ec366b78ab8843aa7a725440e711749a18e`.
  Odczyt FMVP potwierdził skończone `m` oraz niezerowe `H_demag` i `H_eff`
  na 157 393 węzłach Airboxa. FieldMeta wiąże je z końcowym krokiem 10.
  Dowód binarny w control tej grupy:
  `backend/six-points-runtime/cofeb-terminal-fields-841da5bf4ad143eeb65e85f40954f43f.json`.
- Całe przygotowanie nie przyspieszyło: materializacja 429 105 ms i native
  domain preparation 200 702 ms, razem 629 807 ms, wobec 586 414 ms poprzednio.
  Python/Gmsh zakończył się po około 148 s; późniejsze powtórne walidacje,
  lowering i kodowanie nadal pozostają znaczącą pracą. Nie zmniejszano siatki.
- API nadal ma potwierdzony błąd końcowej historii skalarów: run i pola mają
  krok 10, ale jedyny wiersz `scalar_history` pochodzi z prepared kroku 0.
  Poprawiona stopka odrzuca ten wiersz i pokazuje brak średniej magnetyzacji.
  Przyczyna źródłowa: pełne końcowe StepStats są w usuwanym sidecarze;
  zaakceptowany stan CAS i energia nie zawierają kompletu statystyk.
  Naprawa wymaga trwałego, przypiętego artefaktu, bez przelabelowania kroku 0.
- Odbiór przeglądarkowy nadal **NOT VERIFIED**. Pierwsza próba zatrzymała się
  na timeout zimnej strony; druga ujawniła blokadę diagnostycznego POST
  `visualization/client-acks` w samym skrypcie QA. Handler ACK zapisuje jedynie
  stan klienta, bez zlecania obliczeń. Guard dopuszcza teraz dokładnie ten
  same-origin endpoint obok display PATCH, nadal blokując inne mutacje.
  Kolejna próba nie miała błędów HTTP/JS, lecz oczekiwała na spójny Debug
  Airboxa; dodano zapis dokładnego panelu i obrazu przy timeout. Nie obniżono
  warunków gotowości ani wymagań dotyczących bufora/wektorów/WebGL.
- Otwarte pozostają: trwałe końcowe skalary, pomiar optymalizacji na tej samej
  topologii, kontrolowany restart z odtworzeniem bez Solve, odbiór renderu FEM,
  nowe próby obu wariantów FDM oraz wykonana kwalifikowana retencja. Bez testów
  jednostkowych i bez nowych worktree. Nie powtarzać zakończonego Solve.

### Checkpoint: pozytywny odbiór renderu i gotowe poprawki źródeł

- Odbiór `57e1efc6a57b430e9f7210c4c92a602f` zakończył się `succeeded`.
  Przeglądarka zachowała sesję, run i epoch przez przejście Home; primary `m`
  pozostało dostępne. Scoped FEM Airbox `H_demag` zwrócił HTTP 200, przyjęty
  `target-buffer` i 1200 segmentów. Widoczny canvas miał niezagubiony kontekst
  oraz dodatni drawing buffer. Obejrzano obraz po dopasowaniu Airboxa do kamery.
  Dowód dotyczy backendu `4b60cdbfa00a` i bieżących źródeł frontendu z poprawką
  HMR; nie kwalifikuje jeszcze nowej aplikacji backendowej ani fizyki.
- Rzeczywisty odbiór ujawnił dwa błędy diagnostyki: porównanie zapisu SHA-256
  zamiast skrótu oraz odczyt cache po publicznym URL zamiast kluczu konkretnej
  sesji/epoch/request scope. Debug korzysta teraz z tego samego normalizera co
  renderer i dokładnego klucza przeniesionego wraz z buforem. Nie korzysta
  z globalnej bieżącej sesji, aby przypisać staremu buforowi nową tożsamość.
- Skrypt odbioru wymaga pełnego kanonicznego render snapshotu `ready`.
  Oddzielnie raportuje `unknown` panelu porównań, gdy jedynym ograniczeniem jest
  `backend-meta-incomparable`: statystyki próbkowanego żądania nie są tożsame
  ze statystykami całego pola. Nie przepisuje stanu panelu i nie deklaruje
  kompletności takiego porównania. Inne problemy nadal blokują odbiór.
- Typecheck i focused ESLint we frontendzie przeszły:
  `backend/source-checks/a6056dff087447f5b69ac4d046c78e1f.json`.
  Późniejsze zmiany skryptu QA przeszły Node syntax i Python AST.
  Przypięty React Doctor wykazał dwa istniejące ostrzeżenia pętli w
  `viewport3dRenderModel.ts`; diff zmienia w tym pliku tylko przeniesienie
  `cacheResourceKey`. Scan nie jest raportowany jako całkowicie zielony.
- Odczytowa natywna inspekcja rzeczywistego terminalnego runu potwierdziła
  `mutations_applied=false`, `solve_replayed=false`, native config
  `4bfee3acb8bcec75b46cd2f1a98b913acbeb032f7bc956ed8ddcf56a4e0e0f5e`
  i terminal evidence `79e8b6722f7f30c2f6ea4468dc59d696f693ffdc2f0f6df071b83b9d3fc257c4`.
  Receipt: `backend/six-points-runtime/terminal-inspection-7ba55f768e1649cbb7d38c368d0a29d3.json`.
  To wejście do kontrolowanego odtworzenia, jeszcze nie dowód restartu.
- Przygotowano dwa fragmenty Rust do wspólnego buildu: sealed immutable
  materialization usuwa powtórny lowering/serializację przed commit, zachowując
  walidację pierwszego wejścia i wszystkie kontrole publikacji. Trwałe końcowe
  StepStats mają osobny auxiliary artifact `accepted_terminal_scalar_stats`,
  ścisłe CAS/claim/clock i istniejący katalog/piny; quantity bundle v1 nie
  zmienia schematu. Starsze czytniki pomijają nowy typ. Review granicy CAS,
  rollbacku i retencji: PASS źródła. Parser/diff przechodzą; build, nowe
  końcowe skalary i pomiar poprawy czasu pozostają **NOT VERIFIED**.

### Checkpoint: rzeczywisty drain i proof odtworzenia

- Commit UI `9f70be04f8e60a55c5c321d26c2e2fde41798d4c` jest na remote.
  Użytkownik dopuścił niezmieniony hostowy hook przy kolejnych commitach tego
  zadania. Normalny hook zgłosił dwa bounded lookup ostrzeżenia w skrypcie QA;
  nie zmieniano hooka, PATH ani reguł skanera.
- Pierwsza próba stopu wygasła w odczycie namespace przed utworzeniem
  operation. Inspekcja potwierdziła stary start, oba healthy, API 200 i brak
  nowej iteration; nie potraktowano timeoutu jako zakończenia kontenera.
  Ponowiony pełny preflight/drain `3e3997a9af064c53ab134b3a003277c8`
  zakończył się `succeeded`; oba kontenery mają exit0 i `OOMKilled=false`.
- Rzeczywisty receipt zawiera parę historycznych
  `container_recovery` / `container_recovery_authorization`. Zamknięty zestaw
  pól starego walidatora ich nie uwzględniał. Host i Rust dopuszczają teraz
  wyłącznie pełną parę ze znanymi schematami/outcome, statusem `recovered`,
  tym samym request ID i czterema zgodnymi digestami. Cały process pozostaje
  objęty canonical+LF SHA; Ready/Drained owner, children i terminal-run fence
  są sprawdzane niezależnie. Historyczne recovery nie jest nową autoryzacją
  ani operacją do ponowienia. Review: PASS źródła, bez testów.
- Producer na rzeczywistym preflighcie i store zakończył się kodem 0:
  `verification/terminal-observation-six-points-6146e07161af45f8b7a4741ec0c774a8.json`,
  SHA `3d100be0ad4bdcc0ee24f31bad55b32c5a711011a8997957c20c79d706b225e5`.
  Ten proof dotyczy powyższego runu 10 iteracji i potwierdzonego drain;
  nie zastępuje odbioru jego instalacji po nowym starcie.
- Źródłowa optymalizacja materializacji zapisana jako `1bddc0bae`.
  Kontrolowany restart/nowy build ma zachować backend 128 GiB / 16 CPU oraz
  istniejący frontend 16 GiB / 4 CPU. Oba serwisy celowo pozostają zatrzymane
  między drain a odtworzeniem. Pozostałe grupy i dane pozostają zachowane.


### Checkpoint: rzeczywiste odtworzenie terminalnego CoFeB

- Backend `34df0e44a2eb00f109940f6bcb3e1cb06820f834` zbudowano
  w stałym kontenerze `fullmag-master-backend-1`: make 288 573 ms, 24 pliki
  zweryfikowanego pakietu, snapshot
  `cd8acc586bed087ab48f9acf27f5d11158fc77d2b6cfff3dfaf1b97ee78b0972`.
  Zarządzane wznowienie `a2f0d98c797440e2a79a0d007ea89a67` zakończyło się
  `succeeded`; API Ready i kontenery healthy, backend 128 GiB/16 CPU.
- Naprawiono błąd kompilacji E0507 w ponawianej publikacji terminalnych
  skalarów oraz ścisłe rozpoznawanie schematu receiptu V3. Nie zmieniono
  schematu istniejącego quantity bundle V1. Pierwszy nieudany build pozostaje
  zapisany; poprawka przeszła rzeczywisty kolejny build, bez testów jednostkowych.
- Nowe API `d44d0702-b589-4797-b77e-ea84509f15a4` odtworzyło ten sam run
  `run-live-38f03054f1ca457a14dca4a95cbf08006998b8b67bd334a9e6eac017b5f8a0d4`,
  publiczny epoch, krok 10 i domenę 1 087 250 elementów/183 764 węzłów.
  Hashe wartości m oraz Airbox H_demag/H_eff, indeksów węzłów i observation
  frames są identyczne z odczytem sprzed drain. Katalog zadania zachował SHA
  `7f176485debdb3e5251978643051965baa6197ccf9ebce1e425e2f8bb802c4bb`;
  wszystkie zadania nadal succeeded. Nie zlecono nowego Solve ani Compute Fields.
- Dowód porównania: `backend/six-points-runtime/terminal-restoration-comparison-d017211205db4bbf9ea1f5e0e3b87ddd.json`
  w wolumenie control grupy. Odbiór przeglądarkowy po odtworzeniu:
  `browser-qa/attempts/30cd774feb3540bbbe66b6392891a9e8`, succeeded.
  Pierwsza próba po zimnym starcie frontendu zakończyła się na odczycie
  loopback; zachowano receipt, odczyt /workspace potwierdził HTTP 200 przed
  następną próbą. Krótka degradacja obserwacji native ustąpiła po 4 s bez
  zatrzymania API.
- Ten stary run nie zawiera nowego artefaktu terminalnego StepStats; po
  odtworzeniu historia skalarów jest pusta, zamiast fałszywego prepared Step 0.
  Odbiór trwałych końcowych skalarów wymaga nowego runu i pozostaje otwarty.
- Scalenie `origin/master` z poprawką mapowania FDM multilayer w 2D zapisano
  i wypchnięto jako `25e5d76e9766aa3ba924cd4a7528fe5713abcfb1`.
  Kontrola parserów pięciu produkcyjnych plików Rust i JSON source-map przeszła;
  testów nie uruchamiano. Wszystkie siedem obcych plików nadal ma hashe
  manifestu początkowego. Wdrożenie tego scalenia, nowe przebiegi FDM/FEM,
  pomiar materializacji i kwalifikowana retencja pozostają do wykonania.

- Kolejny potwierdzony drain: `8695f842b5d141be99c72caddfa326c3`, oba
  kontenery exit0. Jawny fresh-state zatrzymał się przed usunięciem usług:
  `4544fbee491444dfad9947f2c21a94a1`, failed-confirmed. Preflight wybierał pusty
  recovery context dla archiwizacji, ale kontrola pod lease ponownie wybierała
  retained recovery i odrzucała historyczny capability. Wybór pod lease jest
  teraz zgodny z preflightem. Nie zmieniono walidatora retained recovery;
  zachowano kontrolę dokładnych zatrzymanych inkarnacji i atomowe archiwum
  starego runtime/ledgera/danych. Python AST/diff przechodzi; ponowne wykonanie
  tej zarządzanej ścieżki i nowy build nadal oczekują na odbiór.

- Jawne archiwum `88b6a68101a342c4ac2e13b48fe8d9c8` zakończyło się
  succeeded i zachowało stary katalog CoFeB z tym samym SHA-256. Obrazy
  toolchain/development/backend były cache hit. Kolejny start zatrzymał się
  przed stworzeniem nowego backendu: walidator retirement wymagał sukcesu
  pierwotnego development `1123...`, mimo rzeczywistego udanego resume `a2f0...`.
  Nie zmieniono historycznego failed-confirmed ani gotowego archiwum.
- Walidacja dopuszcza teraz dokładny udany, niezmienny resume: zgodny
  parent/config, source/provenance, namespace/volume, state root i oba
  usunięte container ID. Enumeracja jest ograniczona do 256 rekordów,
  mount control jest readonly, terminal musi odpowiadać canonical receipt.
  Pozostałe piny archiwum oraz genuine native drain nadal są sprawdzane.
  Ścieżka pierwotnego succeeded nie zmienia zachowania. Niezależne review
  wykryło nieobsługiwany argument helpera; poprawiono go na istniejący
  adapter readonly i ponowne review zakończyło się PASS źródła.
- Rzeczywisty odczyt archiwum i powiązanego resume przeszedł bez mutacji;
  startup i nowe przebiegi nadal wymagają dalszego odbioru. Nie powtarzać
  fresh-state ani usuwania kontenerów archiwum `88b6...`: stary runtime
  jest już zachowany, a kolejny krok to zwykły zarządzany start nowej sesji.

### Checkpoint 30.10: wdrożony aktualny master i rzeczywisty FDM/GPU

- Po wznowieniu rozmowy stare uchwyty procesów były nieobecne, a grupa mastera
  nie miała kontenerów. Odczyt rejestru potwierdził zakończone archiwum
  `88b6a68101a342c4ac2e13b48fe8d9c8`; nie powtarzano fresh-state ani starego Solve.
  Master i lokalny `origin/master` wskazywały
  `aee17a54d4c283f2fdf5aa3d89acc5ecdb638e19`, obejmujący także późniejsze
  poprawki odświeżania pól i mapowania warstw. Obce zmiany zachowano.
- Kanoniczny start `just docker-dev` zakończył się `succeeded`:
  `b17bb884f3a3428aa4b1ec14da234370`, config SHA-256
  `d4c13de733ea1b43d851e0e39f83e1f9a3d4a9363db231e7e4b26bec3c77ea52`.
  Toolchain i oba obrazy aplikacji były cache hit; kompilacja aplikacji
  odbyła się w stałym backendzie, `cargo_jobs=16`, make exit0 po 418 173 ms.
  Pakiet ma 24 zweryfikowane pliki. Snapshot źródeł:
  `53e61730cad2704aa59b324802b681c2cfee04f2673ee1409fd008acfb08adb4`.
- Backend `4458da7cc2b404fc5d38c4f5dd0ab5e4ade72fe291b02f1be7bfbec9af499325`
  i frontend `012a6f684a3d` są healthy. Inspekcja potwierdziła backend
  137 438 953 472 B / 16 CPU, readonly źródła i techniczne named volumes;
  rzeczywiste mounty sprawdzono kanonicznym `_validate_retained_service`,
  uwzględniając aliasy bindów Docker Desktop/WSL. API
  `b34e376b-541a-4a14-9c31-462bd4d46372` pozostało to samo podczas aktywacji.
  Frontend: `http://127.0.0.1:3198/workspace`, potwierdzone HTTP 200.
- Automatyczna retencja `d3df3394d073427891399530ba774b32` zakończyła się
  `succeeded`, receipt `/opt/fullmag/runtime-control/runtime-service/cache-maintenance.json`.
  Zachowano current i direct-rollback oraz 6 416 666 624 B używanego cache
  incremental poniżej limitu 8 GiB. Część wspólnego cache ma jawne
  `deferred-busy`: inna grupa ma package claim. Nie zatrzymywano jej ani nie
  usuwano jej danych; domknięcie tej części wymaga zwolnienia claimu i ponownej
  kwalifikacji. Nie jest to dowód odzyskania miejsca na dysku Windows.
- Przykład `fdm_gpu_field_visualization_10_steps.py`, SHA-256
  `9cee023300371816d13a8226116f3b097d98f416a8ae98209c7a94fe15b93bae`,
  aktywowano jako `b4140327146f41d68da343994ddfa6c5`. Po przygotowaniu
  1024 komórek wysłano dokładnie jeden Solve
  `fm-81563949-ca22-461c-afde-a07948ef8f3f`; journal potwierdza completed,
  requested/resolved FDM/GPU/double/strict i `fdm_cuda`.
- Run `run-live-55478efd6a686af08aba30e083e3b740657b6f81f5bdc0dc921c6d71feda22e5`
  zakończył 10 kroków, czas fizyczny 1e-12 s, energia 1.1276150962092844e-18 J.
  Odczyt FMVP potwierdził skończone m dla siatki 16×32×2 oraz niezerowe
  H_demag i H_eff w 640 komórkach Airboxa. Końcowy scalar window ma krok 10,
  ten sam run/request scope i energię. Artefakt `accepted_terminal_scalar_stats.v1`
  ma poprawny CAS SHA-256, task/attempt/ownership epoch oraz accepted/stat step 10.
  Dowód: `backend/six-points-runtime/case-terminal-fields-27965420297e4efc99527c3a410ab8a0.json`
  w grupowym control volume. `CurrentRunResource.total_steps=1` oznacza tutaj
  krok Study; liczbę iteracji sprawdzono osobno w `status.run.solver_steps`.
- Browser QA `ebc364264f3b438d985cf1683e83b8b8` zakończył się succeeded:
  m data-ready, 384 komórki magnetyczne, 640 segmentów Airboxa, WebGL2,
  context_lost=false, drawing buffer 617×495. Zrzut canvasa obejrzano.
  SwiftShader dowodzi renderowania; wykonanie CUDA potwierdza odrębny journal
  runtime. Nie stwierdzono zbieżności ani parytetu naukowego innych realizacji.
- FDM multilayer: aktywacja `d9959257347743b38cbff5c3de8a128d`, jeden Solve
  `fm-dcd15e91-0585-4de8-8c65-5505154874de`, run
  `run-live-41448a23915c5ed915fc865e97e183f0e22148e8463419cd3c0ead7d18584b26`.
  Potwierdzono completed, FDM/GPU/double/strict, 10 kroków / 1e-12 s, energię
  1.6371057829454116e-18 J i trwały terminalny StepStats kroku 10.
  Dowód: `backend/six-points-runtime/case-terminal-fields-bea061e379e04a179a2b460f086d1a0a.json`.
  Magnetyzacja ma 768 próbek native, Airbox H_demag/H_eff ma 3072 próbki
  na osobnym carrierze 16×32×6. Nie utożsamiano tego z przygotowawczym
  `status.domain.cell_count=384`, opisującym pojedynczą siatkę native.
- Osobny odczyt `multilayer-mapping-5854db1336ff43ec8171d6cb3b5e3c67.json`
  w tym samym katalogu control potwierdza po 384 próbki dla `lower_layer`
  i `upper_layer`: odczyty scoped object są identyczne z odpowiednimi
  fragmentami packed m, średnie my mają przeciwne znaki zgodne ze skryptem,
  a originy warstw są różne. Layout potwierdza three_d, cuFFT,
  cuda_native_multilayer_convolution/double i target-only Airbox.
  Browser QA `de83496651cf4c1a8b0b54f546b741b3` succeeded: dwa różne kolory
  warstw, 768 komórek magnetycznych, 1200 segmentów Airboxa, WebGL2 bez
  utraty kontekstu, buffer 617×527. Zrzut canvasa obejrzano.
- Nadal otwarte: nowy CoFeB na identycznej siatce, porównanie
  czasu przygotowania oraz widoczna stopka po odświeżeniu. Narzędzie Windows
  Computer Use odrzuciło inicjalizację z bieżącym WSL cwd; nie obchodzono tej
  granicy. Odbiór stopki wymaga zarządzanego harnessu przeglądarkowego.
  Nie uruchamiano testów jednostkowych ani nowego worktree.

### Checkpoint 30.10: nowy CoFeB, identyczny wynik i krótsze przygotowanie

- CoFeB aktywowano raz jako `8adfcad8c89c4fc6b6a3d943981bc9d4`; SHA skryptu
  `c986e1d8472cca81aef393d24118f4e0dbd215e1587727d114e3a859f8045cf6`.
  Python/Gmsh, walidacja i publikacja accepted input trwały 314 995 ms,
  native domain preparation 184 056 ms; razem 499 051 ms do Ready.
  Względem zapisanego wcześniejszego pomiaru 429 105 + 200 702 ms oznacza
  to 26,6% krótszą materializację i 20,8% krótsze przygotowanie do Ready.
  To pojedyncze porównanie z wcześniejszym checkpointem, nie statystyczna
  kwalifikacja wydajności. Admission po Compute i wykonanie solvera są
  osobnymi kosztami, nieuwzględnionymi w tych liczbach; nadal były długie.
- Nowy run `run-live-0096e07f45d52b68a8eb42043f9398a51efb7472295f0338d47ff836a23ba0b7`
  wykonał dokładnie 10 iteracji BB po jednym Solve
  `fm-370c82ef-2133-4c98-82a2-fa99ec901613`. Task
  `task-eb52fd87df16aff2b870d3fab32759ba97da6a0f13f7f75acacd02b9a31bab27`,
  attempt `attempt-e2983c9fa5fc474bbadf6763b5e6f795`, epoch 1: succeeded.
  Journal i readback potwierdzają FEM/GPU/double/strict, `fem_native_gpu`.
  Czas fizyczny pozostaje 0 s dla minimizacji; nie są to kroki LLG ani dowód zbieżności.
- Dowód `case-terminal-fields-80aa55adc2d1455a9dfacd7ac70eba1e.json` w
  `backend/six-points-runtime` potwierdza m: 183 764 węzły; Airbox H_demag/H_eff:
  157 393 węzły, wszystkie wartości skończone i niezerowe wektory.
  Metadane wszystkich trzech pól i scalar current_observation wskazują krok 10.
  Artefakt `accepted_terminal_scalar_stats` ma poprawny CAS SHA-256
  `79af79be5b5df27e2386440fb4f9ee1529a213c46937fa0da0387e508d5efb9d`,
  odpowiada claimowi i ma accepted/stat step 10; energia -3.668191276379833e-16 J.
- `cofeb-preparation-comparison-08c862ab8d93484db3b579738f086112.json`
  w tym samym katalogu wiąże pomiary z dawnym i nowym odczytem pól.
  Wszystkie wartości m/H_demag/H_eff mają identyczne hashe jak dawny run,
  identyczny domain ID `14850812098407037233`, revision 2 oraz topology SHA-256
  `1a7d1afa1af58fdce2112b1484fd8ec366b78ab8843aa7a725440e711749a18e`.
  Nie zmniejszono siatki ani nie zmieniono wejścia w celu skrócenia czasu.
- FEM Browser QA `826c360b68254af2ad7679de08f1b770`: succeeded. Primary m pozostaje
  data-ready przy wyświetlaniu 1200 wektorów H_demag w `part:__air__`;
  render przyjął target-buffer, render-snapshot health ready, bez degradacji
  glifów. WebGL2 nie utracił kontekstu, drawing buffer 617×495. Zrzut obejrzano:
  Universe obejmuje mniejszą warstwę i pierścień, widoczne są tekstury oraz wektory.
- Dodano jawny odbiór `--expect-terminal-telemetry` do istniejącej recepty
  browser QA: przypięte GET status/current-run/scalars, widoczny Step/Total
  energy, rzeczywisty page.reload i ponowny odbiór tego samego API/runu,
  skalarów, m i WebGL. Nie modyfikuje modelu ani nie zleca Solve.
  Python AST i składnia obu modułów Node w istniejącym frontendzie przeszły.
  Pierwsza rzeczywista próba `0d604d6af795481fb013903743580e14` zakończyła się
  przed reload z błędną sygnaturą callbacku w helperze. Poprawiono dwa wywołania;
  kolejne próby i ostateczny odbiór są opisane poniżej.

### Odbiór końcowy 30.10: sześć punktów zamkniętych

Stan z tego rozdziału zastępuje wcześniejsze checkpointy opisujące otwarte
odbiory. Receipty należą do grupowego control volume
`fullmag-build-control-fullmag-master-a7f7e9b9a4026499`, namespace
`namespaces/c1b31c15d177439fb92ec3df61ca8e26`. Dowody pól i porównania
przygotowania są w jego `backend/six-points-runtime`; odbiory przeglądarki
w `browser-qa/attempts/<id>`.

| Odbiór | Wynik |
| --- | --- |
| Docker i restore | Dostęp działa. Wcześniejszy kontrolowany restore zachował tożsamość ukończonego runu, mesh i identyczne pola bez nowego Solve; dowody w checkpointach odtworzenia powyżej. |
| FEM CoFeB | 1 087 250 komórek, 183 764 węzły, 10 iteracji minimizacji; m i Airbox H_demag/H_eff kroku 10. Render `826c360b68254af2ad7679de08f1b770`: succeeded. |
| FDM GPU | 10 kroków, m na siatce 16×32×2 i 640 próbek pola Airboxa. Render `ebc364264f3b438d985cf1683e83b8b8`: succeeded. |
| FDM GPU multilayer | 10 kroków, packed m 768 próbek, odrębne scoped warstwy po 384 próbki, Airbox 3072 próbki. Render `de83496651cf4c1a8b0b54f546b741b3`: succeeded. |
| Stopka i reload | Odbiór `773c087519d64361b7a5f4e52baf1f9c`: succeeded. Step 10, energia -3.668191e-16 J i identyfikatory zgodne przed oraz po rzeczywistym odświeżeniu. |
| Przygotowanie | Identyczne wejście, topologia i hashe pól. Materializacja 314,995 s zamiast 429,105 s; do Ready 499,051 s zamiast 629,807 s. |
| Wdrożenie i retencja | Build `b17bb884f3a3428aa4b1ec14da234370`, backend 128 GiB/16 CPU, API Ready; retencja `e869b9985f504531aeea2be11f15b2fd`: succeeded. |

Odbiór stopki zapisano w commicie
`3110abe1719821307ae8f01bf6e4843c0556100c`. Dwie wcześniejsze porażki
harnessu pozostały zapisane jako failed: błędny callback oraz
`37870d21a59f4be9a9f3adfbf8b85839`, w którym część przeglądarkowa przeszła,
lecz hostowy walidator błędnie wymagał ścieżki `/workspace`. Aplikacja
kanonizuje ją do `/session/permalloy_layer_cofeb_rings_relax_300nm`.
Poprawiony walidator zachowuje ten sam publiczny origin i kontrolę ścieżki
przed/po reload; nie poluzowano pinów API, sesji, runu ani wartości skalarów.
Próba `7f9b774f724541afa0813843c07c0e29` przeszła cały odbiór. Następnie
usunięto dwie uwagi hooka o tworzeniu formatterów Intl w helperze QA;
ostateczna próba `773c087519d64361b7a5f4e52baf1f9c` ponownie przeszła
odbiór, z SHA-256 helpera
`f4e3d7d8fd919cb13dd8523153469a4a57a28726f608fb37300eb986b612dd8f`.
Te same API/session/run/request scope, scalar revision 2 i source_step 10;
m data-ready, WebGL2 bez utraty kontekstu, buffer 617×495. Nie było nowego
Solve, Compute Fields ani restartu API.

Ponowny audyt dawnych uwag telemetrycznych potwierdził, że bieżący
`platform/system.rs` liczy uptime przez `api_started_at.elapsed()`;
odczyt końcowy dał 3886 s, nie epokę Unix. Canonical status publikuje
`solver.relaxation_algorithm=projected_gradient_bb` i `state=completed`.
Ogólne `solver.algorithm=null` nie opisuje minimizera; szczegółowy,
historyczny atrybut `algorithm=fem` nie jest nazwą algorytmu minimizacji.
Stopka nie ma już dawnych osobnych etykiet algorytmu/settlementu; stan
ukończonego runu i jego dane są zgodne. Nie dodano pollingu do stopki:
jej istniejący sekundowy timer dotyczy lokalnego zegara etapu antenowego.
Dowód odczytu: `final-status-audit-8476f75bd2424c318f9b0295c8474e02.json`.

Końcowa retencja rozwiązała wcześniejsze `deferred-busy` bez zatrzymywania
obcej grupy. Inventory shared cache: 23 383 774 296 B, evicted=[],
staging_retained=[]; używany cache incremental 6 416 666 624 B zachowany.
Niezależna inspekcja prywatnego namespace potwierdziła pusty katalog
candidates, jeden rollback 2 835 424 KiB i osiem katalogów retired
zajmujących łącznie 240 KiB metadanych. Nie było kwalifikowanych pakietów
do usunięcia. Dostępne miejsce Docker VM przed/po wyniosło
180 105 138 176 / 180 104 888 320 B; nie deklarujemy odzyskanych bajtów
na C: ani kompaktowania VHDX. Wyniki, archiwum starej sesji i cudze zmiany
pozostały zachowane.

Pozostają ograniczenia poza odbiorem tych sześciu punktów:

- Admission/przygotowanie po Compute nadal jest długie i wymaga osobnego
  profilowania; skrócenie do Ready nie oznacza skrócenia całego runu o 20,8%.
- Krótkie próby GPU dowodzą uruchomienia, mapowania, materializacji i renderu.
  Nie kwalifikują zbieżności, parytetu FEM/FDM, realizacji CPU ani produkcji.
- Pobrane później commity remote opisują odrębny, nadal zablokowany przypadek
  `fem_relax_gpu_smoke.py`: natywny worker FEM GPU kończy się SIGSEGV przed
  pierwszym krokiem. Udany CoFeB nie zamyka tego błędu;
  [status osobnego odbioru 2D](../../status/2d-slice-capabilities.md).
- Normalny, zatwierdzony hook React Doctor pozostawia dwie wcześniejsze
  uwagi do lookupów w istniejącym głównym harnessie. Nie zmieniano hooka,
  PATH ani progów kontroli; nie przedstawiamy skanera jako bezuwagowego.
- Backend działa ze źródeł `aee17a54d4c283f2fdf5aa3d89acc5ecdb638e19`.
  Późniejsze zmiany odbioru dotyczą harnessu i dokumentacji; nie wymagają
  kolejnej kompilacji solvera. Backend i frontend pozostają włączone
  na 3198 z ukończonym CoFeB. Nie uruchamiano testów jednostkowych.

Przed końcową synchronizacją pobrano
`fec56017703cef40a7321646f3367858dea0d6fb` z origin/master: sześć nowych
commitów zmieniających wyłącznie testy i dokumentację widoku 2D. Połączono
je bez konfliktów z własnymi commitami odbioru; nie uruchamiano tych testów
ani kolejnego buildu. Zmiany nie modyfikują działającego solvera ani jego
wyników. Równoległe zmiany instrukcji, poradników i submodułów zachowano
poza commitami tego zadania.
