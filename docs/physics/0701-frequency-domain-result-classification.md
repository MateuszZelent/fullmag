(frequency-domain-result-classification)=
# Klasyfikacja wyników częstotliwościowych physics-first

- Status: kontrakt referencyjny interfejsu i artefaktów
- Właściciel: zespół Fullmag
- Ostatnia aktualizacja: 2026-08-12
- Powiązane ADR: [ADR 0023](../adr/0023-physics-first-results-explorer.md)
- Powiązana fizyka: [liniaryzowana LLG](0700-frequency-domain-linearized-llg.md), [warunki periodyczne i Floqueta](0710-periodic-and-floquet-boundary-conditions.md)
- Powiązana specyfikacja: [Physics-first Explorer, Results i Analysis](../superpowers/specs/2026-08-11-explorer-results-physics-first-design.md)

(problem-statement)=
## 1. Problem fizyczny i produkt obliczeniowy

Control Room musi nazywać wynik na podstawie jego fizycznego znaczenia, a nie nazwy solvera, pliku albo etykiety. Dwa produkty korzystają z tej samej liniaryzacji LLG wokół jawnego stanu równowagi $\mathbf{m}_0$, ale rozwiązują różne problemy:

- `modal_eigen` publikuje swobodne mody własne i ich częstotliwości;
- `driven_response` publikuje odpowiedź wymuszoną na zadane pole harmoniczne.

To rozróżnienie jest zachowane niezależnie od backendu. Mod własny nie staje się modem aktywnym FMR wyłącznie dlatego, że ma $\mathbf{k}=\mathbf{0}$. Odpowiedź wymuszona nie staje się relacją dyspersji wyłącznie dlatego, że jest próbkowana dla wielu wartości $\mathbf{k}$.

(governing-equations)=
## 2. Równania i obserwable

Przy konwencji fazora $\exp(+\mathrm{i}\omega t)$ modalny produkt rozwiązuje uogólnione zagadnienie własne

```{math}
:label: eq-fd-classification-modal
\mathcal{L}(\mathbf{k})\,\mathbf{q}_n(\mathbf{k})
= \mathrm{i}\omega_n(\mathbf{k})\,\mathcal{B}_{\alpha}(\mathbf{k})\,\mathbf{q}_n(\mathbf{k}),
\qquad
f_n(\mathbf{k})=\frac{\operatorname{Re}\omega_n(\mathbf{k})}{2\pi}.
```

Produkt wymuszony rozwiązuje dla każdej częstotliwości

```{math}
:label: eq-fd-classification-driven
\left[\mathrm{i}\omega\mathcal{B}_{\alpha}(\mathbf{k})-\mathcal{L}(\mathbf{k})\right]
\mathbf{q}(\mathbf{k},\omega)=\mathbf{b}_{\mathrm{RF}}(\mathbf{k},\omega),
```

a następnie publikuje dokładnie nazwane observable, na przykład

```{math}
:label: eq-fd-classification-response
A(\mathbf{k},f)=\mathcal{O}_{A}[\mathbf{q}(\mathbf{k},2\pi f)],
\qquad
\chi(\mathbf{k},f)=\mathcal{O}_{\chi}[\mathbf{q}(\mathbf{k},2\pi f)],
\qquad
P_{\mathrm{abs}}(\mathbf{k},f)=\mathcal{O}_{P}[\mathbf{q}(\mathbf{k},2\pi f)].
```

Mapa $A(\mathbf{k},f)$ może zawierać grzbiety odpowiadające modom, lecz nie jest funkcją własną $f_n(\mathbf{k})$. UI nazywa ją `Spectral Response Map · A(k,f)`, a nie `Dispersion Relation`.

Modalny wynik otrzymuje dodatkową etykietę `RF Coupling / FMR Activity` wyłącznie po publikacji obserwabli sprzężenia, na przykład

```{math}
:label: eq-fd-classification-coupling
C_n=\left|\left\langle\mathbf{b}_{\mathrm{RF}},\mathbf{q}_n\right\rangle\right|^2,
```

