# P0 — status implementacji i bramek A–F

Data: 20.09.2026. Ten dokument jest statusowym uzupełnieniem [inwentarza P0-A](01-inventory.md) i [baseline’u P0-E](02-baseline.md). Rozdziela stan źródeł od dowodu wykonania. Nie jest receipt’em builda, runtime’u, nauki ani wydania.

## Bieżący checkpoint weryfikacji

Ostatnia kontrola: **build PASS; minimalne regresje P0 PASS; P1 rozpoczęty**. Użytkownik polecił „ok wykonaj to co niezbedne i przejdz do p1”, po wyjaśnieniu zakresu niezbędnych testów; jest to scoped odwołanie wcześniejszego zakazu dla odbioru P0. `just verify-session-persistence` zakończył się exit 0: **70 passed, 0 failed, 0 ignored**, zgodne hashe źródeł przed i po. Pełny [odbiór minimalny](05-minimal-gate.md) zapisuje receipt, poprawione fixture’y i pozostałe ograniczenia. Nie oznacza to pełnego odbioru produkcyjnego P0.

Najnowsza rewalidacja bieżącego dirty checkoutu `master@14c8e73a6f3c55f4fc080835a6156f2a4db8f111` jest w runie `4315e35f99d74ffdb77159aaee82a9f5`: `just verify-session-persistence`, source digest `e2d92e4dc84a05ffe3c733141ae3981fc575bde85bc2d436688346596d7aa4df`, receipt SHA-256 `30F08AC207B7D2110D498CAD5035E004F4430A9FB5CF8F4AE5BFB773EF07D4A5`, log SHA-256 `6D036D9E4D259A9B5609E06B60B2AFAE3D3F4E309E3C7DE471F9D3B6F908A045`, `source_changed_during_run=false`. Wszystkie 70 testów są zielone. P0-D ma dodatkowo managed run `3c62609c6fd5478a93f62bbf99c6a4ed`: walidator + 9 testów Python oraz 24/24 testy capability.

Koordynator pełnego buildu wcześniej potwierdził terminalne `succeeded`, exit 0, bez błędu dla joba `1109693f411b4720b87690caa37cb880`. Worker również zakończył się z kodem 0. Nie uruchomiono kolejnego pełnego buildu. Dalsze wpisy opisujące `NOT_RUN` i zakaz są historią sprzed wykonania minimalnych regresji; bieżący wynik zachowania jest w dokumencie `05-minimal-gate.md`.

Receipt `artifacts/build-receipt.json` czwartego joba ma stan `succeeded` i czas zakończenia `2026-09-20T14:12:06.227094Z`. Jego SHA-256 to `0f6ac8e71bef47d259b82e83a1683edd191de61a01a861a169c84784769f0433`. Zweryfikowano wszystkie **109 artefaktów** (148102135 bajtów): rozmiary i SHA-256 zgodne, zero brakujących plików i zero rozbieżności. Etapy `native-build` (639164.535 ms), `frontend-dependencies` (349731.124 ms) i `frontend-build` (414836.803 ms) mają exit 0. CLI, API i Python zakończyły kompilację release; frontend przeszedł webpack, TypeScript i generowanie stron statycznych. Porównanie 20 bieżących plików kodu/testów z kapsułą potwierdziło identyczne bajty.

**Ograniczenie provenance pełnego buildu:** pola `toolchain.cargo` i `toolchain.rustc` mają exit 1: odczyt wersji zatrzymał się na `Permission denied` podczas tworzenia pliku tymczasowego w `/workspace/.fullmag-rustup/tmp/`. Również tekst wyniku rustup sygnalizuje brak odczytu bieżącego rustc. Nie zmieniano uprawnień ani konfiguracji runnera. Udana kompilacja i zgodne artefakty są dowodem buildu wskazanego snapshotu, ale nie pełną kwalifikacją toolchainu; receipt sam zawiera `qualification: NOT VERIFIED`. Późniejszy Windows session check ma poprawny zapis własnego toolchainu; nie uzupełnia wstecz wersji kompilatora kontenerowego.

