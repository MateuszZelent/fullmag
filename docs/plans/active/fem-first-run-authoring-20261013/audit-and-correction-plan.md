# Audyt i plan korekt: od pustego workspace do pierwszego przebiegu FEM/FDM

Data: 2026-10-13. Zakres: audyt źródeł i plan, bez implementacji nowego przepływu.

## 1. Wynik i granice dowodu

Obecny przepływ nie prowadzi użytkownika przez zbudowanie kompletnego modelu. Istnieją formularze, walidatory, readiness i komendy, lecz brakuje widocznego przewodnika łączącego je w kolejność z konkretną następną czynnością. Poprawienie stylu Inspectora ani sam znacznik FEM/FDM nie zamkną tej luki.

Zgłoszenie użytkownika: po wybraniu FEM i dodaniu obiektu Inspector Universe pokazuje:

> Session discretization is unresolved; FEM mesh commands remain unavailable until an explicit FEM lane is published.

To komunikat zależności technicznej, bez czynności dostępnej użytkownikowi. Źródła potwierdzają warunki jego emisji, ale nie potwierdzają, który warunek wystąpił w zgłoszonej działającej sesji. Nie odtworzono tego przypadku na realnym backendzie. Brak wymiarów Universe nie jest dowodem przyczyny tego komunikatu.

Źródło podstawowe: izolowany worktree `simulation-mode-consistency-20261013`, branch `codex/simulation-mode-consistency-20261013`, HEAD `f2eb8f100e706343fe379e9928c589530529bd94`, PR #155. Główny checkout podczas audytu: master `141f21a193bc920f7d5232b7e50d24550e31ba51`, z niezależnymi zmianami użytkownika. PR #155 nie jest scalony. Nie przedstawiam jego kodu jako już obecnego na masterze. Hashe czytanych źródeł zapisano w `source-identity.json`.

Kontrole źródeł/CI dla HEAD PR #155 przeszły: frontend typecheck/lint/test/build, Rust, Python, generated API, architecture/API hygiene, browser fixture i Inspector actions. Powtórzono dwie niezmienione czerwone bramki: Gmsh density i session-store writer busy; kolejny wynik obu SUCCESS. To nie jest dowód poprawnego doświadczenia użytkownika tworzącego rzeczywisty model od zera.

Browser proof: run `38415922670`, syntetyczny merge SHA `5b4b55c86ae268b2dedae9b8382be13b9201aa48`, rodzice `141f21a193bc920f7d5232b7e50d24550e31ba51` i HEAD PR. Widoczny znacznik FEM; WebGL bez utraty kontekstu, bufor 617×437. API fixture/mock; realny backend, FEM CPU→GPU oraz kwalifikacja naukowa: **NOT VERIFIED**. Managed FEM oczekuje na runner; API GitHub dla repozytorium zwróciło zero runnerów. React Doctor advisory SUCCESS, score 83/100, raport 1 error/72 warnings bez skutecznego porównania z bazą; nie deklarować 0 errors. Zgłoszony effect-needs-cleanup dotyczy istniejącego efektu zwracającego `offRestore`, którego PR nie zmienia.

## 2. Dlaczego FEM może być znane, a UI wyświetla unresolved

1. `NewProblemDialog.tsx:43–52,130–133` przekazuje wybrany backend do `sessions.create`.
2. `sessions/create.rs:117–155` tworzy scenę ze wskazanym `study.requested_backend`, lecz `universe: None` (linia 136).
3. `scratch_snapshot`, `create.rs:163–238`, ustawia wszystkie cztery resolved pola sesji i scratch capability snapshot. `resolved_engine_id` pozostaje pusty przed wykonaniem. Na tej konkretnej ścieżce brak uruchomionego engine sam w sobie nie powinien powodować unresolved metody.
4. `active_lane_capability_snapshot`, `sessions/status.rs:514–673`, wymaga kompletu backend/device/precision/mode. Częściowa resolution daje `resolved=None`; konflikt z `metadata.resolved_execution` odrzuca resolution. Brak planner capabilities również publikuje `resolved=None`, nawet gdy pola sesji wskazują FEM.
5. `session.rs:1318–1403` ma domyślny snapshot z backend auto, resolution i capabilities pustymi. `session.rs:1472–1473` importuje capabilities z metadanych, jeśli są opublikowane. To ścieżki wymagające sprawdzenia przy restore/live update; nie dowód ich wystąpienia w zgłoszeniu.
6. `resolveSessionDiscretization`, `sessionDiscretization.ts:73–109`, przy obecnym `active_lane` używa wyłącznie `resolved.discretization`. Nie korzysta z jawnej metody sceny ani authored/requested, gdy resolved jest puste.
7. `geometryLifecycleCommandContributions.ts:243–271` zamienia wynik unknown na cytowany komunikat. `AirboxInspectorLanePanel.tsx:102–111` zamiast formularza pokazuje ogólną informację o niedostępnych kontrolkach.

