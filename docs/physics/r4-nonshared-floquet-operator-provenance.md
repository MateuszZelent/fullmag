# Pochodzenie operatora Floqueta dla domeny non-shared

- Status: `source_visible / runtime_unvalidated`
- Właściciel: Fullmag FEM frequency-domain backend
- Data: 2026-10-01
- Zakres: addytywne związanie operatora non-shared z równowagą, próbką k i dokładnym matrix pencil
- Powiązane kontrakty: `docs/specs/frequency-domain-artifacts-v2.md`, `docs/physics/r4-linearization-identity-v2.md`, `docs/physics/r4-accepted-recomputed-replay-v2.md`

(problem-statement)=
## 1. Problem i cel

Ścieżka Floqueta bez wspólnego operatora Poissona (non-shared) otrzymuje z
warstwy Rust macierze operatora i masy, ale wcześniejszy rekord pochodzenia
przenosił tylko skrót macierzy diagnostycznych. Taki skrót nie wiązał pełnego
matrix pencil z równowagą, materiałem, warunkiem Floqueta ani źródłem
relaksacji. Ten rekord jest prywatnym, addytywnym transportem tożsamości dla
jednego sample; nie zmienia równania, siatki ani publicznego Python API.

(governing-equations)=
## 2. Równanie i tożsamość operatora

Po projekcji na lokalne bazy styczne ścieżka non-shared rozwiązuje uogólniony
problem własny

```{math}
:label: eq-nonshared-floquet-pencil
K_{\omega}(\mathbf k)q = \lambda B(\mathbf k)q,
```

gdzie `K_omega = gamma_0 K_field`, a `B` zawiera blok żyromagnetyczny i
tangent mass. Dla pary węzłów `a,b` z translacją `\Delta r` wiązanie Floqueta
ma fazę

```{math}
:label: eq-nonshared-floquet-phase
q_b = \exp(-i\,\mathbf k\cdot\Delta\mathbf r)q_a.
```

Tożsamość operatora jest liczona z kanonicznego obiektu zawierającego pełne
wartości macierzy `K_omega`, `B`, tangent mass i blok żyromagnetyczny, a także
diagnostykę wejściową, pary i fazy Floqueta, stan `m_0`, identyfikatory źródła
oraz snapshot budowy. Zapisuje się digest SHA-256 oraz dokładne bajty JSON
preimage. Digest nie jest dowodem zbieżności solvera.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `$K_{\omega}$` | macierz pola liniaryzacji pomnożona przez `gamma_0` | $\mathrm{s^{-1}}$ w reprezentacji masowej |
| `$B$` | macierz pencil: blok żyromagnetyczny i masa styczna | zależna od normalizacji FEM |
| `$M_t$` | tangent mass użyta przez solver | $\mathrm{m^3}$ w dyskretyzacji pola |
| `$m_0$` | magnetyzacja równowagi | $1$ |
| `$\alpha$` | tłumienie planu modalnego | $1$ |
| `$\mathbf{k}$` | wektor falowy | $\mathrm{rad\,m^{-1}}$ |
| `$\Delta\mathbf r$` | translacja pary periodycznej | $\mathrm{m}$ |
| `$\phi$` | faza Floqueta | $\mathrm{rad}$ |
| `$\lambda$` | wartość własna pencil | $\mathrm{s^{-1}}$ |
| `$q$` | zespolony wektor perturbacji modalnej | $1$ |
| `$f$` | częstotliwość własna | $\mathrm{Hz}$ |
| `$D$` | digest tożsamości operatora | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice

Rekord dotyczy wyłącznie native FEM CPU/GPU, gdy operator został dostarczony
jako jawny non-shared matrix pencil. Nie udaje `SharedDomainLinearizationState`
i nie nadaje ścieżce non-shared certyfikatu wspólnej domeny ani dynamicznego
demag. W przypadku braku zweryfikowanego handoffu, `m_0`, materiału, siatki,
budowy albo exact payloadów stan pozostaje `NOT_VERIFIED`.

Publikacja tego konkretnego rekordu jest dodatkowo ograniczona do planu z
`spin_wave_bc.kind == Floquet`. Ten sam runnerowy operator może obsługiwać
ścieżki `Free`, `Pinned` albo zwykłe `Periodic`; są one wykonywane własną
ścieżką non-shared, lecz nie otrzymują etykiety ani sidecarów Floqueta.
Bezpośrednie wywołanie buildera dla innego rodzaju granicy kończy się błędem
`nonshared_floquet_provenance_requires_floquet_boundary`, zamiast tworzyć
fałszywe twierdzenie o fazie Blocha.

Zweryfikowany handoff zawiera dokładny, oprawiony digest bajtów
`producer_plan_snapshot.preimage_json`. Z tych samych bajtów można odtworzyć
`FemPlanIR` i kanoniczny `FemMeshPayload`; runner publikuje oba elementy jako
`nonshared_source/producer_plan_snapshot.v1.json` oraz
`nonshared_source/source_mesh.json`. Sam zadeklarowany fingerprint nie jest
traktowany jako payload siatki. Jeżeli snapshot producenta nie istnieje,
publikowany jest tylko `nonshared_modal_mesh.json` z jawnym statusem
`NOT_VERIFIED_producer_payload_not_published`.

