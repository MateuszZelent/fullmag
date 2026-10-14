# Przekazanie równowagi `RelaxedInitialState` do kontynuacji multi-k

- Status: `source-visible / runtime-unverified`
- Właściciel: FEM frequency-domain backend
- Zakres: ponowne użycie jednej zaakceptowanej równowagi statycznej dla kilku
  wektorów falowych $\mathbf{k}$
- Data: 2026-10-01
- Powiązane kontrakty: `docs/physics/r4-accepted-field-replay.md`,
  `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`,
  `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`

Ta nota opisuje granicę pomiędzy etapem relaksacji a etapem rozwiązywania
zagadnienia własnego. Jedna zaakceptowana równowaga $\mathbf m_0$ może zasilać
ścieżkę dyspersji w kilku punktach $\mathbf{k}$, ponieważ zmiana $\mathbf{k}$
zmienia operator dynamiczny i warunek Floqueta, a nie statyczny stan materiału.
Nota nie jest dowodem poprawnego runtime ani zgodności z COMSOL-em lub TetraX.

(problem-statement)=
## 1. Dziedzina fizyczna i kontrakt etapów

Rozpatrujemy magnetyczną część wspólnej siatki FEM oraz opcjonalny airbox
demagnetyzacji. Etap relaksacji wyznacza zaakceptowany stan statyczny, a etap
modalny linearyzuje dynamikę wokół tego stanu dla kolejnych punktów ścieżki
$\mathbf{k}$. Przekazanie jest dozwolone wyłącznie wtedy, gdy oba etapy
odnoszą się do tej samej siatki, materiału, pól statycznych, warunków brzegu i
wektora $\mathbf m_0$.

Przed konwersją plan ma źródło `RelaxedInitialState`. Po sprawdzeniu
certyfikatu przygotowanie planu ustawia źródło `Provided`, aby solver modalny
nie uruchamiał drugiej relaksacji. Zmiana znacznika źródła nie zwalnia z
ponownej walidacji całego powiązania.

(governing-equations)=
## 2. Model fizyczny i równania

Na węzłach magnetycznych równowaga statyczna spełnia warunek zerowego momentu
oraz normalizację:

```{math}
:label: eq-r4-static-equilibrium
\mathbf m_{0,i}\times\mathbf H_{\mathrm{eff},i}(\mathbf m_0)=\mathbf 0,
\qquad \lVert\mathbf m_{0,i}\rVert_2=1.
```

Pole efektywne jest sumą aktywnych składników planu:

```{math}
:label: eq-r4-static-field-binding
\mathbf H_{\mathrm{eff}}
=\mathbf H_{\mathrm{ex}}+\mathbf H_{\mathrm{demag}}
 +\mathbf H_{\mathrm{ani}}+\mathbf H_{\mathrm{ext}}.
```

Dla okresu translacji $\mathbf R$ dynamiczne zaburzenie ma konwencję Floqueta
używaną przez kontrakt modalny:

```{math}
:label: eq-r4-floquet-continuation
\delta\mathbf m_{\mathbf k}(\mathbf r+\mathbf R)
=\exp(-\mathrm i\,\mathbf k\!\cdot\!\mathbf R)
\,\delta\mathbf m_{\mathbf k}(\mathbf r).
```

Wspólny stan $\mathbf m_0$ jest zachowany między punktami $\mathbf{k}$, a
warunek Floqueta i dynamiczny operator demagnetyzacji są ponownie składane dla
danego punktu. Przekazanie nie aproksymuje pola i nie zastępuje dynamicznego
operatora demagnetyzacji.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol/token | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m_0$ / `equilibrium_magnetization` | zaakceptowana magnetyzacja równowagi | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | statyczne pole efektywne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ex}}$ | pole wymiany | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag}}$ | statyczne pole demagnetyzacji | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ani}}$ | pole anizotropii jednoosiowej | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ext}}$ | przyłożone pole zewnętrzne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf k$ / `k_vector` | wektor falowy punktu ścieżki | $\mathrm{rad\,m^{-1}}$ |
| $\mathbf R$ | wektor okresu siatki | $\mathrm{m}$ |
| $\delta\mathbf m_{\mathbf k}$ | dynamiczne zaburzenie modalne | $1$ |
| $\mathbf m\times\mathbf H$ | moment używany w kryterium relaksacji | $\mathrm{A\,m^{-1}}$ |
| $\mathrm i$ | jednostka urojona | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- Handoff zawiera dokładny digest $\mathbf m_0$; tolerancja normalizacji
  wewnętrznego stanu FEM nie pozwala zmienić opublikowanego wektora.
