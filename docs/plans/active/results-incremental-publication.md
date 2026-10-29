# Przyrostowa publikacja wyników dla Results

Stan: projekt kontraktu i kolejność wdrożenia po audycie 29.10.2026. Nie jest to dowód działającego monitoringu autosave. Implementacja pozostaje w zadaniu przeglądarki wyników; nie zastępuje jej samym odtwarzaniem zakończonego runu.

## Wymagany efekt

Results pokazuje opublikowane tabele, pola i pozostałe pliki bieżącego runu już w czasie obliczeń. Nowa próbka zwiększa dostępny zakres czasu bez utraty filtra, rozwinięcia drzewa, wyboru, kamery ani ustawień snapshotu. Wybrana historyczna klatka pozostaje przypięta; pojawienie się danych nie przełącza automatycznie obrazu. Użytkownik może przyjąć nowszą rewizję albo wrócić do Live. Po zakończeniu ten sam output można otworzyć jako folder bez działającej sesji.

Nieznany format jest widoczny, ale nie otrzymuje umownego mapowania do 3D. Dane FEM wymagają powiązania konkretnego quantity, tablicy i supportu z geometrią producenta. Brak publikacji podczas aktywnego runu jest stanem oczekiwania; brak wymaganej publikacji po zakończeniu jest błędem.

## Potwierdzone źródłowo ograniczenia

- `crates/fullmag-api/src/accepted_project_storage.rs::prepare` rezerwuje końcowy leaf i zapisuje manifest running, lecz `data_root` kieruje do prywatnego `temp_dir/data`.
- `accepted_study_worker.rs` i `accepted_fem_study_worker.rs` przekazują ten root jako miejsce autosave. Próbki istnieją w stagingu podczas wykonania; nie są jeszcze publicznym outputem.
- `AcceptedProjectStorage::finish` tworzy `run.json` i publikuje drzewo dopiero po sukcesie. `ProjectStorageLease::publish_directory` wymaga źródła w prywatnym scratch i nie nadpisuje istniejących wyników.
- `router_v2/handlers/workspace_results.rs::resolve_current_results_root` przyjmuje tylko zgodny completed manifest oraz succeeded output-storage receipt. Nie wolno usunąć tych warunków bez nowego kontraktu publikacji.
- Resolver odrzuca więcej niż jeden pasujący leaf jako `current_results_publication_ambiguous`. Obsługa wielu etapów wymaga źródła obejmującego cały run, a nie wyboru ostatniego katalogu.
- `autosave_zarr.rs::append_field_sample` zapisuje chunk, aktualizuje `.zarray`, następnie dopisuje indeks współrzędnych. Sam nowy kształt nie jest transakcją obejmującą payload, czas i semantykę.
- `artifacts.rs::publish_fem_autosave_playback` jest wywoływane przy `RunStatus::Completed`, korzysta z zapisanych przez producenta próbek `m`. Przeniesienie odczytu do stagingu nie zapewni przez to bieżącej geometrii ani innych quantity FEM.
- Czytnik Results waliduje rewizję przed i po odczycie oraz odmawia próbki o niezgodnym rozmiarze lub niefinitywnych wartościach. Zachować te kontrole i aggregate read budget.

## Decyzja kierunkowa

Publikować przyrostowo do **zarezerwowanego folderu wyników**, pod kontrolą jego właściciela. Prywatne receipty wykonania, CAS, workspace solvera i pliki robocze pozostają prywatne. Nie ujawniać API swobodnego wskaźnika na temp_dir i nie zgadywać suffixu attempt z nazwy runu.

Każda publiczna generacja wymaga wersjonowanego, atomowo zatwierdzanego manifestu. Powiązanie zawiera accepted run, task/stage, attempt/ownership epoch, output-root identity, spec fingerprint i jawny stan publikacji. Rozdzielić tożsamość całego runu od tożsamości wykonania danego etapu. Identyfikatory datasetów muszą pozostawać jednoznaczne dla różnych etapów i attemptów.

Commit próbki oznacza, że istnieją wszystkie jej chunki, współrzędna czasu/kroku i opis układu. Writer zatwierdza watermark dopiero po ich zapisie. Reader pokazuje wyłącznie zatwierdzony zakres. Metadata Zarr może być aktualizowana technicznie wcześniej, lecz nie jest samodzielnym dowodem kompletności nowej próbki. Zmiana publikacji podczas odczytu daje jawny stale revision, nigdy dane z dwóch generacji.

Geometria jest publikowana osobno od wartości. Producer nadaje per-quantity binding: dokładna ścieżka tablicy, układ składowych, space/support, topology revision i hash geometrii. Snapshot odwołuje się do tego bindingu. Nie duplikować dużej topologii dla każdej próbki ani nie wywnioskowywać zgodności z liczby węzłów.

Terminalizacja zamyka manifest jako completed/failed/cancelled i zwalnia lease według istniejących reguł. Zapisane poprawne próbki pozostają wynikami również po przerwaniu; stan nie może sugerować ukończenia symulacji. Nie nadpisywać obcego leafu, nie zmieniać ręcznie aktywnych receiptów i nie zmieniać cleanup policy użytkownika.

## Kolejność wdrożenia