**Luka kontraktu:** jedna wartość służy jednocześnie do rozpoznania rodzaju edytowanego modelu i do reprezentacji kompletnej resolution wykonania. CPU/GPU, planner snapshot i bieżący engine nie powinny być warunkiem wprowadzenia polityki domeny dla zaakceptowanego modelu FEM. Jednocześnie requested intent nie może udawać resolved wykonania ani legalności konkretnej operacji.

Następna diagnoza wymaga skorelowanego odczytu `model/scene`, statusu, readiness, capability source/reason oraz revision/session identity na create → project binding → pierwszy odczyt → reconnect/restore. Nie należy naprawiać tego przez domyślny FEM ani fallback do zachowanego artefaktu FDM.

## 3. Ustalenia audytu

| ID | Priorytet | Problem i skutek | Dowód źródłowy | Korekta |
|---|---|---|---|---|
| U01 | P0 | Zadeklarowana metoda authoring zależy od kompletu resolution wykonania. Universe może stać się niedostępne przed uruchomieniem solvera. | `status.rs:539–643`; `sessionDiscretization.ts:73–109` | Rozdzielić metodę zatwierdzonego modelu, możliwości authoring/mesh i resolved execution runu. |
| U02 | P0 | Unresolved nie ma drogi wyjścia dla użytkownika. Nie wiadomo, czy wybrać metodę, czekać, odświeżyć, czy naprawić backend. | `geometryLifecycleCommandContributions.ts:243–271`; `AirboxInspectorLanePanel.tsx:102–111`; `ModelTreeOverviewInspectorPanels.tsx:64–95` (Universe mówi Loading bez CTA) | Odrębne loading/missing intent/conflict/missing capabilities, każda z konkretną akcją i diagnostyką. Nie wymagać znajomości terminu lane. |
| U03 | P1 | Nowa symulacja nie pyta o politykę domeny ani nie kieruje do niej po create. | `NewProblemDialog.tsx:173–240`; `create.rs:136` | Jawny krok Domeny: automatyczna polityka lub ręczne granice; bez fikcyjnych bounds przed geometrią. |
| U04 | P1 | Brakuje widocznego poradnika z następną czynnością. Istniejący checklist helper ma tylko testowe użycia. | `scratchAuthoringReadiness.ts:6–32`; wyszukanie konsumentów `toChecklist` | Podłączyć checklistę readiness do produkcyjnego workspace i routingu Inspector/komend. |
| U05 | P1 | Readiness nie opisuje wyboru domeny/air policy, a zależności są zaszyte w innych walidatorach/plannerze. | `model/readiness.rs:98–160,219–274` | Wspólna, revision-driven lista kroków i blockerów, obejmująca domenę zgodnie z backendem i wybraną fizyką. |
| U06 | P1 | Przycisk Solve pokazuje pierwszy tekstowy blocker zamiast prowadzić do jego usunięcia. | `studyRuntimeCommandContributions.ts:488–504` | Zawsze dostępne Sprawdź gotowość; blocker z Open Inspector/Configure/Build i właściwym object/stage target. |
| U07 | P1 | Universe/Airbox, polityka siatki i wynik solvera nie mają jasnej hierarchii w pierwszym przebiegu. | `AirboxOverviewPanel.tsx:19–43`; `mesh-roundtrip-semantics-v1.md:9–38` | Rozdzielić edytowaną politykę domeny od zrealizowanej siatki; informować, co jest automatic, manual, stale i niewybudowane. |
| U08 | P1 | Brak jasnego kontraktu obiektu wychodzącego poza ręczne granice domeny. | `fullmag-authoring/src/geometry.rs:653–685`: ostrzeżenie, brak blokowanych czynności | Przed build/run jawnie rozstrzygnąć rozszerzenie granic lub poprawę placement; próg i legalność określa backend, nie wyłącznie wizualny overlay. |
| U09 | P1 | Materiał, initial magnetization i physics stack wymagane dopiero w późniejszych bramkach; użytkownik nie widzi kolejności. | `model/readiness.rs:98–141`; `geometry.rs:600–635` | Po dodaniu obiektu pokazać jego brakujące przypisania i akcje; nie utożsamiać nazwy/typu z fizyką. |
| U10 | P1 | New simulation reklamuje CPU/Double jako profil całej symulacji, co sugeruje utrwalenie urządzenia. | `NewProblemDialog.tsx:181`; `simulation/runtime.rs:284–287` | Nazwać profil przygotowania/preview; CPU/GPU/auto wybierać przy run/stage, a wynik pokazywać osobno. |
| U11 | P1 | Brak dowodu realnego happy path empty FEM → object → domain → mesh → solver. Mock smoke nie sprawdza tej zależności. | browser proof i source snapshot PR #155 | E2E z prawdziwym backendem, bez omijania komend/UI; osobno FEM CPU/GPU i FDM CPU/GPU zgodnie z dostępnością. |
| U12 | P2 | Informacje Overview/Shortcuts są tekstem i wymagają znajomości drzewa. | `AirboxOverviewPanel.tsx:38–48` | Kontekstowe przyciski do istniejących paneli, bez nowego osobnego drzewa FEM. |

