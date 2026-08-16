# Statyczna mapa zewnętrznego pola Zeemana

- Status: kontrakt kanoniczny FDM; implementacja FDM CPU/GPU w toku
- Owners: Fullmag core
- Last updated: 2026-08-13
- Related interaction: `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
- Related specification: `docs/superpowers/specs/2026-08-11-solved-current-skyrmion-racetrack-design.md`

(problem-statement)=
## 1. Dziedzina fizyczna

`StaticFieldMap` opisuje zewnętrzną indukcję magnetyczną, która jest zadana na
rozwiązanej siatce magnetycznej i nie zależy od magnetyzacji ani czasu. Jest to
interakcja Zeemana, a nie antena, przewodnik, pole Oersteda ani prescribed
torque. Najważniejszym zastosowaniem jest wspólny limit dynamiki: zaakceptowany
transportowy torque Fullmag może zostać odwrócony do równoważnego pola
`B_eq`, a następnie podany identycznie do Fullmag i MuMax3.

Pole jest przechowywane w SI jako `B [T]`. Backend przelicza je raz na
`H [A m⁻¹]` przez `H=B/μ₀` i dodaje do pola Zeemana w każdym aktywnym punkcie
siatki. Mapa ma tę samą kolejność komórek co rozwiązany FDM grid; brak zgodności
kształtu lub liczby komórek jest błędem planowania.

(governing-equations)=
## 2. Równania

### 2.1. Pole i energia

```{math}
:label: static-field-map-h
\mathbf H_{\mathrm{map}}(\mathbf r_q)=
\frac{\mathbf B_{\mathrm{map}}(\mathbf r_q)}{\mu_0}.
```

```{math}
:label: static-field-map-zeeman-energy
E_{\mathrm Z}=-\mu_0\sum_{q\in\Omega_m}
M_s\,\mathbf m_q\cdot\left(\mathbf H_{\mathrm{uniform}}+
\mathbf H_{\mathrm{map},q}\right)V_q.
```

Dla wspólnego limitu mapę pola otrzymuje się z tangentnego źródła Gilberta
`T_tr,G [s⁻¹]` zaakceptowanego przez Fullmag:

```{math}
:label: static-field-map-gilbert-inversion
\mathbf B_{\mathrm{eq},q}=
\frac{\mathbf m_q\times\mathbf T_{\mathrm{tr,G},q}}{\gamma_e},
\qquad
\mathbf H_{\mathrm{eq},q}=\frac{\mathbf B_{\mathrm{eq},q}}{\mu_0}.
```

Eksporter odrzuca źródło, dla którego
`|m·T_tr,G|` przekracza zadeklarowaną tolerancję; nie wykonuje ukrytej
projekcji. Mapa jest zamrożona na zaakceptowanym snapshocie i nie jest ponownie
wyznaczana podczas przebiegu MuMax3.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf r_q$ | położenie punktu/komórki $q$ | $\mathrm{m}$ |
| $q$ | indeks aktywnej komórki | $1$ |
| $\mathbf B_{\mathrm{map}}$ | zadana mapa indukcji | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{map}}$ | mapa pola używana przez LLG | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{eq}}$ | indukcja równoważna zamrożonemu torque | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{eq}}$ | równoważne pole w solverze | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | przenikalność próżni | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m_q$ | zredukowana magnetyzacja | $1$ |
| $V_q$ | objętość komórki | $\mathrm{m^3}$ |
| $\mathbf H_{\mathrm{uniform}}$ | jednorodne pole zewnętrzne | $\mathrm{A\,m^{-1}}$ |
| $\gamma_e$ | dodatnia wartość stosunku giromagnetycznego elektronu | $\mathrm{rad\,s^{-1}\,T^{-1}}$ |
| $\mathbf T_{\mathrm{tr,G}}$ | transportowe źródło Gilberta | $\mathrm{s^{-1}}$ |
| $E_{\mathrm Z}$ | energia Zeemana | $\mathrm{J}$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- mapa jest statyczna, deterministyczna i niezależna od `m(t)`;
- mapa obowiązuje wyłącznie na dokładnie tej samej siatce i w tej samej
  kolejności komórek co plan FDM;
- nie jest to rozwiązanie Maxwell/Biot--Savart i nie tworzy prądu ani pola
  Oersteda;
- mapa nie może być łączona z `OerstedCylinder` jako ten sam bufor;
- nie wolno traktować mapy jako anteny ani jako `prescribed_sot`;
- konwersja `B → H` jest wykonywana dokładnie raz, przed wejściem do LLG;
- FEM nie jest jeszcze kwalifikowany dla tego artefaktu; mapa FEM wymaga osobnej
  projekcji do przestrzeni elementów i osobnej bramki numerycznej.

(discrete-realization)=
## 5. Realizacja numeryczna

### 5.1. FDM CPU

Planner normalizuje `field_B_T` do wektora `[A m⁻¹]` i przekazuje go jako
niejednorodny składnik pola Zeemana. Każda aktywna komórka dostaje sumę pola
jednorodnego i mapy; komórki nieaktywne nie wpływają na energię ani RHS.

### 5.2. FDM GPU

Single-grid CUDA utrzymuje mapę w istniejącym device-resident wektorze pola,
ale nadaje jej osobną rolę `static_external`. Istniejący bufor ABI jest
wykorzystany bez zmiany layoutu `fullmag_fdm_plan_desc`; po utworzeniu uchwytu
nowy setter oznacza semantykę profilu. `H_EXT` zwraca sumę pola jednorodnego i
mapy, `H_OE` zwraca zero dla mapy niepochodzącej z Oersteda, a energia używa
tej samej sumy. CUDA/GPU nie wykonuje fallbacku CPU.

### 5.3. FEM i hybrid

FEM CPU/GPU oraz hybrydowy runtime są obecnie niekwalifikowane. Nie wolno
deklarować `production_executable` ani porównywać ich jako wspólnego limitu,
dopóki nie ma jawnej projekcji mapy na przestrzeń FE, testu energii i świeżego
managed runtime proof.

(python-api)=
## 6. Publiczne API Python

```python
# %%
import fullmag as fm