Snapshot ostatniego pełnego buildu obejmuje poprawki produkcyjne session oraz nullable metadata w Field Map. Późniejsze testowe fixture’y, helper i P1 nie są częścią tej kapsuły. Lokalna kontrola typów frontendu jest zaliczona; poprzedni build zaliczył część natywną, ale zakończył się błędem frontendu. Wyniku poprzedniej kapsuły nie przypisywać bieżącemu kodowi. Szczegóły czterech zgłoszeń poniżej są historią zdarzeń: dawne określenia `queued`, `running` i „wymaga kolejnego snapshotu” odnoszą się do momentu danego wpisu.

Log bieżącego `fullmag-session` zawiera dwa ostrzeżenia (`Held.file` i `WindowsLocal`), bez błędu kompilacji. Nie zmieniano źródeł w odpowiedzi na te ostrzeżenia. Build nie kompilował ani nie wykonywał fixture’ów testowych.

Receipt, tożsamość źródeł oraz rozmiary i hashe artefaktów zostały sprawdzone. Niezależnie od buildu pozostają otwarte bramki zachowania P0-B/C/F. Niezbędne testy są teraz autoryzowane. P0-E dopuszcza jawne `NOT_RUN` z przyczyną dla niedostępnego pomiaru; nie oznacza to zgody na pominięcie wymaganych dowodów poprawności writera, GC i importu.

**Następny wymagany krok:** wykonać regresje `fullmag-session` na izolowanych danych, z resolverem, własnym profilem wyjść i receiptem. Czysto rustowy graf `fullmag-session → fullmag-ir → fullmag-quantities` nie buduje solverów; jego wąska trasa nie potrzebuje historycznych linków `.fullmag`. Pełne buildy nadal należą do istniejącego koordynatora. Odwołanie zakazu samo nie zalicza testów. Odbiór obejmuje również fault-injection, recovery oraz platformowe odmowy symlink/junction; rzeczywista kwalifikacja power-loss pozostaje osobnym, niewykonanym eksperymentem. P1 ma korzystać z jawnie udowodnionych gwarancji, bez deklaracji odporności na utratę zasilania. Nie wykonywano GC na danych użytkownika, commita ani pushu.

## Baza i reguły odczytu statusu

- Checkout: `master@14c8e73a6f3c55f4fc080835a6156f2a4db8f111`.
- Stan checkoutu jest dirty. Inwentarz P0-A przypina 18/18 hashy materiałów wejściowych jako `MATCH` oraz zapisuje bieżące wpisy dirty.
- Prace są prowadzone na współdzielonym masterze z autoryzacją użytkownika. Ten dokument nie wykonuje stagingu, commita, pushu, merge ani cleanupu.
- Zlecono managed build aplikacji `fem-cpu-release` na niezmiennym snapshocie, bez testów jednostkowych w tym buildzie. Następnie użytkownik autoryzował niezbędne regresje P0, które skompilowano i wykonano osobną ograniczoną trasą. Nie wykonywano zadania solvera, GC na danych użytkownika, browser/WebGL ani kwalifikacji fizycznej.
- Plik albo source anchor oznacza `SOURCE_PRESENT`/`SOURCE_WIP`; nie oznacza `EXECUTED`, `VALIDATED` ani `QUALIFIED`.

## Status P0-A–F

