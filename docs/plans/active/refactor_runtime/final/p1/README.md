# P1 — projekt niezależny od runtime

## Checkpoint odbioru — 21.09.2026

Cel pozostaje nieukończony, ale wcześniejsza blokada testów została usunięta jawną zgodą użytkownika. P1-A i P1-B są zaimplementowane, P1-D ma runtime-free wejścia Open dla CLI, Python binding i desktop, a P1-C ma wspólny lifecycle dokumentu New/Open/Save/Close przez fasadę API, browserowy wybór i pobieranie `.fms`, hostowy adapter Tauri Save, komendowy przycisk ikonowy do chowania Inspektora oraz zarządzany active-run reconnect z rzeczywistym FDM CPU. Produkcyjny shell zachowuje zamontowany workspace po pierwszym przygotowaniu; browserowy smoke potwierdził no-session shell, aktywny canvas WebGL oraz zachowanie tego samego workspace i canvasu po reconnect. Pozostają pełna kwalifikacja runtime/release oraz fizyczny desktopowy smoke. Zmiany pozostają lokalnie na `masterze`, HEAD `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`.

Rewalidacja bieżącego checkoutu potwierdziła P1-A/B/D po dodaniu hostowego Save: `just check-project-application` — run `a7a7f53a7c724005aac70cf2233249d6`, `passed`, source digest `526515938632d4a5e8e8457541b915117c44317e3431214acc2a0be53d78ee41`, receipt SHA-256 `EA05D98689D95F0F868B665DD89488C38643C1A51F9548F298D6A5247F9B92F9`; `just verify-project-application` — najnowszy run `d392fac4f6d145e0bcca65a6760de24b`, `passed`, 6 adapter + 13 lifecycle, source digest `b73b83ce0912582656733098dd33d3ae03dfbfd4b847a4bccde6c206f1cd7483`, receipt SHA-256 `4F116B23580BBBFEAE0250EE6F6DDDF56281D393B0FDBACAEC8EC0D23475F10C`; `just check-project-entrypoints` — run `7e7c87be6a3944b39216878ec339e20c`, `passed`, source digest `5c2967a2377c28bb21a38b70c64488a7769bb75893085bc22630bfc428f5d6dc`, receipt SHA-256 `58275c084a26379f630548e79bf9ed3065854016d64aa136d75619937aa92077`, log SHA-256 `1493f715c4e2cab7bd2e190d9aab6dafc1223aeb1e8ccacc76883dbfa719bc8c`; `just verify-project-entrypoint-runtime` — run `2ce7713c5bbe4bd3a2e924ea3e10ee26`, `passed`, source digest `06477452252f034e1da35e47e00e85eda1c58802e0fb7623431310d0b2559574`, receipt SHA-256 `871dd7e68bd3b2a75b5c6aa8ad4fef88aaf0d0fdde055e8baf152d240b9f1826`; `just verify-project-python-runtime` — run `ebacc9507bf34e21a7de7a66bc13d1aa`, `passed`, source digest `c48cfa0459f59d3243a382c1ab61d15b59ec758dccc11b7585dc46a610003654`, receipt SHA-256 `8ce9ff04553ae8a8b192292110f25aeb52034e534d82533f447c2870b078a90a`. Wszystkie pięć receipt’ów mają `source_changed_during_run=false`.

Granica API/UI również jest aktualna: `cargo check --locked -p fullmag-api --offline` zakończył się exit 0 (ostrzeżenia `dead_code`/`unused`, bez błędu), a najnowsza ukierunkowana macierz kontrolera projektu, komend, menu i InspectorShell przeszła **4 pliki, 26 testów, 0 błędów**. Wcześniejsze przebiegi obejmowały 4 pliki/25 testów oraz 2 pliki/13 testów po dodaniu mostu hostowego. `pnpm --dir apps/control-room typecheck`, ESLint, `check:api-hygiene`, `check:architecture-hygiene` i kontrola spójności repozytorium są zielone. Zarządzana recepta `just verify-project-api-runtime` ma najnowszy receipt `passed`, wiąże `/v2/platform/openapi.json` z aktualnym source snapshotem, zatrzymuje i ponownie uruchamia API oraz otwiera te same bytes z tym samym `ProjectId`, bez mutacji runtime. Osobna `just verify-project-realtime-runtime` przeszła z pustą sesją scratch, handshake `fullmag.live.v1` i reconnectem `after_seq`; dowód opisano w [managed smoke WebSocket](05-realtime-ws-smoke.md). To są mocniejsze dowody lifecycle projektu i transportu, nadal nie pełna rekonsyliacja aktywnego runtime ani fizyczny smoke Tauri.