field = fm.StaticFieldMap(
    id="frozen_transport_equivalent",
    field_B_T=((0.0, 0.0, 0.0),),
)
print(field.to_ir())
```

`field_B_T` jest wymaganym, skończonym ciągiem trójek w teslach. `id` jest
niepustym stabilnym identyfikatorem. Publiczny obiekt nie przyjmuje surowego
CUDA pointera, nazwy kernela ani roli anteny.

| Python | type | default | SI unit | validation | meaning | backend_support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StaticFieldMap.id` | `str` | `required` | `$1$` | `niepusty` | `stabilny identyfikator mapy pola` | `kontrakt FDM CPU/GPU` | `energy_terms[].id` |
| `StaticFieldMap.field_B_T` | `Sequence[Sequence[float]]` | `required` | `$\mathrm{T}$` | `niepuste skończone wektory` | `komórkowa mapa indukcji statycznej` | `kontrakt FDM CPU/GPU` | `energy_terms[].field_B_T` |

(problem-ir)=
## 7. ProblemIR

Obiekt mapuje się na jeden wpis `energy_terms`:

```json
{
  "kind": "static_field_map",
  "id": "frozen_transport_equivalent",
  "field_B_T": [[0.0, 0.0, 0.0]]
}
```

Planner zachowuje requested intent w teslach, a resolved FDM plan zawiera
`static_external_field_xyz` w amperach na metr. Pochodzenie, digest źródłowego
`T_tr,G` i digest mapy pozostają w artefaktach common-limit; sama mapa nie
zmienia grafu transportowego.

(round-trip-and-failure-semantics)=
## 8. Round-trip, planowanie i błędy

Python → `ProblemIR` → planner → runtime zachowuje identyfikator, kolejność i
wartości mapy. Requested intent pozostaje w `ProblemIR`, a resolved execution
zawiera pole `H[A/m]`, wybrany backend i provenance. UI może pokazać mapę
dopiero przez ten sam zasób/eksporter; nie tworzy równoległego pola w drzewie
Explorer. Validation errors obejmują: pustą mapę, nie-skończone składowe,
długość inną niż `3*N`, mapę na niezgodnym gridzie, jednoczesny cylinder
Oersteda oraz żądanie FEM/GPU bez kwalifikacji. Unsupported combinations są
odrzucane przed runtime; w strict nie ma ukrytego fallbacku.

(implementation-mapping)=
## 9. Mapowanie na kod

