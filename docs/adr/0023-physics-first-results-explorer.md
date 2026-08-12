# ADR 0023: Physics-first Explorer wyników i Analysis

- Status: accepted
- Data: 2026-08-11
- Powiązane: ADR 0011, ADR 0016, ADR 0022

## Kontekst

Dotychczasowe drzewo Control Room mieszało konfigurację Study, semantyczne
wyniki, surowe artefakty i nazwy metod numerycznych. W domenie
częstotliwościowej prowadziło to do niepoprawnych skrótów: każdy wynik przy
zerowym wektorze falowym mógł wyglądać jak FMR, pojedynczy punkt niezerowego
$\mathbf{k}$ jak relacja dyspersji, a odpowiedź wymuszona jak mod własny.

Chronione invariants to jeden kanoniczny model fizyczny, jeden resource-first
kontrakt HTTP v2, jedna selekcja, jeden Inspector, jeden Analysis i jeden
zunifikowany Viewport dla FDM i FEM. Requested intent oraz resolved execution
muszą pozostać rozdzielone i widoczne.

## Decyzja

Explorer ma pięć rozłącznych zakładek:

- `Model` jest właścicielem authoring i konfiguracji;
- `Results` prezentuje run/stage-scoped wyniki i postprocessing physics-first;
- `Resources` prezentuje surowe revisioned zasoby runtime;
- `Jobs` prezentuje wyłącznie resource-backed lifecycle;
- `Diagnostics` wyjaśnia stale, mismatch, unsupported, degraded i błędy.

`Results` klasyfikuje typed manifest przez produkt (`modal_eigen` albo
`driven_response`), boundary/Floquet context, k sampling, drive/probe contract,
published observables oraz immutable owner identity. Klasyfikator jest czysty i
nie analizuje etykiet, nazw plików ani kolejności tablic.

Kontekst wektora falowego jest jednym z `finite_open`, `gamma`, `fixed_k`,
`k_path` albo `k_grid`. `FMR` jest legalne wyłącznie przy opublikowanym RF
coupling/oscillator strength dla modu albo magnetycznym drive i wymiarowo
określonym observable dla odpowiedzi. Modalna relacja dyspersji jest
$f_n(\mathbf{k})$; driven response map pozostaje $A(\mathbf{k},f)$,
$\chi(\mathbf{k},f)$ albo $P_{\mathrm{abs}}(\mathbf{k},f)$.

Każdy descriptor zachowuje osobno:

- `resourceState`: `idle`, `loading`, `ready`, `stale`, `error`;
- `executionState`: `not_started`, `queued`, `running`, `paused`, `completed`,
  `cancelled`, `failed`;
- `availability`: `available`, `partial`, `unavailable`, `unsupported`.

Każdy selekcjonowalny kind ma dedykowany typed Inspector route albo jawny panel
unsupported. Wspólny template obejmuje strukturę i styl, ale nie zastępuje
semantycznie różnych paneli wspólną treścią.

Analysis ma stabilne powierzchnie `Dynamics`, `Resonance & FMR`, `Dispersion`,
`Hysteresis` i `Comparison`. Aktywna wizualizacja wyniku jest jednym
`Active Analysis Overlay` związanym z run, stage, equilibrium, field, k/f,
representation i provenance. Animacja modu rekonstruuje zespolony fazor lokalnie;
nie jest integracją czasową.

## Własność zasobów i transport

HTTP v2 pozostaje źródłem prawdy, a websocket jedynie invaliduje resource keys.
Ciężkie pola modów i mapy odpowiedzi pozostają na binary/Zarr data plane.
Komponenty używają generated transport, centralnego facade i resource hooks;
nie budują endpointów ani nie wykonują `fetch()`.

Obecny kontrakt publikuje current run i odczyt runu po znanym ID, ale nie
publikuje kolekcji historii. Result context selector pokazuje zatem bieżący run
oraz tylko jawnie dostarczone identities. Nie skanuje artefaktów i nie tworzy
fikcyjnego `Recent Runs`.

Trwałe user-defined Analysis Views, Derived Values i Plot Groups nie otrzymują
pozorowanego ownera. Do czasu dodania osobnego, zatwierdzonego zasobu w rodzinie
`analysis` albo `workspace`, UI pokazuje wyłącznie istniejące descriptors i jawny
contract gap. Dane pozostają własnością rodziny `data`.

## Konsekwencje

- Nazwy są fizycznie jednoznaczne, ale wymagają bogatszych typed refs i
  kompletnego provenance.
- Zmiana ID obejmuje atomowo buildery, selection refs, commands, Inspectory,
  preferences i testy.
- Ukryte Analysis surfaces i nieaktywny Viewport nie mogą zachowywać rendererów,
  workerów, observerów ani własnych RAF.
- Brakujące coupling observables i stabilne domenowe IDs są widocznym contract
  gap, a nie podstawą inferencji.

## Migracja i usunięcie legacy

Nowe zapisy używają wyłącznie physics-first IDs. Bounded reader może jednorazowo
przetłumaczyć stare preferences i selection identities. Należy go usunąć po
jednej wydanej wersji zapisującej nowy schemat oraz po przejściu testów migracji,
które nie znajdują starych IDs. Stare równoległe drzewo Results, generyczne
Inspectory i statyczne placeholdery runtime są usuwane w tym samym wdrożeniu.

Rollback może przywrócić poprzednią prezentację z kodu wersji, ale nie może
zapisać nowych danych pod starymi IDs ani zmienić kanonicznych zasobów serwera.

## Obowiązki implementacyjne

- typed snapshots i czyste buildery dla wszystkich pięciu zakładek;
- klasyfikator z fixture finite/open, Γ, fixed k, path i grid;
- run/stage/equilibrium-scoped Results i result context selector;
- kompletne selection refs i routing Inspectorów;
- physics-first Analysis i fail-closed comparison;
- kontekstowy Active Analysis Overlay oraz profesjonalny Inspector modów;
- testy stale/error, hydration, accessibility, desktop/narrow browser smoke,
  WebGL health i stress/lifecycle.

## Walidacja

Decyzję weryfikują testy klasyfikatora, builderów, stabilności ID, selection i
route completeness, Inspectorów, Analysis, overlay oraz resource hooks. Bramki
końcowe obejmują typecheck, lint, API/resource hygiene, architecture checks,
desktop i narrow browser smoke oraz audit instancji ECharts, WebGL, requestów,
observerów, workerów i chart-owned RAF.
