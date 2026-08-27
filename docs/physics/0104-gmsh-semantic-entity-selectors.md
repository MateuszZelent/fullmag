# Semantyczne selektory encji Gmsh dla FEM

- Status: terminal contract
- Ostatnia aktualizacja: 2026-08-27
- Decyzja: [ADR 0027](../adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md)

(entity-selectors-problem-statement)=
## Problem statement

Surowe tagi Gmsh są artefaktem realizacji i mogą zmienić się po fragmentacji OCC.
Publiczny kontrakt wybiera powierzchnię lub krzywą przez intencję geometryczną:
najbliższą encję do punktu SI, opcjonalnie w zakresie jednego komponentu.
Selektor steruje wyłącznie meshing; nie zmienia fizyki ani domeny.

(entity-selectors-governing-equations)=
## Governing equations

```{math}
:label: eq-entity-selector-distance

d(\mathbf p,E)=\min_{\mathbf y\in E}\lVert\mathbf p-\mathbf y\rVert_2.
```

Kandydaci są porządkowani leksykograficznie po $(d,\mathrm{tag})$; pierwszych
$n$ encji stanowi resolved execution. Równania LLG i słabe formy pozostają
niezmienione.

(entity-selectors-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Znaczenie | SI |
|---|---|---|
| $\mathbf p$ | public selector point | $\mathrm m$ |
| $E$ | final OCC entity | $1$ |
| $d$ | point-to-entity distance | $\mathrm m$ |
| $n$ | number of requested matches | $1$ |
| $\mathrm{tag}$ | resolved Gmsh entity identifier | $1$ |

(entity-selectors-assumptions-and-validity)=
## Assumptions and validity

Rozwiązanie następuje po konstrukcji i fragmentacji geometrii. Współrzędne są
w metrach, a adapter skaluje punkt dokładnie jak geometrię. Zakres komponentu
ogranicza kandydatów do odzyskanych encji tego komponentu. Tagi nie są stabilną
częścią ProblemIR. Exact through-thickness layers i structured in-plane meshing
są niezależne od selektora.

(entity-selectors-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `nearest_surface_to_point.point` | `Sequence[number]` | `required` | $\mathrm m$ | exactly three numeric coordinates | surface query point | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].point` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_surface_to_point` |
| `nearest_surface_to_point.geometry` | `str \| None` | `None` | $1$ | non-empty when provided | optional component scope | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].geometry` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_surface_to_point` |
| `nearest_surface_to_point.count` | `int` | `1` | $1$ | integer at least one | surface match count | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].count` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_surface_to_point` |
| `nearest_curve_to_point.point` | `Sequence[number]` | `required` | $\mathrm m$ | exactly three numeric coordinates | curve query point | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].point` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_curve_to_point` |
| `nearest_curve_to_point.geometry` | `str \| None` | `None` | $1$ | non-empty when provided | optional component scope | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].geometry` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_curve_to_point` |
| `nearest_curve_to_point.count` | `int` | `1` | $1$ | integer at least one | curve match count | FEM CPU/GPU | `runtime_metadata.mesh_workflow selectors[].count` | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py::nearest_curve_to_point` |

```python
# %% Complete canonical FEM study with semantic entity selectors.
import fullmag as fm
from fullmag.meshing import nearest_curve_to_point, nearest_surface_to_point

study = fm.study("selectors")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(180e-9, 120e-9, 80e-9))
study.universe.mesh(maximum_element_size=20e-9)

body = study.geometry(fm.Box(size=(100e-9, 40e-9, 4e-9)), name="free_layer")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
surface = nearest_surface_to_point(point=(50e-9, 0.0, 2e-9), geometry="free_layer")
curve = nearest_curve_to_point(point=(50e-9, 20e-9, 2e-9), geometry="free_layer")
body.mesh(
    maximum_element_size=8e-9,
    boundary_layer_target_surface_selectors=[surface],
    boundary_layer_target_curve_selectors=[curve],
)
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

(entity-selectors-problem-ir)=
## ProblemIR and provenance

Requested intent zachowuje `kind`, `point`, `geometry` i `count`. Resolved
execution należy do mesh-build evidence: wersja Gmsh, zakres kandydatów, tagi,
odległości i przyczyna failure. Atomic V04 cutover obejmuje typowane selektory;
nie wolno dual-write tagów do kanonicznej intencji.

(entity-selectors-backend-matrix)=
## Backend matrix

| Lane | Status |
|---|---|
| FEM CPU | bieżący resolver Gmsh; produkcja po gate 0105 |
| FEM GPU | identyczna zrealizowana siatka; brak osobnego resolvera GPU |
| FDM CPU | not applicable |
| FDM GPU | not applicable |

(entity-selectors-discrete-realization)=
## Discrete realization

Po fragmentacji OCC resolver tworzy listę kandydatów odpowiedniego wymiaru,
opcjonalnie ogranicza ją do komponentu, mierzy odległość i wybiera stabilnie po
$(d,\mathrm{tag})$. Dopiero finalne tagi trafiają do pól lub boundary layers.

(entity-selectors-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Round-trip zachowuje requested intent, nie tagi. Validation errors obejmują zły
punkt, pustą nazwę i `count<1`. Brak kandydata i nieznany komponent są błędem;
unsupported combinations muszą zakończyć meshing czytelnym błędem; silent broadening jest
zabroniony. Remap po CAD jest dozwolony wyłącznie jako nowa resolved execution.

(entity-selectors-implementation-mapping)=
## Implementation mapping

`nearest_surface_to_point` i `nearest_curve_to_point` budują deskryptory.
`resolve_entity_selectors` wybiera finalne tagi po OCC. Bieżąca implementacja
jest obecna; pełny, wersjonowany raport selektora pozostaje wymaganiem 0105.

(entity-selectors-validation)=
## Validation

- Unit: walidacja punktu, zakresu i liczności.
- Real Gmsh: znane ściany/krawędzie box oraz deterministyczny tie-break.
- Provenance: requested intent i resolved tags są osobnymi polami.
- Regresja: jawne listy tagów zachowują dotychczasowe zachowanie.

(entity-selectors-limitations)=
## Limitations

Brak fuzzy nazw `top`/`left`, automatycznej naprawy CAD i semantyki FDM.
Stabilność zależy od geometrycznie równoważnego finalnego modelu OCC.

(entity-selectors-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine, J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh
  generator with built-in pre- and post-processing facilities”, 2009.
- Gmsh reference manual, geometry queries and mesh fields.

(entity-selectors-source-code-index)=
## Source-code index

| Warstwa | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| Public helper | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py` | `nearest_surface_to_point` | deskryptor powierzchni |
| Public helper | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py` | `nearest_curve_to_point` | deskryptor krzywej |
| Resolver | `packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py` | `resolve_entity_selectors` | requested selector → finalne tagi |
| Diagnostyka | `packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py` | `collect_orphan_entity_diagnostics` | raport osieroconych encji |
