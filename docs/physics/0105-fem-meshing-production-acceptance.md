# FEM meshing production acceptance

- Status: zaakceptowany kontrakt; pełna kwalifikacja produkcyjna pozostaje nieosiągnięta, dopóki wszystkie wymagane metryki, FMMQ v2 i runtime/browser evidence nie przejdą
- Owners: Fullmag core
- Last updated: 2026-08-27
- Governing ADR: `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`
- Related notes: `docs/physics/0100-mesh-and-region-discretization.md`, `docs/physics/0101-swept-mesh-through-thickness.md`, `docs/physics/0102-airbox-mesh-grading-geometric.md`, `docs/physics/0103-rectangular-waveguide-edge-corner-mesh-refinement.md`, `docs/physics/0104-thin-film-shared-domain-meshing.md`, `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`

(fem-meshing-acceptance-problem-statement)=
## 1. Problem statement

Siatka FEM jest produkcyjna tylko wtedy, gdy authored policy, rozwiązany plan
pól rozmiaru, finalna wspólna siatka solvera i publikowane dowody opisują ten
sam model. Ta nota definiuje jeden gate dla polityki rozmiaru, stref,
topologii, sweep, wzrostu i jakości. Nie promuje obecnej implementacji:
tetrahedralne raporty Gmsh i mixed-P1 certificate są częściowe. Aktywny
writer oraz czytniki FMMQ v1 nie kodują rodziny/topologii komórki; writer
może wyemitować v1 także dla mixed mesh, lecz taki payload nie może
kwalifikować mixed topology. FMMQ v2 pozostaje planowany.

(fem-meshing-acceptance-governing-equations)=
## 2. Governing equations

Nie powstaje nowa energia mikromagnetyczna. Dla punktu fizycznego
$\mathbf x$ zbiór $\mathcal U(\mathbf x)$ zawiera wszystkie uprawnione w danej
strefie górne ograniczenia rozmiaru, a $\mathcal L(\mathbf x)$ wszystkie
uprawnione ograniczenia dolne. Kanoniczny cel jest dokładnie

```{math}
:label: eq-fem-mesh-size-composition

h_\mathrm{target}(\mathbf x)
=\max\!\left(
  \min_{u\in\mathcal U(\mathbf x)}u,
  \max_{\ell\in\mathcal L(\mathbf x)}\ell
\right),
\qquad \min\varnothing=+\infty,\quad\max\varnothing=0.
```

Wynik musi być skończony i dodatni na całej domenie siatkowania. Konflikt
$\max\mathcal L>\min\mathcal U$ wewnątrz tej samej strefy jest błędem przed
Gmsh. Dolne ograniczenie airbox nie jest uprawnione w strefie magnetycznej ani
na interfejsie, więc nie może przysłonić dokładniejszego celu obiektu.

Curvature jest niezależnym źródłem górnym, aktywnym tylko z jawnej polityki:

```{math}
:label: eq-fem-mesh-curvature-source

h_\kappa(\mathbf x)=\kappa R(\mathbf x).
```

Na płaskiej encji albo bez wiarygodnej dodatniej wartości $R$ źródło nie
uczestniczy w $\mathcal U$; nie emituje zera ani sztucznej wartości zastępczej.

Dla sąsiadujących przez pełną ścianę komórek $K,L$ w tym samym grafie growth:

```{math}
:label: eq-fem-mesh-realized-growth

\rho_{KL}=\frac{\max(h_K^\mathrm{edge},h_L^\mathrm{edge})}{\min(h_K^\mathrm{edge},h_L^\mathrm{edge})}.
```

Growth jest ograniczeniem sąsiedztwa, nie far-field maximum. Dla komórki
$K$ numeryczna degeneracja skaluje się z jej rozmiarem:

```{math}
:label: eq-fem-mesh-relative-jacobian-floor

|\det J_K(\boldsymbol\xi_q)|
\le \tau_J (h_K^\mathrm{strict})^3,
\qquad \tau_J=64\,\epsilon_{64}.
```

Każdy ujemny $\det J_K$ jest inwersją niezależnie od wartości progu.

(fem-meshing-acceptance-symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf x$ | punkt fizyczny, w którym rozwiązywana jest polityka | $\mathrm m$ |
| $\mathcal U(\mathbf x)$ | uprawnione górne ograniczenia rozmiaru w punkcie | $\mathrm m$ |
| $\mathcal L(\mathbf x)$ | uprawnione dolne ograniczenia rozmiaru w punkcie | $\mathrm m$ |
| $h_\mathrm{target}(\mathbf x)$ | rozwiązany docelowy rozmiar elementu | $\mathrm m$ |
| $h_\kappa(\mathbf x)$ | niezależny curvature upper target | $\mathrm m$ |
| $\kappa$ | `curvature_factor` | $1$ |
| $R(\mathbf x)$ | dodatni lokalny promień krzywizny | $\mathrm m$ |
| $K,L$ | finalne komórki dzielące pełną ścianę | $1$ |
| $h_K^\mathrm{strict}$ | strict-validation characteristic scale: maximum pairwise vertex distance | $\mathrm m$ |
| $h_K^\mathrm{air}$ | regular-tetrahedron-equivalent size used by current airbox percentile diagnostics | $\mathrm m$ |
| $h_K^\mathrm{edge}$ | maximum canonical-edge size of cell K used by the adjacency growth metric | $\mathrm m$ |
| $h_L^\mathrm{edge}$ | maximum canonical-edge size of cell L used by the adjacency growth metric | $\mathrm m$ |
| $\max$ | algebraic maximum operator | $1$ |
| $\min$ | algebraic minimum operator | $1$ |
| $\rho_{KL}$ | zrealizowany stosunek rozmiarów sąsiadów | $1$ |
| $J_K$ | mapa elementu referencyjnego do fizycznego | $\mathrm m$ |
| $\boldsymbol\xi_q$ | normowany punkt kwadratury referencyjnej | $1$ |
| $\det J_K(\boldsymbol\xi_q)$ | wyznacznik Jacobianu w próbce | $\mathrm{m^3}$ |
| $\tau_J$ | względny próg numerycznej degeneracji | $1$ |
| $\epsilon_{64}$ | machine epsilon IEEE-754 binary64 | $1$ |
| $t$ | fizyczna grubość filmu | $\mathrm m$ |
| $N_z$ | żądana i zrealizowana liczba warstw komórek | $1$ |
| $\tau_\mathrm{plane}$ | tolerancja grupowania płaszczyzn sweep | $\mathrm m$ |
| $q_\mathrm{SICN}$ | signed inverse condition number z określonego producenta | $1$ |
| $q_\gamma$ | gamma quality z określonego producenta | $1$ |
| $q_\mathrm{SJ}$ | topology-aware scaled Jacobian | $1$ |
| $V_K$ | dodatnia objętość fizyczna komórki | $\mathrm{m^3}$ |
| $d_K$ | odległość centroidu komórki od właściciela danej strefy | $\mathrm m$ |

(fem-meshing-acceptance-assumptions-and-validity)=
## 4. Assumptions and validity

### 4.1 Strefy i ownership

Rozwiązanie polityki używa rozłącznych ról, choć ich geometryczne zasięgi mogą
się przecinać:

| Strefa | Właściciel | Dozwolone źródła | Niedozwolony skutek |
|---|---|---|---|
| magnetic bulk | obiekt magnetyczny | object maximum/minimum, narrow region | airbox minimum nie może coarsen |
| material/interface | obiekt/region/interfejs | interface target, region target, curvature | brak anonimowego splitu materiału |
| surface shell | obiekt | surface target i transition | brak zmiany fizyki powierzchni |
| edge | obiekt | edge target/extent/growth | brak automatycznego rozszerzenia na wszystkie krawędzie sceny |
| corner | obiekt | corner target/extent/growth | brak dziedziczenia edge bez jawnego loweringu convenience API |
| transition air | universe + sąsiadujący obiekt | surface/edge/corner plume, air growth | brak body-only restriction dla air-side plume |
| far air | universe | airbox maximum/minimum/growth | brak wpływu na interface triangulation |
| boundary layer | jawny selector | count, first thickness, stretching | nierozwiązany selector blokuje build |
| swept layer | obiekt | topology, direction, distribution, exact count | brak cichego prism-to-tet w strict mode |

Finalny solve zawsze zużywa jedną conforming shared-domain mesh. `Universe`
nie jest obiektem magnetycznym. Region z mesh-only policy nie staje się
materiałem ani niezależnym polem magnetyzacji.

### 4.2 Exact layers a struktura in-plane

`exact_layers=N_z` oznacza dokładnie $N_z$ trójwymiarowych warstw komórek i
$N_z+1$ płaszczyzn wzdłuż osi sweep, z
$\tau_\mathrm{plane}=\max(10^{-15}\,\mathrm m,10^{-8}t)$. Nie oznacza
Cartesian, tensor-product ani mapped in-plane mesh. Triangularna, również
nieustrukturyzowana siatka source face może być wyciągnięta do dokładnych
`prism6`. Structured in-plane jest osobną, obecnie niezaimplementowaną
semantyką i nie wolno jej wywnioskować z `swept`, `fixed` lub `prismatic`.


### 4.3 Mirrored periodic seam v6

Gdy shared-domain mesh deklaruje okresowość FEM, acceptance wymaga dokładnej
bijekcji zbiorów węzłów dla każdej pary markerów ścian. Pary muszą zachować po
translacji topologię wierzchołków, pole, orientację, przeciwne normalne,
ownership domeny elementu i object-region. Dla wielu osi wymagane są domknięte,
niezależne od kolejności klasy równoważności krawędzi i naroży; nearest-centroid
match ani sama lista residual pairs nie stanowią dowodu. Certificate v6 jest
związany z bieżącym topology fingerprint oraz identities region/material przed
assembly solvera. Brak bijekcji, niezgodny fingerprint lub niezamknięta klasa
jest hard failure.

### 4.4 Adaptive-estimator truthfulness

- FEM relaxation adaptivity może używać tylko jawnie nazwanego estymatora:
  `energy_delta`, `max_torque_delta` albo `solution_change`.
- `eigenfrequency_delta` pozostaje unsupported, dopóki aktywny stage nie
  publikuje rzeczywistej obserwabli eigenfrequency i jej estymatora. Musi fail
  closed; zmiana energii nie jest estymatorem częstotliwości własnej.
- Każdy zaakceptowany pass zapisuje requested criterion oraz resolved estimator
  w runtime provenance. Pass zmieniający topology wymaga także state-transfer
  i mesh-certificate gates z tej noty.

### 4.5 Interaktywne budżety ArchWaveguide

Domyślny interaktywny `examples/arch_waveguide_relax_50nm.py` musi
materializować się poniżej 75 000 węzłów i 450 000 tetrahedrów, bez
automatycznego coarsening przed jawnym poleceniem compute. Jeżeli aktywna jest
legacy dense-demag realization, musi także zmieścić się w skonfigurowanym
interaktywnym budżecie RAM. Kanoniczny przykład używa `poisson_robin`, więc
legacy dense-FEM RAM warning nie ma do niego zastosowania. Zmiana któregokolwiek
limitu wymaga w tym samym commit measured evidence: starego i nowego limitu,
fixture, wall time, node count, tetrahedron count i RAM estimate.

(fem-meshing-acceptance-python-api)=
## 5. Python API

Ta nota nie dodaje nowych parametrów. Dwa istniejące przełączniki dowodów są:

| Python | Typ | Default | SI | Walidacja i błąd | Znaczenie | Backend | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.configure.compute_quality` | `bool \| None` | `None` | $1$ | zamierzony kontrakt: `bool` lub `None`; bieżący `configure` nie waliduje typu i zapisuje wartość bezpośrednio; planowany `TypeError` przed lowering | żąda summary jakości po meshing | FEM CPU/GPU; FDM N/A | `runtime_metadata.mesh_workflow.per_geometry[].compute_quality` | `packages/fullmag-py/src/fullmag/world.py::class GeometryMeshHandle` |
| `GeometryMeshHandle.configure.per_element_quality` | `bool \| None` | `None` | $1$ | zamierzony kontrakt: `bool` lub `None`; bieżący `configure` nie waliduje typu; planowany `TypeError`; `True` jest wymagane dla per-element artifact | żąda per-element arrays; samo ustawienie nie dowodzi FMMQ v2 | FEM CPU/GPU; FDM N/A | `runtime_metadata.mesh_workflow.per_geometry[].per_element_quality` | `packages/fullmag-py/src/fullmag/world.py::class GeometryMeshHandle` |

```python
# %% Author requested mesh evidence; this does not claim production qualification.
import fullmag as fm

fm.reset()
study = fm.study("mesh-acceptance")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(120e-9, 80e-9, 60e-9))
study.universe.mesh(
    maximum_element_size=20e-9,
    minimum_element_size=2e-9,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)