P0 oznacza blocker poprawnego tworzenia modelu, nie potwierdzenie, że każda nowa sesja ma ten sam błąd. U08 wymaga decyzji kontraktu: obecna ostrzegawcza geometria nie dowodzi legalności każdej ścieżki solvera.

## 4. Universe przed obiektem — zalecana decyzja produktu

Przed pierwszym obiektem należy pokazać politykę domeny i jednostki, a nie zawsze wymuszać ręczne liczby.

- **Automatycznie:** użytkownik jawnie wybiera dopasowanie domeny do geometrii. Przed pierwszym obiektem stan brzmi „granice zostaną wyznaczone po dodaniu geometrii”, nie 0×0×0. Po dodaniu/przesunięciu obiektu podgląd pokazuje przewidywane granice i padding. Przed build są zatwierdzone rzeczywiste parametry i metoda ich wyznaczenia.
- **Ręcznie:** w tym samym Inspectorze dostępne size/center/bounds z czytelnymi jednostkami, np. nm i SI w zapisie kanonicznym. Użytkownik może je podać przed obiektem. Przy wyjściu geometrii poza domenę dostaje wybór zgodny z backendową walidacją.
- **FEM:** obecność i rodzaj airbox zależą od wybranego demag i materializacji domeny. `fullmag-plan/src/util.rs:121–158` bierze pod uwagę energy terms, requested demag i mesh workflow; `mesh.rs:1878–2004` rozróżnia elementy powietrza i strategie wymagające airbox. Nie wolno prezentować wszystkich modeli FEM jako tej samej obligatoryjnej kostki powietrza.
- **FDM:** rozdzielić extent Universe od rozdzielczości strukturalnego gridu. Przewodnik prowadzi do właściwych pól FDM, nie do Build FEM mesh.

Ten plan nie wybiera nowych numerycznych wartości paddingu, hmin/hmax, współczynnika airbox ani warunków brzegowych. Te wartości muszą pochodzić z istniejącego kanonicznego kontraktu/plannera, być widoczne i podlegać obecnej walidacji naukowej. Universe policy nie jest zrealizowanym solver mesh.

## 5. Docelowy przepływ użytkownika

Jeden workspace, obecne Ribbon/Explorer/Inspector i shared UI. Przewodnik jest checklistą/modelowym kontekstem, nie osobnymi ekranami Build/Study/Analyze.

| Krok | Co użytkownik widzi i robi | Dowód zakończenia / następna akcja |
|---|---|---|
| 1. Nowy model | Nazwa, jawne FEM/FDM; profil wykonania opisany jako późniejszy wybór. | ACK i odczyt kanonicznej metody tego samego session scope. |
| 2. Domena i jednostki | Automatic / Manual oraz wyjaśnienie Universe vs FEM Airbox. | Zatwierdzona polityka; automatic bounds mogą jeszcze oczekiwać na obiekt. |
| 3. Geometria | Dodaj obiekt; rozmiary, pozycja i podgląd domeny; Apply/Revert. | ACK + obserwacja nowej scene revision; wymagania domeny aktualizują się. |
| 4. Materiał i stan początkowy | Wskaż brakujące przypisania dla każdego solve object. | Resource readback, nie tylko lokalne wartości formularza. |
| 5. Fizyka | Jawnie włącz interakcje; dobierz demag i wymagania domeny. | Legalność i konfiguracja wynikają z backendu; brak cichego włączania z type/name. |
| 6. Dyskretyzacja | FEM: wspólna domena/mesh właściwego typu. FDM: extent + cell/grid. | Terminalny build outcome, aktualna revision/generation i quality/readiness. |
| 7. Badanie | Dodaj konkretny etap i jego parametry. | Zatwierdzony kanoniczny StudyPlan/scene. |
| 8. Wykonanie | CPU/GPU/auto i dostępność dla bieżącego run/stage. Sprawdź gotowość. | Requested vs resolved i fallback/provenance jawne; wymuszone GPU nie przechodzi cicho na CPU. |
| 9. Start i wynik | Prepare/ACK/observation/run, logi i przerwanie z konkretną diagnostyką. | Engine/runtime potwierdzone dla tego przebiegu; wynik + ścieżka poprawy błędu. |