Kontrakt transportowego reconnectu jest teraz jawny w źródle: `RealtimeClient` wywołuje `onReconnected` dopiero po ponownym połączeniu wcześniej ustanowionego socketu, a `RealtimeInvalidationBridge.handleReconnect()` wymusza odświeżenie `session:status` i zasobów bieżącej sesji przez HTTP. Ukierunkowane testy realtime i kontrolera invalidacji przeszły **3 pliki, 75 testów, 0 błędów**; regresja sprawdza również zasoby aktywnego runu (`run`, `stages`, `solver`, `commands`) przez prefiks bieżącej sesji. Zarządzana recepta active-run potwierdziła następnie ten sam `session_id` i `run_id`, stan solvera `running`, dostępność HTTP i niemalejące rewizje po kontrolowanym zerwaniu oraz reconnect z `after_seq`. Browserowy smoke potwierdził dodatkowo ten sam węzeł workspace i canvas WebGL; pozostaje pełna session-recovery.

Szacunek postępu dotyczy zakresu planu, a nie gotowości wydania: **P0 — około 85%** (minimalna bramka przejścia do P1: 100%; otwarte power-loss, inne platformy, baseline naukowy i release), **P1 — około 98%** (A/B wykonane, D ma kompilację wszystkich wejść oraz zarządzane smoke CLI/Python, C obejmuje UI New/Open/Save/Close, hostowy Tauri adapter, runtime-free API, kontrolowany reconnect lifecycle projektu, managed transport WebSocket na pustej sesji, managed active-run reconnect FDM CPU oraz browserowy dowód zachowania workspace/canvas po reconnect; otwarte fizyczny desktop smoke, runtime Tauri, pełna session-recovery, nauka i release).