| Pakiet | Stan źródeł | Stan kontraktu | Bramka wykonawcza | Dowód / właściciel następnego kroku |
|---|---|---|---|---|
| **P0-A inventory** | `SOURCE_COMPLETE` | `INVENTORY_PINNED` | `SOURCE_GATE_PASS`; runtime/API/browser/physics/release `NOT_RUN` | `01-inventory.md`, `inventory.json`, `scripts/audit_refactor_p0.py`; owner: koordynator po review kompletności |
| **P0-B GC/reachability/capture** | `SOURCE_IMPLEMENTED` | `SCOPED_CONTRACT_PRESENT` | `MINIMAL_WINDOWS_GATE_PASS`; API/runtime pending | Syntetyczny store, unknown-root refusal i capture/restore przeszły w runie `236ce87237184c099c89d5e75f89d63b`; zob. `05-minimal-gate.md` |
| **P0-C writer/durability/lock** | `SOURCE_IMPLEMENTED` | `LIMITATIONS_EXPLICIT` | `MINIMAL_WINDOWS_GATE_PASS`; power-loss `NOT VERIFIED` | Native lock/process death, fault injection przed i po rename przeszły; Windows directory durability i inne platformy niekwalifikowane |
| **P0-D ADR/authority/build contract** | `DECISION_SOURCE_PRESENT` | `SCOPED_DECISION_PRESENT` | `REVIEW_AND_DEPENDENT_GATES_PENDING` | `docs/adr/0032-fdm-cpu-authority-and-runtime-selection.md` oraz zmiany ADR-0009/0025/0030, backend masterplan, instrukcji backendu, capability/API specs; decyzja dokumentacyjna nie jest kwalifikacją lane’u |
| **P0-E fixture/receipt/baseline** | `SOURCE_COMPLETE` | `BASELINE_RULES_PRESENT` | Testy persistence odświeżone; pomiary baseline `NOT_RUN` | `02-baseline.md`, `02-baseline-manifest.json`; fixture’y zachowane, ale brak bieżącego pomiaru wydajności. Testy persistence nie zastępują baseline’u operacji ani transferów |
| **P0-F import/path containment** | `SOURCE_IMPLEMENTED` | `TRUSTED_ROOT_EXPLICIT` | `MINIMAL_WINDOWS_GATE_PASS` | Testy ID/path/absolute/traversal/junction i niepustego destination przeszły; brak gwarancji przeciw wrogiemu lokalnemu procesowi podmieniającemu ścieżki |

`SOURCE_COMPLETE` przy P0-A i P0-E oznacza zakończony odczyt/inventory, nie wynik runtime. P0-B/C/F mają wykonany minimalny zestaw regresji Windows. Ten wynik pozwala rozpocząć P1, lecz nie zamyka kwalifikacji produkcyjnej wszystkich platform i adapterów.

## Braki blokujące promocję

### Storage i session

1. Minimalne source/contract checks P0-B/C/F wykonano osobną zarządzaną trasą na syntetycznych danych; nie wymagały migracji rzeczywistego `.fullmag`.
2. Pozostaje odbiór integracji API/CLI i kwalifikacja platform/durability adekwatna do deklarowanego wydania.
3. Nowy adapter projektu P1 wymaga własnych testów roundtrip i writer/revision conflict. Nie dziedziczy automatycznie wyniku SessionStore.

Znane ograniczenia zachowania do zachowania w odbiorze:

- Kolejny CLI `Open` do zajętego domyślnego store kończy się jawną odmową. P0 usuwa niebezpieczne nadpisywanie, ale nie implementuje jeszcze transakcyjnej zamiany aktywnego projektu P1. API korzysta z izolowanego stagingu.
- CLI `Save` może zbudować workspace/export profile w pamięci bez zapisania ich jako osobnych lokalnych dokumentów `manifest/*`. Archiwum zawiera te dokumenty; lokalny store po Save i po import pozostaje asymetryczny. Nie podnosić tej ścieżki do pełnego repozytorium projektowego P1.
- Nieznane dokumenty oraz nieopisane referencje mogą zablokować apply GC także w istniejącym store. Jest to jawna konserwatywna odmowa, a nie dowód, że dowolny istniejący katalog został kompletnie zinterpretowany.
- Niepewne piny i staging są zachowywane. Nie ma automatycznej procedury uznającej je za bezpieczne do usunięcia na podstawie wieku.
- Power-loss i wymiana katalogu artefaktów API pozostają bez kwalifikacji wykonawczej. Nie deklarować „production durable” na podstawie format check albo zakończonego procesu.

### Backend i build

Odczyt health runnera potwierdził `worker_alive=true`, `accepting_jobs=true`, brak aktywnych zadań i około 111,5 GB wolnego storage przed submit. Domyślny sandbox blokował dostęp sieciowy; jawnie dozwolony odczyt rozstrzygnął, że runner działa. Lokalny `just check-session-persistence` zatrzymał się przed kompilacją na istniejącym rzeczywistym `.fullmag`; nie wykonano migracji ani obejścia tego guardu. Profil `fdm-cpu-release` jest dozwolony, lecz nie ma przypisanego obrazu. Użyto istniejącego, skonfigurowanego `fem-cpu-release`, którego komendy budują CLI/API/biblioteki i frontend bez kompilowania testów. Jest to build aplikacji do weryfikacji źródeł P0, nie zamiana wymaganego GPU ani kwalifikacja FEM.