z jawną definicją iloczynu, normalizacją, jednostką i provenance w artefakcie. Klasyfikator nie rekonstruuje $C_n$ z samego pola modu.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf{m}_0$ | znormalizowany stan równowagi | $1$ |
| $\mathbf{q}_n$ | zespolone współrzędne styczne modu n | zależna od normalizacji, jawna w artefakcie |
| $\mathbf{q}$ | zespolona odpowiedź styczna | zależna od normalizacji, jawna w artefakcie |
| $\mathcal{L}$ | zliniaryzowany operator pola efektywnego i momentów | $\mathrm{s^{-1}}$ w znormalizowanej postaci operatora |
| $\mathcal{B}_{\alpha}$ | operator masowy/żyroskopowy z konwencją tłumienia | $1$ w znormalizowanej postaci operatora |
| $\mathbf{k}$ | wektor Blocha/Floqueta | $\mathrm{rad\,m^{-1}}$ |
| $\omega$, $\omega_n$ | częstotliwość kołowa wymuszenia lub modu | $\mathrm{rad\,s^{-1}}$ |
| $f$, $f_n$ | częstotliwość liniowa wymuszenia lub modu | $\mathrm{Hz}$ |
| $\mathbf{b}_{\mathrm{RF}}$ | zespolone wymuszenie magnetyczne RF w układzie stycznym | zgodna z kontraktem pola, zwykle $\mathrm{A\,m^{-1}}$ przed projekcją |
| $A$ | amplituda odpowiedzi określona przez opublikowane observable | jednostka opublikowana przez observable |
| $\chi$ | podatność określona przez opublikowany kontrakt | jednostka opublikowana przez observable |
| $P_{\mathrm{abs}}$ | moc absorbowana lub jawnie nazwana gęstość mocy | $\mathrm{W}$ albo $\mathrm{W\,m^{-3}}$ |
| $C_n$ | miara sprzężenia RF z modem n | jednostka opublikowana przez observable |
| $n$ | indeks modu lub gałęzi | $1$ |
| $\mathcal{O}_{A}$, $\mathcal{O}_{\chi}$, $\mathcal{O}_{P}$ | jawnie zdefiniowane funkcjonały obserwabli | zależna od observable |

(assumptions-and-validity)=
## 4. Założenia, kontekst $\mathbf{k}$ i granice nazw

Klasyfikacja zakłada ważny stan równowagi, spójną konwencję fazora i typed manifest zachowujący `run_id`, `stage_id`, `equilibrium_identity`, `study_product`, kontekst brzegowy oraz revision. Nie dowodzi ona poprawności numerycznej wyniku; prezentuje wyłącznie dowód opublikowany przez runtime.

Kontekst wektora falowego jest rozłączny:

| Wejście manifestu | Klasyfikacja | Legalna nazwa |
|---|---|---|
| geometria skończona, brzegi otwarte | `finite_open` | `Finite system · k n/a` |
| periodyczna pojedyncza próbka $\mathbf{k}=\mathbf{0}$ | `gamma` | `Γ point · k = 0` |
| periodyczna pojedyncza próbka $\mathbf{k}\ne\mathbf{0}$ | `fixed_k` | `Eigenfrequencies at fixed k` albo `Response at fixed k` |
| modalna ścieżka lub siatka $\mathbf{k}$ | `k_path` albo `k_grid` | `Dispersion Relation · fₙ(k)` |
| wymuszona ścieżka lub siatka $\mathbf{k}$ | `k_path` albo `k_grid` | `Spectral Response Map · A(k,f)` |

Implementacja traktuje komponent wektora jako zero, gdy jego moduł nie przekracza $10^{-12}\,\mathrm{rad\,m^{-1}}$. Jest to tolerancja klasyfikacji metadanych, nie tolerancja solvera. Dla wyniku periodycznego brak jawnego `kSampling` jest błędem kontraktu i klasyfikacja zatrzymuje się fail-closed.

FMR jest kwalifikowane następująco:

- modalnie: wymagane jest observable `rf_coupling`;
- w odpowiedzi wymuszonej: wymagany jest drive `magnetic_rf` oraz co najmniej jedno z `absorbed_power`, `drive_projected_response` lub `susceptibility`;
- `response_amplitude` bez powyższego dowodu pozostaje neutralną odpowiedzią harmoniczną.

(python-api)=
## 5. Publiczne API Python

Klasyfikator nie dodaje konstruktora ani parametru do `packages/fullmag-py`. Publiczny skrypt nadal definiuje osobne etapy `Eigenmodes` i `Frequency Response` zgodnie z notą o liniaryzowanej LLG. Nazwa Results jest pochodną opublikowanego artefaktu, a nie nowym polem authoring.

Brak nowego parametru jest zamierzony: użytkownik nie może wymusić etykiety `FMR` ani `Dispersion Relation`. Musi opublikować odpowiedni produkt, kontekst $\mathbf{k}$ i observable. Eksport skryptu z UI zachowuje definicję Study, lecz nie zapisuje etykiet prezentacyjnych klasyfikatora.

