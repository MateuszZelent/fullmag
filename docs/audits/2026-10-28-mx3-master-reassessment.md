# MX3 — ponowna ocena aktualnego mastera, 28.10.2026

> Stan początkowy z 28.10.2026. Późniejszy [odbiór CoFeB z 29.10](2026-10-29-cofeb-master-runtime-result.md) potwierdza działający master,10 iteracji GPU i pola; poniższe obserwacje zatrzymanych kontenerów są historyczne.

## Wynik

Nie należy ponownie wykonywać całego planu F0–F12 z 19–21 października. Wiele
opisanych tam braków ma już implementację i nowszych właścicieli. Pozostaje
jedna potwierdzona w tym przeglądzie usterka geometrii, ograniczenia publikacji
pól oraz sześć bloków domknięcia opisanych w §6. Nie jest to pełny nowy licznik
wszystkich usterek produktu.

**Aktualny master nie jest teraz uruchomiony:** oba kontenery są zatrzymane,
port 3198 odmawia połączenia. Zachowany pakiet backendu nie odpowiada obecnemu
HEAD. Nie można potwierdzić aktualnej wizualizacji samym starym screenshotem,
testem źródeł lub receiptem `ready` zatrzymanego procesu.

## 1. Zakres, źródła i granice

- Checkout: `/home/kkingstoun/git/fullmag/fullmag`, branch `master`, HEAD
  `3ffd6896a45109f881ae1dd072107727cf5d5d15`.
- Baza późniejszej części wątku: `ae8e570f2aa9655cb9fd8321c716b8d49a87e084`;
  `git rev-list <baza>..HEAD --count` zwraca **618**. Nie oznacza to 618 napraw.
- Lokalny ref `origin/master` wskazuje ten sam HEAD. Nie wykonano fetch/pull
  ani sprawdzenia stanu serwera, więc nie jest to niezależny dowód świeżości remote.
- Zastana zmiana submodułu `external_solvers/3` zachowana. Brak unmerged
  entries i zmian staged w odczycie początkowym; brak zapisów do indeksu/refów Git.
  `git status --short` zgłasza brak dostępu do pięciu katalogów `.fullmag-tmp`;
  ich zawartości nie oceniano i nie zmieniano uprawnień.
- Odczytano wybrane stare zgłoszenia, nowsze plany, źródła backendu/frontendu,
  Docker inspect/logs i dwa zachowane dokumenty z zatrzymanego kontenera.
  To ponowna ocena zakresu wątku, nie pełny audyt każdego ID z MX3.
- **Nie uruchamiano testów, buildów, symulacji, przeglądarki, restartu ani recovery.**
  Zmieniono wyłącznie dokumentację. Brak nowej kwalifikacji numerycznej.
- Surowe obserwacje, tożsamości, hashe metadanych i wybranych źródeł:
  [zapis dowodów](2026-10-28-mx3-master-reassessment.evidence.json).

To wewnętrzny raport statusu. Równania i kontrakty metod pozostają w
`docs/physics/`, architektura w `docs/architecture/backend-golden-masterplan.md`,
a zasady browser/API w `docs/specs/resource-first-control-room-api-v2.md`.

## 2. Aktualne wdrożenie: co naprawdę zastaliśmy