- `packages/fullmag-py/src/fullmag/model/energy.py` — `StaticFieldMap`;
- `crates/fullmag-ir/src/study.rs` — `EnergyTermIR::StaticFieldMap`;
- `crates/fullmag-ir/src/validation.rs` — walidacja skończoności i niepustości;
- `crates/fullmag-plan/src/fdm.rs` — konwersja `B/μ₀` i zgodność z gridem;
- `crates/fullmag-ir/src/plan.rs` — `FdmPlanIR::static_external_field_xyz`;
- `crates/fullmag-runner/src/fdm/cpu/reference.rs` — referencyjne pole per-cell;
- `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` — upload
  i oznaczenie profilu;
- `backends/fdm/api/c_api.cpp` i `backends/fdm/gpu/cuda/runtime/context.cu` —
  setter, role `static_external`, obserwable i energia.

(validation)=
## 10. Walidacja

1. Test Python sprawdza konstrukcję, serializację i błędy wejścia.
2. Test IR/plannera sprawdza `B/μ₀`, długość mapy i fail-closed mismatch gridu.
3. Test CPU sprawdza energię oraz `H_eff = H_uniform + H_map`.
4. Test CUDA FP64 sprawdza `H_EXT`, `H_OE`, `H_EFF`, energię, maskę aktywną i
   parity z CPU na małej siatce.
5. Common-limit porównuje pełną trajektorię z MuMax3, ale nie awansuje mapy do
   orakla solved-current.

(limitations)=
## 11. Ograniczenia i prace odroczone

Static map nie zastępuje dynamicznego transportu: dla produkcyjnego racetracka
wynik solved-current musi nadal pochodzić z `V`, `J_c`, `mu_s`, `Q` i
transportowego torque. Mapa służy wyłącznie do kontrolowanego common-limit.
Projekcja FEM, dynamiczne mapy zależne od czasu oraz mapy oparte o pliki
zewnętrzne wymagają osobnych kontraktów.

(scientific-bibliography)=
## 12. Bibliografia

1. A. Hubert and R. Schäfer, *Magnetic Domains*, Springer (1998),
   DOI: `10.1007/978-3-540-85054-0`.
2. A. A. Thiele, "Steady-State Motion of Magnetic Domains",
   *Phys. Rev. Lett.* 30, 230 (1973), DOI: `10.1103/PhysRevLett.30.230`.
3. O. Büttner et al., "Dynamics of a magnetic vortex core",
   *Nature Physics* 11, 225–230 (2015), DOI: `10.1038/nphys3225`.

(source-code-index)=
## 13. Indeks źródeł

Pełne mapowanie równań, symboli, API, plannerów i testów znajduje się w
`0971-static-external-field-map.source-map.json`. Każdy wpis wskazuje ścieżkę
repozytorium oraz stabilny symbol; status runtime pozostaje rozdzielony od
statusu kontraktu.

| Path | Symbol | Odpowiedzialność | Lane | Test/evidence |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class StaticFieldMap` | walidacja i serializacja mapy | Python/FDM | `packages/fullmag-py/tests/test_static_field_map.py` |
| `crates/fullmag-ir/src/study.rs` | `is_static_field_map` | wariant i predykat ProblemIR | IR | `crates/fullmag-ir/tests/static_field_map_ir.rs` |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | konwersja B/T → H/A/m i grid | FDM CPU/GPU | `crates/fullmag-plan/tests/spin_transport.rs` |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `build_reference_problem` | pole per-cell w CPU | FDM CPU | `cargo check -p fullmag-runner` |
| `crates/fullmag-engine/tests/static_field_map.rs` | `static_field_map_contributes_to_external_field_and_zeeman_energy` | energia i H_eff CPU | FDM CPU | `cargo test -p fullmag-engine --test static_field_map` |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` | `create` | upload i oznaczenie profilu | FDM GPU | managed CUDA contract |
| `backends/fdm/gpu/cuda/runtime/context.cu` | `context_download_field_impl` | H_EXT/H_OE i snapshot | FDM GPU | `oersted_cuda_runtime` |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_external_energy_fp64` | energia Zeemana z profilu | FDM GPU | `oersted_cuda_runtime` |
| `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_set_static_external_field_f64` | oznaczenie roli bez zmiany ABI | FDM GPU | `oersted_cuda_runtime` |
| `scripts/export_fullmag_transport_torque_for_mumax.py` | `equivalent_field` | zamrożone B_eq i provenance | common-limit | `scripts/test_compare_fdm_racetrack_mumax.py` |
