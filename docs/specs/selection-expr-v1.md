# `selection_expr.v1`: kanoniczny typed selector magnetycznych DOF

- Status: zatwierdzony kontrakt implementacyjny, runtime niezakwalifikowany
- Wersja schematu: `selection_expr.v1`
- Właściciel semantyki: `ProblemIR` i kanoniczny kompilator selekcji
- Powiązane: ADR 0026, `docs/specs/frozen-spins-v1.md`

(selection-expr-v1-contract)=
## 1. Zakres

`SelectionExprIR` opisuje requested intent wyboru aktywnych magnetycznych DOF.
Nie jest maską gridu, listą węzłów FEM, fragmentem kodu Python ani stanem UI.
Ten sam AST jest wejściem dla plannera, authoritative preview, runtime,
checkpointu i viewportu.

V1 jest zamkniętym, wersjonowanym językiem danych. `eval`, lambdy, callbacki i
stringowe wyrażenia wykonywalne są odrzucane.

(selection-expr-v1-ast)=
## 2. Kanoniczny znormalizowany typed AST

Publiczny authored input i kanoniczny `SelectionExprIR` są dwiema kolejnymi
fazami jednego kontraktu, nie dwoma formatami o tej samej requiredness.
Python DSL i Control Room mogą pominąć pola mające publiczny default, w tym
`inside_geometry.boundary`. Lowering musi zastosować defaulty i dopiero potem
utworzyć kanoniczny znormalizowany `SelectionExprIR`. W serialized canonical IR
`boundary` jest wymaganym, jawnym obiektem; brak tego pola na granicy
deserializacji canonical IR jest błędem schematu, a nie ponownym zastosowaniem
defaultu.

Każda kanoniczna named selection ma
`schema_version="selection_expr.v1"`, stabilne `id`, opcjonalną nazwę i jedno
`expression`. Kolumna „Wymagane pola” poniżej dotyczy wyłącznie canonical
normalized `SelectionExprIR`. Dozwolone warianty expression:

| `kind` | Wymagane pola | Semantyka |
|---|---|---|
| `all_magnetic` | brak | cała aktywna domena magnetyczna |
| `in_object` | `object_id` | aktywne magnetyczne DOF obiektu |
| `in_region` | `object_id`, `region_id` | DOF należące do regionu wskazanego obiektu |
| `inside_geometry` | `geometry`, `frame`, `sampling`, `boundary` | typed predykat punkt-w-geometrii |
| `compare` | `lhs`, `op`, `rhs` | ścisłe lub inkluzywne porównanie skalarów |
| `approx` | `value`, `target`, `atol`, `rtol` | jawna równość przybliżona |
| `between` | `value`, `lower`, `upper`, `closed` | jawny przedział |
| `and` | niepuste `expressions` | przecięcie |
| `or` | niepuste `expressions` | suma |
| `xor` | co najmniej dwa `expressions` | różnica symetryczna |
| `not` | `expression` | dopełnienie wyłącznie w aktywnej domenie magnetycznej |
| `ref` | `selection_id` | referencja do named selection |

Skalary V1 to skończona stała, współrzędna `x|y|z` w jawnym frame,
`magnetization_component(x|y|z)`, `magnetization_norm`,
`magnetization_dot(axis)` i `abs(value)`. Magnetyzacja jest bezwymiarowa;
współrzędne są w metrach.

Operator `compare.op` należy do `lt|le|gt|ge`. Zwykłe zmiennoprzecinkowe `eq`
nie istnieje. Pole `compare.tolerance` jest kompatybilnościowym składnikiem IR,
ale kompilator V1 wymaga dokładnie `atol=0` i `rtol=0`; wartość niezerowa
failuje kodem `selection_compare_tolerance_unsupported`, zamiast być cicho
ignorowana. `approx` wymaga `atol >= 0`, `rtol >= 0` i co najmniej jednej
dodatniej tolerancji. `between` wymaga `lower <= upper` i
`closed=none|left|right|both`. NaN daje `false` i diagnostykę; nieskończona
magnetyzacja jest validation error stanu.

(selection-expr-v1-geometry)=
## 3. Geometria, frame i granica

`inside_geometry.geometry` używa `geometry_predicate.v1`: `box`, `cylinder`,
`sphere`, `ellipsoid`, `union`, `intersection`, `difference`, `xor`,
`complement` z jawną domeną oraz `affine`. `imported_solid` może być znanym
wariantem schematu, ale strict planner odrzuca go bez kwalifikowanego occupancy
engine i capability.