Istniejące punkty ponownego użycia: `ModelTreeOverviewInspectorPanels.tsx:64–95` dla Universe, `AirboxMeshParametersPanel.tsx:78–103,407–544` dla size/center/padding i Apply & Build, `ribbonContributions.tsx:311–337,375–386` dla tworzenia i walidacji geometrii, wspólne InspectorGroup/FeedbackBanner/Button i sesja Apply/Revert. Komendy draftu (`geometryLifecycleCommandContributions.ts:1274–1303`) oraz transakcja tworzenia (`GeometryObjectPanel.tsx:402–453`) nie wymagają Universe przed obiektem; jest to świadoma granica planu, a nie powód dodania wymuszonego formularza.

Kolejność jest pomocą. Ekspert może edytować dowolny panel; backend weryfikuje zależności przed build/run. CPU/GPU można zmieniać między przebiegami/obsługiwanymi etapami w tej samej sesji. Migracja aktywnego kroku i wznowienie konkretnego checkpointu na innym urządzeniu to osobne kontrakty, bez obietnicy hot-switch.

## 6. Plan wdrożenia w kolejności zależności

| Etap | Zakres i właściciel zmian | Wynik / kryterium odbioru | Weryfikacja |
|---|---|---|---|
| P0-A | Backend/API: `sessions/create.rs`, `sessions/status.rs`, `session.rs`, właściwe restore/binding; frontend `sessionDiscretization.ts`, Airbox gating. | Zapisany FEM pozostaje edytowalny przed engine resolution. UI rozróżnia loading, brak wyboru, sprzeczność i brak caps. Każdy stan ma drogę wyjścia. | Regresje create→binding→readback→reconnect/restore, brak caps, częściowa resolution, konflikt; FDM i FEM. Żadnego domyślnego FEM. |
| P0-B | Kontrakt authoring capabilities vs runtime capabilities; API/schema/generated types tylko jeśli istniejący kontrakt nie wystarczy. | Metoda zatwierdzonej sceny nie udaje wykonanej lane. Mesh operation nadal waliduje legalność, revision, model i wymagania backendu. | ADR/capability matrix/resource-first review; testy realnych komend, brak cyklu „mesh potrzebny do run, run potrzebny do edycji domeny”. |
| P1-A | Backend `model/readiness.rs`, frontend readiness resources + command mapping. | Kroki domeny, geometrii, materiału, tekstury, fizyki, dyskretyzacji, study i execution mają stabilne ID, target i action/reason. Readiness odpowiada bieżącej scene revision. | Testy niekompletnego modelu, stale revisions, method switch, per-object blockers; brak lokalnej duplikacji plannera. |
| P1-B | Layout/Ribbon/Explorer + `scratchAuthoringReadiness.ts`, `NewProblemDialog.tsx`. | Po create widoczny Następny krok. Każda akcja otwiera istniejący Inspector/komendę; po ACK kroki się odświeżają. | DOM + browser happy path, keyboard navigation, stan dirty Apply/Revert przy zmianie kroku, brak utraty drafts. |
| P1-C | Airbox/Universe istniejące panele i model polityki; podgląd viewport przez istniejące adaptery. | Automatic/Manual, jednostki i brak geometrii są jasne. Politykę można wprowadzić bez wybudowanej siatki. Wyjście poza manual domain ma konkretną naprawę. | Unit/contract + Object/Airbox Inspector mutation; browser visible canvas/context/buffer. E2E nie stosuje ukrytych wartości naukowych. |
| P1-D | Study editor + preparation/current-run readback + status bar. | CPU/GPU/auto wybrane per run/stage, requested i resolved rozdzielone; brak sesyjnej blokady CPU i fikcyjnego engine przed runem. | Dwa przebiegi w jednej sesji; wymuszone nieobsługiwane GPU fail-closed; checkpoint incompatibility jawne. Osobne receipts realnego FEM CPU/GPU. |
| P1-E | E2E scenariusze produkcyjnego workspace i backendu. | Użytkownik przechodzi od pustej FEM do wyniku bez szukania ukrytych prerequisites. Analogiczny FDM. | Real backend + managed runtime; source identity, request/ACK/observation, mesh generation, logs, screenshots, WebGL. Mock pozostaje osobną klasą dowodu. |

