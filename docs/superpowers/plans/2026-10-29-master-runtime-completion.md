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
- [ ] **2. Odtworzenie siatki i pól bez obliczeń.** Root odpowiada za
  `development_accepted_restore/terminal_observation.rs`,
  `live_accepted_projection.rs`, `live_scene_preparation.rs` i wymaganych
  konsumentów. Najpierw prześledzić odmowę publikacji terminalnej domeny.
  Wykorzystać istniejącą projekcję accepted output i zweryfikowaną siatkę;
  zachować run/task/attempt/epoch/plan/topology oraz stan terminalny.
  Dowód: po kontrolowanym odtworzeniu ten sam run i krok, dostępne domena,
  m/H_demag/H_eff, identyczne wartości, brak nowego admission/Start/Solve.
- [ ] **3. Telemetria.** Worker `footer_step_authority` zakończył swoją część;
  root integruje stopkę z brakującymi danymi backendu i generowanym kontraktem.
  Nie mieszać prepared scalar z późniejszym zaakceptowanym krokiem.
  Dowód: API i widoczna stopka pokazują ten sam krok i energię po ukończeniu
  i odświeżeniu; brak niepotrzebnego pollingu. Poprawić także potwierdzone
  błędne wartości uptime/nazwy algorytmu i etykietę settlementu, zachowując
  istniejący kształt kontraktu albo regenerując API zarządzaną receptą.
- [ ] **4. Czas przygotowania.** Worker `materialization_profile_map` tylko
  mapuje kod i pomiary; root wybiera i wdraża zmianę. Rozdzielić generację,
  certyfikację, encode/decode, native preparation i publikację. Usunąć
  wykazaną pracę powtarzaną przy reuse, zachowując walidację/piny wejścia.
  Dowód: porównanie tego samego workloadu, konfiguracji i fingerprintów
  topologii; podać czasy i faktycznie usuniętą pracę, bez utożsamiania różnych
  etapów pomiaru i bez zmniejszania domeny.
- [ ] **5. Wdrożenie scalonych źródeł.** Uzgodnić końcowy stan starego runu
  i ownera po przerwie silnika, zachować dane i użyć istniejącej recepty
  stop/recovery/resume. Zbudować w stałym backendzie, zachować 128 GiB/16 CPU.
  Dowód: źródła/SHA/snapshot, manifest, build receipt, API Ready, mounty,
  requested/resolved GPU/double oraz kwalifikowana retencja tej próby.
- [ ] **6. Odbiór obu rodzin.** CoFeB FEM/GPU/double: zgodny Universe i mesh,
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