`frame` jest `world` albo `object(object_id)`. Dla object frame evaluator
stosuje pełną odwrotną transformację affine obejmującą translację, quaternion,
skalę i pivot. Transformacja osobliwa jest błędem. Oś cylindra jest skończona,
normalizowalna i transformowana jako kierunek.

Publiczny `disk(radius, thickness, center, normal)` obniża się do skończonego
`cylinder` z `height_m=thickness_m`. `disk(...,
extrusion="through_object")` wymaga `object_id`, wyznacza skończony zakres z
projekcji bounds obiektu, dodaje kanoniczną tolerancję i zawsze przecina wynik
z `in_object`. Nie istnieje wariant o zerowej grubości w domenie 3D.

`boundary` V1 to `inclusive` albo `exclusive` z
`absolute_tolerance_m >= 0` i `relative_tolerance >= 0`. W publicznym authored
input pole `boundary` jest opcjonalne i domyślnie oznacza `inclusive`. Lowering
braku całego pola zapisuje w kanonicznym IR jawny wymagany obiekt
`{"kind":"inclusive","absolute_tolerance_m":0.0,"relative_tolerance":1e-12}`;
brak pojedynczej tolerancji w podanym obiekcie wypełnia odpowiednio `0.0` albo
`1e-12`. Są to wersjonowane defaulty `selection_expr.v1`, niezależne od
sprzętu i obecne w authored fingerprint. Resolved certificate zapisuje te same
wartości oraz identyfikator realizacji evaluatora.

`sampling` requested intent to `dof_point`. Realizacja oznacza środek komórki
FDM albo magnetyczny true DOF FEM. Węzeł/centroid preview ma osobny status
`non_authoritative` i nie może zasilać aktywacji.

(selection-expr-v1-canonicalization)=
## 4. Walidacja, canonicalizacja i fingerprint

Walidacja odbywa się przed materializacją i wymusza:

- unikalne, niepuste ID; istniejące object, region i selection references;
- brak cykli referencji;
- maksymalnie 64 poziomy, 4096 węzłów i 1024 referencje;
- niepuste operatory zbiorowe oraz skończone stałe;
- dodatnie rozmiary geometrii, normalizowalne osie i odwracalne transformacje;
- `deny_unknown_fields` na każdym wariancie;
- jawny frame dla geometrii niezwiązanej convenience API z obiektem;
- brak operatorów i polityk niewspieranych przez requested lane.

Canonicalizacja normalizuje osie, porządkuje klucze, spłaszcza zagnieżdżone
`and|or|xor`, zachowuje kolejność tam, gdzie wpływa na diagnostykę, oraz
rozwiązuje named refs do certyfikowanego grafu zależności. Fingerprint to
`sha256` z wersji schematu, kanonicznego AST i jego jawnych zależności. Nie
zawiera maski ani rewizji stanu; resolved fingerprint zawiera dodatkowo
topologię, politykę granicy i rewizję snapshotu.

Analiza zależności klasyfikuje AST deterministycznie. `all_magnetic`,
`in_object`, `in_region`, `inside_geometry`, współrzędne, skończone stałe i ich
kompozycje boolowskie są `geometry_only`. Każde użycie
`magnetization_component`, `magnetization_norm` albo `magnetization_dot` nadaje
całemu zależnemu wyrażeniu i każdemu odwołującemu się `ref` klasę
`state_dependent`; `abs`, `compare`, `approx`, `between` i operatory zbiorowe
propagują tę klasę z potomków. Klasyfikacja jest zapisana w certyfikowanym
grafie zależności i nie zależy od lane'u.

(selection-expr-v1-materialization)=
## 5. Materializacja

Pipeline jest deterministyczny:

1. schema i semantic validation;
2. resolution object/region/selection references;
3. canonicalization i authored fingerprint;
4. analiza zależności `static` lub `state_dependent`;
5. materializacja static candidate mask;
6. dla snapshotu: atomowa ewaluacja predykatu stanu;
7. zastosowanie authored policy do raw candidate mask: domyślne
   `warn_and_intersect` raportuje liczność poza aktywną domeną i przecina z
   nią, a `error` odrzuca materializację;
8. certyfikat zawierający counts, bounds, warnings, topology fingerprint,
   authored fingerprint i resolved mask fingerprint.