1. Wersjonowany kontrakt publikacji i fixture writer/reader: niekompletny chunk, brak współrzędnej, atomowy commit, stale revision, zmiana właściciela. Bez zmian solvera.
2. Właściciel accepted storage udostępnia ograniczony writer publicznego outputu w swoim zarezerwowanym leafie. Finalizacja nie kopiuje powtórnie opublikowanych chunków i nie zmienia reguł prywatnego scratch. Testy failed/cancelled i ochrony istniejących danych są obowiązkowe.
3. Runner autosave używa powyższego commit boundary dla tabel i pól. FEM producer publikuje dokładne bindingi przed pierwszą wyświetlalną próbką; każda dopuszczona quantity ma własne potwierdzenie semantyki. FDM zachowuje swój jawny layout/grid.
4. Zasób bieżącego runu rozwiązuje cały zestaw zatwierdzonych etapów. Nie wybiera arbitralnie jednego leafu. Dane dużego katalogu pozostają stronicowane i przypięte do rewizji; stan publikacji jest cienkim control plane. Zmiana publicznych DTO wymaga managed OpenAPI capture/codegen.
5. Frontend prezentuje waiting/available/updating/terminal-failure, zachowuje kontekst UI przy kolejnych rewizjach, pozwala przyjąć nowy zakres próbek i wrócić do Live także przy błędzie lub opóźnieniu odczytu. Nie maskować błędu tożsamości jako oczekiwania.
6. Realny managed run FEM i FDM o wystarczającym czasie trwania, aby odebrać co najmniej trzy publikacje przed terminalizacją. Sprawdzić cały przepływ w przeglądarce, potem reopen ukończonego folderu bez sesji. Test z interceptem odpowiedzi nie zastępuje tego dowodu.

## Kryteria odbioru

| Kontrakt | Wymagany dowód |
|---|---|
| Autosave podczas runu | Co najmniej trzy rosnące watermarki, zaakceptowane przed rzeczywistym terminal receipt; zgodne run/task/attempt |
| Kompletność próbki | Fault injection między chunk, współrzędną i commit; niezatwierdzona próbka nie pojawia się jako gotowa |
| FEM/FDM i quantity | Hashe payloadów pobranych przez UI zgodne z producer output; geometry binding dla każdej prezentowanej quantity, bez fallbacku po szerokości tablicy |
| Wiele etapów | Dwa etapy i odrębne dataset identities; oba widoczne i czytelne po końcu runu, brak `publication_ambiguous` dla legalnego zestawu |
| Rewizja i interakcja | Filtr/collapse/focus, selected/displayed index i ustawienia przetrwają trzy publikacje; zmiana runu nie rebinduje starego wyboru po ścieżce |
| Wyjście z preview | Return to live podczas odczytu, przy błędzie i po końcu; późna odpowiedź nie przywraca historii ani nie mutuje modelu |
| Trwałość | Reopen folderu bez sesji, terminalizacja failed/cancelled, brak utraty zatwierdzonych próbek; prywatne receipty i cleanup policy zachowane |
| Wydajność | Katalog z wieloma etapami i długą serią, ograniczony odczyt i pamięć, brak ponownego transferu topologii na każdą klatkę |
| Integracja | Właściwe testy w przypisanej grupie, managed runtime/browser, review kontraktu i wymagane CI przed merge |

Bieżąca poprawka komunikatu waiting nie realizuje punktów 1–4. Ich status pozostaje otwarty w audycie UX; ukończenie części frontendowej nie jest deklaracją działającej przyrostowej publikacji.

## Pierwszy etap implementacji: commit pojedynczej tablicy

Nowy `ZarrAutosaveWriter` deklaruje w `.zattrs` politykę `sample_publication: "fullmag.zarr.sample_publication.v1"`. W tej samej tablicy `.fullmag-samples.json` zawiera `schema_version`, `committed_samples` i `coordinate_bytes`. Ostatnie pole wskazuje kompletny prefiks lokalnego `samples.csv` z nagłówkiem `sample,physical_time_s,accepted_step`. Każdy wiersz ma dokładnie jedną współrzędną: skończony czas SI albo dokładny `u64` kroku. Indeks próbki jest lokalny dla quantity, także przy przeplatanych zapisach różnych pól i układzie `separate`.

Writer zapisuje i synchronizuje chunk, aktualizuje fizyczny rozmiar Zarr, zapisuje indeks zgodności continuous, następnie zapisuje i synchronizuje współrzędną. Dopiero atomowa podmiana manifestu udostępnia nową próbkę. Ponowienie nieudanego append usuwa jedynie niezatwierdzony suffix indeksu lokalnego; licznik writera przesuwa się po udanym commit. Szerokość pola pozostaje stała w obrębie etapu. Jest to granica widoczności dla współbieżnego odczytu i przerwania procesu; nie jest kwalifikacją odporności systemu plików na utratę zasilania.

Reader ogranicza `shape[0]` i `sample_count` do zatwierdzonej liczby, weryfikuje pełny prefiks współrzędnych oraz uwzględnia manifest w rewizji. Niekompletny niezatwierdzony suffix pozostaje niewidoczny. Odczyt payloadu nadal sprawdza jego dokładny rozmiar, skończone wartości i niezmienioną rewizję. Brak manifestu przy zadeklarowanej polityce, osierocony manifest, nieznana wersja, liczba większa od fizycznego shape lub brak współrzędnej są błędami. Starsze tablice bez obu deklaracji zachowują dotychczasowy kontrakt.

Ten etap **nie jest manifestem własności runu** i nie zamyka punktów 2–6. Zachowuje istniejący limit metadanych i listy współrzędnych Results; długie serie nadal wymagają osobnego zakresowego indeksu. Nie wprowadza publicznych endpointów ani zmian DTO. Wynik testów i kwalifikację runtime należy odnotować w audycie po wykonaniu.