Każdy etap wdrożenia obejmuje testy regresji i adekwatne CI. Lokalny zakaz kompilacji testów jednostkowych pozostaje w mocy; niniejszy audyt ich nie uruchamia. Przed przyszłym wdrożeniem trzeba ustalić dozwoloną trasę wykonania bramek. Plan nie obniża wymaganych naukowych ani release gates.

## 7. Scenariusze odbioru, które muszą być jawne

1. Pusty FEM, brak current run i brak mesh: metoda FEM widoczna, polityka domeny edytowalna, engine nie jest udawany, Build ma konkretne brakujące prerequisites.
2. Automatic domain przed obiektem: brak fikcyjnego zera; po obiekcie widoczne wyznaczone granice i źródło; zapisana polityka przetrwa reload.
3. Manual domain przed obiektem: jednostki i Apply/Revert działają; obiekt poza granicami uruchamia właściwą walidację i akcję naprawy.
4. FEM bez wymaganej airbox vs FEM z demag wymagającym powietrza: checklist i planner zgadzają się; sam napis FEM nie wystarcza do wyboru strategii.
5. Brak materiału, tekstury albo fizyki: przycisk prowadzi do właściwego obiektu/Inspectora, nie tylko pierwsza wiadomość w tooltipie.
6. Mesh stale po zmianie geometrii/domeny: krok wraca do Do poprawy; poprzednia siatka nie udaje aktualnej.
7. Reconnect, reopen projektu i capabilities unavailable: metoda authoring zachowana; runtime support oznaczony niedostępny; użytkownik ma bezpieczną drogę diagnostyki/retry bez kasowania modelu.
8. Requested CPU → kolejny run requested GPU w tej samej sesji; engine i urządzenie poprzedniego runu nie opisują nowego. Nieobsługiwana konfiguracja wyjaśniona bez cichego fallbacku.
9. Zmiana kroku z dirty draft: Apply/Revert/Cancel zachowują kontrakt istniejącej sesji edycji. Nie wprowadzać nowego stanu poza wspólnym mechanizmem.
10. Eksport i ponowny import kanonicznego skryptu odtwarzają metodę, domain policy, geometrie, przypisania, StudyPlan i requested execution; UI i Python nie mają rozbieżnych modeli.

## 8. Decyzje wymagające rozstrzygnięcia przy implementacji

Zalecenie produktu: domyślny panel Następny krok w pustym modelu oraz jawna polityka automatic/manual; brak obowiązkowych ręcznych wymiarów dla każdej FEM. Brakująca geometry-dependent informacja ma status „do wyznaczenia”, nie nieistniejący błąd engine.

Decyzje kontraktu: źródło authoring method/capabilities oddzielone od runtime lane; prezentacja automatycznej domeny i moment jej zatwierdzenia; legalność obiektu poza manual Universe; mapowanie readiness blockers na akcje oraz warunki transferu checkpointu CPU/GPU. Czy produktowa nazwa Universe oznacza istniejącą politykę outer domain/Airbox, czy odrębny byt — ustalić przed dodaniem nowych pól. Nie tworzyć drugiego edytora ani równoległego modelu. Akcja Retry/Resolve musi wskazywać istniejącą obsługiwaną komendę/zasób; bez jej potwierdzenia nie projektować przycisku, który jedynie odświeża ten sam błąd. Rozstrzygać na podstawie Python→IR→planner/API, bez wymyślania uproszczonego solvera w UI.

## 9. Stan pracy

Nowy przewodnik ani korekty tego planu nie zostały zaimplementowane. Nie zmieniono kodu aplikacji w ramach tego audytu. PR #155 ma zielone bramki źródłowe/browser, ale merge jest wstrzymany do rozstrzygnięcia U01/U02 w świetle nowego zgłoszenia. Worktree pozostaje zachowane z tym raportem; bez commit/push/merge samego nowego audytu. Cały R0/R1 D07 i kwalifikacja wydania FEM nie są zamknięte.

Podstawy kontraktu: `docs/specs/mesh-roundtrip-semantics-v1.md`, `docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md`, `docs/specs/resource-first-control-room-api-v2.md`, `docs/validation/frontend-3d-required-check-matrix.md`, root AGENTS i wskazane symbole źródeł. To plan UX/API, nie nowa terminalna specyfikacja fizyki ani zmiana parametrów naukowych.