Job: `68e6c4155f3e4c4394353e42dde12dc0`; snapshot capsule: `93285009ba7141dbb7748699bf4e9433`; source digest: `d49c1372dd3778b50cc1e5b559f8931abb4cdeb922e2c8e9f364d343328adb0c`; native source identity: `68dc145305301d9aa18f9464969ba27a5661664391f3f46700f46c7d57f1222f`. Odczyt po submit: `running`, `exit_code=null`. Ten stan nie jest wynikiem buildu. Późniejsze dostosowania fixture’ów `cfg(test)` wymagają osobnego zaznaczenia względem tego snapshotu; testy nie zostały skompilowane.

Kontrole przed submit: `rustfmt --check --edition 2021` dla zmienionych modułów session/CLI — PASS; parser trzech JSON inventory/baseline/capability — PASS; 12 względnych linków dokumentacji P0 — PASS; `git diff --check` — PASS. Inventory zostało zregenerowane 21.09.2026 po dodaniu endpointów projektu i korekcie rozpoznawania zagnieżdżonych modułów Rust: 300 operacji OpenAPI, 300 rozpoznanych handlerów, 0 nierozpoznanych handlerów/konsumentów, 2 jawne router-only i 18 materiałów wejściowych. Są to kontrole źródeł/dokumentów, nie wykonanie testów zachowania.

Po capture poprawiono fixture’y w sekcji `#[cfg(test)]` pliku `crates/fullmag-session/src/fms.rs`: poprawny run manifest, dynamiczny identyfikator checkpointu, zgodny common state i rzeczywisty descriptor/chunk przed celowym uszkodzeniem CAS. Porównanie bajtów potwierdziło identyczny prefiks produkcyjny tego pliku względem kapsuły; pełny plik w momencie porównania miał SHA-256 `b1fa5e40115dc7b462cf8ebbe561922b93f031990370352155f9ebbfcab45bec`. Nie utożsamiać snapshotu buildu z późniejszym pełnym plikiem ani z wykonaniem tych testów. Ponowny format/diff check przeszedł.

Następnie zmieniono również kod produkcyjny `reachability.rs`: oba walkery wybierają typ restart payloadu według pola checkpointu, a nie nazwy pliku. `backend_state_ref` wymaga `fullmag.backend_state.v1`, `rng_ref` jest odczytywany jako `RngState`, a `integrator_ref` musi zawierać niepusty obiekt JSON; zasada obejmuje także referencje CAS. W `tests/p0_archive.rs` dodano fixture odrzucający niepoprawny backend state pod niestandardową nazwą. Format check przeszedł; test pozostaje `NOT_RUN`. **Pierwszy build nie obejmuje tej poprawki produkcyjnej i nie może potwierdzić kompilacji końcowego checkoutu.** Po zamrożeniu poprawek potrzebny jest nowy snapshot na tej samej zarządzanej trasie, po zakończeniu pierwszego zadania.

Pierwszy build zakończył się **FAILED**, `exit_code=2`, 20.09.2026 o `12:16:24 UTC`. Kompilator wykazał siedem wywołań nieistniejącej metody `StoreWalker::missing` (`E0599`) i brak pożyczenia `&checkpoint` w archive walkerze (`E0308`). Zgłosił również zbędne `mut` przy deskryptorze writera. Nie był to błąd infrastruktury ani timeout obserwacji. Wynik nie potwierdza kompilacji CLI/API ani późniejszych etapów.

Receipt znajduje się pod `storage/runs/fullmag-0950f4dca4ffe38f/68e6c4155f3e4c4394353e42dde12dc0/artifacts/build-receipt.json` względem project root resolvera. SHA-256 receiptu: `29e803905081dd7b4fdd6102581c34c91f47407a9f952071c052d85f3ba47eea`. Oba wskazane w nim logi istnieją, są niepuste i mają hashe zgodne z receiptem. Native-build trwał około 239 s; wcześniejsze przygotowanie snapshotu nie jest czasem kompilacji. Poprawki tych błędów wymagają kolejnego buildu na nowym snapshocie.