Poniższy wykonywalny przykład pokazuje minimalny dowód artefaktu, który może zakwalifikować odpowiedź wymuszoną jako FMR. Jest to inspekcja kontraktu, nie alternatywny konstruktor Study:

```python
# %% Jawny typed evidence odczytany z artefaktu wyniku
result_evidence = {
    "study_product": "driven_response",
    "boundary_context": "finite_open",
    "drive": {"identity": "rf-field-1", "kind": "magnetic_rf"},
    "observables": [
        {"identity": "absorbed-power", "kind": "absorbed_power", "unit": "W"},
    ],
    "run_id": "run-1",
    "stage_id": "frequency-response-1",
    "equilibrium_identity": "equilibrium-1",
}

# %% Sprawdzenie dowodu wymagane przed legalnym użyciem etykiety FMR
has_magnetic_rf_drive = result_evidence["drive"]["kind"] == "magnetic_rf"
fmr_observables = {"absorbed_power", "drive_projected_response", "susceptibility"}
has_fmr_observable = any(
    observable["kind"] in fmr_observables
    for observable in result_evidence["observables"]
)
assert has_magnetic_rf_drive and has_fmr_observable
```

(problem-ir)=
## 6. ProblemIR, planner i requested/resolved execution

Klasyfikacja nie zmienia `ProblemIR`. `ProblemIR` zachowuje żądany etap, backend, urządzenie, precyzję, warunki brzegowe i sampling. Planner rozstrzyga legalną realizację, lecz nie może zamienić `modal_eigen` w `driven_response` ani odwrotnie.

Artefakt zachowuje osobno intencję żądaną i wykonanie rozstrzygnięte. Klasyfikator używa typed evidence wyniku; nie wnioskuje produktu z backendu, statusu joba, ścieżki pliku ani nazwy etapu.

(round-trip-and-failure-semantics)=
## 7. Round-trip, zasoby i semantyka błędów

Pipeline Control Room jest jednokierunkowy i deterministyczny:

```text
revisioned API resource
  -> typed result snapshot
  -> fail-closed physical classifier
  -> run/stage-scoped Results tree
  -> typed selection ref
  -> dedicated Inspector / Analysis / Viewport
```

Brak `equilibrium_identity` albo `boundary_context` tworzy jawny contract gap i nie publikuje semantycznego wyniku. Brak zasobu produktu nie jest zastępowany placeholderem. Zmiana display unit, etykiety albo revision payloadu nie zmienia immutable run/stage identity węzła.

W terminologii round-trip **requested intent** zachowuje żądany produkt i warunki, a **resolved execution** zachowuje faktycznie wybrany lane. **Validation errors** zatrzymują materializację wyniku przy brakującym dowodzie. **Unsupported combinations** pozostają jawnie niedostępne i nie otrzymują nazwy sugerującej wykonanie.

(discrete-realization)=
## 8. Realizacje FEM/FDM i CPU/GPU

Ta nota klasyfikuje artefakty i nie promuje lane’u solvera. Równania oraz reguły nazw są backend-neutralne; wykonanie pozostaje ograniczone przez capability i dowody każdej realizacji.

| Solver | Urządzenie | Stan klasyfikacji | Granica wykonania |
|---|---|---|---|
| FEM | CPU | udokumentowana | klasyfikacja działa dla opublikowanych artefaktów; produkcyjność operatora pozostaje określona przez noty FEM frequency-domain |
| FEM | GPU | semantyczna | klasyfikacja nie promuje niezakwalifikowanych ścieżek GPU ani nonzero-$\mathbf{k}$ |
| FDM | CPU | semantyczna | legalna po publikacji zgodnego manifestu; ta nota nie dowodzi dostępności eigensolve/response |
| FDM | GPU | semantyczna | legalna po publikacji zgodnego manifestu; ta nota nie dowodzi dostępności ani parity GPU |

(implementation-mapping)=
## 9. Mapowanie implementacji

| Odpowiedzialność | Ścieżka i symbol |
|---|---|
| typed evidence, unie produktów i kontekstów | `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.ts` — `FrequencyDomainResultEvidence` |
| czysta klasyfikacja fizyczna | `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.ts` — `classifyFrequencyDomainResult` |
| adaptacja revisioned resources do snapshotu | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts` — `physicsFirstResultsSnapshotFromResources` |
| physics-first builder drzewa | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts` — `buildPhysicsFirstResultsTree` |
| semantyczne modele nagłówków | `apps/control-room/src/modules/inspector/panels/physics-first/physicsFirstResultInspectorModel.ts` — `physicsFirstResultInspectorModel` |