Data rozpoczęcia: 20.09.2026. Autoryzacja: „ok wykonaj to co niezbedne i przejdz do p1”; praca na `masterze`. [Minimalna bramka P0](../p0/05-minimal-gate.md) przeszła na lokalnym Windows. Pełny zakres P1 pozostaje w [planie](../03-plan-refaktoryzacji.md#5-p1--pierwszy-pionowy-przekrój-projektu-bez-solvera).

## Pierwszy zakres implementacji

1. P1-A: `fullmag-application` — agregat projektu, port repozytorium oraz Create/Open/Save/Save As/Close bez zależności od runtime, HTTP, meshera i solvera. Jawne konflikty rewizji, dirty state i ochrona przed nieuzgodnionym zamknięciem aktywnego wykonania.
2. P1-B: `FileProjectRepository` — wersjonowane archiwum `.fms`, bezpieczne skanowanie ZIP, atomowa publikacja i lock writera, migracja legacy sesji, zachowanie raw JSON/assetów/dokumentów oraz read-only dla nieznanego schematu. Oryginał migracji pozostaje niezmieniony.
3. P1-C: utrzymanie już otwartej powłoki podczas kolejnego przygotowania lub rozłączenia, z inert dla paneli i pojedynczą instancją diagnostyki. `WorkspaceShellClient` włącza `preserveMountedWorkspace` po pierwszym zamontowaniu powłoki. `ProjectDocumentController` prowadzi New/Open/Save/Close przez `ControlRoomApi.persistence.projects`, wybiera plik `.fms`, pobiera bytes-only archiwum i raportuje lokalny błąd/status; Close wymaga decyzji o odrzuceniu dirty state i nie dotyka runtime. Nie wywołuje Restore runtime ani solve. No-session `EmptyWorkspace` pokazuje te same akcje projektu bez montowania runtime. Inspector ma ikonę `PanelRightClose`, która wywołuje wspólną komendę `panels:inspector:toggle` i zmienia `panelVisible.right`; przywrócenie pozostaje dostępne z ribbon/menu Panels. Kolekcja sesji zachowuje potwierdzone dane przy błędzie odświeżenia. Ochrona ribbon/status i otwartych portali jest objęta testami źródłowymi.
4. P1-D: CLI `project open`, Python `_fullmag_core.open_project_json` i desktopowe `open_project_path`/dialog używają `ProjectApplication<FileProjectRepository>`. Operacja zwraca migrację i tryb read-only, nie uruchamia Restore runtime ani solve. Dodatkowy managed smoke uruchamia zbudowane CLI na rzeczywistym `.fms` i sprawdza tę granicę w procesie.

Dodano `crates/fullmag-application` do Cargo workspace i lockfile. Warstwa lifecycle pozostaje bez zależności od authoring runtime, runnera, silników ani API; zależność ZIP/SHA-256 jest zamknięta w adapterze plikowym. Zawiera agregat dokumentu z raw JSON, port repozytorium, use cases, writer `.fms` i regresje z repozytorium pamięciowym oraz plikowym. **Kompilacja biblioteki i managed testy przeszły**; testy obejmują **6 scenariuszy adaptera plikowego oraz 13 scenariuszy lifecycle**.

Polecenia New/Open/Save/Close są podłączone do wspólnego lifecycle dokumentu w powłoce. Bytes-only API resource facade działa przez `POST /v2/persistence/projects` i `POST /v2/persistence/projects/open`, z wygenerowanym OpenAPI/TypeScript oraz fasadą `ControlRoomApi.persistence.projects`; nie publikuje ono celu plikowego ani runtime. W przeglądarce Open/Save pozostaje adapterem wyboru/pobrania pliku, Close odłącza dokument po potwierdzeniu dirty state, natomiast Tauri korzysta z `open_project_archive_dialog` i `save_project_archive`, które walidują archiwum przez `ProjectApplication<FileProjectRepository>`, używają atomowego writeru i wymagają zgodnych ProjectId/revision dla istniejącego celu. Zachowanie utrzymania zamontowanej powłoki jest włączone w produkcyjnym shellu, a komenda Inspektora korzysta z tego samego layout controller/ribbon/menu. **P1 jest rozpoczęty, nie ukończony.**

## Niezmienne granice

- ProjectId nie jest SessionId, scene.id ani identyfikatorem build/storage/worktree.
- OpenDocument czyta dokument. Nie uruchamia skryptu Python, meshera, Compute ani RestoreRuntime.
- Wersjonowany agregat jest jedyną zapisywalną definicją projektu. Raw scene.v2 zachowuje nieznane pola; typed projection nie może przez serializację skasować rozszerzeń, obrotu lub skali.
- Zapis wymaga oczekiwanej rewizji i jednego writera. Po błędzie aktywny dokument pozostaje dirty; nie wolno raportować zapisu bez potwierdzenia repozytorium.
- Save As tworzy niezależną tożsamość. Źródłowy dokument migracji pozostaje niezmieniony.
- Nieznana wersja pozostaje read-only; nie trafia do starszego writera. Nieznane pola w obsługiwanej wersji i assety mają przechodzić roundtrip bez utraty.
- Close nie anuluje runu w tle. Aktywne wykonanie wymaga jawnej polityki; domyślna odmowa jest poprawnym wynikiem pierwszego zakresu.
- Port repozytorium nie przyznaje gwarancji power-loss. Adapter dyskowy musi raportować rzeczywiste gwarancje P0.

## Stan hostowego Save

Hostowy zapis został podłączony w wąskim, bezpiecznym pionowym przekroju. `ProjectApplication::save_detached` publikuje pierwszy zapis z bytes-only dokumentu jako create-only; istniejący cel przechodzi przez ten sam `FileProjectRepository`, kontrolę symlink/reparse point, ProjectId, bazową rewizję i atomowy `.part` → rename. `apps/desktop/src-tauri` udostępnia `open_project_archive_dialog` i `save_project_archive`, a `ProjectDocumentController` wybiera most przez `window.__TAURI__.core.invoke`; po sukcesie synchronizuje hostPath, ProjectId, revision/persisted_revision, source hash i `dirty`. Web pozostaje bez arbitralnych ścieżek filesystemu. Receipt zwraca rzeczywistą klasę durability i nie podnosi `power_loss_qualified` na Windows.

Dowody bieżącego checkoutu: `cargo test --locked -p fullmag-application --offline` — **6 testów adaptera + 13 lifecycle, 0 błędów**; `cargo test --locked -p fullmag-desktop --offline` — **4 testy, 0 błędów** (create-only Save, stale revision, existing-target replacement i sidecar); wcześniejszy test kontrolera i komend — **2 pliki, 13 testów, 0 błędów**; najnowsza macierz obejmująca także menu i InspectorShell — **4 pliki, 26 testów, 0 błędów**; `pnpm --dir apps/control-room typecheck` i ESLint zmienionych plików — **PASS**. `withGlobalTauri` jest jawnie włączone w konfiguracji desktopu. Nie wykonano jeszcze interakcji w zbudowanym oknie Tauri, więc physical desktop smoke pozostaje `NOT VERIFIED`.

Kontrolny build debug `cargo build --locked -p fullmag-desktop --offline` zakończył się `PASS` i utworzył binarium `fullmag-ui`. Próba wybrania jego okna przez automatyzację Windows nie uzyskała zgody w czasie limitu; proces został zakończony, a wynik nie jest używany jako dowód interakcji. Brakujący gate pozostaje jawnie `NOT VERIFIED`.

Ponowna próba uruchomiła portowy dev-server Control Room i binarium `fullmag-ui`; proces desktopu miał aktywny uchwyt okna, ale bieżąca warstwa automatyzacji nie zwróciła tego okna w inventory aplikacji. Po zatrzymaniu obu procesów nie ma dowodu kliknięcia ani odczytu UI Tauri, więc physical desktop smoke nadal pozostaje `NOT VERIFIED`.

Rewalidacja 21.09.2026 przez bieżący helper automatyzacji Windows zwróciła `apps=[]`; nie było aktualnego, jednoznacznego uchwytu okna Tauri, więc nie wykonano kliknięcia ani nie użyto starych współrzędnych. To potwierdza brak dowodu hostowej interakcji, a nie awarię samego kontraktu komend.

Najświeższa rewalidacja ścieżki ikony Inspektora, hostowego Save i Close Project: `pnpm --dir apps/control-room test -- --run src/kernel/persistence/ProjectDocumentController.test.ts src/kernel/layout/shellCommands.test.ts src/kernel/layout/AppMenuBar.test.ts src/modules/inspector/InspectorShell.test.ts` — **4 pliki, 26 testów, 0 błędów**. Test potwierdza ikonę `PanelRightClose`, wspólną komendę `panels:inspector:toggle`, menu Close Project oraz synchronizację rewizji po zapisie przez Tauri.

Wykonawczy Playwright smoke `pnpm --dir apps/control-room smoke:inspector` na lokalnym Next.js zakończył się **exit 0**, a rewalidacja 21.09.2026 powtórzyła ten wynik na `http://localhost:3100/workspace`. Raport zawiera `inspectorPanelToggle: verified; header icon and ribbon restore`, zachowanie/powiększenie viewportu, `previewRequests: 0` i zieloną macierz stabilności mutacji. Jedyny zliczony błąd konsoli to oczekiwany pojedynczy `409 Conflict` w scenariuszu dirty-selection; wszystkie nieoczekiwane błędy zostały odrzucone. Szczegóły są w [browserowym smoke](02-browser-smoke-inspector.md); jest to dowód browserowy, nie managed receipt ani kwalifikacja release.

Osobny Playwright smoke `pnpm --dir apps/control-room smoke:project-lifecycle` zakończył się **exit 0** i potwierdził `New → Open → Save → Close` bez sesji: `untitled-project.fms`, `roundtrip.fms`, `close_project: verified`, `open_archive_bytes: 4` oraz `forbidden_runtime_requests: []`. Pełny zapis znajduje się w [smoke lifecycle projektu](04-browser-smoke-project-lifecycle.md).

Managed smoke `just verify-project-realtime-runtime` zakończył się **state=passed**. Na pustej sesji scratch probe odebrał `hello` z `fullmag.live.v1`, zamknął socket, połączył się ponownie z `after_seq=1` i potwierdził ten sam `session_id`; szczegółowy receipt i granice dowodu są w [managed smoke WebSocket](05-realtime-ws-smoke.md).

Osobny lokalny probe rzeczywistego FDM CPU wykonał aktywny `flat_relax`,
zerwał WebSocket i połączył się z `after_seq=141`. Ten sam `session_id` i
`run_id` przetrwały reconnect, solver pozostał `running`, a licznik kroków
wzrósł `4000 → 4050`; endpointy run/stages/solver/commands pozostały
dostępne. Jest to historia diagnostyczna opisana w
[diagnostyce active-run reconnect](06-active-run-reconnect-diagnostic.md).

Następnie `just verify-project-active-run-runtime` zakończyło się
`state=passed` na zarządzanej trasie Windows. Receipt runu
`96725388626d45a6b475a56b3a97ba7a` potwierdza source snapshot
`1b53c128203d6402ff89c4e44946a20bf31d97a5792084511ddb968c7db59a8c`,
`same_session=true`, `same_run=true`, `solver_continued=true`, dostępność
HTTP oraz niemalejące rewizje po zerwaniu i reconnect z `after_seq=12`.
Szczegółowy zapis i SHA-256 receiptu są w [zarządzanym active-run smoke](07-active-run-reconnect-managed.md).
Dowód backendowy nie obejmuje fizycznego Tauri. Browserowa część CAE-41 jest
potwierdzona osobnym smoke opisanym niżej; pełna session-recovery pozostaje
`NOT VERIFIED`.

Niezależny browserowy smoke na aktywnej sesji Control Room wykonał następnie
`New Project → Save Project → Open Project → Save Project → Close Project`
przez rzeczywiste menu `File` i file chooser. Oba pobrane archiwa miały te same
942 bajty (`untitled-project.fms` → `roundtrip.fms`), stan końcowy był `No
project`, a lista mutacji solvera/runtime pozostała pusta. Jedynymi zapisami
API były `POST /v2/persistence/projects` i
`POST /v2/persistence/projects/open`; oczekiwane 404 zasobów bezczynnej sesji
są sklasyfikowane jawnie w raporcie. Skrypt i wynik są w
[browserowym smoke lifecycle aktywnej sesji](08-browser-lifecycle-runtime.md).
To rozszerza dowód P1-C poza no-session shell, ale nadal nie zastępuje
fizycznego smoke Tauri ani pełnej session-recovery.

Osobny smoke `pnpm --dir apps/control-room smoke:mounted-workspace-reconnect`
domknął browserową część CAE-41. Kontrolowane zamknięcie pierwszego socketu
po `hello` doprowadziło do drugiego socketu z `after_seq=14`; `session_id`
pozostał ten sam, a element `#fm-main-content` i canvas WebGL zachowały tę
samą tożsamość DOM. Bufor canvasu pozostał `703×478`, `contextLost=false`.
Szczegółowy raport jest w
[browserowym smoke reconnectu](09-browser-mounted-workspace-reconnect.md).
Nie zastępuje to fizycznego Tauri ani trwałej recovery po awarii procesu.

## Bramka następnego zakresu

Po tym checkpointcie pozostają fizyczny desktop smoke, runtime Tauri, scenariusz pełnej session-recovery oraz nauka/release. Managed transport WebSocket na pustej sesji i managed active-run są pokryte osobnymi receiptami, a źródłowy reconnect guard wymusza ponowne pobranie stanu HTTP; żaden z tych dowodów nie zastępuje trwałego odtworzenia runtime po awarii procesu. Adapter plikowy ma osobne regresje roundtrip, migracji, stale revision, create-only writer conflict i unsafe archive path; hostowy most i runtime-free API mają testy Rust/TS oraz managed receipt, ale nie zastępują pełnej kwalifikacji runtime ani power-loss.

Read-only probe `GET http://localhost:8081/v2/sessions/current/persistence/recovery` zwrócił `200` i `{"snapshots":[]}`. Dodatkowo najnowsze `just verify-project-api-runtime` (run `62b8f2e3f5bf4678aeb36895921b752a`) zbudowało binarium z przypiętym source snapshotem, wykonało `health → build identity → New/Open → recovery`, kontrolowanie zakończyło proces, uruchomiło go ponownie i ponowiło Open tych samych bytes; receipt ma `state=passed`, `source_changed_during_run=false`, ten sam `ProjectId` po reconnect oraz `runtime_mutations=[]`. Nie dowodzi to scenariusza utraty połączenia WebSocket, rekonsyliacji aktywnego runu ani przywrócenia runtime; te bramki pozostają `NOT VERIFIED`.

Pełniejszy zapis scenariusza `create → open → stop → restart → open → recovery` znajduje się w [smoke runtime-free API](03-api-runtime-smoke.md). Zarządzany wynik zachował ten sam `ProjectId`, rewizję `0`, tryb `read_write` i `dirty=false` po obu Open; jego receipt wskazuje source snapshot `14ef2051a2e97d7fac63a78fe075a31798fcbc69950bb5bc84936fb6f1aad81f` oraz binary SHA-256 `e51ca97aba4405a5a6f1d7af34755ab075acd0f28385607412b4c851871a7811`.

Testy P0 nie zastępują testów P1. Pierwsza próba Vitest została odrzucona przez automatyczny przegląd z powodu wcześniejszego zakazu; po jawnej zgodzie użytkownika testy uruchomiono poza sandboxem. Nie uruchamiano pełnych testów solverów ani operacji GC na danych użytkownika.

## Dowód kompilacji pierwszego zakresu P1-A

- Recepta: `just check-project-application` → dokładnie `cargo check --locked -p fullmag-application --lib`; najnowszy run `a7a7f53a7c724005aac70cf2233249d6` ma stan `passed`, exit 0 i `source_changed_during_run=false`.
- Receipt względem skonfigurowanego storage: `builds/fullmag-0950f4dca4ffe38f/windows-application-check/project-application-check/a7a7f53a7c724005aac70cf2233249d6/receipt.json`; SHA-256 receiptu `EA05D98689D95F0F868B665DD89488C38643C1A51F9548F298D6A5247F9B92F9`, źródła `526515938632d4a5e8e8457541b915117c44317e3431214acc2a0be53d78ee41`, logu `6DECABE57C225B84A43280915EE195F6726B6CCDCE3A1C844DEB8D44D63D32EF`.
- Aktualny test zachowania: `just verify-project-application` → run `d392fac4f6d145e0bcca65a6760de24b`; receipt state `passed`, **6 file-adapter tests + 13 lifecycle tests, 0 failed, 0 ignored**, `source_changed_during_run=false`. Fixture plikowego roundtripu zawiera niekompletną bryłę bez materiału, obrót, skalę oraz nieznane pole obiektu; dodatkowa regresja drugiego writera potwierdza odrzucenie przed publikacją i zachowanie poprzedniego pliku. Receipt SHA-256 `4F116B23580BBBFEAE0250EE6F6DDDF56281D393B0FDBACAEC8EC0D23475F10C`, log SHA-256 `19A42D513A29FB87FB9004C0BC20EB63801F160F3686D0B7A6CFDCA0446FF17`.
- Wcześniejsze receipty pozostają zachowane jako historia iteracji; poprawki inicjalizatorów `expected_project_id`, create-only host Save i usunięcie nieużywanego typu zostały już włączone do aktualnej kontroli.

Przegląd kodu objął walidację ProjectId podczas deserializacji, nieznane wersje projektu/sceny jako read-only, create-only dla nowego celu, dopasowanie tożsamości i rewizji istniejącego dokumentu, odmowę zmiany celu zwykłym Save, weryfikację odpowiedzi repozytorium i zachowanie dirty state po błędzie. Zarządzany receipt potwierdza wykonanie wszystkich **19 regresji aplikacyjnych**: 6 file-adapter i 13 lifecycle.

## Stan P1-B — adapter plikowy

`FileProjectRepository` zapisuje aktualny agregat jako ZIP `.fms` z manifestem, raw `project/definition.json`, raw `project/scene_document.json`, źródłem, assetami i dokumentami nieznanymi. Odczyt odrzuca traversal, ścieżki Windows, case-fold collisions, symlinki, katalogi ZIP oraz przekroczenie limitów. `encode_archive` udostępnia ten sam walidowany codec jako operację bytes-only dla przyszłych adapterów HTTP/desktop/download; nie publikuje celu ani nie przyznaje gwarancji trwałości. Publikacja używa create-new locka writera, pliku `.part`, `sync_all` i atomowego rename; receipt trwałości nie udaje power-loss qualification na Windows.

Legacy `manifest/session.json` + `manifest/workspace.json` jest migrowane do nowej tożsamości projektu. Oryginalne bajty pozostają niezmienione, a pozostałe wpisy są zachowane pod `project/legacy/`. Nieznany bieżący schema otwiera się read-only i nie przechodzi do writera.

- `just check-project-application`: run `a7a7f53a7c724005aac70cf2233249d6`, state `passed`, source SHA-256 `526515938632d4a5e8e8457541b915117c44317e3431214acc2a0be53d78ee41`, receipt SHA-256 `EA05D98689D95F0F868B665DD89488C38643C1A51F9548F298D6A5247F9B92F9`, log SHA-256 `6DECABE57C225B84A43280915EE195F6726B6CCDCE3A1C844DEB8D44D63D32EF`, `source_changed_during_run=false`.
- `just verify-project-application`: najnowszy run `d392fac4f6d145e0bcca65a6760de24b`, state `passed`, **6 file-adapter tests + 13 lifecycle tests, 0 failed, 0 ignored**, source SHA-256 `b73b83ce0912582656733098dd33d3ae03dfbfd4b847a4bccde6c206f1cd7483`, receipt SHA-256 `4F116B23580BBBFEAE0250EE6F6DDDF56281D393B0FDBACAEC8EC0D23475F10C`, log SHA-256 `19A42D513A29FB87FB9004C0BC20EB63801F160F3686D0B7A6CFDCA0446FF17`, `source_changed_during_run=false`.

## Stan P1-D — wspólne wejścia Open

CLI `fullmag project open`, Python `_fullmag_core.open_project_json` i desktopowe komendy Tauri używają tego samego `ProjectApplication<FileProjectRepository>`. `Session Open` pozostaje osobnym, jawnym Restore runtime i nie jest aliasem projektu. Managed route `just check-project-entrypoints` obejmujący CLI, Python binding i desktop przeszedł: run `7e7c87be6a3944b39216878ec339e20c`, source SHA-256 `5c2967a2377c28bb21a38b70c64488a7769bb75893085bc22630bfc428f5d6dc`, receipt SHA-256 `58275c084a26379f630548e79bf9ed3065854016d64aa136d75619937aa92077`, log SHA-256 `1493f715c4e2cab7bd2e190d9aab6dafc1223aeb1e8ccacc76883dbfa719bc8c`, `source_changed_during_run=false`.

Niezależna trasa `just verify-project-entrypoint-runtime` wykonała rzeczywisty `fullmag project open <fixture.fms>` na zarządzanym binarium Windows: run `2ce7713c5bbe4bd3a2e924ea3e10ee26`, receipt SHA-256 `871dd7e68bd3b2a75b5c6aa8ad4fef88aaf0d0fdde055e8baf152d240b9f1826`, binary SHA-256 `239aed14ff193bd6f61cdbbed9b96cc7a23ae37decb6d29dcf32bd35ea4bf0bc`, fixture SHA-256 `c7f0bfc4690d1b10ac188ce5a043020182ea244f5adecf561632f0d0bd820db7`. CLI zwrócił `operation=open_project`, `project_id=project-cli-entrypoint`, `dirty=false`, `mode=read_write`, `runtime=untouched`, `migration.migrated=false`, exit 0; `source_changed_during_run=false`. Startup stamp jest tolerowany jako provenance poprzedzający JSON.

Niezależna trasa `just verify-project-python-runtime` zbudowała moduł PyO3 `_fullmag_core` i zaimportowała go przez `C:\Users\Mateusz\miniconda3\python.exe`: run `ebacc9507bf34e21a7de7a66bc13d1aa`, receipt SHA-256 `8ce9ff04553ae8a8b192292110f25aeb52034e534d82533f447c2870b078a90a`, extension SHA-256 `703264cc54d0ad9875948076e1d69105f5a1e8b2c6c20fa5c0a0d3f332b4592b`, fixture SHA-256 `118f2e68d75ee1cc9a434b9a202bb5c0af981b1af8f83d1dfa337b8faee7fb16`. Python `_fullmag_core.open_project_json` zwrócił `operation=open_project`, `project_id=project-python-entrypoint`, `dirty=false`, `mode=read_write`, `runtime=untouched`, exit 0; `source_changed_during_run=false`. To jest dowód procesu Python i wspólnego adaptera, ale nie fizycznego mostu Tauri.

Dalszy review wykrył ryzyko przepięcia znacznika aktywnego wykonania przy Save As. Pierwszy zakres odmawia takiej operacji do zakończenia wykonania; nie anuluje runu. `finish_execution(expected_run_id)` usuwa wyłącznie właściwy znacznik, a próba podmiany już aktywnego runu jest odrzucana. Dodano dwa źródłowe scenariusze regresji: brak zapisu i zmiany dokumentu po odmowie Save As oraz odrzucenie spóźnionego zakończenia innego runu. Poprzedni zielony run `f8af45c473ab4b3c9cfea7bbcea69d13` pozostaje historyczny; aktualną bibliotekę obejmuje kontrola powyżej.

## Stan wariantu P1-C

Bytes-only adapter API przeszedł `cargo check --locked -p fullmag-api --offline` oraz dwa kontraktowe testy routera (create/open bez mutacji runtime i odrzucenie niepoprawnego Base64: **2/2**). Regeneracja `openapi-v2.json`, typów i klienta zakończyła się powodzeniem; kontrakt fasady ma **12/12** testów, a `pnpm --dir apps/control-room typecheck` i ukierunkowany ESLint są zielone. `ControlRoomApi.persistence.projects.create/open` używa wyłącznie wygenerowanego transportu; nie powstał drugi writer ani alias do session restore. Ten fragment nie jest jeszcze dowodem browser/API runtime.

Najnowsze wykonanie `cargo test --locked -p fullmag-api project_document_transport --offline` na bieżącym checkoutu zakończyło się **2 passed, 0 failed**: utworzenie i ponowne otwarcie archiwum bez mutacji runtime oraz odmowa niepoprawnego Base64 przed otwarciem aplikacji. Jest to ukierunkowany dowód routera v2; nie zastępuje managed runtime API/session-recovery.

Źródła: `ProjectDocumentController.ts`, `ProjectDocumentStatus.tsx`, `shellCommands.ts`, `SimulationStartupOverlay.tsx`, `WorkspaceDockLayout.tsx`, style startup/header, fixture DOM i testy kontrolera/komend. Historyczna ukierunkowana trasa Vitest przeszła przez ready → blocked → ready, tożsamość węzła, pojedynczy diagnostics slot, inert paneli, failure-dialog oraz bytes-only New/Open/Save: **8 plików, 163 testy, 0 błędów**. W trakcie naprawiono brakujące API `getAttributeNames` fixture’a oraz zagnieżdżoną rolę dialogu; ten przebieg pozostaje zielonym dowodem wcześniejszego zakresu.

`pnpm --dir apps/control-room typecheck`: **PASS, exit 0** po włączeniu `preserveMountedWorkspace` i `ProjectDocumentController`. Ukierunkowany ESLint dla zmienionych plików: **PASS**. Wcześniejszy szerszy run obejmujący lifecycle projektu, menu Open/Restore, startup gate, overlay/dock, kolekcję sesji i ribbon: **8 plików, 163 testy, 0 błędów**; wcześniejsza rewalidacja kontrolera i komend projektu po dodaniu hostowego Open/Save miała **2 pliki, 13 testów, 0 błędów**. Najnowsza rewalidacja po dodaniu Close Project i potwierdzenia dirty state objęła kontroler, komendy, menu oraz InspectorShell: **4 pliki, 26 testów, 0 błędów**. `resolveSessionCollectionResourceState` zachowuje potwierdzoną kolekcję przy błędzie odświeżenia, więc aktywna powłoka nie jest z tego powodu odmontowywana; początkowy błąd bez danych nadal pozostaje osobnym stanem. `WorkspaceShellClient` włącza zachowanie po pierwszym przygotowaniu, a `Ctrl+O` nie uruchamia już runtime restore: „Open Project”, „New Project” i „Save Project” używają kontrolera dokumentu, natomiast „Restore Runtime State” ma osobny `Ctrl+Shift+O`. Naprawa fixture’a hydracji usunęła wcześniejszy `diffHydratedProperties`; końcowy test shella przechodzi bez unhandled errors. Testy Inspektora, stylów i wspólnej komendy paneli: **3 pliki, 17 testów, 0 błędów**.

`pnpm --dir apps/control-room check:api-hygiene`: **PASS, exit 0** po przeniesieniu dwóch grup testowych viewportu na `DATA_FIELD_VECTOR_PATH`; projektowy lifecycle nie dodaje bezpośredniego transportu ani literalnych ścieżek v2.

`pnpm --dir apps/control-room check:architecture-hygiene`: **PASS, exit 0**; kontroler dokumentu pozostaje w kernelowej warstwie persistence, a moduły nie zyskały własnych endpointów.

Końcowa rewalidacja po zmianie Inspektora i korekcie layoutu: `python scripts/check_repo_consistency.py`, `pnpm --dir apps/control-room check:api-hygiene`, `pnpm --dir apps/control-room check:architecture-hygiene` oraz `cargo check --locked -p fullmag-desktop --offline` zakończyły się **PASS, exit 0**. Sprawdzenie `git diff --check` dla zmienionych źródeł i dokumentów nie wykazało błędów whitespace; ostrzeżenia dotyczą wyłącznie normalizacji LF→CRLF przez Git na Windows.

Po korekcie `WorkspaceDockLayout` zapis layoutu został przeniesiony z funkcji updatera stanu do kontrolowanego `useEffect`. `pnpm exec react-doctor --verbose --scope changed` zakończył się **92/100, 10 issue** (wcześniej 91/100, 11 issue); zniknęło ostrzeżenie `no-side-effect-in-state-updater-function`. Pozostały ostrzeżenia dotyczące istniejącego odczytu browser global w `ControlRoomApi`, celowych eksportów helperów z `SimulationStartupOverlay` oraz chained iterations w niepowiązanym fragmencie viewportu. Nie zmieniano konfiguracji ani nie wyciszano tych reguł.

Po tej korekcie ponowiona macierz P1-C obejmująca API/OpenAPI, kontroler projektu, shell, startup overlay/dock i kolekcję sesji przeszła: **8 plików, 63 testy, 0 błędów**. Wcześniejszy szerszy run 8 plików/163 testów pozostaje dowodem poprzedniego zakresu; bieżący run jest dowodem wpływu korekty layoutu.

Po tej zmianie regresja viewportu (`viewport3dResources.test.ts` i `useViewport3DSceneModel.test.ts`) ma **2 pliki, 215 testów, 0 błędów**. Lokalny structured-grid target nie dziedziczy już `renderingState` przez globalny fallback; używa scoped settings z własnego targetu.

Krótki smoke w przeglądarce na lokalnym Next.js i backendzie v2 potwierdził render nagłówka workspace, menu, jawny stan `No project`, utworzenie `Untitled project · unsaved` oraz aktywację Save. Po utworzeniu pustej sesji aktywny workspace pokazał canvas `376x487`; CDP odczytał `webgl2`, drawing buffer `[376,487]`, `lost=false` i 30 klatek. Pusty backendowy scenariusz zwrócił brak preparation dla nieprzygotowanej sesji, więc nie jest to dowód solvera ani kwalifikacji runtime. Wbudowany browser nie wyemitował osobnego zdarzenia pobrania blobu; zapis bytes-only pozostaje potwierdzony testem kontrolera.

Zmiana UI Inspektora jest command-backed: `InspectorShell` renderuje ikonę `PanelRightClose` z `aria-label="Hide Inspector"`, a `InspectorModule` uruchamia `panels:inspector:toggle` z `sourceDetail="inspector-header"`. Zamykanie i ponowne otwieranie korzystają z istniejącego `LayoutController.panelVisible.right` oraz przycisku ribbon/menu Panels; nie powstał lokalny stan ani osobny endpoint.

Najnowszy browserowy smoke na `http://localhost:3104/workspace` wykonał pełny cykl UI: początkowy `panel-right` z przyciskiem `Hide Inspector`, kliknięcie ikony usunęło panel i poszerzyło viewport, menu `Panel` raportowało `Inspector = 0`, a pozycja `Inspector` przywróciła panel z `Inspector = 1`. Jest to dowód interakcji powłoki i layoutu; nie jest dowodem runtime solvera ani kwalifikacji wydania.

Szczegółowy zapis tego przebiegu znajduje się w [browserowym smoke](02-browser-smoke-inspector.md).

Pierwsze polecenie Vitest zakończyło się EPERM przy odczycie `vitest.mjs`, a automatyczny przegląd odrzucił eskalację przy braku jawnej zgody. Po zgodzie użytkownika testy ukierunkowane uruchomiono poza sandboxem. `react-doctor`, pełna macierz runtime i kwalifikacja release pozostają **NOT VERIFIED**.