- Identyczność obejmuje generację i fingerprint topologii siatki, indeksowanie,
  rejestr części, materiał, aktywne pola statyczne oraz warunki brzegu.
- Obecność `uniaxial_anisotropy`, także dla $K_u=0$, wybiera istniejący
  kontrakt materiału V2; bez tego pola pozostaje V1. Nie zmieniamy semantyki
  surowej/canonical provenance ani mixed-topology V3.
- Ścieżka multi-k może ponownie użyć jednej równowagi. `bias_field_samples`
  są odrzucane, ponieważ każda próbka pola wymaga własnej równowagi lub
  jawnej kontynuacji relaksacji.
- Walidacja handoffu jest warunkiem bezpieczeństwa danych wejściowych. Nie
  jest progiem residualu modalnego, testem zbieżności siatki ani dowodem
  poprawności częstotliwości.

(python-api)=
## 5. Publiczne API Python

Ta zmiana nie dodaje konstruktora, parametru ani interakcji Python DSL. Istniejące
`k_sampling` i `equilibrium` są obniżane do `FemEigenPlanIR`; przekazanie
zaakceptowanej relaksacji jest wewnętrznym kontraktem wykonawczym. Publiczny
skrypt należy opierać na istniejącym scenariuszu stage-first
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.

Przykład inspekcji artefaktu nie uruchamia solvera:

```python
# %%
import json
from pathlib import Path

handoff_path = Path("equilibrium/accepted_relax_stage_handoff.v3.json")
handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
assert handoff["schema_version"] == "AcceptedFemRelaxStageHandoff.v3"
assert handoff["equilibrium_content_sha256"].startswith("sha256:")
```

(problem-ir)=
## 6. `ProblemIR` i obniżanie planu

| Intencja | Pole `FemEigenPlanIR` | Normalizacja |
|---|---|---|
| źródło stanu przed przekazaniem | `equilibrium = RelaxedInitialState` | wymagany zaakceptowany handoff |
| ścieżka dyspersji | `k_sampling = Path { points, samples_per_segment, closed }` | orchestrator tworzy plan `Single` dla każdego punktu |
| punkt pojedynczy | `k_sampling = Single { k_vector }` | zachowany dokładnie w operatorze modalnym |
| próbka pola bias | `bias_field_samples` | nie jest częścią tego handoffu; wymaga osobnej równowagi |
| stan po przekazaniu | `equilibrium = Provided` oraz `equilibrium_magnetization` | ten sam digest $\mathbf m_0$ z handoffu |

Wektor $\mathbf{k}$ należy do tożsamości dynamicznego operatora modalnego, lecz
nie do statycznych podpisów materiału, pól i warunków brzegu. Mixed-topology
fingerprint V3 opisuje modalne dane siatki i pozostaje odrębny od topology
fingerprint źródłowej relaksacji.