(validation)=
## 10. Walidacja

Test klasyfikatora pokrywa finite/open, Γ, fixed nonzero-$\mathbf{k}$, path, grid, modalne sprzężenie RF, kwalifikowaną odpowiedź FMR, neutralną odpowiedź harmoniczną i fail-closed brak samplingu. Test buildera dowodzi run/stage-scoped ID, braku wyników dla samej konfiguracji oraz rozdzielenia modal/driven. Test rejestru wymaga osobnego właściciela komponentu dla każdego physics-first kind.

Walidacja tej noty obejmuje source-map validator, testy walidatora dokumentacji, changed-page gate oraz testy TypeScript wskazane w indeksie źródeł. Browser smoke sprawdza routing, nagłówki `Response Frequency Points` i `Response Fields`, reset scrolla, akcję pola 3D i brak błędów konsoli.

(limitations)=
## 11. Ograniczenia i praca odroczona

- Backend musi opublikować stabilne `equilibrium_identity`, `boundary_context`, drive i observable; UI nie może ich zgadywać.
- Bieżący adapter `physicsFirstResultsSnapshotFromResources` przenosi observable, lecz nie przenosi jeszcze drive evidence; dlatego zasób runtime nie może obecnie zakwalifikować driven FMR wyłącznie przez ten adapter.
- Obecny adapter ścieżki $\mathbf{k}$ czyta jawne `path_metadata`; single-$\mathbf{k}$ i grid wymagają równoważnego typed payloadu, zanim mogą być produkcyjnie materializowane z zasobów.
- Jednostka `susceptibility` oraz normalizacja $C_n$ muszą pochodzić z artefaktu; klasyfikator nie narzuca jednej konwencji wymiarowej.
- Porównanie modal–driven wymaga osobnego verdict zgodności equilibrium, geometrii/mesh, kontekstu $\mathbf{k}$, jednostek i observable.
- Ta nota nie stanowi dowodu wykonania ani parity dla FEM GPU, FDM CPU lub FDM GPU.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. W. F. Brown Jr., *Micromagnetics*, Interscience, 1963.
2. A. G. Gurevich, G. A. Melkov, *Magnetization Oscillations and Waves*, CRC Press, 1996, [DOI:10.1201/9780138743147](https://doi.org/10.1201/9780138743147).
3. M. Krawczyk, D. Grundler, “Review and prospects of magnonic crystals and devices with reprogrammable band structure”, *Journal of Physics: Condensed Matter* 26, 123202 (2014), [DOI:10.1088/0953-8984/26/12/123202](https://doi.org/10.1088/0953-8984/26/12/123202).

(source-code-index)=
## 13. Indeks kodu źródłowego i dowodów

| Twierdzenie | Ścieżka i symbol | Lane | Dowód |
|---|---|---|---|
| klasyfikacja produktu, $\mathbf{k}$ i FMR | `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.ts` — `classifyFrequencyDomainResult` | wspólna semantyka | `frequencyDomainResultClassification.test.ts` — `describe("classifyFrequencyDomainResult")` |
| modalne zagadnienie własne | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` — `solve_modal_eigen_contract` | FEM CPU / kontrakt | testy frequency-domain backendu i runnera |
| wymuszona odpowiedź harmoniczna | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` — `solve_driven_response_contract` | FEM CPU / kontrakt | testy frequency-domain backendu i runnera |
| fail-closed resource snapshot | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts` — `physicsFirstResultsSnapshotFromResources` | Control Room | `resultsExplorerNodes.test.ts` — `describe("physics-first Results builder")` |
| typed evidence i klasyfikacja | `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.ts` — `classifyFrequencyDomainResult` | wspólna semantyka | `frequencyDomainResultClassification.test.ts` — komplet kontekstów i kwalifikacji |
| deterministyczne drzewo wyników | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts` — `buildPhysicsFirstResultsTree` | Control Room | `resultsExplorerNodes.test.ts` — `describe("physics-first Results builder")` |
| semantyczne modele Inspectorów | `apps/control-room/src/modules/inspector/panels/physics-first/physicsFirstResultInspectorModel.ts` — `physicsFirstResultInspectorModel` | Control Room | `physicsFirstResultInspectorModel.test.ts` — komplet 28 rodzajów physics-first |
