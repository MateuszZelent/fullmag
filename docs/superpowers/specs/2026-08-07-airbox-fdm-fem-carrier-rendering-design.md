# Projekt naprawy renderowania Airboxa FDM/FEM

**Status:** zatwierdzony przez użytkownika 2026-08-07  
**Źródło audytu:** `docs/audits/2026-08-07-airbox-fdm-fem-visualization-regression-audit.md`

## Cel

Przywrócić pełne, fizycznie uczciwe renderowanie meshu Airboxa w trybach
`wireframe` i `points` dla FDM oraz FEM, a następnie potwierdzić wektory
`H_demag` na tym samym carrierze Airboxa.

## Kontrakt produktu

- `Visible` jest nadrzędną bramką Airboxa.
- Podstawowe tryby geometrii Airboxa to `off`, `wireframe` i `points`.
- `Vectors` jest niezależnym overlayem i może działać z `wireframe`, `points`
  albo bez podstawowego passu geometrii.
- Airbox nie otrzymuje magnetycznego surface shadera.
- `Frame/Bounds` jest osobnym passem kontekstowym. Nie wolno przedstawiać
  proceduralnego AABB jako meshu.
- Renderer pozostaje wspólny i domenowo neutralny. Różnice FDM/FEM pozostają
  w adapterach oraz neutralnych modelach renderowania.

## FDM

### Carrier geometrii

Źródłem prawdy jest bieżący structured-grid descriptor oraz zgodna maska FMRM.
Airbox carrier zawiera komórki z `FMRM_INACTIVE_REGION_ID`. Istniejący
`buildFdmCuboidInstanceModel(..., cellSelection: "inactive")` pozostaje jedynym
budowniczym ich centrów, wymiarów i canonical cell ordinals.

Ten sam `FdmCuboidInstanceModel` zasila:

- instanced-cell wireframe;
- punkty w centrach komórek;
- kotwice wektorów `H_demag`;
- picking i diagnostyczne liczniki.

Plan passów musi włączać model inactive cells dla `wireframeVisible`,
`pointsVisible` albo `vectorsVisible`. Sampling pozostaje ograniczony przez
istniejący display budget, deterministyczny i oparty na rzeczywistych ordinalach.

### Frame

`FdmUniverseOutsideSupportLayer` pozostaje właścicielem wyłącznie obrysu
`universeBounds` i `magneticSupportBounds`. Nie rysuje proceduralnych linii
wewnętrznych i nie jest źródłem wireframe meshu.

## FEM

Źródłem prawdy pozostaje manifest i binarna topologia shared-domain.

- `wireframe/full` używa `volumeEdgeIndices`;
- `wireframe/surface` używa `edgeIndices`;
- `points/full` używa `fullNodeSelection` po odjęciu magnetycznych węzłów;
- `points/surface` używa `surfaceNodeSelection` tego samego air-only carriera;
- wektory używają tej samej selekcji i sampled node identity.

Runtime normalization nie może usuwać `pointsVisible`. Proceduralny interior
bounds overlay jest dozwolony tylko jako jawny fallback, gdy brakuje realnych
volume edges. Gdy rzeczywiste krawędzie istnieją, overlay nie jest renderowany.

## Dane pola i proweniencja

HTTP v2 pozostaje źródłem prawdy. WebSocket służy wyłącznie invalidacji.

FDM request:

```text
GET /v2/sessions/current/data/fields/H_demag/samples/vector
  ?component=full&scope_kind=airbox&max_samples=<budget>
```

FEM request dodatkowo niesie dokładny `scope_id` manifestowej części Airboxa.
Payload musi być zgodny pod względem quantity, scope, domain generation,
topology/grid fingerprint, point count i sampled indices. Niezgodność jest
stanem fail-closed; nie wolno użyć stale bufferu ani syntetycznego pola.

## Obsługa stanów niegotowych

- Bez aktualnego FMRM FDM pokazuje co najwyżej jawny Bounds frame i status
  `membership pending`; nie udaje meshu.
- Bez aktualnej topologii FEM zachowuje requested state, ale nie renderuje
  fałszywych points ani mesh edges.
- Brak pola nie usuwa geometrii Airboxa i nie zmienia jej trybu.
- Brak `H_demag` jest raportowany jako unavailable/not materialized.

## Weryfikacja

Testy modelowe muszą przejść cykl RED/GREEN i dowieść:

1. FDM wireframe oraz points żądają inactive-cell geometry.
2. FDM Bounds nie generuje fałszywego meshu o czterech podziałach.
3. FDM wireframe/points/vectors używają tego samego modelu i cell ordinals.
4. FEM runtime zachowuje `pointsVisible`.
5. FEM pełny wireframe preferuje `volumeEdgeIndices` bez proceduralnego
   overlayu, a fallback działa tylko bez realnych krawędzi.
6. FEM points i vectors używają zgodnego air-only node selection.

Browser smoke ma osobno dla FDM i FEM:

- ustawić `wireframe`, wykazać zmianę pikseli i telemetryczny carrier;
- ustawić `points`, wykazać zmianę pikseli i telemetryczny carrier;
- włączyć `H_demag`, wykazać prawidłowy request, przyjęty buffer i widoczne
  glyphy;
- po każdej interakcji potwierdzić widoczny canvas, `isContextLost() === false`
  i niezerowy drawing buffer;
- zapisać screenshoty dowodowe.

## Granica kwalifikacji

Fixture potwierdza frontend i kontrakt transportu, nie naukową kwalifikację
solvera. Produkcyjny dowód `H_demag` wymaga aktualnych sesji FEM i FDM CPU.
FDM GPU pozostaje niezakwalifikowany, dopóki nie publikuje full-domain
observable demag bufferu z parytetem CPU/GPU.