Przygotowane poprawki źródłowe po błędzie: `StoreWalker::missing` deleguje do raportu oznaczającego graf jako niekompletny, a tryb GC nadal wymaga kompletności przed zwrotem; archive walker pożycza checkpoint; writer nie deklaruje zbędnego `mut`. Dodatkowo referencje CAS i plikowe przechodzą przez ten sam typed payload traversal. Zapobiega to pomijaniu potomnych referencji common state/artifact index oraz uznawaniu nieznanego dokumentu CAS za kompletny tylko dlatego, że zgadza się jego hash. Są to poprawki kodu oczekujące na wynik ponownej kompilacji, nie zaliczone bramki.

**Drugi build:** job `c53a4a51da2149a6a91ef7fb3796f88c`, request key `refactor-runtime-p0-20260920-source-check-2`, profil `fem-cpu-release`, operation `build`. Kapsuła `f76c6e54118946f78a0c992880037cbb`; source digest `2cd5741a89440a45a79a3add119299b7369c4f02e3da1bd1a5248d47d6626221`; native source identity `7e4b89e8fccafdf86ad7cb2fd475bcab1090334cf8d284245c268e28b1ef6b14`. Snapshot obejmuje powyższe poprawki oraz źródłowe fixture’y; kopię przygotowano przy zamrożonych zapisach. Submit zakończył się powodzeniem i stanem `queued`, bez wyniku kompilacji. Testy nie są celem tego profilu i pozostają `NOT_RUN`. Przed submit runner potwierdził `worker_alive=true`, `accepting_jobs=true`, pustą kolejkę aktywnych zadań i `109690216448` bajtów wolnego storage. Pierwszy job był już terminalny.

Kolejny odczyt drugiego joba: `running`, `exit_code=null`. Po utworzeniu kapsuły rozszerzono wyłącznie test integracyjny `archive_preflight_follows_descriptor_to_chunk_and_preserves_resume_payload` w `tests/p0_archive.rs`: teraz wykonuje także import do osobnego tymczasowego store, porównanie wszystkich osiągalnych obiektów CAS, odczyt rzeczywistych wartości pola głównego i pomocniczego oraz stanu integratora/RNG. Format check tego testu przeszedł; kompilacja i wykonanie pozostają `NOT_RUN`. Ta późniejsza zmiana testu nie jest częścią kapsuły drugiego buildu i nie zmienia kompilowanego kodu produkcyjnego.

Późniejszy review P0-C/F wskazał lukę eksportu na Windows: `canonical_store_root` i `validate_store_source` sprawdzały `is_symlink` oraz canonical containment, ale nie wszystkie reparse points. Dodano w tych miejscach wspólne `repository_path::reject_link`. **Ta poprawka produkcyjna nie znajduje się w drugim snapshocie; jego wynik będzie dowodem tylko dla zapisanej kapsuły.** Format/diff check poprawki przeszedł. W sekcji testów `fms.rs` dodano również archiwum z poprawnymi nazwami ZIP, ale złośliwym `session_id` w treści manifestu: przypadki traversal/absolute/separator/DOS mają być odrzucone przed lease i zapisami. Test pozostaje `NOT_RUN`.

Review odróżnił brak dowodu od ograniczenia protokołu. Przerwany `unpack_fms` pozostawia częściowy docelowy staging, a retry w nim jest odrzucane; kontrolowany odzysk wymaga nowego izolowanego stagingu zgodnie z `04-storage-protocol.md`. Nie ma automatycznej promocji ani kasowania częściowej kopii. Nadal brak wykonywalnego dowodu awarii po rename/directory barrier, Windows junction/reparse oraz kwalifikacji lokalnych filesystemów. Istniejący test śmierci procesu nie zastępuje żadnego z tych dowodów. Drugi build, nawet zakończony poprawnie, nie zamknie tych bramek.

Do końcowego snapshotu dodano również wspólną walidację zgodności `step`, `time_s` i `dt` checkpointu z odczytanym common state w obu walkerach. Wcześniej zgodność sprawdzał bezpośredni zapis/odczyt checkpointu, lecz preflight importu mógł przepuścić niespójne dane. Brak dokumentu pozostaje jawnym niekompletnym grafem; sprzeczne wartości są błędem. Dodano źródłowy fixture rozbieżnego common state i rozszerzono zestaw odrzucanych ID o `CONIN$`, `CONOUT$`, `COM¹` oraz `LPT¹`. Format check przeszedł. Wszystkie te scenariusze pozostają `NOT_RUN`; zmiany produkcyjne `reachability.rs` oraz `fms.rs` wymagają trzeciego snapshotu po zakończeniu drugiego joba.