film = study.geometry(fm.Box(size=(24e-9, 12e-9, 3e-9)), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(
    maximum_element_size=3e-9,
    minimum_element_size=1e-9,
    curvature_factor=0.5,
    compute_quality=True,
    per_element_quality=True,
)
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

(fem-meshing-acceptance-problem-ir)=
## 6. ProblemIR

Requested policy stays in `runtime_metadata.mesh_workflow`; realized topology
and reports stay in `geometry_assets.fem_domain_mesh_asset` and runtime
provenance. V04 adopts these meanings only through the one atomic writer
cutover from ADR 0024/0027. Until then v0.3 is the canonical public writer;
V04 reader/migrator code is not a second editable model.

(fem-meshing-acceptance-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Python and UI preserve **requested intent** without replacing it by measured
values. Planning publishes **resolved execution**: selected zones, fields,
topology, metric IDs, producer versions, and degradation. Validation errors
reject malformed SI values, conflicts, incomplete sweep tuples, and invalid
selectors. Unsupported combinations reject before backend startup; strict
mode never auto-converts topology or falls back device/solver.

Missing required evidence is `not_qualified`, not `passed`. Non-finite values,
unknown metric/version, wrong topology family, stale fingerprint/revision,
duplicate/missing global ordinal, count mismatch, inversion, or missing sample
is a hard failure. A proxy receives its own metric ID; it cannot satisfy a gate
named for SICN, gamma, volume, or another metric.

(fem-meshing-acceptance-discrete-realization)=
## 8. Discrete realization and metric registry

### 8.1 Lane matrix

| Solver | Device | Status |
|---|---|---|
| FDM | CPU | not applicable: regular-grid quality has a separate grid certificate |
| FDM | GPU | not applicable: regular-grid quality has a separate grid certificate |
| FEM | CPU | documented; tetra summaries and bounded mixed certificate exist, full production gate pending |
| FEM | GPU | same mesh contract; device/runtime proof is independent and pending where noted |

### 8.2 Normative sampling and tolerances

Gate calculations use every final cell/facet/adjacency in scope; no random or
display-only subsampling is admissible. Percentiles use the sorted binary64
array and linear interpolation at index $(n-1)p$. Histograms are diagnostics
with at least 30 bins and never replace the underlying array.

| Metric ID | Scope i punkty próbkowania | Tolerancja / acceptance | Failure semantics | Stan implementacji |
|---|---|---|---|---|
| `topology.manifold.v1` | wszystkie canonical faces z posortowanych global node IDs | interior owner count $=2$, exterior $=1$, duplicates/orphans $=0$ | dowolna różnica fail | implemented dla istniejących certificate paths |
| `topology.exact_layers.v1` | wszystkie magnetic nodes, grupowanie współrzędnej normalnej przez $\tau_\mathrm{plane}$ | requested $=$ realized $=N_z$ i planes $=N_z+1$ | brak/wrong plane lub fallback fail | bounded mixed-P1 implemented, szersze scope unsupported |
| `cell.strict_scale.max_pairwise_vertex_distance.v1` | każda finalna komórka; maksimum odległości po wszystkich parach jej wierzchołków | skończone $h_K^\mathrm{strict}>0$; bez agregacji lub subsamplingu | missing/non-finite/non-positive fail | implemented w `MeshData.validate_strict` |
| `cell.det_jacobian.v1` | tet: jeden stały affine determinant; prism: 3 triangle points $\times\{\pm1/\sqrt3\}$; pyramid: $r,s\in\{\pm1/\sqrt3\}$ i $t=1/3\pm\sqrt{10}/15$; hex: $2^3$ Gauss points | wszystkie determinants $>\tau_J(h_K^\mathrm{strict})^3$; każdy negative fail niezależnie od progu | missing/non-finite/non-positive fail | topology-aware certificate path implemented |
| `gmsh.min_sicn.v1` | wszystkie finalne element tags obsługiwane przez Gmsh, `minSICN` | p05 $\ge0.1$ i minimum $>0$ | inny producer/proxy nie spełnia gate | per-family summaries obejmują obsługiwane rodziny; mixed production evidence nie jest FMMQ v2 |
| `gmsh.gamma.v1` | wszystkie finalne element tags, Gmsh `gamma` | minimum $\ge0.08$ | brak per-element array daje `not_qualified` | per-family availability jawnie pomija pyramid5 i hex8; taki scope nie spełnia pełnego gate'u gamma |
| `mixed_topology_scaled_jacobian.v1` | `tet4`: affine map; `prism6`/`pyramid5`: mapowany Jacobian w jawnych punktach kwadratury danej topologii | per-family p05 $\ge0.1$ i każde minimum $>0$; signed Jacobian pozostaje osobnym gate'em | nie jest SICN ani tetrahedralnym proxy; każda rodzina jest oceniana w swojej topologii | mixed certificate implemented |
| `cell.volume.v1` | całkowanie mapy na wszystkich komórkach; SI $\mathrm{m^3}$ | $V_K>0$; względny CAD/shared-domain error $\le10^{-8}$ | non-finite/non-positive lub przekroczenie fail | tet + bounded mixed certificate implemented |
| `cell.max_edge.v1` | $h_K^\mathrm{edge}$: maksimum wszystkich canonical edges komórki; agregacja po pełnym scope | object/interface p95 $\le1.25h_\mathrm{target}$ i max $\le1.50h_\mathrm{target}$ | pusty wymagany scope lub przekroczenie fail | kontrakt planowany; obecne tet-equivalent stats nie są tym gate'em |
| `adjacent_size_growth.v1` | każda para komórek dzieląca pełną ścianę w tym samym resolved growth graph | $\rho_{KL}=\max(h_K^\mathrm{edge},h_L^\mathrm{edge})/\min(h_K^\mathrm{edge},h_L^\mathrm{edge})\le g(1+0.05)$ | cross-zone pary są oceniane tylko, gdy plan jawnie łączy ich growth graph; przekroczenie fail | planowany |
| `airbox.regular_tet_equivalent_size.v1` | $h_K^\mathrm{air}=(6\sqrt2|V_K|)^{1/3}$ dla każdej finalnej air cell; bieżący diagnostic, bez mixed-topology claim | wszystkie wartości skończone i dodatnie; percentyle używają pełnego posortowanego binary64 scope | missing/non-finite/non-positive fail; nie spełnia strict-scale ani mixed gate | implemented dla tetra i mixed-family stat reports |
| `airbox.distance_bands.v1` | centroidy air cells w pasmach $[0,0.1d]$, $(0.45d,0.55d]$, $(0.9d,d]$ osobno dla surface, edge, corner i każdej strony bbox | każde wymagane pasmo niepuste; p50/p95 size niemaleją z tolerancją $5\%$; far p95 w $[0.75h_\mathrm{air,max},1.25h_\mathrm{air,max}]$ | puste pasmo, odwrócony trend lub brak corner/side coverage fail | częściowe testy istnieją; pełny raport/gate planowany |
| `evidence.identity.v1` | wszystkie element ordinals i payload sections | dokładna zgodność count, order, topology fingerprint, mesh revision i metric metadata | stale/duplicate/missing/tampered fail | JSON certificate częściowo; FMMQ v2 planowany |

Gmsh `Mesh.CharacteristicLengthMin` jest wyłącznie implementacyjną obwiednią.
Nie może zastąpić strefowego $\max\mathcal L$ ani przyciąć lokalnego upper
target. `airbox.regular_tet_equivalent_size.v1` jest jawnie
tetra-equivalent diagnostic, nie `cell.max_edge.v1` i nie mixed-topology gate.

Autorskie `growth_rate` w `mesh_options` jest wskazówką gradacji Gmsh
(`Mesh.SmoothRatio`), a nie kontraktem $\rho_{KL}\le g(1+0.05)$. Gmsh nie
ogranicza ilorazu sąsiadów: dla dwóch sfer ($h_\mathrm{max}=10$ nm,
$h_\mathrm{air}=30$ nm) $\max\rho_{KL}\approx2.2$–$2.6$ przy $g=1.3$, $1.8$ i $3.0$,
a p95 $\approx1.39$ niezależnie od $g$. Dlatego `_mesh_result_payload` dla
samego `growth_rate` publikuje `adjacent_size_growth` jako diagnostykę
(`enforced: false`), bez blokowania builda. Twardy gate (tolerancja 0,
wymagane pary) działa tylko na jawne żądanie kwalifikacji
`enforce_growth_gate: true`. Gate z tej tabeli, związany z
`growth.max_neighbor_ratio` w `fem_mesh_policy.v1`, pozostaje planowany.

### 8.3 Mixed-mesh statistics and metric availability

The bounded mesh-statistics report covers supported linear `tet4`, `prism6`,
`pyramid5`, and `hex8` cells globally and by marker. Cell volume is reported in
SI $\mathrm{m^3}$ using the canonical tetrahedral decomposition. For planar-faced
linear cells this is the polyhedral volume; for warped quadrilateral faces it
is the decomposition volume and is not claimed to be the exact isoparametric
integral. Orientation and exact-zero degeneracy counts
for non-tetrahedra use the topology-specific Jacobian samples from
`cell.det_jacobian.v1`; these diagnostics are sampled and do not prove positive
Jacobian everywhere. Edge-length summaries include each family's canonical
edges, without face/body diagonals. Node counts are the unique nodes referenced
by cells in the selected scope.

`characteristic_size` remains the equivalent regular-tetrahedron diagnostic
$h_\mathrm{eq}=(6\sqrt{2}|V_K|)^{1/3}$ for every family. The report labels this
definition explicitly; it is not a mixed-cell edge measure or a substitute for
`cell.max_edge.v1`.

Each global or marker scope also publishes volume and canonical-edge-length
histograms in SI units ($\mathrm{m^3}$ and $\mathrm m$). Their counts represent
cells and per-cell canonical edges, respectively. Positive nonconstant ranges
use up to 30 logarithmic bins; constant or numerically indistinguishable ranges
collapse to one bin. The edge histogram uses a bounded second pass over the
same chunked canonical-edge samples as the summary statistics.

Per-family `minSICN` and `gamma` summaries retain Gmsh provenance. Gmsh defines
SICN across supported 2D and 3D element families; its `gamma` metric is defined
for simplices and prisms, but not pyramids or hexahedra. Those families therefore
publish `gamma` as unavailable instead of inserting a numeric placeholder. A
scope containing any unsupported family has no scope-wide `gamma` value, while
its available per-family metrics remain visible. A topology-aware scaled
Jacobian appears in a marker scope only when the certificate covers that
marker and the family occurs exclusively there. The certificate's family
minimum and p05 remain mesh-wide summaries when that family spans markers;
marker counts alone do not partition those metrics. These descriptive
summaries do not certify the FMMQ v2 production gates or change their sampling
and acceptance rules.

Starszy format `per_domain_quality` wymaga kompletnego pokrycia markerów i ich
liczności. Jeżeli choć jeden marker nie ma pełnej obsługiwanej metryki gamma,
publikacja pomija cały starszy format zamiast emitować niekompletny podzbiór.
Nie usuwa to bogatych `mesh_statistics` ani dostępnych metryk per-family;
nie wprowadza również sztucznych wartości gamma.

W ścieżce accepted preparation bogaty raport jest przenoszony przez
`domain_asset.build_report.mesh_statistics`, opcjonalne pole
`FemSharedDomainBuildReportIR`, `FemPlanIR.mesh_build_report` oraz
`FemMeshPayload.build_report`. Samo `mesh_statistics` na najwyższym poziomie
JSON siatki nie stanowi tego kontraktu: starszy typowany `MeshIR` pomija
nieznane pola. API odczytuje raport przypisany do bieżącej siatki przed
starszymi diagnostykami workspace, a endpoint Airboxa wybiera wyłącznie
scope markera 0. Brak nowego pola pozostaje zgodny ze starszymi artefaktami
i uruchamia dotychczasowy fallback geometrii, bez tworzenia metryk Gmsh.

Mapowanie fizycznych grup Gmsh na markery semantyczne musi być identyczne
dla topologii i raportów jakości. W szczególności nazwy `air` i `airbox`
oznaczają marker 0 niezależnie od surowego numeru grupy fizycznej. Surowe
numery pozostają podstawą wykrywania nakładających się grup; normalizacja
nie może ukrywać konfliktu przypisania elementu.

The mixed-v2 Gmsh producer extracts these metrics when quality computation is
requested and converts its scaled-coordinate volume channels back to SI before
attaching them to `MeshData`. Marker reports are rekeyed only when the final
classification is a one-to-one relabel of complete source-marker scopes. For a
split or merge, aligned per-cell SICN and volume arrays are regrouped by the
final marker when available; a metric without aligned samples remains
unavailable for that scope. If `oriented_copy` changes cell connectivity, it
drops the signed quality report and topology certificate so that stale
orientation-dependent values cannot be published.

The metric availability statements follow the [Gmsh reference manual's mesh
quality section](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-quality).

(fem-meshing-acceptance-implementation-mapping)=
## 9. Implementation mapping

- `GeometryMeshHandle.configure` jest aktualnym publicznym ownerem parametrów.
- `resolve_user_mesh_size_controls` rozwiązuje bieżące COMSOL-like presets.
- `_build_field_stack` składa bieżący plan pól Gmsh; docelowo musi publikować
  dokładną algebrę i strefową eligibility.
- `_extract_quality_metrics` pobiera bieżące Gmsh SICN/gamma/volume.
- `generate_disconnected_mixed_p1_mesh` dołącza żądane przez `MeshOptions`
  metryki Gmsh do mieszanej siatki i przelicza kanały objętości z Gmsh scale do
  SI przed przekazaniem danych.
- `MeshData.statistics_ir` i `_build_mesh_statistics_report` publikują
  ograniczone statystyki globalne i markerowe dla obsługiwanych rodzin komórek;
  `_mesh_cell_geometry` oraz `_mesh_edge_statistics` zachowują ich geometrię
  i krawędzie właściwe danej topologii.
- Dla starszych publikacji bez statystyk `mesh_scope_size_statistics` w API
  używa `mesh_cell_geometry::cell_geometry` z tą samą dekompozycją i listami
  rzeczywistych krawędzi. Publikuje tylko geometrię, nigdy zastępczy SICN,
  Gamma ani certyfikat. Histogramy używają tolerancji względnej względem
  wartości danych, także dla objętości rzędu $10^{-27}\,\mathrm{m}^3$.
- `_quality_by_family_for_scope` odrzuca niezgodne liczności podsumowań rodziny
  i używa ponownie tylko próbek jakości wyrównanych z bieżącą siatką;
  `_certificate_scaled_jacobian_for_scope` pokazuje mesh-wide minimum i p05 w
  markerze tylko wtedy, gdy cała rodzina występuje wyłącznie w tym markerze.
- `_size_histogram_bins` ustala bins volume i characteristic size w zakresie
  danych, a `_mesh_edge_histogram_bins` agreguje canonical-edge bins porcjami.
- `_rekey_per_domain_quality_for_markers` zachowuje raporty tylko przy dokładnej
  bijekcji markerów, `_quality_reports_for_final_mixed_markers` grupuje dostępne
  tablice według finalnych markerów, a `MeshData.oriented_copy` unieważnia
  raporty po zmianie orientacji connectivity.
- `_cell_jacobian_determinants` implementuje jawne topology sampling points, a
  `_mixed_cell_scaled_jacobians` oblicza wersjonowany metric
  `mixed_topology_scaled_jacobian.v1` bez rozkładania prism/pyramid na
  zastępcze tetraedry.
- `_write_quality_data_artifact_if_available` jest aktywnym writerem FMMQ v1; nie koduje family/topology i nie ma mixed guard.
- `decodeMeshQualityData` oraz Rust `per_element_quality_metric_from_fmmq` są aktywnymi czytnikami v1. UI `topologySupportsTet4FmmqQuality` jest osobną ochroną prezentacji, nie cechą ani guardem formatu.

(fem-meshing-acceptance-validation)=
## 10. Validation

Gate dokumentacyjny i kontraktowy obejmuje source-map validator, changed-page
gate i testy walidatora. Gate produkcyjny pozostaje
`just verify-fem-meshing-production`, ale przejście obecnej receptury nie może
promować pełnej polityki z tej noty, dopóki nie zawiera `cell.max_edge.v1`,
`adjacent_size_growth.v1`, pełnych airbox bands, FMMQ v2, managed native runtime
i browser/WebGL evidence związanych tym samym fingerprintem.

Macierz realizacji obejmuje Box, flat/curved ArchWaveguide, Cylinder,
multi-object, component-aware i concatenated STL fallback, bbox/spherical
airbox oraz bounded mixed-P1. Każdy wiersz publikuje `passed`, `degraded`,
`unsupported` albo `failed`; brak raportu nie jest sukcesem.


### 10.1 Pełna macierz S1-S13

| ID | Geometry / workflow | Airbox | Required result |
|---|---|---|---|
| S1 | `fm.Box` thin film, one magnetic object | bbox | air-side surface, edge, and corner refinement active; object and airbox statistics separate |
| S2 | flat `fm.ArchWaveguide(arch_height=0)` | bbox | box-like lowering preserves one-through-thickness intent and stable air grading |
| S3 | curved `fm.ArchWaveguide(arch_height>0)` | bbox | geometric surface/edge/corner fields realized without body-only restriction |
| S4 | `fm.Cylinder` | bbox | curved sidewall and top/bottom edges give smooth air-side grading without interface coarsening |
| S5 | multi-object box + cylinder | bbox | per-object targets remain independent; airbox follows the finest eligible local target |
| S6 | imported STL component-aware path | bbox | realized/degraded operations reported without secondary planner exceptions |
| S7 | imported STL concatenated fallback | bbox | unsupported component-only fields use an explicit approximation or degraded status |
| S8 | coarse airbox maximum plus fine object target | bbox | interface p95 respects object target; populated far/corner bands approach airbox target |
| S9 | spherical airbox | sphere | radial grading implemented and tested, otherwise scenario is unsupported |
| S10 | swept/thin-film strategy | bbox | metric provenance truthful; proxy is never mislabeled SICN |
| S11 | Control Room mesh diagnostics | bbox | scoped counts/histograms and selected-bin highlighting exposed through typed API/UI |
| S12 | `examples/arch_waveguide_relax_50nm.py` | bbox | no fallback crash or silent coarsen; passes explicit node/tet/RAM budget |
| S13 | axis-aligned Box, native mixed P1, one magnetic layer | bbox | note-0106 gates: prism-only magnet, pyramid/tet-only air, exact two-plane certificate, conforming manifold, no fallback |

### 10.2 Wymagane obserwable API/UI

Każda produkcyjna siatka publikuje w logach, mesh IR, typed API resource i —
gdy dotyczy — Control Room: requested i realized mesh controls; total counts
węzłów, elementów i boundary faces; cell/facet counts według canonical topology
i regionu; per-part counts; magnetic-air interface i outer-airbox face counts;
characteristic-size oraz edge-length histograms (co najmniej 30 bins); quality
histogram z metric/producer/version; worst-element samples; global element/node
ordinals dla zaznaczonego histogram bin; degraded operation statuses; topology
fingerprint, mesh revision i evidence identity. UI nie może rekonstruować tych
wartości z display geometry ani podmieniać brakującego payloadu zerami.

### 10.3 Pełny release gate

Produkcyjną kwalifikację może nadać wyłącznie:

```bash
just verify-fem-meshing-production
```

Receptura musi wykonać Python meshing tests i Python API/round-trip tests, Rust
IR/planner/API tests, OpenAPI generation z clean-diff check, frontend lint,
typecheck i tests, browser/WebGL viewport smoke z widocznym canvas, żywym
context i niezerowym drawing buffer, managed native FEM CPU/GPU runtime proof
dla deklarowanych lanes oraz końcowy `git diff --check`. Pominięty składnik,
synthetic-only oracle albo niepowiązany fingerprint daje `not_qualified`.

(fem-meshing-acceptance-limitations)=
## 11. Limitations

- FMMQ v2 i topology-aware per-element mixed quality carrier nie są jeszcze
  zaimplementowane.
- Aktywny FMMQ v1 writer może zapisać również mixed mesh, a czytniki dekodują layout v1, ale format nie zawiera family/topology identity i dlatego nie może kwalifikować mixed topology. V1 można wycofać dopiero po odcięciu wszystkich writerów v1 i migracji wymaganych konsumentów.
- Pełne growth/size/airbox gates z tabeli są kontraktem implementacyjnym, nie
  opisem obecnego production-qualified runtime.
- Arbitrary invalid/non-manifold CAD repair, anisotropic user fields i hybrid
  FEM/FDM projection pozostają poza zakresem.
- Exact layers nie zapewniają structured in-plane mesh.

(fem-meshing-acceptance-scientific-bibliography)=
## 12. Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh
  generator with built-in pre- and post-processing facilities,” *International
  Journal for Numerical Methods in Engineering* 79(11), 2009,
  <https://doi.org/10.1002/nme.2579>.
- P. M. Knupp, “Algebraic mesh quality metrics,” *SIAM Journal on Scientific
  Computing* 23(1), 2001, <https://doi.org/10.1137/S1064827500371499>.
- Gmsh 4.15.2 reference manual, mesh quality and background fields,
  <https://gmsh.info/doc/texinfo/gmsh.html>.

(fem-meshing-acceptance-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| Public policy | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | authoring, validation, requested mesh metadata | FEM CPU/GPU | implemented source contract |
| Size controls | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `resolve_user_mesh_size_controls` | current preset and COMSOL-like control resolution | FEM CPU/GPU | implemented, canonical zone algebra pending |
| Field stack | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_build_field_stack` | current deterministic size-field descriptors | FEM CPU/GPU | implemented, complete evidence pending |
| Gmsh metrics | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_extract_quality_metrics` | current SICN/gamma/volume extraction | FEM CPU/GPU | implemented for current report path |
| Jacobian sampling | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `_cell_jacobian_determinants` | topology-aware determinant samples | FEM CPU/GPU | implemented certificate evidence |
| Legacy marker quality serialization | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `_legacy_per_domain_quality_is_complete` | permits the gamma-bearing legacy map only for complete, count-aligned, gamma-eligible Gmsh marker reports | FEM CPU/GPU | implemented; mixed family metrics remain in `mesh_statistics` |
| FMMQ v1 writer | `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py` | `_write_quality_data_artifact_if_available` | writes active FMMQ v1 arrays without family/topology identity | FEM CPU/GPU transport | implemented v1; v2 planned |
| FMMQ v1 TS reader | `apps/control-room/src/kernel/api/codecs/meshQualityDataCodec.ts` | `decodeMeshQualityData` | decodes active v1 layout; format identity is insufficient for mixed qualification | unified Control Room | implemented v1; v2 planned |
| FMMQ v1 Rust reader | `crates/fullmag-api/src/fem_cross_section.rs` | `per_element_quality_metric_from_fmmq` | reads active v1 per-element arrays | API | implemented v1; v2 planned |
| Strict characteristic scale | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `validate_strict` | computes maximum pairwise vertex distance and relative determinant floor | FEM meshing | implemented |
| Canonical planned policy | `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` | `DOC-ANCHOR:canonical-fem-mesh-policy` | accepted upper/lower, zones, curvature, sweep and quality decision | cross-layer | planned contract |
| Planned FMMQ v2 | `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` | `DOC-ANCHOR:fmmq-v2-contract` | typed per-family quality transport and v1 exit criteria | API/Control Room | planned contract |


(fem-object-mesh-by-id)=
## Publiczne per-object mesh przez immutable ID

**Zaimplementowany authoring i round-trip; source-only Gmsh proof, bez solver qualification.**
`study.objects.mesh.by_id(object_id)` wybiera jawnie zarejestrowany obiekt
magnetyczny lub pomocniczy i zwraca istniejący `GeometryMeshHandle`.
Nie tworzy magnetu, materiału, magnetyzacji ani nowego solvera. Dotychczasowe
`study.geometry_object` i `study.antenna_object` nadal zwracają surową geometrię.
To dostęp do istniejącej per-object recipe; równania i polityka jakości powyżej
pozostają bez zmian.

| Publiczny parametr | Typ/default | SI | Walidacja i znaczenie | ProblemIR |
|---|---|---|---|---|
| `StudyObjectsMeshHandle.by_id.object_id` | `str`, required | $1$ | dokładny niepusty immutable ID w aktywnym study; nie lookup po nazwie; zły typ/blank/unknown/niejednoznaczny ID odmawia; zwraca GeometryMeshHandle | lookup object identity; recipe `runtime_metadata.mesh_workflow.per_geometry[]` używa rzeczywistego geometry name |
| `GeometryMeshHandle.configure.maximum_element_size` | `float` lub `None`, dotychczasowy default | $\mathrm m$ | dotychczasowa dodatnia skończona wartość i walidacja configure; override obiektu | `.per_geometry[].maximum_element_size` i canonical alias hmax |
| `GeometryMeshHandle.configure.minimum_element_size` | `float` lub `None`, dotychczasowy default | $\mathrm m$ | dotychczasowa walidacja configure i hmin/hmax; floor obiektu | `.per_geometry[].minimum_element_size` i hmin |
| `GeometryMeshHandle.configure.order` | `int` lub `None`, dotychczasowy default | $1$ | dotychczasowy supported order; nie zmiana physical model | `.per_geometry[].order` |

Pozostałe existing GeometryMeshHandle controls zachowują ten sam serializer,
walidację oraz ograniczenia meshing; ta zmiana nie dodaje parameter dialect.
Wywołanie/configure zwraca mesh handle, pozwalając dotychczasowe chaining.
Handle z innego authoring context odmawia. Ponowny lookup tego samego ID
widzi tę samą recipe. Rozdzielone ID/name zachowują swoje znaczenie.

```python
# %% Existing public authoring, no auxiliary physics activation
import fullmag as fm
study = fm.study("independent_sampling_mesh")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.geometry_object(fm.Box(80e-9, 80e-9, 80e-9),
                      name="Sampling volume", object_id="sampling")
study.objects.mesh.by_id("sampling")(
    maximum_element_size=150e-9, minimum_element_size=150e-9, order=1,
)
```

Fragment pokazuje istniejący authoring, bez etapu solvera ani deklaracji wyniku.
Scene `object_mesh`/`mesh_override` przechodzi do builder geometry.mesh,
następnie eksport emituje `study.objects.mesh.by_id(exact_id)(...)` również dla
nonmagnetic geometry. Canonical export/reimport zachowuje per_geometry intent,
nie aktywuje physics przez type/name. Existing precedence to per-object recipe,
per_geometry, default_mesh, FEM hints; sampling override nie zmienia source
recipe. Wszystkie controls muszą wejść do cache/provenance istniejącą ścieżką.
Nie dopisujemy ręcznie prywatnych metadata do Problem.

| Lane | Znaczenie nowego lookup |
|---|---|
| FEM CPU | authoring istniejącej per-object recipe; interpretowany Gmsh 4.15.2, jeden wątek, proof poniżej |
| FEM GPU | identyczny authoring; brak nowej runtime/GPU qualification |
| FDM CPU | istniejące cell_size/mesh restrictions; brak nowego FEM solve |
| FDM GPU | ten sam authoring, existing backend gates; brak silent fallback |

Walidacja: exact ID odmowy i context lifetime; raw geometry return unchanged;
magnetic oraz auxiliary recipe; Scene/Python/IR round-trip. Trzy poziomy źródła z jawnym `minimum_element_size = maximum_element_size`
0.15/0.10/0.075 um oraz osobnym sampling override 0.15 um mają zachować bitowo
identyczne sampling XYZ i ordered Tet4, podczas gdy rzeczywista source mesh
się zmienia. Samo `maximum_element_size` jest górną granicą i nie gwarantuje
zmiany liczby komórek, jeśli Gmsh już generuje drobniejszą siatkę. Test przechodzi
przez publiczne `Problem.to_ir(include_geometry_assets=True)`. Nie jest to scientific V/J/H convergence ani kwalifikacja basis.
API resources/endpoint/schema nie zmieniają się: istniejący per-object mesh
intent pozostaje canonical resource semantics.

Mapa przed implementacją: `packages/fullmag-py/src/fullmag/world.py::StudyObjectsMeshHandle`,
`GeometryMeshHandle`, `_collect_mesh_workflow_metadata`;
`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py::realize_fem_mesh_asset`;
`packages/fullmag-py/src/fullmag/runtime/script_builder.py::_study_geometry_mesh_configs`;
`docs/specs/mesh-roundtrip-semantics-v1.md::DOC-ANCHOR:mesh-object-id-recipe`.
Nowa metoda jest zaimplementowana; physics/current carrier/basis pozostają poza tym dowodem.

Weryfikacja `packages/fullmag-py/tests/test_auxiliary_geometry_mesh.py` wykonuje
canonical public script → loader → Python export/reimport oraz Scene export/reimport.
Sprawdza ID różne od nazw, unknown/blank/type/ambiguous ID, lifetime context,
magnet API i raw auxiliary geometry returns, default inheritance oraz pełną recipe.
Gmsh test `test_independent_auxiliary_gmsh_mesh_across_source_levels` porównuje
bitowo `nodes`, `cell_nodes`, `cell_types` dla stałego sampling i trzech source
hlevels. `FULLMAG_GMSH_THREADS=1` jest jawny warunek deterministycznego dowodu;
domyślna wielowątkowa realizacja wykazała zmienne ordering/coords i nie otrzymuje
tej kwalifikacji. Nie wykonano V/J/H, field solve, Relax/Run ani native build.

| Roszczenie | Ścieżka | Symbol | Status |
|---|---|---|---|
| ID lookup bez physics | `packages/fullmag-py/src/fullmag/world.py` | `class StudyObjectsMeshHandle` | implemented authoring |
| Prywatny auxiliary owner | `packages/fullmag-py/src/fullmag/world.py` | `class _AuxiliaryMeshOwner` | implemented mesh state only |
| Canonical export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_study_geometry_mesh_configs` | Python i Scene round-trip green |
| Bitowa niezależność sampling | `packages/fullmag-py/tests/test_auxiliary_geometry_mesh.py` | `test_independent_auxiliary_gmsh_mesh_across_source_levels` | executed Gmsh, one thread |
| API lifetime/ambiguity | `packages/fullmag-py/tests/test_auxiliary_geometry_mesh.py` | `test_mesh_context_lifetime_and_ambiguous_identity` | executed Python |
| Round-trip spec | `docs/specs/mesh-roundtrip-semantics-v1.md` | `DOC-ANCHOR:mesh-object-id-recipe` | canonical contract |


| Publiczny parametr | Typ | Default | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| StudyObjectsMeshHandle.by_id.object_id | str | required | 1 | exact nonempty registered immutable ID; rejects wrong type, blank, unknown or ambiguous identity | wybór istniejącej recipe magnetycznego lub pomocniczego obiektu bez aktywacji fizyki | shared authoring FEM/FDM CPU/GPU; existing mesh gates remain | runtime_metadata.mesh_workflow.per_geometry[] keyed by actual geometry name |


(fem-recursive-boundary-qualification)=
## Geometry-only: prerejestracja dokładnej granicy i recursive lattice seeds

**Stan: `planned_contract`; nowe seeds, triangulacja, volume fill i kwalifikacja
FEM są `NOT_VERIFIED`.** Metoda poniżej jest zamkniętym kontraktem przyszłego
storage-only eksperymentu dla pełnego trójwymiarowego microstrip z taperem.
Nie zmienia geometrii authored, materiałów, source cut, probes ani żadnego
produkcyjnego progu z sekcji 8.2. Nie stanowi solvera prądu ani modelu 2.5D.
Pozytywny geometry-only receipt nie nadaje siatce statusu produkcyjnego.

### Problem, wejścia i granice stosowalności

Wejście jest przypiętym ledgerem CAD ancestry: 160 wypukłych czworokątnych
faces, 36 cells, 228 unikalnych shared curves, 104 authored anchors oraz
548 primitive steps: 228 curves i 320 chart axes. Współrzędne pochodzą z
rzeczywistych authored binary64 corners; nie wolno zastępować ich wygodniejszymi
literałami dziesiętnymi. Każdy face zachowuje parents, material part i orientację
cell incidence. Wspólną krzywą materializuje się raz, z odwróceniem kolejności
connectivity dla przeciwnego ownera. Dwa owners source-cut face muszą pochodzić
z tego samego retained authored cut; nazwa obiektu ani najbliższa płaszczyzna
nie są wystarczającym dowodem.

Obsługiwany chart ma jeden niezerowy składnik normalnej albo dwa o stosunku
wartości bezwzględnych 1:10 oraz jedną wolną oś extrusion. Inna klasa, brak
exact planarity, gcd/line binding albo zmienione authored corner bytes dają
odmowę. Próby obrotu 90° i 45° zachowują osobną dotychczasową odmowę unsupported
normal class; nie deklarujemy covariance na podstawie identity case.
Historyczne v3 ledgery są immutable i nie zostają przepisane jako nowy wynik.

Readonly witness wykazał na `curve/106` generated point jeden ULP od authored
corner: długość segmentu $2^{-72}\,\mathrm m$, nie dwa bliskie authored anchors.
Pełne wyliczenie możliwych trzecich vertices ogranicza squared normalized double
area każdego incydentnego trójkąta do rzędu $10^{-28}$. Jest to wada starej
polityki generated endpoint rank, nie powód do obniżenia determinant/SICN/gamma
floors. Nowa metoda zaczyna od authored endpoints i dobiera wyłącznie rozdzielone
wewnętrzne rank candidates. Nie wykonuje snap, `setNode`, nearest mapping,
projection już wygenerowanych nodes ani przesuwania planes.

### Symbole i jednostki SI

| LaTeX token | Znaczenie | Jednostka SI |
|---|---|---|
| $h_\mathrm{seed}$ | zadany rozmiar jednego poziomu geometry-only eksperymentu | $\mathrm m$ |
| $\delta$ | nieprzekraczalny maksymalny odstęp shared curve i chart axis | $\mathrm m$ |
| $\varepsilon_s$ | minimalna separacja generated points od granicy i innych points na tym face | $\mathrm m$ |
| $\rho_s$ | promień kompletnego ciągłego pokrycia face przez retained nodes | $\mathrm m$ |
| $S$ | skala zapisu współrzędnych względem SI | $1$ |
| $P$ | okres maski admissible integer ranks | $1$ |
| $\mathbf o$ | początek affine lattice line w świecie fizycznym | $\mathrm m$ |
| $\mathbf b$ | przesunięcie fizyczne odpowiadające jednemu integer rank | $\mathrm m$ |
| $r$ | bezwymiarowy parametr rank, rational dla authored endpoint i integer dla generated point | $1$ |
| $\mathbf y(r)$ | dokładny punkt fizyczny affine lattice | $\mathrm m$ |
| $d$ | długość jednego primitive step w normie L1 | $\mathrm m$ |
| $G$ | największy dopuszczalny błąd wyszukiwania względem midpoint celu | $\mathrm m$ |
| $L$ | długość parent segment w normie L1 | $\mathrm m$ |
| $L_c$ | długość child segment w normie L1 | $\mathrm m$ |
| $r_m$ | rational midpoint parametru parent segment, wyłącznie cel wyszukiwania | $1$ |
| $\mathbf U,\mathbf V$ | dokładne fizyczne końce parent segment | $\mathrm m$ |
| $\mathcal B$ | pełna authored granica jednego face | $\mathrm m$ |
| $\mathcal A$ | zbiór już przyjętych interior nodes tego face | $\mathrm m$ |
| $\mathbf p$ | kandydat interior point | $\mathrm m$ |
| $\mathbf Z$ | retained node będący świadkiem pokrycia patch | $\mathrm m$ |
| $\mathbf V_j$ | exact rational vertex diagnostycznego convex patch | $\mathrm m$ |
| $\lambda_j$ | nieujemny współczynnik kombinacji wypukłej vertices patch | $1$ |
| $j$ | indeks vertex diagnostycznego patch | $1$ |
| $\mathcal C$ | clipped convex patch, bez dodawania mesh nodes | $\mathrm m$ |
| $N_\mathrm{curve}$ | upper bound liczby nodes jednej shared curve | $1$ |
| $N_\mathrm{face}$ | upper bound liczby interior candidates jednego face | $1$ |
| $\ell_u,\ell_v$ | physical L1 rozpiętości dwóch niezależnych chart axes | $\mathrm m$ |
| $d_u,d_v$ | primitive L1 step odpowiedniej chart axis | $\mathrm m$ |
| $\sigma_u,\sigma_v$ | dodatnie dolne ograniczenie odstępu greedy chart ranks | $\mathrm m$ |

### Pełne parametry i stałe eksperymentu

Nie są to nowe publiczne parametry Pythona. To stałe wersjonowanej prerejestracji,
walidowane przed kodem i przed każdym przyszłym case; nie dziedziczą defaults
z solvera ani UI.

| Pole kontraktu | Typ / stała | SI | Walidacja, znaczenie i odmowa |
|---|---|---|---|
| `scale` | exact integer, kolejno 1000000 i 1048576 | $1$ | dwie oddzielne lanes; brak mieszania danych lub zmiany scale po odmowie |
| `h_hex` | binary64, `0x1.421f5f40d8376p-23`, `0x1.ad7f29abcaf48p-24`, `0x1.421f5f40d8376p-24` | $\mathrm m$ | dokładnie .15/.10/.075 µm; Fraction z rzeczywistych bits, nie rounded decimal substitute |
| `delta`, `separation`, `coverage_radius` | rational, odpowiednio $h_\mathrm{seed}/4$, $\delta/16$, $\delta$ | $\mathrm m$ | dodatnie; exact squared comparisons; żadnej tolerancji ani powiększania radius |
| `period`, `scalar_tiles`, `rank_tiles` | integer, 32768, 768, 768 | $1$ | sorted unique residues i pełne closed tile bounds; przekroczenie odmawia |
| `curve_depth` | integer, 32 | $1$ | exact preflight $(9/16)^{32}L_\max<\delta_\min$; depth exhaustion odmawia |
| `coverage_depth`, `patch_vertices` | integer, 2 i maksimum 8 | $1$ | skończony clipping tree; brak witness na depth 2 odmawia bez nowych points |
| `node_cap` | integer, 50000 | $1$ | także bardziej ścisły per-case independent precount; żadnego podniesienia po wyniku |
| `integer_bits` | integer, 4096 | $1$ | bound wszystkich rational/integer intermediates, nie tylko final values |
| `case_seconds` | 120 | $\mathrm s$ | jeden owned subprocess; stop first refusal, bez retry zmieniającego contract |
| `private_commit`, `sampled_rss` | integer, każde 268435456 bytes | $1$ | Windows Job i sampled RSS; brak deklaracji peak z samego `len()` |
| `mask_cache_bytes` | integer, 16777216 | $1$ | measured retained capacity, także empty dictionary i wszystkie entries |
| `predicate_calls` | integer, 100000000 per case | $1$ | pełne counters distance/predicates; exhaustion odmawia, nie pomija coverage |
| `witness_hits` | integer, 1000000 per face | $1$ | wszystkie candidate hits, bez przyjmowania pierwszego niezweryfikowanego node |
| `ledger_bytes`, `thin_bytes`, `evidence_bytes` | integer, 33554432/case, 65536/case, 268435456 aggregate | $1$ | bounded binary payloads i thin JSON; overflow daje terminal refusal |
| `curves_nested`, `interior_nested` | boolean, `True`, `False` | $1$ | subset proof dla shared curves; interior niezależne pergrade, bez union wcześniejszych grids |
| `qualification` | literal `NOT_VERIFIED` | $1$ | geometry-only receipt nie aktywuje solve ani production-ready capability |

(fem-recursive-boundary-curve-proof)=
### Exact curve bracketing i dowód odstępów

```{math}
:label: eq-fem-recursive-seed-scales

\delta=\frac{h_\mathrm{seed}}4,\qquad
\varepsilon_s=\frac\delta{16},\qquad \rho_s=\delta.
```

```{math}
:label: eq-fem-recursive-curve-map

\mathbf y(r)=\mathbf o+r\mathbf b,\qquad
 d=\lVert\mathbf b\rVert_1,\qquad
 G=(769P+1)d<\frac\delta{16}.
```

Authored endpoints mogą mieć rational, nieinteger rank. Dla parent $\mathbf U,
\mathbf V$ zaczynamy od ich dokładnych coordinates. Jeżeli $L\le\delta$, segment
pozostaje. Gdy $L>\delta$, target $r_m$ jest połową sumy endpoint ranks; nie
publikujemy samego midpoint jako node. Przeszukujemy tylko otwarty parent
interval: od `floor(r_U)+1` do `ceil(r_V)-1`, intersected z curve rank bounds.

Successor jest najmniejszym admitted rank nie mniejszym niż `ceil(r_m)`;
predecessor największym nie większym niż `floor(r_m)`. Predecessor odwiedza
pełne tiles w odwrotnej kolejności i używa `bisect_right` w sorted residues:
przy braku residue w bloku przechodzi do poprzedniego P-block. Oba query muszą
wykazać pełną minimalność/maximalność przez tile i block bounds. Empty tiles
są zachowane w receipt. Average mask density nie dowodzi istnienia bracket.

Każdy znaleziony kandydat musi być ściśle wewnątrz parent, spełnić
$|r-r_m|d\le G$ oraz pełny niezależny exact RNE/SI/scaled/line/plane verifier.
Wybieramy najmniejszy exact błąd, remis: mniejszy rational curve parameter,
potem integer rank. Brak candidate daje `REFUSED_NO_ADMITTED_MIDPOINT_BRACKET`,
bez endpoint trimming lub float fallback. Rekurencja przebiega left-before-right.

```{math}
:label: eq-fem-recursive-child-spacing

L_c\le\frac L2+G,\qquad
L>\delta\ \Longrightarrow\
L_c>\frac\delta2-G>\frac{7\delta}{16},\qquad
\lVert\mathbf V-\mathbf U\rVert_2\ge
\frac{\lVert\mathbf V-\mathbf U\rVert_1}{\sqrt3}.
```

Zatem dla dzielonego parent długość spada co najmniej w stosunku 9/16, a created
child jest dłuższy niż separacja. Niedzielony authored segment nie jest usuwany:
jeśli jego exact physical length narusza separację, następuje jawna odmowa
jakości authored wejścia. Każdy final segment przechodzi complete consecutive
L1 i Euclidean maxgap check. Middle i fine dziedziczą wszystkie wcześniejsze
**curve** nodes bitowo; nowe splits dotyczą tylko segmentów powyżej nowego
maksimum. Subset checker jest niezależny od konstrukcji. Nonnested interior
meshes nie unieważniają takiej jawnie określonej convergence study.

Readonly independent precount używa actual lengths i primitive steps wszystkich
160 faces/228 curves, nie historycznych seed counts:

```{math}
:label: eq-fem-recursive-seed-precount

N_\mathrm{curve}\le
\left\lfloor\frac{L}{\delta/2-G}\right\rfloor+2,\qquad
\sigma_u=\delta-(769P+2)d_u>0,\quad
\sigma_v=\delta-(769P+2)d_v>0,\qquad
N_\mathrm{face}\le
\left(\left\lfloor\frac{\ell_u}{\sigma_u}\right\rfloor+1\right)
\left(\left\lfloor\frac{\ell_v}{\sigma_v}\right\rfloor+1\right).
```

Dolny odstęp chart wynika z integer floor w istniejącej fixed-K greedy policy;
successor może go powiększyć, nie skrócić. Curve bound dotyczy przyjętych bracket
splits; nie zakłada, że bracket zawsze istnieje. Osobno doliczamy wszystkie 104
anchors, konserwatywnie także gdy są już w curve count.

| Grade, w obu scales | Face candidates upper | Curve nodes upper | Extra anchors | Global upper | Bbox cells upper | Coverage patch visits upper |
|---|---:|---:|---:|---:|---:|---:|
| .15 µm | 10584 | 3994 | 104 | 14682 | 13412 | 281652 |
| .10 µm | 23516 | 5944 | 104 | 29564 | 27672 | 581112 |
| .075 µm | 37599 | 7700 | 104 | 45403 | 42812 | 899052 |

Max face candidate count wynosi 243/533/918. Wszystkie upper są poniżej 50000;
nie dowodzą actual admission, czasu, pokrycia ani dobrej siatki FEM. Finest
coverage może wymagać 899052 patch visits/case; przekroczenie 120 s pozostaje
uczciwą odmową, nie podstawą subsamplingu.

(fem-recursive-boundary-coverage-proof)=
### Interior separation i skończone ciągłe coverage

Interior candidate universe jest istniejącym pergrade chart grid, bez union
wcześniejszych interior sets. Strict halfspace inside, exact point roundtrip
i normal/line binding pozostają obowiązkowe. Chart używa affine world map;
wszystkie distances wykorzystują trzy world coordinates, także dla slope.
Przed przyjęciem candidate obowiązuje

```{math}
:label: eq-fem-recursive-interior-separation

\operatorname{dist}(\mathbf p,\mathcal B)^2\ge\varepsilon_s^2,
\qquad
\lVert\mathbf p-\mathbf Z\rVert_2^2\ge\varepsilon_s^2
\quad\text{dla każdego }\mathbf Z\in\mathcal A.
```

Distance do czterech authored boundary segments wyliczamy przez exact rational
projection parameter clamped do [0,1], bez zmiany candidate. Zapewnia to także
separację od wszystkich boundary nodes. Neighbor grid o width separacji bada
pełne 27 neighboring world cells i exact distances; cell boundary nie może
ukryć pary. Candidates rozpatrujemy w rosnącym chart-rank order. Separation
na unrelated faces nie zastępuje ani nie zmienia fizycznej odległości materiałów.

Coverage nie wynika automatycznie z thinning. Pełne chart ordinates wraz z exact
bbox ends muszą mieć consecutive L1 gap nie większy niż maksimum. Ich cartesian
rectangles pokrywają cały bbox. Każdy przecinamy z authored convex quad przez
exact rational clipping w kolejności `u_min,u_max,v_min,v_max`. Intersection
jest rational; crossing z zerowym denominator odmawia. Diagnostyczny patch ma
najwyżej 8 vertices; nie staje się source mesh face ani zbiorem nowych seeds.

Dla każdego positive-area patch szukamy jednego retained node tego samego face,
który spełnia bound na **wszystkich** patch vertices. Kandydaci pochodzą z
pełnego closed world bbox pierwszego vertex rozszerzonego o promień; każdy
przechodzi exact distance i owner verification. Pierwszy node w sorted ID order
spełniający wszystkie warunki jest świadkiem. Dla nieujemnych weights o sumie
jeden zachodzi

```{math}
:label: eq-fem-recursive-continuous-coverage

\mathcal C=\operatorname{conv}\{\mathbf V_j\},\qquad
\lVert\mathbf V_j-\mathbf Z\rVert_2^2\le\rho_s^2\ \text{dla każdego }j
\ \Longrightarrow\
\left\lVert\sum_j\lambda_j\mathbf V_j-\mathbf Z\right\rVert_2^2
\le\sum_j\lambda_j\lVert\mathbf V_j-\mathbf Z\rVert_2^2
\le\rho_s^2,
\quad\lambda_j\ge0,\quad\sum_j\lambda_j=1.
```

To proof całego convex patch z convexity squared norm, nie centroid sampling.
Bez wspólnego witness dzielimy parent rectangle rational halves w kolejności
LL, LU, UL, UU, do depth 2. Brak witness na tej depth daje
`REFUSED_FINITE_COVERAGE`; nie zwiększamy radius/depth i nie dodajemy points.
Maksimum visits per root cell to 1+4+16=21. Zero-area touch nie jest 2D proof;
closed boundary ma osobny pełny curve maxgap witness.

Niezależny verifier potwierdza wszystkie root (i,j) dokładnie raz, pełne four-child
trees, clipping halfspaces, exact positive-area sum równą authored quad area i
pełne closed boundary coverage. Cartesian roots mają rozłączne interiors, a
clipping/subdivision zachowuje ich union; missing root/quadrant odmawia. Tak
powstaje kompletny finite certificate bez triangulowania patches. Actual PASS
tego certificate nie zostało jeszcze wykonane.

### Backend, publiczny Python i kanoniczna semantyka

| Solver/device | Zakres nowej metody | Support / evidence |
|---|---|---|
| FEM CPU | planowany storage-only exact rational/integer geometry helper; nie MFEM solve | `planned_contract`, actual seeds/coverage/volume quality `NOT_VERIFIED` |
| FEM GPU | potencjalnie zużywa później tę samą kwalifikowaną siatkę; brak realizacji GPU tego eksperymentu | brak GPU execution/device proof; nie aktywuje capability |
| FDM CPU | regular grid nie zużywa tego CAD boundary certificate | not applicable, osobny grid gate |
| FDM GPU | regular CUDA grid nie zużywa tego CAD boundary certificate | not applicable, osobny grid gate |

Istniejący stage-first public Python i tabela parametrów sekcji 5 pozostają
jedynym authoring contract. Nie dodajemy konstruktora seeds ani private numerical
knobs do DSL. Wcześniejszy copyable public przykład i jego canonical lowering
pozostają bez zmian. Mapping wpływu jest jawnie nieaktywowany:

| Warstwa | Python → IR / runtime mapping | Requested intent i resolved execution |
|---|---|---|
| Python | istniejący `GeometryMeshHandle.configure` i `runtime_metadata.mesh_workflow.per_geometry[]` pozostają bez zmian | public mesh recipe nie wybiera automatycznie nowej metody |
| `ProblemIR` | brak nowego pola, wariantu lub dialektu; istniejące geometry assets pozostają aktualne | storage receipt nie zastępuje scientific mesh asset ani authored refs |
| Planner/capabilities | brak aktywnego loweringu lub nowej capability | missing qualification nadal odmawia; forced device nie dostaje fallback |
| Session/run/stage | brak aktywnego producenta, command, endpoint ani journal mutation | nie deklaruje accepted stage output ani source basis readiness |
| Export/reimport | dotychczasowy canonical recipe round-trip jest zachowany | reproducibility obejmie nową realization dopiero po osobnym preregistered integration |

Validation errors i unsupported combinations nowej metody są opisane jako
storage qualification refusals; nie reinterpretują bieżącego public API ani
nie aktualizują live scalar input hashes. Sampling i source geometry nie mogą
być utożsamiane przez sam object label.

(fem-recursive-boundary-artifacts)=
### Planowane artefakty, provenance i immutable evidence

Planowany manifest `canonical_recursive_bracketed_seed_case.v1` wiąże source/input
SHA256, root approval, case/scale/h bits, parent **curve** manifest digest,
counts, pełne face/cell/curve owners i bounded payload locators. Node record
ma 80 bytes: raw SHA256 ID (32), SI xyz f64-le (24) i scaled xyz f64-le (24).
Ordinals są storage indices, nie zamiennikiem ID; reader odtwarza exact rational
preimage z SI bytes i sprawdza scaled RNE. Connectivity używa uint32-le indices
w tej samej node order. Heavy arrays nie trafiają do thin JSON.

Coverage stream `FMCOV001` ma preorder roots po sorted face ID i rosnącym (i,j),
tagi EMPTY/PASS/SPLIT; PASS ma uint32-le witness ordinal, SPLIT dokładnie cztery
children, depth 2 nie dopuszcza kolejnego SPLIT. Reader sam odtwarza exact patches
z pełnych bounded chart arrays i authored polygons. Missing/trailing bytes,
foreign witness, wrong hashes albo fałszywy EMPTY dają odmowę. Mask density i
bracketing ancestry pozostają pełnymi bounded payloads; summary nie zastępuje
ich scientific owner identity. Publikacja jest atomic dopiero po pełnym verifier;
refusal nigdy nie publikuje seed qualification PASS.

Registry storage znajduje się pod resolver-owned `e2/canonical-recursive-bracketed-seeds-v1`:
`preregistration.md` SHA256
`38193a9b1dde2be112bd894fd94dcc78e71216d5decce26caab2d0e3f2d75fd2`,
`payload-contract.md` SHA256
`8cdba66423db76fdcd020c900b402a2ca8c7f9a9f59e2b7d9eb2ed71cd7bf330`,
freeze SHA256
`fe4d6f198e7f4942716c2fd7c78c2ab8f8022883bfc7593b4c9906ba82ae7bd6`.
Readonly recount actual 160 faces/228 curves/548 steps oraz 6 precount/depth bounds
przeszedł; nie wykonuje masks, rank selection, nowych seeds ani triangulacji.
Prerejestracja i te dowody są zewnętrznym immutable evidence, nie repo-tracked
numerical implementation. Nie wskazujemy nieistniejącego helpera jako obecnego
source symbol. Planned mapping używa poniższych jednoznacznych DOC-ANCHOR.

### Walidacja, completeness i dalsze bramki

Przed numerical implementation wymagane są source/root review i zamrożenie
helper/driver/worker/test identities. Plan negative checks używa tego samego
positive verifier: exhaustive predecessor/successor vs finite oracle, fractional
endpoints/negative ranks/binade boundaries/empty tiles, brak bracket, exact RNE
mismatch, too-close/overlong segment, missing authored anchor, altered plane,
wrong parent/cut orientation, subset violation, missing/overlap root/quadrant,
wrong clipped area, depth-3 coverage, foreign/just-outside-radius witness,
false zero-area EMPTY oraz node/bytes/cache/bits/time/Job/RSS overflow.
Neighbor grid musi być równoważny allpairs oracle na pełnych małych fixtures.
Source-only documentation checks nie są tymi jeszcze niewykonanymi numerical tests.

| Element kompletności | Stan w tej prerejestracji |
|---|---|
| problem, exact geometry scope, equations i SI units | zamknięty planowany kontrakt |
| pełne stałe, bracketing, separation, nesting curves | zamknięty planowany kontrakt, actual run `NOT_VERIFIED` |
| nonnested interior i complete continuous coverage | skończony exact checker z terminal refusal, actual PASS `NOT_VERIFIED` |
| independent precount 160 faces/228 curves/6 cases | readonly arytmetyka wykonana; nie seed realization |
| CPU/GPU/FDM, Python/IR/planner/session impact | jawnie rozdzielone, bez aktywacji |
| binary payload identity, provenance, owner i resource bounds | planowane, nie opublikowany scientific stage result |
| actual six-case seeds, triangulation, bit-preserving Gmsh fill | niewykonane, osobna autoryzacja i receipts |
| production determinant/SICN/gamma/volume/edge gates | niezmienione; geometry-only nie spełnia ich zamiast finalnej siatki |
| source cut two-Tet4 opposite-side proof, full3D V/J/H | brak kwalifikacji; pozostaje `NOT_VERIFIED` |

Ostateczna metoda musi wytworzyć dobrą FEM siatkę; cel nie jest spełniony przez
triangulację o znanej zdegradowanej jakości. Każdy późniejszy volume fill wymaga
zachowania boundary bits, exact shared incidence i istniejących quality floors.
Brak evidence nie jest PASS. Nie obniżamy $\tau_J$, SICN p05 0.1/min>0, gamma
minimum 0.08 ani żadnej pozostałej bramki z sekcji 8.2.

### Literatura i indeks źródeł podsekcji

- J. R. Shewchuk, [Triangle: exact arithmetic](https://www.cs.cmu.edu/~quake/triangle.exact.html):
  rozdzielenie orientation/incircle predicates od konstrukcji nowych vertices;
  nie jest dowodem własnego helpera.
- J. R. Shewchuk, [Triangle: quality meshing](https://www.cs.cmu.edu/~quake/triangle.quality.html):
  size/angle constraints i ograniczenia input angles; tiny-edge witness nie
  jest automatycznie dowodem małego authored input angle.

| Claim | Path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| Geometry-only scope i pełne stałe | `docs/physics/0105-fem-meshing-production-acceptance.md` | `DOC-ANCHOR:fem-recursive-boundary-qualification` | prerejestrowany kontrakt, bez fikcyjnego tracked helpera | FEM CPU qualification; GPU bez proof; FDM N/A | planned_contract |
| Recursive curve spacing/precount | `docs/physics/0105-fem-meshing-production-acceptance.md` | `DOC-ANCHOR:fem-recursive-boundary-curve-proof` | exact bracketing, termination, separacja i nowe upper | FEM geometry-only | planned_contract |
| Continuous interior coverage | `docs/physics/0105-fem-meshing-production-acceptance.md` | `DOC-ANCHOR:fem-recursive-boundary-coverage-proof` | pełne clipping/tree/witness proof, bez nowych nodes | FEM geometry-only | planned_contract |
| Immutable payload identity | `docs/physics/0105-fem-meshing-production-acceptance.md` | `DOC-ANCHOR:fem-recursive-boundary-artifacts` | planned binary/owner/provenance certificate | storage qualification, nie API stage | planned_contract |


(fem-residue-validation-once-contract)=
### Jednorazowa walidacja niemodyfikowalnych wzorców reszt: kontrakt przed implementacją

To ograniczona optymalizacja walidacji storage-only metody opisanej powyżej, a nie nowa metoda wyboru punktów. Przypadek bazowy zakończył się odmową po 120 s; diagnostyka case0 również nie ukończyła wyniku. Dwie częściowe obserwacje stosu wskazują `exact_geometry.validate_tiles` i jego generatory. Nie dowodzą przyspieszenia ani jakości siatki; narzut obserwatora wyklucza traktowanie ich jako benchmarku. Rzeczywiste wykonanie nowej wersji, triangulacja, Gmsh, FEM i fizyka mają status **NOT VERIFIED**.

Dla okresu $P$ i skończonej sekwencji $r=(r_0,\ldots,r_{n-1})$ własność jest dokładnie:

```{math}
:label: eq-fem-residue-validation-property
V(P,r) \iff P\in\mathbb{Z}_{>0}\ \land\
\bigwedge_{i=0}^{n-1}(\operatorname{type}(r_i)=\texttt{int}\ \land\ 0\le r_i<P)
\ \land\ \bigwedge_{i=0}^{n-2}r_i<r_{i+1}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $P$ | dokładny dodatni okres reszt | $1$ |
| $r_i$ | reszta całkowitego rangu; `bool`, podklasy `int` i liczby zmiennoprzecinkowe są odrzucane | $1$ |
| $n$ | liczba zachowanych reszt | $1$ |
| $i$ | indeks całkowity od $0$ do $n-1$ | $1$ |
| $L_t,U_t$ | zamknięte granice t-tego przedziału całkowitych rangów | $1$ |
| $t$ | kolejność przedziału w partycji | $1$ |
| $V$ | predykat poprawności zawartości | $1$ |

Reprezentacją jest zwykła niemodyfikowalna `tuple[int]`, bez podklasy, flag certyfikacji ani ukrytego mutable backing. Rejestr lokalny jednego przypadku przechowuje silne odniesienie do klucza `(P, tuple)` i tej samej kanonicznej krotki. Skrót przyspiesza wyszukiwanie, lecz zgodność wymaga pełnej równości klucza. Sama klasa, adres, hash, klucz scalar mask ani znacznik producenta nie stanowią dowodu. Zaufany powrót wymaga wyszukania pełnej zawartości w bieżącym kontekście i zgodności z jego zatrzymaną kanoniczną krotką. Obca lub skonstruowana krotka przechodzi świeżą kontrolę ścisłych typów i $V$; jest to konieczne także dlatego, że Python porównuje `True == 1`.

Mutable źródło jest zawsze przechwytywane przed użyciem. Dokładne `array('H')` daje wbudowane `int`, lecz zakres i porządek nowego wzorca nadal podlegają $V$. Inne kontenery wymagają kontroli ścisłych typów przed lookup. Zmiana źródłowej tablicy nie zmienia już zatrzymanej krotki. Wszystkie wywołania `Masks.tiles`, również wewnątrz scalar `ranks`, zwracają snapshoty; nie wystarcza pominięcie kontroli w jednym callerze przy pozostawieniu mutable danych dla wyszukiwania.

(fem-residue-validation-once-proof)=
### Równoważność, pamięć i odmowy

Jeśli rejestr zawiera $(P,r)$ po poprawnym $V(P,r)$, niemodyfikowalność zachowuje wszystkie przesłanki $V$ przez życie kontekstu. Ponowne pełne sprawdzenie tego samego własnego snapshotu może więc zostać zastąpione pełnym lookup. Każdy przedział nadal wymaga ścisłych typów granic, $L_t\le U_t$, ciągłości $L_t=U_{t-1}+1$ oraz limitu liczby przedziałów; nie wykonuje się ponownie kosztownego `residues[1:]` dla certyfikowanej zawartości. Czytnik ma świeży rejestr i niezależny checker, rekonstruuje scalar masks z niezmienionego źródła i nie przejmuje certyfikatów producenta. Równania scalar, binade guards, exact RNE, bracketing, tie order, separation, coverage i wszystkie progi jakości z sekcji 8.2 pozostają obowiązujące.

| Wewnętrzny parametr | Typ i wartość ustalona | Jednostka SI | Walidacja i odmowa | Backend / publiczny IR |
|---|---|---|---|---|
| okres | ścisły `int`, $P=32768$ w actual scalar | $1$ | dodatni; zmiana okresu tworzy inny klucz | storage CPython CPU; brak nowego pola IR |
| kontekst | prywatny, nowy dla producenta i czytnika każdego przypadku | $1$ | brak globalnego cache lub importowanych flag | FEM CPU/GPU: nieaktywowany; FDM CPU/GPU: nie dotyczy |
| wzorce | maksymalnie 4096 pełnych kluczy | $1$ | odmowa bez eviction i bez fallback | brak publicznego parametru |
| zatrzymana pamięć | 16 MiB łącznie ze scalar cache | $\mathrm{byte}$ | rzeczywisty `sys.getsizeof` całego zatrzymanego grafu: słowniki, klucze, wszystkie int/krotki/tablice, context/headers i zachowane stats; deduplikacja tylko rachunkowa | istniejący limit, bez dodatkowych 16 MiB |
| rollback | transakcja insert/append | $1$ | po odmowie brak nowego wpisu lub statystyki i brak zatrzymanego grafu ponad limit | prywatna implementacja |
| przedziały | najwyżej 768 | $1$ | kontrola dla każdej partycji, nawet znanego wzorca | bez zmiany scalar guards |
| process private commit / RSS | 256 MiB | $\mathrm{byte}$ | dotychczasowy owned Job i pomiar RSS; accounting retained nie dowodzi peak RAM | future actual run, nie wykonany |
| czas przypadku | 120 | $\mathrm{s}$ | dotychczasowa odmowa, bez retry pod nową polityką | future actual run, nie wykonany |
| payload / thin / evidence | 32 MiB / 64 KiB / 256 MiB | $\mathrm{byte}$ | dotychczasowe limity bez rozszerzenia | nie powstaje nowy publiczny artifact schema |

Nie dodaje się publicznego konstruktora ani przykładu Python: publiczne parametry, `ProblemIR`, planner, session API, backend selection i requested/resolved intent są niezmienione i nieaktywowane przez ten eksperyment. Provenance nowego storage namespace wiąże baseline, scalar helper, prerejestrację i nowe źródła; nie zastępuje wcześniejszych odmów ani ledgerów.

(fem-residue-validation-once-validation)=
### Kontrole przed rzeczywistym wykonaniem i source index

Osiem grup małych interpreted kontroli obejmuje: pełny oracle dla małych okresów; mutation/foreign tokens/collision/per-period; wszystkie bounds i continuity; indexing/slicing/bisect; pełne małe predecessor/successor/bracket search; rzeczywisty retained graph i rollback; świeży niezależny checker czytnika; piny i odmowę bez nowej execution authorization. Wynik source-only nie jest dowodem runtime ani przyspieszenia. Następny gate wymaga review kompletnych źródeł i oddzielnej zgody na actual przypadki. Produkcyjne quality floors, authored geometria, material planes, probes i sourcecut owners pozostają bez zmian.

| Claim | Path + symbol | Status dowodu |
|---|---|---|
| własność i reprezentacja | `docs/physics/0105-fem-meshing-production-acceptance.md`, `DOC-ANCHOR:fem-residue-validation-once-contract` | kontrakt przed implementacją |
| dowód i zasoby | ta sama ścieżka, `DOC-ANCHOR:fem-residue-validation-once-proof` | kontrakt przed implementacją |
| testy i nonactivation | ta sama ścieżka, `DOC-ANCHOR:fem-residue-validation-once-validation` | plan kontroli; runtime NOT VERIFIED |

Planowane prywatne symbole `residue_validation.Context`, `residue_validation.validation_masks` i checker czytnika należą wyłącznie do nowego storage namespace `canonical-residue-validation-once-v1-implementation`. Nie są przedstawiane jako istniejące symbole repozytorium ani publiczne API. Definicje immutable tuples i równości pochodzą z [dokumentacji Python 3.12](https://docs.python.org/3.12/library/stdtypes.html#tuples); ograniczenie pomiaru obiektu versus referents opisuje [sys.getsizeof](https://docs.python.org/3.12/library/sys.html#sys.getsizeof). Cały graf mierzy prywatny traversal, a nie pojedyncze wywołanie `getsizeof`.


(fem-binary-residue-validation-v2)=
### Immutable binary residues v2: prerejestrowana realizacja storage-only

V1 tuple[int] została sprawdzona źródłowo, ale root synthetic probe trzech prób po dziesięć powtórzeń pełnej `array('H', range(32768))` wykazał 5,32–5,45 razy większy czas niż bazowy predykat. Wynik dotyczy tego syntetycznego porównania, nie FEM. V2 wybiera bytes, zachowując wszystkie pełne graph guards; przed jej implementacją nie deklaruje się poprawy szybkości. Geometria, scalar helper, authored planes/probes, bracketing, RNE, separation, coverage, 36 cells /160 faces /228 curves i wszystkie quality floors pozostają bez zmian.

Kanoniczne dane to zwykłe immutable bytes, u16 little-endian, dwie oktety na resztę. Prywatna sequence ma intrinsic immutable backing: tuple subtype z `__slots__=()` i dokładnie jednym elementem bytes. Jest to mały header nad jednym payloadem, nie tuple wszystkich int. Odczyt backing używa builtin `tuple.__getitem__`; graph traversal używa builtin `tuple.__iter__`, nie decoded iteration. Nie istnieje mutable backing, dictionary flag ani mutable memoryview. Lookup lokalnego rejestru wymaga pełnego klucza $(P,E(r))$ i związania z zatrzymaną kanoniczną sequence. Sam hash, klasa, flag lub object id nie dowodzą $V$.

```{math}
:label: eq-fem-binary-residue-identity
E(r)_{2i}=r_i\bmod256,\qquad E(r)_{2i+1}=\lfloor r_i/256\rfloor,
\qquad D(E(r))_i=E(r)_{2i}+256E(r)_{2i+1}=r_i.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $E(r)$ | dokładny u16LE encoding skończonej sekwencji | $\mathrm{byte}$ |
| $D$ | dokładny decoder wartości całkowitych | $1$ |
| $r_i$ | reszta całkowitego rangu; `bool`, podklasy `int` i liczby zmiennoprzecinkowe są odrzucane | $1$ |
| $i$ | indeks całkowity od $0$ do $n-1$ | $1$ |
| $n$ | liczba zachowanych reszt | $1$ |
| $P$ | dokładny dodatni okres reszt | $1$ |
| $B_p$ | rzeczywisty zatrzymany graf producenta | $\mathrm{byte}$ |
| $B_r$ | niezależny rzeczywisty zatrzymany graf czytnika | $\mathrm{byte}$ |
| $C$ | wspólny limit retained pamięci dla każdego ownera | $\mathrm{byte}$ |

Na zakresie $0\le r_i\le65535$ encoding jest injective, decoder odtwarza wartości i kolejność, a immutable payload zachowuje $V$ przez życie kontekstu. Mutowane źródło musi być przechwycone ponownie; nowa zawartość wymaga nowego pełnego $V$. Foreign/forged wrappers zawsze wymagają świeżej weryfikacji struktury oraz $V$, także gdy są równe wartościowo. Reader używa świeżego kontekstu i własnego checkera, rekonstruuje scalar masks, nie przejmuje certyfikatów producenta. Tiles zawsze sprawdzają ścisłe bounds/continuity/cap768. Search, tie order i wszystkie scientific guards nadal obowiązują.

| Wewnętrzny parametr / interfejs | Typ / default lub wartość | SI | Walidacja / odmowa | Publiczny model i realizacja |
|---|---|---|---|---|
| actual okres | strict int32768 | $1$ | prywatne testy1..65536; poza reprezentacją odmowa | bez nowego Python/IR pola |
| fast capture | exact arrayH | $1$ | itemsize2 i little-endian obowiązkowe; nowe tobytes na każdym wywołaniu | tylko storage CPython CPU |
| generic capture | exact list/tuple/range | $1$ | bounded length<=P, strict int i zakres przed encoding; inny typ odmowa | bez implicit coercion |
| immutable sequence | intrinsic one-tuple bytes | $1$ | arity1, exact bytes, even length; forged shape odmowa | len/index/negative/slice/iter/bisect zachowują wartości |
| pełny rejestr | case-local(P,raw bytes),4096patterns | $1$ | pełna równość mimo kolizji; foreign fresh check | brak globalnego certificate cache |
| retained limit $C$ |16MiB, scalar+registry+headers+keys+stats | $\mathrm{byte}$ | pełny measured graph po każdym guard miejscu v1; transactional rollback całych poprzednich obiektów | nie dowodzi peak RAM |
| Job / sampled RSS / time |256MiB /256MiB /120s | $\mathrm{byte}$ / $\mathrm{s}$ | niezmienione; actual przypadki nieautoryzowane | source-only gate |
| payload/thin/evidence |32MiB /64KiB /256MiB | $\mathrm{byte}$ | resource JSON mieści się w tych samych limitach | brak rozszerzenia budżetu |
| reader authority | jawny candidate lub completed | $1$ | candidate: private local producer measurement; cold: external approved driver receipt pin; bez default weaker mode | niezmieniona application API |
| physical values | strict int1..C | $\mathrm{byte}$ | każdy owner bounded; bool/zero/overflow odmowa | nie wymaga equality ownerów |

FEM CPU: storage qualification plan i synthetic tests, solver/runtime **NOT VERIFIED**. FEM GPU: nieaktywowane, bez dowodu urządzenia. FDM CPU/GPU: nie dotyczy tej boundary realizacji. Nie zmienia się publicznego Python API, ProblemIR, planner/capabilities, sessions ani requested/resolved intent; nie dodaje się przykładu publicznego dla prywatnego storage helpera. Triangulacja, Gmsh, FEM/native V/J/H i production qualification są nadal odrębnymi gates.

(fem-binary-residue-resources-v2)=
### Wersjonowane local physical measurements i owner admission

```{math}
:label: eq-fem-binary-residue-resource-bounds
1\le B_p\le C,\qquad1\le B_r\le C,\qquad B_p=B_r\ \text{nie jest wymagane}.
```

Nowy storage manifest `canonical_recursive_bracketed_seed_case.v2` wymaga `canonical_seed_resource_measurement.v2` oraz payload `resource_measurement.json` z algorithm `immutable_residue_full_graph.v2`. Wszystkie pozostałe numerical layouts zostają bez zmian. Historyczna schema v1 i jej equality pozostają przypiętą, odrębną ścieżką; nie ma automatycznej reinterpretacji albo fallback.

Producer mierzy własny full graph po generacji i przed niezależnym readerem. Resource payload wiąże case/execution/source/contract, runtime fingerprint, actual producer bytes, logical mask counts i logical digest. Manifest wiąże payload digest/length i te same wartości. Reader mierzy własny full graph; independently rekonstruuje scalar patterns, validation patterns, ordered density, logiczny digest oraz wszystkie coordinates/ownership/nesting/separation/coverage. Nie udaje rekonstrukcji historycznego heap producenta.

Cold authenticity wymaga independently pinned istniejącego `case-N.driver.json`, zatwierdzonego przez pinned driver z actual owned PID/Job handshake. Receipt wiąże exact manifest/resource locators i digests, case/source/execution, oba bounded physical values oraz logical counts. Pin pochodzi z owner inventory/terminal, a nie z bundle. Sam rehash manifest+payload+lokalnego counterfeit receipt nie wystarcza. Brak receipt, foreign identity, unknown version, malformed integer i mismatched values odmawiają. Źródłem wiarygodności historycznej liczby jest reviewed measurement code w potwierdzonym owner process, nie numerical payload sam w sobie.

Candidate verify wymaga private local measurement z producenta i nadal wykonuje niezależny reader. Folder rename może pozostać przed driver checks; folder, manifest i worker JSON są wtedy wyłącznie candidate. Sole completed admission następuje po immutable accepted driver receipt. Parent grade jest odtwarzany z dokładnego approved parent receipt chain, nie latest/name. Resource payload powstaje przed manifestem i nie zawiera manifest SHA; worker/driver receipts wiążą oba później, więc brak circular hash. Aborted/refused execution nie dostaje completed receipt.

(fem-binary-residue-validation-gates-v2)=
### Source-first verification i source index

Wymagane są wszystkie osiem grup: exhaustive mały encoding/V oracle; mutation/foreign/forged/kolizja/per-period; always tile guards; len/index/slice/bisect i pełny search oracle; actual graph/alias/capacity/rollback; niezależny reader; resource schema/counterfeit/completion/parent-chain; pins/nonactivation i fixed synthetic capture+stats timing. Forgery test rehashuje własny bundle tak, aby badany semantic gate nie był maskowany wcześniejszym hash mismatch. Fixed timing nie jest dowodem actual masks lub speedup production; wynik wolniejszy także zostaje utrwalony. Odrębne root source review poprzedza zgodę na sześć actual przypadków.

| Claim | Path + stable symbol | Evidence |
|---|---|---|
| bytes identity i scope | `docs/physics/0105-fem-meshing-production-acceptance.md`, `DOC-ANCHOR:fem-binary-residue-validation-v2` | prereg przed kodem |
| versioned resource authority | ta sama ścieżka, `DOC-ANCHOR:fem-binary-residue-resources-v2` | prereg przed kodem |
| controls i nonactivation | ta sama ścieżka, `DOC-ANCHOR:fem-binary-residue-validation-gates-v2` | source-only plan; runtime NOT VERIFIED |

Planned storage symbols `FrozenResidues`, `Context.capture`, `verify_candidate_v2`, `verify_completed_v2` i driver accepted-resource receipt nie są istniejącym publicznym API/repo implementation. Ich future source freeze/index należy do nowego namespace `canonical-residue-validation-once-v2-implementation`; scalar/math/history/v1 pozostają immutable. Primary references: [Python array](https://docs.python.org/3.12/library/array.html), [immutable sequences](https://docs.python.org/3.12/library/stdtypes.html#immutable-sequence-types), [sys.getsizeof](https://docs.python.org/3.12/library/sys.html#sys.getsizeof). Referencje opisują reprezentację i ograniczenia pomiaru, nie kwalifikują siatki ani szybkości.