(round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka odrzuceń

Walidator wykonuje dwa jawne przejścia. W terminologii kontraktu zachowuje
zarówno **requested intent**, jak i **resolved execution**, a odrzucenia są
raportowane jako jawne **validation errors**; nie ma cichych wyjątków dla
**unsupported combinations**.

1. `validate_target_plan` wymaga `RelaxedInitialState` i odrzuca plan ścieżki
   lub sweepu na wejściu do pojedynczego etapu relaksacji.
2. Po ustawieniu `Provided` `validate_provided_continuation_plan` ponownie
   sprawdza te same digests, dokładny $\mathbf m_0$, normy i identyczność siatki;
   dopuszcza ścieżkę multi-k, ale odrzuca `bias_field_samples`.

Brak handoffu, zmiana materiału, pola statycznego, warunku brzegu, geometrii,
indeksowania, części siatki lub wektora $\mathbf m_0$ kończy się błędem fail-closed.
Nie ma fallbacku do niecertyfikowanego `Provided`.

(discrete-realization)=
## 8. Realizacja dyskretna i macierz wsparcia

| Solver | CPU | GPU | Status tej zmiany |
|---|---|---|---|
| FEM | wspólny kontrakt walidacji i modalny runner | ten sam kontrakt, osobna ścieżka urządzenia | source-visible; runtime unverified |
| FDM | nie dotyczy tego FEM handoffu | nie dotyczy tego FEM handoffu | not applicable |

### 8.1 FEM CPU

W planowanej ścieżce CPU operator dla każdego punktu otrzymuje tę samą
certyfikowaną równowagę oraz własny k sampling i redukcję Floqueta. Cached
operator demagnetyzacji nie może zmienić statycznego bindingu.

### 8.2 FEM GPU

GPU może używać tego samego kontraktu wejściowego, lecz wymaga osobnego dowodu
urządzenia, receiptu i parytetu. W tej nocie nie ma takiego dowodu.

### 8.3 FDM

FDM nie konsumuje `AcceptedFemRelaxStageHandoff`; ewentualna analogiczna
kontynuacja wymaga własnego kontraktu siatki i artefaktów.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `AcceptedFemRelaxStageHandoff::validate_plan_binding` jest wspólnym rdzeniem
  podpisów i digestów.
- `validate_target_plan` jest wejściem przed konwersją znacznika źródła.
- `validate_provided_continuation_plan` jest wejściem po konwersji i ma osobny
  guard sweepu pola.
- `prepare_single_k_stage_continuation` konwertuje plan, kopiuje dokładny
  wektor $\mathbf m_0$ i natychmiast wykonuje drugą walidację.
- `validate_eigen_equilibrium_certificate` stosuje właściwy walidator do
  aktualnego znacznika `RelaxedInitialState` albo `Provided`.
- `eigen_tests.rs` obejmuje ścieżkę single-k, path, drift $\mathbf m_0$,
  materiału, siatki i odrzucenie sweepu.

(validation)=
## 10. Walidacja

Weryfikacja źródłowa obejmuje:

- `python scripts/test_fem_relaxed_provided_continuation_contract.py` — testy
  interpretowane kontraktu i kolejności walidacji;
- parser/rustfmt dla zmienionych plików Rust;
- przygotowany test natywny w `eigen_tests.rs` — niekompilowany zgodnie z
  bieżącą polityką runnera.

Managed runtime, wykonanie solvera FEM, residual modalny, zbieżność siatki,
parytet CPU/GPU i porównanie z COMSOL/TetraX pozostają `NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia i dalsza praca

Ten fragment nie przenosi jeszcze pełnego source-identity binder V3 ani nie
publikuje wszystkich zaakceptowanych i przeliczonych payloadów w handoffie.
Nie rozstrzyga też jakości równowagi ani fizycznej poprawności dynamicznego
demagnetyzowania dla $k\neq0$. Następne bramki to runtime na kontrolowanym
runnerze, testy zbieżności i porównanie z analityką oraz COMSOL-em na tej samej
geometrii, materiale, airboxie i konwencji fazy.

(scientific-bibliography)=
## 12. Referencje

- Fullmag, `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`:
  kanoniczny kontrakt liniowego operatora i granic kwalifikacji.
- Fullmag, `docs/physics/r4-accepted-field-replay.md`:
  niezależna kontrola accepted/recomputed oraz tolerancji w SI.
- Fullmag, `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`:
  reprezentacje dyspersji i pochodzenie Floqueta.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Źródło | Odpowiedzialność | Dowód |
|---|---|---|---|
| pre/post source marker validation | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `validate_plan_binding` | wspólny binding materiału, pól, brzegu, siatki i $\mathbf m_0$ | source-visible |
| post-conversion Provided guard | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `validate_provided_continuation_plan` | dopuszczenie multi-k i odrzucenie sweepu | source-visible |
| conversion and immediate replay | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` — `prepare_single_k_stage_continuation` | nie uruchamia drugiej relaksacji | source-visible |
| certificate dispatch | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` — `validate_eigen_equilibrium_certificate` | dobór walidatora zgodnie ze znacznikiem | source-visible |
| source identity | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` — `EquilibriumIdentitySignaturesV1` | canonical material, static-physics, and boundary signatures | source-visible |
| modal path binding | `crates/fullmag-runner/src/fem/eigen_path.rs` — `execute_fem_eigen_path` | tworzy plany pojedynczych próbek i zachowuje handoff | source-visible |
| regressions | `crates/fullmag-runner/src/fem/eigen_tests.rs` — `accepted_relax_stage_handoff_revalidates_provided_multik_path_and_rejects_sweeps` | drift i sweep fail-closed | prepared; native not compiled |
| interpreted source gate | `scripts/test_fem_relaxed_provided_continuation_contract.py` — `class RelaxedProvidedContinuationContractTests` | kolejność i obecność guardów | executable source check |