Status `source_replay_qualified` wymaga dodatkowo, aby opublikowany payload
producenta dał się odczytać, a wszystkie cztery pola źródłowe (`m_0`, `h_eff0`,
`h_demag0`, `phi0`) miały zweryfikowane pochodzenie i długość równą liczbie
węzłów tego samego payloadu. Sam skończony wektor albo zgodny digest topologii
nie kwalifikuje replayu. Brak któregokolwiek dowodu pozostawia status
`NOT_VERIFIED`.

Przy każdym zbudowanym pencilu publikowane są także dokładne bajty preimage:
`nonshared_floquet_source_state_preimage.v1.json`,
`nonshared_floquet_operator_input_preimage.v1.json` oraz
`nonshared_floquet_matrix_pencil_preimage.v1.json`. Referencje w polu
`nonshared_floquet_exact_replay_refs` zawierają ścieżkę, kodowanie, długość i
surowy SHA-256 każdego pliku. Dla fizycznych sygnatur referencja podaje także
namespace użyty do digestu ramowanego. Tylko gdy istnieje zweryfikowany handoff
producenta, ten sam bundle zawiera dokładne preimage materiału równowagi,
statycznej fizyki, warunku brzegowego i raw material provenance. Brak któregoś
z wymaganych bajtów albo namespace pozostawia replay `NOT_VERIFIED`; sam digest
nie jest dowodem odtwarzalności.

`alpha` w tożsamości jest tłumieniem planu eigen; tłumienie relaksacji jest
częścią źródłowego handoffu. `k=0` nie zmienia wariantu na shared-domain.
FDM i publiczny DSL nie są objęte tym rekordem. Publikacja artefaktów nie
oznacza jeszcze kwalifikacji fizycznej, residual ani zgodności z COMSOL-em.

(python-api)=
## 5. Python API

Brak zmiany publicznego Python API. Autor tworzy istniejący `FemEigenPlanIR`
z `k_sampling`, `spin_wave_bc`, `damping_policy` i materiałem; transport
provenance jest wewnętrzny dla runnera.

(problem-ir)=
## 6. ProblemIR

Wykorzystywane są istniejące pola `eigenmodes.k_sampling`, typu Floqueta,
`operator`, `material.damping`, włączonych oddziaływań i konfiguracji siatki.
Nie dodaje się pól IR ani nie zmienia round-trip.

Przykład deklaruje istniejący etap authoringowy; nie uruchamia solvera ani nie
tworzy nowego pola publicznego:

```python
# %%
import fullmag as fm

# %%
study = fm.study("nonshared_floquet_provenance")
study.stages.add_stage(
    fm.eigenmodes_stage(
        count=4,
        operator="full_2x2",
        include_demag=True,
        k_vector=(0.0, 2.0e6, 0.0),
        bc="floquet",
        magnetostatic_bc="floquet_airbox",
    ),
    stage_id="dispersion-k-y-2e6",
)
```

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

Diagnostyka wejściowa przekazana do native, diagnostyka wyniku, summary oraz
każdy opublikowany mode otrzymują ten sam digest tożsamości. Exact accepted,
certified i recomputed payloady są przenoszone tylko wtedy, gdy istnieje
zweryfikowany handoff; w przeciwnym przypadku rekord jawnie wskazuje brak
replay. Mutacja dowolnego parametru operatora, stanu, fazy lub snapshotu musi
zmienić digest. Konflikt istniejącego sidecara jest błędem fail-closed.

Są dwa różne skróty pencilu. Rust publikuje
`linearized_dynamic_pencil_dependency_digest`,
który wiąże dokładne wejście przekazane do native. Native publikuje
`linearized_dynamic_pencil_digest`, wyliczony z rzeczywistego pencilu po
zastosowaniu znaku `L=-K` i `B=-G`, oraz powtarza digest zależności w obu
JSON-ach. Produkcyjna ścieżka odrzuca wynik, gdy którykolwiek z tych pól jest
nieobecny, ma niekanoniczny format albo nie zgadza się między Rust,
diagnostyką i wynikiem. Skrót wejścia nie zastępuje dowodu, że solver zwrócił
poprawny residual.

Dokładne bajty `source_state`, `operator_input` i `matrix_pencil` są
publikowane jako sidecary obok ich digestów. Dzięki temu niezależny konsument
może policzyć hash z rzeczywistych bajtów i porównać wartości macierzy, zamiast
rekonstruować JSON z samego skrótu. Preimage fizycznych sygnatur jest
przenoszony z `AcceptedFemRelaxStageReplayPayload`; nie jest tworzony z
bieżącego planu modalnego.

Pythonowy check jest wyłącznie kontrolą źródeł: nie odtwarza algorytmu
`shared_domain_content_digest` przez `json.dumps` i nie dowodzi zgodności
Python–Rust ani wykonania native.

`requested intent` pozostaje zapisany w istniejącym `FemEigenPlanIR`, a
`resolved execution` pochodzi z planera i managed native attestation.
Niezgodne lub niepełne wejście zwraca jawne `validation errors`; kombinacje
`unsupported combinations` muszą zostać odrzucone bez cichego fallbacku.