| Obserwacja | Wynik | Znaczenie |
|---|---|---|
| `fullmag-master-backend-1` | `924bbf46e6ee66c20dc45815e3923c11c39565f8ce99f623ff29f3bd83818afe`, exited 255 | Backend obecnie nie świadczy API |
| `fullmag-master-frontend-1` | `c040c05d3fe0079fada3e7617fddfd7a043985fa36bb6d76119013be36be6711`, exited 255 | Frontend obecnie nie działa |
| Zakończenie obu usług | 28.10.2026, około **19:57:48 czasu polskiego**; `OOMKilled=false` | Nie dowodzi przyczyny zakończenia; nie przypisujemy jej watcherowi ani OOM |
| Adres grupy | `http://127.0.0.1:3198/workspace`; health probe: connection refused | Port jest przypisany, ale nie obsługiwany |
| Budżet backendu z Docker inspect | **32 GiB / 8 CPU** | Rozbieżność z wcześniejszą decyzją wątku: 128 GiB / 16 CPU; niczego nie zmieniono |
| Zachowana provenance backendu | commit `44dccd0dc40d4017f6784ea93460b79b714bf6a3`, snapshot `64485fd91ad0e86d3ae4818566700114467668995a74015f01b4eaab53f88856` | W historii HEAD jest 228 commitów poza tym commitem; snapshot może obejmować WIP, więc sam ten dystans nie wylicza różnic binarium |
| Zachowany process-tree | schema `fullmag.docker-process-tree.v1`, `state=ready` | Historyczny zapis, nie bieżący health i nie dowód żywego PID |
| `/host-ledger` backendu | volume `fullmag-dev-group-ledger-v1-bd7aadbfa4d0ef3cf6f0b215` | Grupa DEV ma własny ledger; stara globalna migracja nie uzasadnia zatrzymywania innych grup |

Ostatnie logi zawierają odzyskanie obserwacji po 4–8 s oraz późniejsze
`live_probe_failed` z ponawianiem przez 120 s. Nie ma w tym odczycie dowodu,
że właśnie to spowodowało wspólne zakończenie kontenerów z kodem 255.
Nie odtwarzano domniemanej przyczyny ani nie zmieniano zapisanych ownerów.

## 3. Dawne problemy: aktualna kwalifikacja

„Naprawione w źródle” oznacza obecność właściwej ścieżki i jej konsumenta.
Nie oznacza wykonania na obecnym pakiecie ani zaliczenia browser/WebGL.