FDM próbuje predykat w środkach aktywnych komórek. FEM wybiera magnetyczne true
DOF właściwego FE space i zachowuje mapę trzech składowych. Airbox i
niemagnetyczne DOF mogą wystąpić wyłącznie w raw candidate mask i podlegają
authored policy z kroku 7. Po utworzeniu certyfikatu resolved mask musi być
podzbiorem aktywnej domeny. Bit poza aktywną domeną w masce przekazanej do
runtime, odtworzonej z checkpointu albo odebranej z cache jest naruszeniem
inwariantu i twardym błędem `selection_resolved_mask_outside_active_domain`;
nie wolno go naprawiać ponownym przecięciem. Pusta finalna selekcja domyślnie
daje typed error.

Preview uprawniony do aktywacji i runtime używają tego samego kompilatora,
topology fingerprintu i mask fingerprintu. Stale revision albo inny topology
fingerprint unieważnia wynik; UI nie może zatwierdzić starego preview.

Warstwa IR i plannerowa materializacja istnieją obecnie jako
`ResolvedFrozenSpinsPlanIR`, `SelectionCertificateIR`,
`compile_fdm_frozen_spins` i `compile_fem_frozen_spins`. Nie są jeszcze
podłączone do wykonania constraintu, authoritative preview ani checkpointu.
Wszystkie lane'y wykonawcze pozostają `UNQUALIFIED`.

(selection-expr-v1-errors)=
## 6. Failure semantics

Typed errors zawierają ścieżkę `ProblemIR`, kod, odpowiednie ID i diagnostykę.
Wymagane kody obejmują:

- `selection_unknown_object`, `selection_unknown_region`,
  `selection_unknown_reference`, `selection_reference_cycle`;
- `selection_complexity_exceeded`, `selection_invalid_constant`,
  `selection_invalid_axis`, `selection_invalid_boundary`,
  `selection_invalid_geometry`, `selection_singular_transform`;
- `selection_empty`, `selection_inactive_intersection`;
- `selection_resolved_mask_outside_active_domain`;
- `selection_stale_revision`, `selection_topology_mismatch`;
- `selection_variant_unsupported`, `selection_imported_solid_unqualified`.

Unsupported combinations failują przed alokacją solvera. Brak capability nie
oznacza pustej maski ani fallbacku na inny evaluator.

(selection-expr-v1-capabilities)=
## 7. Capability vocabulary

Minimalne identyfikatory capability:

```text
selection_expr.v1
selection.geometry_predicate.v1
selection.boolean.and_or_xor_not.v1
selection.state.magnetization_snapshot.v1
selection.membership.static.v1
selection.membership.snapshot_at_activation.v1
selection.materialization.fdm_cell_center.v1
selection.materialization.fem_true_dof.v1
selection.preview.authoritative.v1
selection.disk.finite_cylinder.v1
selection.affine.object_world.v1
```

Każdy wpis raportuje `supported`, `qualified`, ograniczenia solver/device/
precision, obsługiwane warianty i codes dla odrzucenia. Planner może wybrać
lane tylko wtedy, gdy requested warianty są supported; `qualified` jest
niezależne i pochodzi z macierzy walidacyjnej.

(selection-expr-v1-example)=
## 8. Kanoniczny przykład danych

```json
{
  "schema_version": "selection_expr.v1",
  "id": "pinned_positive_core",
  "name": "Pinned positive core",
  "expression": {
    "kind": "and",
    "expressions": [
      {"kind": "in_object", "object_id": "free_layer"},
      {
        "kind": "inside_geometry",
        "frame": {"kind": "object", "object_id": "free_layer"},
        "sampling": {"kind": "dof_point"},
        "boundary": {"kind": "inclusive", "absolute_tolerance_m": 0.0, "relative_tolerance": 1e-12},
        "geometry": {
          "kind": "cylinder",
          "center_m": [0.0, 0.0, 0.0],
          "axis": [0.0, 0.0, 1.0],
          "radius_m": 2.5e-8,
          "height_m": 3e-9
        }
      },
      {
        "kind": "compare",
        "lhs": {"kind": "magnetization_component", "component": "z"},
        "op": "gt",
        "rhs": {"kind": "constant", "value": 0.5}
      }
    ]
  }
}
```

To jest zatwierdzony kontrakt i wspólny fixture parity Rust/Python. Bieżący
kod zawiera typed `SelectionExprIR`, publiczny `fullmag.select`, canonical
lowering, strict validation i zgodny fingerprint authoringowy. Planner zawiera
kompilację dense maski oraz certyfikatu dla FDM i FEM true DOF, ale runtime,
checkpoint i authoritative preview pozostają niezaimplementowane. Każdy lane
wykonawczy pozostaje `UNQUALIFIED`; plannerowa materializacja nie jest dowodem
wykonania constraintu.
