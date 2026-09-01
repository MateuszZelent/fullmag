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
| `gmsh.min_sicn.v1` | wszystkie finalne element tags obsługiwane przez Gmsh, `minSICN` | p05 $\ge0.1$ i minimum $>0$ | inny producer/proxy nie spełnia gate | tetra reports implemented; mixed production evidence nie jest FMMQ v2 |
| `gmsh.gamma.v1` | wszystkie finalne element tags, Gmsh `gamma` | minimum $\ge0.08$ | brak per-element array daje `not_qualified` | tetra reports implemented |
| `mixed_topology_scaled_jacobian.v1` | `tet4`: affine map; `prism6`/`pyramid5`: mapowany Jacobian w jawnych punktach kwadratury danej topologii | per-family p05 $\ge0.1$ i każde minimum $>0$; signed Jacobian pozostaje osobnym gate'em | nie jest SICN ani tetrahedralnym proxy; każda rodzina jest oceniana w swojej topologii | mixed certificate implemented |
| `cell.volume.v1` | całkowanie mapy na wszystkich komórkach; SI $\mathrm{m^3}$ | $V_K>0$; względny CAD/shared-domain error $\le10^{-8}$ | non-finite/non-positive lub przekroczenie fail | tet + bounded mixed certificate implemented |
| `cell.max_edge.v1` | $h_K^\mathrm{edge}$: maksimum wszystkich canonical edges komórki; agregacja po pełnym scope | object/interface p95 $\le1.25h_\mathrm{target}$ i max $\le1.50h_\mathrm{target}$ | pusty wymagany scope lub przekroczenie fail | kontrakt planowany; obecne tet-equivalent stats nie są tym gate'em |
| `adjacent_size_growth.v1` | każda para komórek dzieląca pełną ścianę w tym samym resolved growth graph | $\rho_{KL}=\max(h_K^\mathrm{edge},h_L^\mathrm{edge})/\min(h_K^\mathrm{edge},h_L^\mathrm{edge})\le g(1+0.05)$ | cross-zone pary są oceniane tylko, gdy plan jawnie łączy ich growth graph; przekroczenie fail | planowany |
| `airbox.regular_tet_equivalent_size.v1` | $h_K^\mathrm{air}=(6\sqrt2|V_K|)^{1/3}$ dla każdej finalnej air cell; bieżący diagnostic, bez mixed-topology claim | wszystkie wartości skończone i dodatnie; percentyle używają pełnego posortowanego binary64 scope | missing/non-finite/non-positive fail; nie spełnia strict-scale ani mixed gate | implemented dla bieżących tetra reports |
| `airbox.distance_bands.v1` | centroidy air cells w pasmach $[0,0.1d]$, $(0.45d,0.55d]$, $(0.9d,d]$ osobno dla surface, edge, corner i każdej strony bbox | każde wymagane pasmo niepuste; p50/p95 size niemaleją z tolerancją $5\%$; far p95 w $[0.75h_\mathrm{air,max},1.25h_\mathrm{air,max}]$ | puste pasmo, odwrócony trend lub brak corner/side coverage fail | częściowe testy istnieją; pełny raport/gate planowany |
| `evidence.identity.v1` | wszystkie element ordinals i payload sections | dokładna zgodność count, order, topology fingerprint, mesh revision i metric metadata | stale/duplicate/missing/tampered fail | JSON certificate częściowo; FMMQ v2 planowany |

Gmsh `Mesh.CharacteristicLengthMin` jest wyłącznie implementacyjną obwiednią.
Nie może zastąpić strefowego $\max\mathcal L$ ani przyciąć lokalnego upper
target. `airbox.regular_tet_equivalent_size.v1` jest jawnie
tetra-equivalent diagnostic, nie `cell.max_edge.v1` i nie mixed-topology gate.

(fem-meshing-acceptance-implementation-mapping)=
## 9. Implementation mapping

- `GeometryMeshHandle.configure` jest aktualnym publicznym ownerem parametrów.
- `resolve_user_mesh_size_controls` rozwiązuje bieżące COMSOL-like presets.
- `_build_field_stack` składa bieżący plan pól Gmsh; docelowo musi publikować
  dokładną algebrę i strefową eligibility.
- `_extract_quality_metrics` pobiera bieżące Gmsh SICN/gamma/volume.
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
| FMMQ v1 writer | `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py` | `_write_quality_data_artifact_if_available` | writes active FMMQ v1 arrays without family/topology identity | FEM CPU/GPU transport | implemented v1; v2 planned |
| FMMQ v1 TS reader | `apps/control-room/src/kernel/api/codecs/meshQualityDataCodec.ts` | `decodeMeshQualityData` | decodes active v1 layout; format identity is insufficient for mixed qualification | unified Control Room | implemented v1; v2 planned |
| FMMQ v1 Rust reader | `crates/fullmag-api/src/fem_cross_section.rs` | `per_element_quality_metric_from_fmmq` | reads active v1 per-element arrays | API | implemented v1; v2 planned |
| Strict characteristic scale | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `validate_strict` | computes maximum pairwise vertex distance and relative determinant floor | FEM meshing | implemented |
| Canonical planned policy | `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` | `DOC-ANCHOR:canonical-fem-mesh-policy` | accepted upper/lower, zones, curvature, sweep and quality decision | cross-layer | planned contract |
| Planned FMMQ v2 | `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` | `DOC-ANCHOR:fmmq-v2-contract` | typed per-family quality transport and v1 exit criteria | API/Control Room | planned contract |