**Trzeci build:** job `ce2a5d2ede124be38a4e682f3301123e`, request key `refactor-runtime-p0-20260920-source-check-3`, kapsuła `6b311dba4c7d414d8d54f5509acc4187`, source digest `910d0402110b9810dc58d847293555cf5d355d26ea4c55562dec33476f5f579f`, native source identity `d4f60c64fd64e664fcd4cbc2a595203967f4ece9e83048fdd8bd25ba2aca180e`. Profil pozostaje `fem-cpu-release`, operation `build`, bez celu kompilowania testów. Submit zakończył się powodzeniem ze stanem `queued`. Snapshot zawiera końcowe poprawki powyżej, w tym poprawiony borrow przy walidacji common state oraz wszystkie bieżące fixture’y.

Po potwierdzeniu serializacji kolejki zmieniono wyłącznie moment zgłoszenia: trzeci job zgłoszono, gdy drugi był jeszcze aktywny. `queue.py::claim` odrzuca claim przy aktywnym `running/cancel_requested`, a `RunnerService` czeka na uzgodnienie poprzedniego joba przed następnym execute. Nie uruchomiono równoległej kompilacji ani nie zmieniono konfiguracji runnera. Wynik trzeciego joba pozostaje oczekiwany; stan `queued` nie zamyka bramki kompilacji.

Postęp drugiego joba: log `native-build.stderr.log` zawiera pomyślne zakończenie kompilacji release CLI (`6m 04s`) oraz API (`5m 29s`), po czym rozpoczęła się część Python. Poprzednie błędy `E0599`/`E0308` nie wystąpiły w tym przebiegu. Pozostały ostrzeżenia, m.in. pole utrzymujące deskryptor writera i wariant Windows niekonstruowany na Linuxie. Są to wyniki częściowe zapisanej kapsuły drugiego joba; cały job i późniejszy końcowy snapshot nadal wymagają końcowych receiptów. Nie przypisywać tym logom testów runtime, importu ani awarii zasilania.

Biblioteka Python drugiego joba również zakończyła kompilację (`2m 35s`), zależności frontendu przygotowano poprawnie, a webpack zgłosił `Compiled successfully in 107s`. Następnie TypeScript odrzucił `FieldMapModule.tsx:588`: `surfaceProjectionStatus(meta.data)` przyjmowało nullable metadata, a diagnostyka dereferencjonowała `overlap_count`/`fold_count`. Plik nie należał do dotychczasowych zmian P0; wystąpił nowy, konkretny blocker pełnego buildu. Istniejący wrapper uruchomił własne jednokrotne ponowienie frontendu; job pozostawał aktywny.

Trzeci job **anulowano ze stanu `queued`**, aby nie powielać znanego błędu w przestarzałym snapshocie. API potwierdziło stan `cancelled`; nie był to przerwany aktywny build ani niepowodzenie kompilacji. Wszystkie artefakty i kapsuła pozostają zachowane. Aktywny drugi job pozostawiono do końcowego receiptu. Bounded poprawka nullable metadata i dozwolona kontrola źródłowa poprzedzą następny snapshot; zakaz budowania testów pozostaje aktywny.

Poprawka frontendu obejmuje wyłącznie guard `meta.data &&` przed diagnostyką `surfaceProjectionStatus` w `FieldMapModule.tsx`. Diagnostyka nadal pokazuje rzeczywistą niejednoznaczność, kiedy metadata są dostępne; brak danych nie jest dereferencjonowany. Zgodność błędnego pliku z bazowym HEAD potwierdzono przez porównanie kapsuły trzeciego joba po normalizacji EOL (SHA-256 pliku kapsuły: `0eae0462b3fada5a7695085fbdf5bbc074f7e05fe612b52facb6cf8f09065932`). Delegowana lokalna kontrola `pnpm --dir apps/control-room typecheck` zakończyła się **PASS, exit 0**. Nie wykonywano testów, instalacji pakietów ani dodatkowego lokalnego buildu. Wynik dotyczy źródłowych typów; browser/WebGL i wykonanie ścieżki z nullable metadata pozostają bez dowodu runtime.