(discrete-realization)=
## 8. Realizacja dyskretna

Macierze są serializowane w kolejności row-major razem z wymiarami. Dla
bezpośredniej ścieżki Rust waliduje masę jako powtarzalny blok `N×N` i buduje
`G = [[0,M],[-M,0]]`; nie odrzuca przy tym jawnie podanego operatora bez
sprawdzenia struktury ani nie pozwala native rekonstruować innego bloku. Dla
zespolonego Blocha/Floqueta jawne osadzenie
rzeczywiste dostarcza `G = [[0,-M_R],[M_R,0]]`. Native otrzymuje dokładnie
zbudowaną macierz `G`, a jego wewnętrzna reprezentacja realna stosuje
`R(iG) = [[0,-G],[G,0]]`. Są to ustalone konwencje reprezentacji; nie wolno
wyciągać z nich ręcznej zmiany znaku ani utożsamiać zgodności częstotliwości ze
zgodnością polaryzacji. Bezpośredni input ma `2N` stopni swobody, zespolony
realified input `4N`, a wewnętrzny obrót native podwaja odpowiednio każdy z
tych wymiarów. Test polaryzacji i parytet runtime pozostają otwarte.

`K_field` ma jednostkę pola masowego `A/m`, natomiast `K_omega` przekazywane
do native ma `rad/s`; `gamma_0` jest stosowane dokładnie raz przy przejściu
z pierwszego do drugiego. Lista par Floqueta zachowuje identyfikator, indeksy
węzłów, translację i fazę w radianach. Digest obejmuje również operator
diagnostics JSON po jego sparsowaniu, lecz nie zastępuje exact danych macierzy.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` — prywatny stan,
  canonical preimage, digest, exact sidecary, producer plan snapshot, payload
  siatki i pola diagnostyczne;
- `crates/fullmag-runner/src/fem/eigen_native_window.rs` — budowa tożsamości
  przed wywołaniem native, walidacja bloków masy, rozróżnienie jednostek oraz
  fail-closed dla digestów zależności/actual native pencilu;
- `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` — exact preimage
  `source_state`, `operator_input`, `matrix_pencil` i fizycznych źródeł replayu,
  wraz z referencjami, namespace'ami digestów i surowymi digestami;
- `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` — publikacja pól
  provenance w summary i per-mode oraz exact sidecarów źródła;
- `crates/fullmag-runner/src/fem/mod.rs` — rejestracja prywatnego modułu;
- `crates/fullmag-runner/src/native_fem/frequency_domain.rs` — brak zmiany ABI.

(validation)=
## 10. Walidacja

Przygotowano interpretowany source regression sprawdzający użycie
repozytoryjnego digestu ramowanego, zachowanie exact preimage, wspólne pola
diagnostyki wejścia/artefaktu, indeks próbki CSV, strukturę `G` i fail-closed
dla braku payloadu producenta oraz digestów native.
Regresja obejmuje również obecność exact sidecarów i referencji pełnego
replayu. Nie jest to test runtime. Natywne testy, managed build, runtime oraz
obliczenie fizycznej dyspersji pozostają `NOT VERIFIED` w tym przyroście
zgodnie z polityką runnera.

(limitations)=
## 11. Ograniczenia

Tożsamość nie dowodzi poprawności dyskretyzacji, zbieżności siatki, poprawności
demag ani zgodności z analityką/COMSOL. Ścieżka non-shared z brakującym
handoffem może publikować diagnostykę operatora, ale nie może otrzymać statusu
`payload_replay_qualified`. Zgodność indeksów w CSV i digestów jest warunkiem
integralności artefaktu, a nie wynikiem obliczenia dyspersji.

(scientific-bibliography)=
## 12. Bibliografia naukowa

- Bloch, F., *Über die Quantenmechanik der Elektronen in Kristallgittern*,
  Zeitschrift für Physik 52 (1929), 555–600 — faza Blocha.
- Brown, W. F., *Micromagnetics*, Interscience (1963) — liniaryzacja pól
  magnetycznych i energia wymiany.
- Dokumentacja MFEM i lokalny kontrakt Fullmag `frequency-domain-artifacts-v2` —
  realizacja macierzy FEM i pochodzenie artefaktów.

(source-code-index)=
## 13. Indeks źródeł

Źródła odpowiedzialne za kontrakt i transport są wskazane w pliku
`r4-nonshared-floquet-operator-provenance.source-map.json`. Status `source_visible`
oznacza kontrolę kodu; status runtime i kwalifikacja naukowa pozostają otwarte.

| Ścieżka | Symbol |
|---|---|
| `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` | `build_nonshared_floquet_provenance` |
| `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `execute_native_modal_window` |
| `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` | `native_modal_artifacts` |
| `crates/fullmag-runner/src/fem/eigen_policy.rs` | `native_modal_floquet_periodic_pairs` |
| `scripts/test_nonshared_floquet_operator_identity.py` | `class NonSharedFloquetOperatorIdentitySourceContract` |