| Dawny problem | Stan na ocenionym HEAD | Kotwica obecnego właściciela |
|---|---|---|
| Brak targetu Airbox w Inspectorze | Naprawione źródłowo: fallback prezentacyjnego węzła, target i obsługa stanów bez udawania istniejącego mesha | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts::buildModelTree`; `airboxExplorerNodes.ts::buildAirboxPresentationNode`; `modules/inspector/panels/airbox/AirboxVisualizationPanel.tsx::AirboxVisualizationPanel` |
| Grubość 1,6 nm wyświetlana jako 0,0 | Poprawiony formatter: przykład 2 µm × 0,6 µm × 1,6 nm zachowuje `0.0016 um`; fixture istnieje, nie był uruchamiany | `apps/control-room/src/modules/inspector/panels/geometryObjectPanelModel.ts::formatDimensions/formatDimension`, linie 214–264 |
| Same `unknown` w Geometry | Panel rozróżnia loading/error/stale/missing; nadal potrzebny odbiór rzeczywistych payloadów i stabilności edycji | `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx::geometrySourceNotice`, linia 838 |
| Szare, nierozróżnialne primitive | Wspólna stabilna paleta po object ID, override i konsument renderera są obecne | `apps/control-room/src/kernel/visualization/primitiveSurfaceColor.ts`; `modules/viewport-3d/layers/PrimitiveObjectLayer.tsx::PrimitiveObjectLayer` |
| Brak feedbacku komend | Registry emituje także missing/disabled/error/pending; controller i presenter są podpięte. ACK pozostaje pending | `kernel/commands/CommandRegistry.ts::execute`; `kernel/commands/CommandFeedbackController.ts`; `kernel/layout/CommandFeedbackPresenter.tsx`; `kernel/runtime/studyRuntimeCommandContributions.ts` |
| „Compute Fields: m/full nieopublikowane” | Kontrola nie wymaga ponownego wyjścia `m/full` z ewaluatora; przyjęte `m` pozostaje walidowane | `crates/fullmag-api/src/accepted_field_materialization.rs::adopt_current_bundle`, linie 178–197 |
| Zajęty writer natychmiast kończy scheduler | Są odrębne ścieżki retry/defer; historyczny raport opisuje udany odczyt po dłuższej blokadzie. Nie kwalifikuje to każdej fazy obecnego runtime | `crates/fullmag-api/src/accepted_scheduler_main.rs` i `accepted_fem_preparation_scheduler_main.rs`, `retry_store_writer_busy/defer_scheduler_writer_busy` |
| Watcher traktuje normalny freeze jak awarię API | Read-only health/runtime/profile są dopuszczone podczas freeze; supervisor ma grace i zachowanie diagnostycznego API | `router_v2/middleware/development_admission.rs::mutation_admission_middleware`; `docker/all-in-one/entrypoint.py::_supervise_once/_retain_diagnostic_api` |
| Dropdown quantities pokazuje tylko sztuczne `m` | UI ma osobne stany empty/loading/error/unavailable/execution-required; capabilities są projektowane także wcześniej niż terminalny run | `ObjectVisualizationPanelModel.ts::visualizationQuantitySelectionState`; `ObjectVisualizationTargetSection.tsx::VisualizationQuantitySection`; `crates/fullmag-api/src/live_accepted_projection.rs` |
| Materializacja zawsze trwa kilkadziesiąt minut | Doszły cache planu/Study, współdzielenie mesha i krótsze sekcje krytyczne. **Nie ma nowego porównywalnego pomiaru na tym HEAD** | `c676a1ca462922bf7a74c47d98f950cc44100adf`; `live_accepted_projection.rs`; `live_scene_preparation.rs` |
| Cała geometria ma limit 64 MiB | Nieaktualne uogólnienie: zapis FEM P1 JSON ma 256 MiB; manifest 1 MiB, limit shape-derived i FMMT są osobne | `crates/fullmag-session/src/solution_field_geometry.rs::MAX_FEM_P1_GEOMETRY_BYTES/MAX_FEM_P1_GEOMETRY_SHAPE_BYTES`; `crates/fullmag-api/src/schemas/saved_field_geometry.rs` |
| Brak prostego uruchomienia DEV skryptu | Istnieje `just fullmag-dev-container`: up grupy, jeden run-script, obserwacja terminalnego wyniku; serwisy pozostają | `justfile::fullmag-dev-container`, linie 39–43; `scripts/docker_dev_run_script.py::run_script` |

### Potwierdzony błąd, którego nie zamknęły późniejsze poprawki

**P2 — granice cylindra ignorują oś.**
`crates/fullmag-authoring/src/geometry.rs::derive_geometry_bounds`, linie
1443–1452, zawsze zwraca `[-r,-r,-h/2]..[r,r,h/2]` i nie czyta `axis`.
Pierścień CoFeB z osią X nie ma takiej samej AABB jak cylinder z osią Z.
Helper jest używany przez `derive_object_bounds` i realizację sceny;
konsumują to m.in. fit/containment/overlap/tiny-feature checks. Inspector
korzystający z bounds może przypisać grubość do niewłaściwej osi.

Commit `eafe4811690b2c554ac377954844a1a3d3a374a4` naprawia osobny helper
voxelizacji w Pythonie. Nie poprawia tego kodu Rust. Naprawa powinna objąć
normalizację osi, AABB w lokalnych współrzędnych, a następnie istniejący
transform obiektu. Kryterium odbioru: X/Y/Z oraz oś ukośna; Difference/ring;
Fit Universe i zgodność wymiarów Inspectora. W tej sesji nie zmieniono kodu
i nie wykonano regresji. To nie dowód błędu jawnie zadanych wymiarów Universe
ani przyczyna wcześniejszego przerwania solvera.

## 4. FDM i FEM: różnice, które trzeba zachować

| Realizacja | Pola przygotowanego stanu przed Run | Pola zaakceptowanego stanu i dalszy odbiór |
|---|---|---|
| FDM CPU | Nie objęte automatycznym preparerem FEM; nie przenosić jego statusu | Własny grid, maska i cell ordinals; dla multilayer nośniki `layer_native` i osobne mapowanie Airbox. Bieżący runtime niekwalifikowany |
| FDM GPU | Jak wyżej; żądanie GPU nie może stać się CPU bez jawnej semantyki | CUDA single-grid i multilayer to różne ścieżki. Historyczny smoke 10 kroków nie kwalifikuje rozszerzonego operatora ani każdej precyzji/integratora |
| FEM CPU | Preparacja może automatycznie policzyć i adoptować magnetic fields/energie dla przygotowanego `m`; błędy obserwacji nie zmieniają powodzenia mesha | Wspólny mesh domeny i natywne mapy pól; realny H_demag/H_eff Airbox po biegu wymaga pełnodomenowego nośnika i potwierdzenia właściwego stanu |
| FEM GPU | Przy żądanym GPU przygotowana obserwacja jest obecnie liczona na **FEM CPU** z jawnymi `evaluation_lane=fem_cpu`, `requested_lane=fem_gpu`; solver nadal ma własny tor GPU | Nie nazywać tego GPU materialization ani dowodem wykonania solvera GPU. Sprawdzić requested/resolved/executed i fizyczny carrier w nowym runie |

Kotwice: `accepted_fem_preparer.rs::publish_prepared_observation/
evaluate_prepared_fem_fields/store_prepared_bundle`;
`prepared_observation_adoption.rs::adopt_prepared_observation`;
`crates/fullmag-runner/src/accepted_materialization.rs`.

Istotne ograniczenia obecnej implementacji:

- Automatyczna obserwacja podczas Prepare to inna operacja niż przycisk
  **Compute Fields**. `adopt_current_bundle` nadal wymaga terminalnego runu.
  Nie należy obiecywać, że kliknięcie tego przycisku przed Run uruchomi ewaluator.
- `store_prepared_bundle` pomija `m` oraz pola z `role=airbox`. Przygotowana
  obserwacja nie rozwiązuje zatem sama prośby o H_demag w Airboxie przed Run.
- Obserwacja przygotowania ma budżet `min(memory/4, 1 GiB)` i ograniczenia
  wejść dynamicznych, transportu, frozen spins i temperatury. Powód odmowy
  nie może znikać pod komunikatem „mesh ready”.
- Live writer nadal stosuje budżet `min(storage/8, memory/8, 128 MiB)` dla
  generacji. Gdy cały zestaw nie mieści się, `field_sampling_interval`
  wybiera rzadszy tor `m/preview`; nie gwarantuje wszystkich H przy każdej
  iteracji. Zwiększenie limitu kontenera samo tego nie zmienia.
- [ADR 0071](../adr/0071-prepared-state-field-evaluation.md) zawiera pierwotną
  propozycję osobnego ewaluatora i późniejszą rewizję v1 preparera. Status
  `proposed`, opis GPU i rozdział wstępny wymagają redakcyjnego uzgodnienia
  z rewizją v1; raport nie awansuje ADR ani feature do pełnego wsparcia czterech torów.

## 5. Czego nie przenosimy ze starego wątku

Historyczny [raport z 24.10](../reports/2026-10-24/fem-fdm-runtime-resume.md)
opisuje wykonania FDM single, FDM multilayer, wcześniejszy FEM, skończone pola
oraz ograniczone próby browser/WebGL. Dotyczą konkretnych dawnych runów,
snapshotów i wejść. Świeży audyt odczytał raport, nie ponawiał tych prób.

Ostatnia komenda FEM z końcówki wątku miała intent
`fem-cofeb-10-recovery-20261024-01`, run
`run-live-920ceda35ced1b1338ffae97eb682c71ab77d4a819173058cfc199bbb8ef9e40`
i niejednoznaczną odpowiedź HTTP 500. Nie ustalono w tej sesji jej terminalnego
wyniku. Nie ponowiono jej. Przed nowym Solve trzeba odczytać właściwy journal
z zachowanej generacji; aktualna pusta/inna sesja nie dowodzi porażki dawnej komendy.

Nowe dowody 2D oraz saved playback mają odrębny zakres:

- [Status 2D](../status/2d-slice-capabilities.md) zawiera nowsze smoke FDM CPU,
  FDM GPU i FEM CPU, ale także otwarte budżety D2D-12 i historyczne wiersze
  sprzed poprawek. Po optymalizacji raportuje około 0,35/0,45 s ciepłego
  przełączenia warstwy oraz trzy żądania przy zmianie składowej. Nie jest to
  spełnienie wszystkich budżetów ani świeży CoFeB FEM GPU smoke mastera.
- [FEM saved playback](../superpowers/plans/2026-10-28-fem-saved-results-playback.md)
  opisuje syntetyczne dwa tetraedry oraz sprawdzone odtwarzanie FDM. Nie
  kwalifikuje obliczenia H_demag przez rzeczywisty solver FEM.
- [Checkpoint anteny / PR #247](../superpowers/plans/2026-10-27-antenna-master-pr247-checkpoint.md)
  dotyczy zapisanych V/J/H i innego runu. Odzyskane `inspection_only` H nie
  jest polem demag CoFeB ani automatycznie zakwalifikowaną bazą LLG.

## 6. Co jeszcze zrobić — sześć bloków domknięcia

| ID / priorytet | Konkretna praca | Kryterium zakończenia i granica |
|---|---|---|
| **D1 / P1 — wdrożenie mastera** | Rozpoznać aktualne receipty i właściciela zatrzymanej grupy; uzgodnić rozbieżność 32/8 wobec decyzji 128/16. Właściwym launcherem doprowadzić pakiet i frontend do ocenionego źródła | Health i native ready, przypięty source snapshot/build, rzeczywiste 128 GiB/ 16 CPU jeśli ta decyzja nadal obowiązuje. Zachowane dane/cache; brak resetu ownera lub zatrzymania cudzych grup |
| **D2 / P2 — cylinder i Universe** | Naprawić axis-aware bounds w Rust, po sprawdzeniu równoległych zmian | Zgodne X/Y/Z/ukośna, ring/Difference, Fit i Inspector. Nie zmieniać ręcznie rozmiaru Universe, by zamaskować błąd |
| **D3 / P1 — odbiór CoFeB FEM GPU** | Rozstrzygnąć stary intent bez replay, następnie jeden jawny nowy przebieg wcześniejszego przykładu na nowym pakiecie: preparation → mesh → 10 kroków → pola → browser | Mesh z właściwymi wymiarami i nośnikami, potwierdzone 10 kroków minimizacji, m oraz H_demag/H_eff i energie związane z tym samym accepted state; widoczny canvas, WebGL nieutracony, niezerowy bufor i obejrzany render Airbox. To smoke, nie zbieżność naukowa. FDM CPU/GPU i FEM CPU mają osobne wymagane odbiory, bez kopiowania statusu FEM GPU |
| **D4 / P2 — duże domeny i czas przygotowania** | Zmierzyć cold/warm osobno: Python/Gmsh, walidację/certyfikację, CAS, adopcję i payloady; sprawdzić granice zapisu JSON, shape-derived, FMMT i live fields | Ten sam przykład, rozmiar mesha, źródło i budżet; raport CPU/RSS/I/O i faz, czytelne logi UI. Nie obiecywać przyspieszenia bez pomiaru; zaprojektować selektywną publikację pól, jeśli 128 MiB odcina wymagany H |
| **D5 / P2 — lifecycle i komunikaty** | Odebrać DEV po success/error oraz kolejnym skrypcie bez restartu API; doprecyzować Prepare vs Compute Fields i tor ewaluacji. Osobno domknąć publiczną produkcyjną komendę `fullmag-container skrypt.py` | DEV zachowuje API i dane, wraca do gotowości na kolejne zadanie. Zwykła porażka zadania nie wymaga recovery; rzeczywiście nieznany owner nadal blokuje tylko niebezpieczne obliczenia. Produkcja kończy własne usługi poza interactive; w przeszukanych entrypointach brak odpowiednika tej publicznej komendy. Istnienie `fullmag-dev-container` nie zamyka produkcji |
| **D6 / P2 — odbiór frontendu i pozostałe F0–F12** | Sprawdzić na działającym masterze Inspector Object/Airbox, Apply/Revert i rewizje, kolory/wireframe, H i legendę, utratę ACK/reconnect, kanoniczny eksport i reopen; wykorzystać istniejący plan 2D | Panel/focus/scroll stabilne, stan stale/error zgodny z danymi, jedna komenda przy utracie ACK, brak Solve od odświeżenia strony. Eksport zachowuje requested runtime, materiały/regiony/napędy/outputs i scenę przy jawnych draftach. W MX3 zamykać ID po dowodzie, nie według wieku; uwzględnić nadal otwarte budżety 2D |

Kolejność: D1 → D3; D2 można przygotować niezależnie, ale sprawdzić przed
kwalifikacją Fit. D4 mierzyć w tym samym przebiegu D3. D5 i D6 odbierać
na rzeczywistym runtime, nie wyłącznie fixture. Ten raport jest planem
dalszego odbioru; nie uruchomił żadnej z tych operacji.

**Odrębny zakres:** pełna przebudowa FDM multilayer ma już
[zaakceptowany plan](../superpowers/plans/2026-10-25-fdm-gpu-multilayer-rebuild.md)
i istniejący branch `codex/fdm-gpu-multilayer-rebuild`. Nie zaczynać jej od
nowa w tym wątku. Postęp tej gałęzi nie był audytowany; jej istnienie nie
oznacza integracji ani kwalifikacji rozszerzonych geometrii, FP32, transferu
i wszystkich integratorów. Mały dawny smoke identity/FP64 nie zamyka tego planu.

## 7. Jak czytać dawny plan F0–F12

| Etapy MX3 | Aktualne rozstrzygnięcie |
|---|---|
| F0 | Dawne trzy konflikty nie występują w obecnym indeksie; nie rozwiązywać ich ponownie. Baza aktualnego odbioru to obecny snapshot i D1 |
| F1–F2 | Implementacja znacznie późniejsza: osobne grupy, retry/defer, projekcje accepted, obserwacje i prepared FEM. Otwarte konkretne odbiory D3–D5, nie ogólne „brak wykonawcy pól” |
| F3–F4, F6 | Feedback, readiness i prezentacja quantities istnieją. Wymagają odbioru w aktualnej przeglądarce i spójnej semantyki Prepare/Run/Fields |
| F5, F7–F8 | Nie przeprowadzono ponownie pełnego audytu round-trip, wszystkich formularzy i mutacji regionów. Stan „wszystko naprawione” byłby nieuprawniony; D6 obejmuje konkretne scenariusze |
| F9–F11 | Nowsze wspólne mechanizmy palet, paneli i 2D zastępują część starego zakresu. Dalsze zadania należy wiązać z aktualnym planem/ledgerem 2D i realnym objawem |
| F12 | Nie zamknięty dla aktualnego mastera: usługi są zatrzymane, brak spójnego nowego dowodu CoFeB od źródła do renderu i eksportu |

## 8. Zmiany dokumentacyjne i weryfikacja tej sesji

Dodano ten raport i odczytowy zapis dowodów. W `mx3.md` dodano aktualny punkt
odniesienia i oznaczono stary plan jako historyczny; zachowano treść dowodów.
W raporcie wznowienia z 24.10 dodano ostrzeżenie o historycznym zakresie.
Nie przepisywano dawnych Windowsowych ścieżek jako rzekomo aktualnych.

Kontrola tej aktualizacji obejmuje poprawność JSON, istnienie lokalnych
linków i źródeł, niezmienność przypiętych hashy oraz `git diff --check`.
Nie jest to test solvera, UI, builda ani nauki. Dokumenty są lokalnie zmienione;
nie wykonano commit/push. `mx3.md` jest wersjonowany, a stary katalog
`docs/reports/2026-10-24/` jest nadal ignorowany przez Git.