**Terminalny wynik drugiego joba:** `failed`, `exit_code=2`, `2026-09-20T13:23:33.777516Z`. Receipt SHA-256: `55f4307f4fa152e01bb14511dd0fe466bc4510b0f16e68d32628b0fad0ff1f0b`; wszystkie 6 wskazanych logów mają zgodne rozmiary i hashe. Etapy: `native-build` PASS (947637 ms), `frontend-dependencies` PASS (384716 ms), `frontend-build` FAIL (749302 ms, wraz z automatycznym retry). Obie próby frontendu zakończyły się tym samym błędem nullable metadata. Receipt jest niepusty i opisuje niepowodzenie; nie jest receipt’em poprawnego wydania.

**Czwarty build:** job `1109693f411b4720b87690caa37cb880`, request key `refactor-runtime-p0-20260920-source-check-4`, kapsuła `ef883555dc7d4e42a30dca9d67225635`, source digest `c94f76352a051c62f618de8dd386d507418363ce8c9246e4947055bedd755859`, native source identity `d4f60c64fd64e664fcd4cbc2a595203967f4ece9e83048fdd8bd25ba2aca180e`. Snapshot obejmuje poprawkę Field Map, końcowe zmiany session i fixture’y. Native identity jest taka sama jak w anulowanej kapsule trzeciej, ponieważ różnica dotyczy frontendu; pełny source digest jest inny i jest konieczny do identyfikowania tego buildu. Profil `fem-cpu-release`, operation `build`; submit zakończył się stanem `queued`. Wynik nadal oczekiwany, bez kompilowania testów.

Przegląd konsumentów ujawnił również bezpośredni zapis snapshotu artefaktów w API. W `session_persistence.rs` dodano walidację run ID, containment, wyłączne UUID staging i wspólny writer lease; eksport utrzymuje go dopiero po ostatnim `await`, przez capture/pack/publikację. `CURRENT` jest aktualizowany po udanym pakowaniu. Zmiany te są w wysłanej kapsule. Pełna kwalifikacja awarii przy wymianie katalogu artefaktów nadal wymaga osobnego dowodu; samo podłączenie blokady jej nie zastępuje.

### API i frontend

P0-A wykazało rozdzielne metryki: 248 unikalnych ścieżek OpenAPI, 239 current, 300 operacji; 249 bloków Axum, 302 rejestracje metod; 295 adnotacji `utoipa::path`, 288 current. Po korekcie skanera dla zagnieżdżonych modułów Rust checker rozpoznaje wszystkie 300 handlerów, nie raportuje nierozpoznanego handlera ani konsumenta, a dwa router-only są jawne. Wpis `POST /v2/sessions` wskazuje teraz bezpośrednio `crates/fullmag-api/src/router_v2/handlers/sessions/create.rs:28`. Consumer status pozostaje evidence-level (`FRONTEND_LITERAL_EVIDENCE` albo `PATH_CONSTANT_OR_GENERATED_ONLY`). To nie jest dowód zgodności live router↔schema ani browser flow. P3a nadal wymaga pilota identity/context i regeneracji transportu po kontrakcie.

## Kolejność odblokowania

1. Utrzymać P0-A jako przypięty inventory i nie zmieniać API/session kontraktu poza scoped decyzją.
2. Dokończyć review source diffów P0-B/C/D/F oraz managed preflight; zapisać konkretne powody blokad.
3. Wykonać wymagane dozwolone checks P0-B/C/F i zbudować receipt’y, bez nazywania zielonego source check kwalifikacją naukową.
4. Dopiero po przejściu storage/containment/authority gates rozpocząć P1 shell/persistence. P0-E pomiary i backendowy strumień B pozostają osobnymi bramkami.
5. Nie zamykać P0 jako całości, dopóki którykolwiek pakiet ma `BLOCKED_FOR_PROMOTION`, `NOT_RUN` albo brak pełnej tożsamości receipt’u.

## Stan końcowy tego statusu

P0-A jest gotowym artefaktem inwentaryzacyjnym. P0-E ma gotowy rejestr wejść i progów, ale nie ma pomiaru. P0-B/C/D/F zawierają bieżące zmiany źródłowe lub kontraktowe w dirty checkout, jednak ich bramki wykonawcze pozostają otwarte. Najbliższa bezpieczna decyzja to review i dozwolone checks na właściwej trasie managed; nie jest nią publikacja ani promocja produkcyjna.
