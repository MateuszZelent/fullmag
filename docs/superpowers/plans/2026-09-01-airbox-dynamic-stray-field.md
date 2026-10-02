# Dynamiczne pole stray w Airboxie (`H_demag_dynamic`) — plan implementacji

**Status:** gotowy do implementacji  
**Data:** 2026-09-01  
**Zakres produkcyjny v1:** FEM Poisson Airbox, CPU i GPU, dynamika w dziedzinie czasu, live preview, autosave, API i Control Room  
**Zakres późniejszy:** FDM single-grid i multilayer przez oddzielny carrier obserwacyjny  
**Powiązane komponenty:** canonical quantities, accepted-state observation, FEM demag, artifact pipeline, API v2, Control Room

## 1. Decyzja

Tak, należy dodać osobne quantity pola dynamicznego w Airboxie. Nie może to być jednak drugi alias całkowitego `H_demag` ani pole nazwane ogólnie `H_dynamic`, ponieważ taka nazwa byłaby fizycznie niejednoznaczna.

Kanoniczny kontrakt powinien mieć postać:

| Właściwość | Wartość |
|---|---|
| Canonical quantity ID | `H_demag_dynamic` |
| Typ Rust | `QuantityId::HDemagDynamic` |
| Symbol fizyczny | $\delta\mathbf H_{\mathrm d}$ |
| Etykieta UI | `Dynamic stray field` / `Dynamic demagnetization field` |
| Jednostka zapisu | $\mathrm{A\,m^{-1}}$ |
| Opcjonalna jednostka prezentacji | $\mu_0\delta H$ w `mT` |
| Kształt | trójskładnikowe pole wektorowe |
| Lokalizacja FEM | węzły pełnej domeny wspólnej |
| Domena quantity | `full_domain` |
| Docelowy scope użytkownika | przede wszystkim `airbox`, ale także `full`, `part` i `selection` |
| Stan odniesienia v1 | zaakceptowany stan na początku etapu dynamiki |
| Definicja | `H_demag(t) - H_demag(reference)` |

Istniejące `H_demag` nadal oznacza całkowite chwilowe pole demagnetyzujące. Nowe quantity izoluje część generowaną przez zmianę magnetyzacji względem stanu odniesienia. W typowym przebiegu `relax -> run` stanem odniesienia jest zrelaksowany stan, od którego startuje propagacja fal spinowych.

## 2. Mierzalny rezultat

Po wdrożeniu użytkownik ma móc:

1. wykonać relaksację;
2. rozpocząć etap dynamiki fal spinowych;
3. wybrać Airbox jako target i `H_demag_dynamic` jako quantity;
4. obserwować live pole pochodzące wyłącznie od dynamicznej części magnetyzacji;
5. zapisać serię czasową na wybranym zakresie Airboxa;
6. odtworzyć animację bez ponownego uruchamiania solvera;
7. sprawdzić w metadanych dokładny stan odniesienia, operator demagnetyzacji, mesh, czas, krok i precision;
8. otrzymać jawny błąd zamiast wiarygodnie wyglądającego pola, jeżeli stan odniesienia jest niezgodny albo niedostępny.

Kryterium naukowe jest mocniejsze niż samo pokazanie nowej pozycji w UI: każda klatka musi pochodzić z zaakceptowanego stanu integratora i z tego samego dyskretnego operatora, który utworzył pole odniesienia.

## 3. Stan obecny i rzeczywista luka

### 3.1. Co już istnieje

- `crates/fullmag-quantities/src/id.rs` definiuje zamrożone identyfikatory wire-format, w tym `H_demag`.
- `crates/fullmag-quantities/src/catalog.rs` opisuje `H_demag` jako nodalne, trójskładnikowe pole `full_domain` w $\mathrm{A\,m^{-1}}$.
- FEM Poisson Airbox rozwiązuje potencjał na wspólnej domenie magnetyk + powietrze i odzyskuje pełnodomenowe `H_demag`.
- `backends/fem/src/api.cpp` ma ścieżkę pełnodomenowego snapshotu GPU; dla Poisson/Hypre źródłem `H_demag` jest `poisson_gradient`.
- artifact pipeline potrafi zapisywać serie pól do Zarr i asynchronicznie odbierać natywne snapshoty FEM.
- API umie zawężać pole do `scope_kind=airbox`, zachować indeksy źródłowych węzłów i identyfikować carrier.
- Python `FieldAutosave` umie definiować cadence czasowe albo krokowe.
- istnieje zalążek operatora demag dla perturbacji używany przez moduły częstotliwościowe i liniaryzację.

### 3.2. Czego brakuje

- nie istnieje kanoniczny quantity ID dla dynamicznego pola demag;
- nie istnieje kontrakt stanu odniesienia dla time-domain quantity;
- snapshot pola nie przenosi obecnie tożsamości reference state;
- backend nie przechowuje rezydentnej referencji `M_ref`/`H_demag_ref` dla etapu;
- trzeba udowodnić, że snapshot po kroku odpowiada zaakceptowanemu endpointowi, a nie ostatniemu wewnętrznemu stage'owi RK/Heun;
- natywny writer FEM zapisuje obecnie snapshot jako `scope=full`; time-series scope Airboxa wymaga prawdziwego scoped carriera;
- FDM Airbox jest obecnie końcowym, target-only artifactem obliczanym po solverze, a nie obserwatorem serii czasowej;
- UI nie ma semantyki stałego zakresu kolorów dla porównywalnej animacji pola oscylacyjnego.

Wniosek: nie jest to zmiana polegająca wyłącznie na dopisaniu jednej pozycji do katalogu.

## 4. Definicja fizyczna

### 4.1. Domena

Niech:

- $\Omega_m$ oznacza domenę magnetyczną;
- $\Omega_a$ oznacza całą wspólną domenę FEM, czyli magnetyk i Airbox;
- $\Omega_{\mathrm{air}}=\Omega_a\setminus\overline{\Omega_m}$ oznacza część powietrzną;
- $\Gamma_m=\partial\Omega_m$ oznacza granicę magnetyk–powietrze;
- $\Gamma_a=\partial\Omega_a$ oznacza zewnętrzną granicę Airboxa.

Magnetyzacja wynosi

$$
\mathbf M(\mathbf r,t)=M_s(\mathbf r)\,\mathbf m(\mathbf r,t)
\qquad \text{w }\Omega_m,
$$

oraz

$$
\mathbf M(\mathbf r,t)=\mathbf 0
\qquad \text{w }\Omega_{\mathrm{air}}.
$$

Najbardziej ogólna implementacja powinna posługiwać się rzeczywistym polem $\mathbf M$, a nie zakładać bezwarunkowo stałego $M_s$. Dla statycznych materiałów używanych obecnie przez solver zachodzi jednak

$$
\delta\mathbf M(\mathbf r,t)
=M_s(\mathbf r)\left[\mathbf m(\mathbf r,t)-\mathbf m_{\mathrm{ref}}(\mathbf r)\right].
$$

### 4.2. Równania magnetostatyczne

W przybliżeniu magnetoquasistatycznym:

$$
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot\mathbf B=0,
\qquad
\mathbf B=\mu_0\left(\mathbf H_{\mathrm d}+\mathbf M\right).
$$

Ponieważ $\nabla\times\mathbf H_{\mathrm d}=0$, wprowadzamy potencjał skalarny $u$:

$$
\mathbf H_{\mathrm d}=-\nabla u.
$$

Po podstawieniu do warunku $\nabla\cdot\mathbf B=0$ otrzymujemy równanie Poissona używane przez realizację FEM:

$$
\Delta u=\nabla\cdot\mathbf M
\qquad \text{w }\Omega_a,
$$

przy czym $\mathbf M=0$ w elementach Airboxa.

### 4.3. Rozkład na część odniesienia i część dynamiczną

Niech $t_{\mathrm{ref}}$ będzie czasem zaakceptowanego stanu na początku etapu dynamiki. Definiujemy

$$
\mathbf M_{\mathrm{ref}}(\mathbf r)
=\mathbf M(\mathbf r,t_{\mathrm{ref}}),
$$

$$
\delta\mathbf M(\mathbf r,t)
=\mathbf M(\mathbf r,t)-\mathbf M_{\mathrm{ref}}(\mathbf r).
$$

Analogicznie:

$$
 u(\mathbf r,t)=u_{\mathrm{ref}}(\mathbf r)+\delta u(\mathbf r,t),
$$

$$
\mathbf H_{\mathrm d}(\mathbf r,t)
=\mathbf H_{\mathrm d,ref}(\mathbf r)
+\delta\mathbf H_{\mathrm d}(\mathbf r,t).
$$

Nowe quantity ma dokładną definicję:

$$
\boxed{
\mathbf H_{\mathrm{demag,dynamic}}(\mathbf r,t)
\equiv\delta\mathbf H_{\mathrm d}(\mathbf r,t)
=\mathbf H_{\mathrm d}(\mathbf r,t)
-\mathbf H_{\mathrm d,ref}(\mathbf r)
}
$$

oraz

$$
\boxed{
\delta\mathbf H_{\mathrm d}=-\nabla\delta u.
}
$$

Ponieważ problem magnetostatyczny jest liniowy względem źródła $\mathbf M$, potencjał dynamiczny spełnia

$$
\boxed{
\Delta\delta u=\nabla\cdot\delta\mathbf M
\qquad \text{w }\Omega_a.
}
$$

W konsekwencji można policzyć quantity dwiema algebraicznie równoważnymi drogami:

$$
\delta\mathbf H_{\mathrm d}
=\mathbf H_{\mathrm d}[\mathbf M(t)]
-\mathbf H_{\mathrm d}[\mathbf M_{\mathrm{ref}}],
$$

albo bezpośrednio

$$
\delta\mathbf H_{\mathrm d}
=\mathbf H_{\mathrm d}[\delta\mathbf M(t)].
$$

Ta równoważność jest prawdziwa dokładnie dla tego samego dyskretnego meshu, warunku zewnętrznego, współczynnika Robin, przestrzeni FEM, kolejności elementu i solvera reprezentującego ten sam operator.

### 4.4. Postać słaba w Airboxie

Dla Robinowskiego zamknięcia Airboxa:

$$
\int_{\Omega_a}\nabla\delta u\cdot\nabla v\,\mathrm dV
+\beta\int_{\Gamma_a}\delta u\,v\,\mathrm dS
=
\int_{\Omega_m}\delta\mathbf M\cdot\nabla v\,\mathrm dV
\qquad \forall v\in V.
$$

Warunek zewnętrzny ma postać

$$
\partial_n\delta u+\beta\delta u=0
\qquad \text{na }\Gamma_a.
$$

Dla zamknięcia Dirichleta:

$$
\delta u=0
\qquad \text{na }\Gamma_a,
$$

oraz

$$
\int_{\Omega_a}\nabla\delta u\cdot\nabla v\,\mathrm dV
=
\int_{\Omega_m}\delta\mathbf M\cdot\nabla v\,\mathrm dV
\qquad \forall v\in V_0.
$$

### 4.5. Warunki na granicy magnetyk–powietrze

Przyjmując normalną $\mathbf n$ skierowaną z magnetyka do powietrza, ciągłość normalnej składowej $\mathbf B$ daje

$$
\mathbf n\cdot
\left(\delta\mathbf H_{\mathrm{air}}
-\delta\mathbf H_{\mathrm{mag}}
\right)
=
\mathbf n\cdot\delta\mathbf M.
$$

Potencjał pozostaje ciągły:

$$
[\delta u]_{\Gamma_m}=0.
$$

Dla pochodnych normalnych równoważnie:

$$
\partial_n\delta u_{\mathrm{air}}
-\partial_n\delta u_{\mathrm{mag}}
=-\mathbf n\cdot\delta\mathbf M.
$$

W globalnej, konforemnej postaci słabej FEM skok wynikający z ładunku powierzchniowego jest zakodowany przez całkę źródłową po $\Omega_m$; nie należy dodawać drugiego, niezależnego źródła powierzchniowego bez zmiany kontraktu operatora.

### 4.6. Znaczenie pola w Airboxie

W powietrzu $\delta\mathbf M=0$, dlatego

$$
\boxed{
\delta\mathbf B(\mathbf r,t)
=\mu_0\delta\mathbf H_{\mathrm d}(\mathbf r,t)
\qquad \text{w }\Omega_{\mathrm{air}}.
}
$$

To uzasadnia wygodną prezentację w `mT`, ale canonical storage pozostaje w $\mathrm{A\,m^{-1}}$. Konwersja UI jest wyłącznie zmianą jednostki:

$$
\mu_0\delta H\,[\mathrm{mT}]
=10^3\mu_0\,\delta H\,[\mathrm{A/m}].
$$

W magnetyku relacja jest inna:

$$
\delta\mathbf B
=\mu_0\left(\delta\mathbf H_{\mathrm d}+\delta\mathbf M\right).
$$

Dlatego nie wolno nazywać $\mu_0\delta H_{\mathrm d}$ pełnym dynamicznym polem $B$ wewnątrz materiału.

### 4.7. Związek z falami spinowymi i phasorem

Dla małej, harmonicznej perturbacji można zapisać

$$
\delta\mathbf m(\mathbf r,t)
=\operatorname{Re}\left[
\widetilde{\mathbf m}(\mathbf r,\omega)e^{-i\omega t}
\right],
$$

$$
\delta\mathbf H_{\mathrm d}(\mathbf r,t)
=\operatorname{Re}\left[
\widetilde{\mathbf h}_{\mathrm d}(\mathbf r,\omega)e^{-i\omega t}
\right].
$$

Wtedy

$$
\widetilde{\mathbf h}_{\mathrm d}
=\mathcal D\left[M_s\widetilde{\mathbf m}\right],
$$

gdzie $\mathcal D$ jest operatorem demagnetyzacji. Nowe time-domain quantity nie jest jednak wyłącznie liniowym przybliżeniem. Definicja różnicowa pozostaje dokładna także dla skończonej amplitudy i dryfu DC, dopóki operator demag nie zmienia się w obrębie etapu.

### 4.8. Czym to quantity nie jest

`H_demag_dynamic` nie oznacza:

- całkowitego `H_demag`;
- całkowitego dynamicznego `H_eff`;
- samego pola wymuszającego anteny;
- pochodnej $\partial_t\mathbf H$;
- filtru high-pass ani odejmowania średniej ruchomej;
- automatycznie zespolonego phasora;
- radiacyjnego rozwiązania pełnych równań Maxwella.

Poisson Airbox opisuje pole magnetostatyczne/magnetoquasistatyczne. Nie modeluje opóźnienia propagacji elektromagnetycznej, fal radiacyjnych, prądu przesunięcia ani indukowanego pola elektrycznego. Gdyby celem było dalekie pole elektromagnetyczne emitowane przez układ, potrzebny byłby osobny solver Maxwella.

## 5. Postać dyskretna FEM

Dla ustalonego meshu i ustalonego warunku zewnętrznego zapisujemy układ potencjału jako

$$
\mathbf A\widehat{\mathbf u}=\mathbf C\widehat{\mathbf M},
$$

gdzie:

- $\mathbf A=\mathbf K+\beta\mathbf B_\Gamma$ dla Robin;
- $\mathbf A$ jest odpowiednio ograniczoną macierzą sztywności dla Dirichleta;
- $\mathbf C$ jest dyskretną mapą źródła magnetyzacji do prawej strony;
- $\widehat{\mathbf u}$ zawiera stopnie swobody potencjału;
- $\mathbf G$ jest operatorem odzyskania gradientu.

Pole wynosi

$$
\widehat{\mathbf H}_{\mathrm d}=-\mathbf G\widehat{\mathbf u}.
$$

Dla reference state:

$$
\mathbf A\widehat{\mathbf u}_{\mathrm{ref}}
=\mathbf C\widehat{\mathbf M}_{\mathrm{ref}}.
$$

Dla bieżącego zaakceptowanego stanu $n$:

$$
\mathbf A\widehat{\mathbf u}_n
=\mathbf C\widehat{\mathbf M}_n.
$$

Po odjęciu:

$$
\mathbf A\delta\widehat{\mathbf u}_n
=\mathbf C
\left(\widehat{\mathbf M}_n-\widehat{\mathbf M}_{\mathrm{ref}}\right),
$$

$$
\boxed{
\delta\widehat{\mathbf H}_{\mathrm d,n}
=-\mathbf G\delta\widehat{\mathbf u}_n
=\widehat{\mathbf H}_{\mathrm d,n}
-\widehat{\mathbf H}_{\mathrm d,ref}.
}
$$

Dodanie stałej do potencjału nie zmienia gradientu. Mimo to reference receipt musi identyfikować ten sam operator, ponieważ zmiana meshu, map source, boundary closure albo przestrzeni potencjału zmienia dyskretne znaczenie pola.

## 6. Kontrakt stanu odniesienia

### 6.1. Jedna semantyka v1

Pierwsza wersja nie powinna oferować kilku niejasnych wariantów. Ustalamy:

```text
reference_kind = stage_start_accepted
```

Czyli:

$$
\mathbf H_{\mathrm{demag,dynamic}}(t)
=
\mathbf H_{\mathrm{demag}}(t)
-
\mathbf H_{\mathrm{demag}}(t_{\mathrm{stage\ start}}).
$$

Reference state jest przechwytywany po pełnym zastosowaniu wyniku poprzedniego etapu, ale przed pierwszym trial stepem nowego etapu dynamiki.

Nie wolno używać jako reference:

- pierwszej klatki, która przypadkowo trafiła do autosave;
- pierwszego odświeżenia UI;
- stanu ostatniego wewnętrznego stage'a integratora;
- bieżącego stanu w chwili, gdy użytkownik późno otworzył panel;
- średniej z początkowego okna bez jawnego nowego quantity.

### 6.2. Lifecycle

- `relax -> run`: reference dla `run` jest końcowym zaakceptowanym stanem `relax` przekazanym do początku `run`.
- `pause -> resume` tego samego etapu: reference nie zmienia się.
- nowy etap `run`: tworzony jest nowy reference ID.
- jawny restart etapu: tworzony jest nowy reference ID.
- wybór historycznej klatki: quantity używa reference zapisanego dla etapu tej klatki.
- remesh, zmiana topologii, materiału, $M_s$, demag realization, boundary variant, współczynnika Robin, PBC albo przestrzeni FEM unieważnia reference.

### 6.3. Receipt

W runnerze należy dodać wersjonowany kontrakt, przykładowo:

```rust
struct DynamicDemagReferenceReceiptV1 {
    schema_version: String,
    reference_id: String,
    reference_kind: String,
    stage_id: String,
    accepted_state_id: String,
    reference_step: u64,
    reference_time_s: f64,
    domain_generation_id: String,
    mesh_topology_sha256: String,
    material_signature: String,
    demag_operator_signature: String,
    boundary_signature: String,
    precision: String,
    node_count: u64,
    component_order: String,
    reference_m_content_sha256: String,
    reference_h_demag_content_sha256: Option<String>,
}
```

Reference ID powinien być content-addressed albo co najmniej zawierać hash receiptu. Sama nazwa etapu nie wystarcza.

### 6.4. Late materialization

Aby użytkownik mógł włączyć podgląd po rozpoczęciu etapu, runtime powinien zachować niezmienny stage-start checkpoint źródłowej magnetyzacji. Wtedy `H_demag_ref` może zostać policzone później przez izolowaną ścieżkę obserwacyjną bez podmieniania live state.

Pierwszy produkcyjny krok może dopuścić tylko quantity zadeklarowane przed startem etapu, ale musi wtedy zwracać typowany stan `dynamic_reference_not_captured` dla późnego żądania. Nie wolno po cichu przyjąć bieżącego stanu jako reference.

## 7. Poprawność względem integratora

To jest najbardziej krytyczny punkt implementacji.

Heun, RK4, RK23 i RK45 wykonują kilka ocen pola dla stanów próbnych. Ostatnio obliczone `H_demag` nie musi odpowiadać ostatecznej zaakceptowanej magnetyzacji. Dla przykładu pole z drugiego stage'a Heuna jest policzone dla predyktora, podczas gdy zaakceptowany stan jest kombinacją nachyleń.

Każdy field snapshot musi być związany z:

```text
AcceptedStateId = hash(
    stage_id,
    accepted_step,
    accepted_time,
    state_revision,
    domain_generation,
    m_content_or_revision
)
```

Backend powinien posiadać receipt pola:

```rust
struct DemagFieldReceipt {
    accepted_state_id: AcceptedStateId,
    m_revision: u64,
    demag_operator_signature: String,
    evaluation_time_s: f64,
}
```

Przed snapshotem należy wykonać:

```text
ensure_demag_for_accepted_state(accepted_state_id)
```

Zasada:

1. jeżeli cache `H_demag` ma dokładnie ten receipt, można go użyć;
2. jeżeli integrator dostarczył endpoint field z udowodnionym receipt, można go użyć;
3. w innym przypadku należy wykonać endpoint observation solve;
4. rejected/trial state nie może być publikowany;
5. field snapshot, scalar row i magnetization frame muszą wskazywać ten sam `AcceptedStateId`.

Ta naprawa powinna objąć również zwykłe `H_demag`, ponieważ nowe quantity ujawniłoby istniejące ryzyko publikacji pola z niewłaściwego stage'a integratora.

## 8. Dwie równoważne ścieżki materializacji

### 8.1. Route A: różnica dwóch pełnych pól

$$
\delta\mathbf H_{\mathrm d,n}
=
\mathbf H_{\mathrm d,n}-\mathbf H_{\mathrm d,ref}.
$$

Zalety:

- brak dodatkowego solve, jeżeli bieżące zaakceptowane `H_demag` jest już dostępne;
- można współdzielić wynik z jednoczesnym autosave `H_demag`;
- na GPU odejmowanie jest prostym kernelem pamięciowym.

Wady:

- wymaga przechowywania $\mathbf H_{\mathrm d,ref}$ na pełnej domenie albo na dokładnie tym samym carrierze;
- może tracić cyfry znaczące, gdy dynamiczne pole jest bardzo małe względem statycznego i precision jest zbyt niskie.

### 8.2. Route B: bezpośredni solve dla $\delta\mathbf M$

$$
\mathbf A\delta\widehat{\mathbf u}_n
=\mathbf C\delta\widehat{\mathbf M}_n,
$$

$$
\delta\widehat{\mathbf H}_{\mathrm d,n}
=-\mathbf G\delta\widehat{\mathbf u}_n.
$$

Zalety:

- nie odejmuje dwóch dużych pól;
- jest naturalnym oraclem jakości;
- przy bardzo małej amplitudzie daje lepszy budżet błędu numerycznego.

Wady:

- wymaga dodatkowego solve w każdym punkcie zapisu, jeżeli nie da się wykorzystać istniejącego solve;
- potrzebuje rezydentnego $\mathbf M_{\mathrm{ref}}$;
- istniejący interfejs częstotliwościowy/tangent nie powinien zostać użyty bez sprawdzenia pełnodomenowego layoutu i braku założeń właściwych wyłącznie liniaryzacji.

### 8.3. Rekomendowany resolver `auto`

Semantyka quantity jest jedna, lecz materializer może wybierać route:

```text
if exact accepted-state H_demag exists and H_ref is resident:
    route = difference_of_total_fields
else:
    route = direct_delta_poisson
```

W metadanych każdej serii należy zapisać `materialization_route`. Test parytetu obu dróg jest obowiązkowy.

Dla pierwszej kwalifikacji produkcyjnej należy wspierać FP64. FP32 nie powinno być oznaczone jako qualified przed wykazaniem akceptowalnego błędu względnego dla małych amplitud fal spinowych.

## 9. Implementacja FEM CPU

### 9.1. Stan runtime

Dodać właściciela reference, logicznie obok stanu Poisson:

```rust
struct DynamicDemagReference {
    receipt: DynamicDemagReferenceReceiptV1,
    m_reference_magnetic: BackendResidentVector,
    h_demag_reference_full: Option<BackendResidentVector>,
}
```

W implementacji C++ odpowiednik może znajdować się w kontekście obserwacji/demag, ale nie może należeć do pojedynczego writer joba.

### 9.2. Capture

Przed pierwszym krokiem etapu:

1. zamrozić `AcceptedStateId` początku etapu;
2. skopiować źródłowe $\mathbf m_{\mathrm{ref}}$;
3. upewnić się, że pełnodomenowe `H_demag_ref` odpowiada temu stanowi;
4. zapisać receipt i hash;
5. nie zmieniać czasu, RNG, integratora ani live state.

### 9.3. Snapshot

Dodać natywny observable `H_demag_dynamic`. CPU path:

1. materializuje albo odzyskuje zaakceptowane `H_demag_current`;
2. sprawdza signatures current/reference;
3. odejmuje trzy komponenty dla pełnej domeny albo wybranego scope;
4. publikuje AoS zgodny z istniejącym snapshot ABI;
5. dołącza source i reference receipt.

Koszt samego odejmowania to $O(3N_{\mathrm{scope}})$ i nie wymaga nowego operatora fizycznego.

## 10. Implementacja FEM GPU

### 10.1. ABI i mapowanie quantity

Rozszerzyć bez zmiany istniejących wartości enum:

```c
FULLMAG_FEM_OBSERVABLE_H_DEMAG_DYNAMIC = <nowa_stala>
```

Następnie zaktualizować:

- `native/include/fullmag_fem.h`;
- `crates/fullmag-fem-sys/src/lib.rs`;
- mapowanie quantity w `NativeFemBackend`;
- `gpu_snapshot_source_field` / dispatch snapshotu w `backends/fem/src/api.cpp`;
- capability reporting.

### 10.2. Bufory

Gdy quantity nie jest requested, nie alokować nowych pełnodomenowych buforów.

Gdy jest requested:

- zachować `m_reference` na węzłach magnetycznych;
- zachować `h_demag_reference_full.{x,y,z}` albo materializować je przez delta route;
- użyć istniejącego snapshot pool do bufora staging;
- nie kopiować reference host→device dla każdej klatki.

W FP64 pełny baseline wektorowy kosztuje

$$
3N\cdot 8\ \mathrm{B}=24N\ \mathrm{B}.
$$

Dla miliona węzłów jest to około 24 MB.

### 10.3. Kernel różnicowy

Dodać prosty kernel SoA:

```text
out_x[i] = current_x[i] - reference_x[i]
out_y[i] = current_y[i] - reference_y[i]
out_z[i] = current_z[i] - reference_z[i]
```

Kernel powinien pisać bezpośrednio do leasingowanego bufora staging. Dla scope Airboxa preferowany jest fused subtract+gather po indeksach carriera, aby nie materializować pełnego AoS host-side.

Synchronizacja:

1. compute stream zapisuje event po ukończeniu accepted-state demag recovery;
2. I/O stream czeka na event;
3. subtract/gather zapisuje staging;
4. staging jest kopiowany do pinned host memory albo przekazywany dalej device-side;
5. snapshot pool nie może zwolnić slotu przed eventem końcowym.

### 10.4. Pełnodomenowe odzyskanie pola

Nowe observable musi wejść do tej samej logiki, która dla `H_demag` wywołuje pełnodomenowe recovery gradientu Poissona. Nie wolno odejmować magnetic-only `fields.h_demag` od full-domain reference.

### 10.5. Brak cichego fallbacku

Jeżeli użytkownik wymusił GPU, a dynamic full-domain demag nie jest dostępny, runtime zwraca `unsupported` z reason code. Nie wolno policzyć pola na CPU i oznaczyć wyniku jako GPU.

## 11. Canonical quantity i capability matrix

### 11.1. Quantity registry

Zmiany minimalne:

- `crates/fullmag-quantities/src/id.rs`:
  - `QuantityId::HDemagDynamic`;
  - wire ID `H_demag_dynamic`;
  - aliasy `h_demag_dynamic`, `delta_H_demag`, `H_stray_dynamic`;
  - dopisanie do `ALL`;
- `crates/fullmag-quantities/src/catalog.rs`:
  - vector field;
  - `A/m`;
  - `Node`;
  - `FullDomain`;
  - `MaxAbs`;
  - preview 2D/3D;
  - history/export true;
- testy kompletności katalogu i stabilności wire ID;
- aktualizacja wszystkich exhaustive matches w runnerze, backendach i API.

### 11.2. Aktywność quantity

`H_demag_dynamic` jest aktywne tylko, gdy jednocześnie:

- demagnetyzacja jest włączona;
- etap jest time evolution albo wskazaną historyczną ramką time evolution;
- istnieje zgodny reference receipt;
- backend ma pełnodomenowy operator/observation carrier;
- requested precision i lane są qualified.

Samo `plan.enable_demag=true` nie wystarcza.

### 11.3. Etapy capability

Nie oznaczać od razu wszystkich lane'ów jako supported.

| Lane | Stan początkowy | Warunek promocji |
|---|---|---|
| FEM CPU Poisson Airbox FP64 | implementing | test analityczny, direct/difference parity, accepted-state tests |
| FEM GPU Poisson Airbox FP64 | implementing | executed-device parity i brak CPU fallbacku |
| FEM BEM/FMM | unsupported | osobna materializacja pola zewnętrznego |
| FDM CPU single-grid Airbox history | planned | target convolution dla wielu ramek |
| FDM CUDA Airbox live | unsupported | device observation carrier |
| FDM multilayer Airbox | planned | source→target convolution wszystkich warstw |
| frequency-domain phasor | osobny quantity family | nie mieszać z time-domain wire ID bez jawnego view |

## 12. IR i Python API

### 12.1. Scope autosave

Obecny `FieldAutosave` identyfikuje quantity i cadence, ale nie scope. Należy go rozszerzyć kompatybilnie:

```python
fm.FieldAutosave(
    "H_demag_dynamic",
    every=2.5e-12,
    scope_kind="airbox",
    scope_id=None,
)
```

Znaczenie:

- `scope_kind=None` zachowuje obecne zachowanie full-domain;
- `scope_kind="airbox"`, `scope_id=None` oznacza aggregate wszystkich części FEM o roli air;
- jawne `scope_id` wybiera konkretny part;
- canonical vocabulary ma być identyczny z `FieldVectorQuery`, bez drugiego systemu nazw.

Proponowane pola IR:

```rust
pub struct FieldAutosaveIR {
    pub quantity: String,
    pub every_seconds: Option<f64>,
    pub every_steps: Option<u64>,
    pub sample_period_policy: Option<...>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    pub geometry_scope: Option<String>,
}
```

Nie dodawać user-facing `reference` w v1. Semantyka `stage_start_accepted` jest częścią quantity i etapu, a nie właściwością pojedynczego writer policy.

### 12.2. Przykład pełnego workflow

```python
import fullmag as fm

nm = 1e-9

study = fm.study("spin_wave_dynamic_stray")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

# geometria, materiały, Airbox i demag zgodnie z normalnym workflow
# ...
study.demag(model="airbox", variant="robin")

study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    max_steps=50000,
    tolT=5e-9,
)

study.stages.add_run(
    stage_id="spin_waves",
    until=10e-9,
).autosave(
    fm.StageAutosave(
        target="spin_waves",
        format="zarr",
        fields=[
            fm.FieldAutosave(
                "m",
                every=2.5e-12,
            ),
            fm.FieldAutosave(
                "H_demag_dynamic",
                every=2.5e-12,
                scope_kind="airbox",
            ),
        ],
    )
)
```

## 13. Artifact pipeline i format danych

### 13.1. Dlaczego nie zapisywać zawsze pełnej domeny

Pełne pole FP64 dla miliona punktów zajmuje około 24 MB na klatkę. Dziesięć tysięcy klatek zajęłoby około 240 GB bez narzutu i metadanych. Dlatego scoped Airbox autosave jest wymaganiem produkcyjnym, a nie tylko optymalizacją UI.

### 13.2. Carrier

Każda seria musi wskazywać niezmienny carrier:

```text
carrier_id
carrier_fingerprint
domain_generation_id
mesh_topology_sha256
scope_kind
scope_id
geometry_scope
source_node_count
stored_sample_count
sampled_node_indices / membership artifact
component_order
```

Dla nodalnego FEM Airboxa serie mają zachować indeksy źródłowych węzłów albo content-addressed membership artifact. Sam kształt tablicy nie wystarcza do umieszczenia wektorów w geometrii.

### 13.3. Zarr

Rekomendowany logiczny layout:

```text
fields/H_demag_dynamic/<carrier_id>/
  values        [sample, component, point]
  time_s        [sample]
  step          [sample]
  solver_dt_s   [sample]
  source_revision [sample]
  accepted_state_id [sample]
  attrs
```

W `attrs`:

```json
{
  "observable": "H_demag_dynamic",
  "definition": "H_demag(t)-H_demag(stage_start_accepted)",
  "unit": "A/m",
  "component_order": "xyz",
  "scope_kind": "airbox",
  "reference_kind": "stage_start_accepted",
  "reference_id": "...",
  "reference_stage_id": "spin_waves",
  "reference_step": 0,
  "reference_time_s": 0.0,
  "reference_accepted_state_id": "...",
  "demag_operator_signature": "...",
  "boundary_signature": "...",
  "materialization_route": "difference_of_total_fields"
}
```

String arrays mogą wymagać osobnego indeksu/manifestu zamiast bezpośredniego datasetu Zarr; format fizyczny może być dostosowany do istniejącego writera, ale wszystkie informacje muszą być zachowane.

### 13.4. Reference artifact

Reference receipt i hash powinny być zapisane raz na etap. Nie należy duplikować pełnego `H_ref` w każdej klatce. Do trwałego odtworzenia wystarczy:

- niezmienna ramka `m_ref`;
- signatures operatora;
- opcjonalnie zapisane `H_demag_ref` jako cache/artifact;
- checksum.

### 13.5. Backpressure

Dynamiczne pole Airboxa może być duże. Writer musi zachować istniejącą bounded queue i raportować drop/block policy. Nie wolno blokować compute stream przez synchroniczny zapis pliku wykonywany w pętli integratora.

## 14. API v2

### 14.1. Katalog

`GET /api/quantities/catalog` powinien zwracać descriptor nowego quantity i lane-specific resolved capability.

### 14.2. Pobranie bieżącego pola

Istniejący kontrakt scope powinien wystarczyć:

```text
.../fields/H_demag_dynamic/vector?scope_kind=airbox&component=full
```

Meta response musi dodatkowo zawierać:

```rust
struct DynamicFieldReferenceMeta {
    reference_id: String,
    reference_kind: String,
    reference_stage_id: String,
    reference_step: u64,
    reference_time_s: f64,
    reference_accepted_state_id: String,
    demag_operator_signature: String,
}
```

### 14.3. Stany błędów

Wprowadzić stabilne reason codes, co najmniej:

```text
dynamic_demag_reference_not_captured
dynamic_demag_reference_stale
dynamic_demag_reference_domain_mismatch
dynamic_demag_operator_mismatch
dynamic_demag_not_time_evolution
dynamic_demag_precision_not_qualified
dynamic_demag_airbox_carrier_unavailable
dynamic_demag_accepted_state_not_materialized
```

Nie zwracać pustego pola ani zer jako substytutu błędu.

### 14.4. Atomowość publikacji

Payload pola, metadata, field revision, accepted state, source time i reference ID muszą zostać opublikowane jako jeden bundle. UI nie może połączyć wartości z nowej rewizji z reference metadata starej rewizji.

## 15. Control Room

### 15.1. Wybór quantity

Na target Airbox dodać `Dynamic stray field`. Pozycja ma być widoczna wyłącznie, gdy resolved capability dla konkretnego targetu jest supported/materializable.

### 15.2. Informacja o referencji

Panel powinien stale pokazywać:

```text
Δ względem początku etapu „spin_waves”
t_ref = ...
step_ref = ...
reference_id = ...
```

Nie wystarczy tooltip w katalogu.

### 15.3. Komponenty

Obsłużyć:

- `x`, `y`, `z`;
- magnitude $|\delta\mathbf H|$;
- wektory/glyphs;
- scalar coloring wybranego komponentu;
- opcjonalnie projekcję na zadaną oś w późniejszym etapie.

### 15.4. Normalizacja animacji

Dla podpisanego komponentu `x/y/z` skala powinna być symetryczna:

$$
[-H_{\max},+H_{\max}].
$$

Nie należy przeliczać niezależnego min/max dla każdej klatki, ponieważ animacja wtedy ukrywa zmianę amplitudy. Tryby:

- `fixed_series_max_abs` — rekomendowany dla playback;
- `fixed_user_range`;
- `current_frame_max_abs` — dopuszczalny tylko jako jawna opcja diagnostyczna.

Dla magnitude skala jest nieujemna.

### 15.5. Jednostki

Storage i API: `A/m`. UI może przełączać:

- `A/m`;
- `kA/m`;
- `μ0H` w `mT`.

Konwersja nie może zmieniać danych źródłowych ani etykietować wyniku jako `B` wewnątrz magnetyka.

## 16. Sampling czasowy

Aby uniknąć aliasingu, dla najwyższej analizowanej częstotliwości $f_{\max}$:

$$
\Delta t_{\mathrm{save}}\leq\frac{1}{2f_{\max}}.
$$

To jest jedynie granica Nyquista. Dla czytelnej animacji fazy i amplitudy zalecane jest co najmniej 10–20 próbek na okres:

$$
\Delta t_{\mathrm{save}}
\lesssim
\frac{1}{10f_{\max}}
\quad\text{do}\quad
\frac{1}{20f_{\max}}.
$$

Dla $f_{\max}=20\ \mathrm{GHz}$ okres wynosi $50\ \mathrm{ps}$, więc praktyczne cadence to około $2.5$–$5\ \mathrm{ps}$.

Sampling musi dotyczyć czasu zaakceptowanego solvera. Wewnętrzne stage'e integratora nie są próbkami fizycznej trajektorii.

## 17. FDM — oddzielna realizacja

### 17.1. Dlaczego nie wolno udawać, że obecny FDM Airbox już to potrafi

Obecny target-only FDM Airbox jest materializowany z końcowej magnetyzacji po zakończeniu solvera przez oddzielną konwolucję CPU. Nie uczestniczy w hot loopie i publikuje pojedyncze `H_demag`.

W FDM padding FFT nie jest automatycznie fizycznym Airboxem. Nie wolno pokazywać komórek paddingu jako certyfikowanych punktów pola zewnętrznego bez jawnej geometrii obserwacyjnej i source→target kernela.

### 17.2. Matematyka

Dla dyskretnego operatora konwolucyjnego:

$$
\mathbf H_{\mathrm d,i}(t)
=-\sum_j\mathbf N_{ij}\mathbf M_j(t),
$$

więc

$$
\delta\mathbf H_{\mathrm d,i}(t)
=-\sum_j\mathbf N_{ij}
\left[\mathbf M_j(t)-\mathbf M_{j,\mathrm{ref}}\right].
$$

Tak jak w FEM można liczyć różnicę dwóch pól albo jedną konwolucję źródła dynamicznego.

### 17.3. Etapy FDM

**FDM-1: history/offline CPU**

- użyć autosave `m(t)`;
- dla każdej wybranej ramki wykonać target-only source→Airbox convolution;
- użyć tej samej geometrii targetu dla reference i wszystkich ramek;
- zapisać serię z carrier fingerprintem;
- zweryfikować `D[M]-D[M_ref] = D[M-M_ref]`.

**FDM-2: live CPU**

- asynchroniczny observation worker uruchamiany tylko w cadence output;
- nie wkładać observation targetu do dynamiki źródłowej;
- nie dopuścić observation→magnet feedback.

**FDM-3: CUDA**

- device-resident source→target convolution;
- osobne plany FFT/transfer maps;
- async output stream;
- brak host round-trip magnetyzacji na każdą klatkę.

**FDM-4: multilayer**

- suma wkładów wszystkich warstw źródłowych na jednym target carrierze;
- brak wkładu target-only carriera do źródeł;
- jednoznaczna orientacja i offset każdego source→target kernela.

Do czasu przejścia kwalifikacji capability FDM pozostaje `unsupported`, a nie `supported` z wolnym, ukrytym fallbackiem.

## 18. Plan zmian w kodzie

### Etap 0 — kontrakt i testy czerwone

1. Dodać ADR/spec quantity, reference lifecycle i accepted-state semantics.
2. Dodać test, że reference state daje dokładnie zero.
3. Dodać test wykrywający pole pochodzące z trial stage'a Heuna.
4. Dodać test operator/reference mismatch.

**Gate:** testy muszą najpierw odtwarzać brak funkcji albo błąd semantyczny.

### Etap 1 — canonical quantity

Pliki bazowe:

- `crates/fullmag-quantities/src/id.rs`;
- `crates/fullmag-quantities/src/catalog.rs`;
- `crates/fullmag-quantities/src/registry.rs`;
- `crates/fullmag-runner/src/quantities.rs`;
- testy katalogu, aliasów i exhaustive match.

**Gate:** quantity istnieje w katalogu, ale capability backendu nadal jest truthful `unsupported`.

### Etap 2 — reference i accepted-state receipts

- dodać `AcceptedStateId`, jeżeli nie ma już wystarczającego wspólnego kontraktu;
- dodać `DynamicDemagReferenceReceiptV1`;
- capture przed pierwszym trial stepem;
- zachowanie reference przez pause/resume;
- invalidation przy zmianie operatora/domeny;
- `ensure_demag_for_accepted_state`.

**Gate:** zwykłe i dynamiczne snapshoty nie mogą pochodzić z trial state.

### Etap 3 — FEM CPU

- nowy observable;
- baseline/reference owner;
- route difference;
- route direct delta;
- scope-aware output;
- FP64 qualification.

**Gate:** analytic, parity, interface i convergence tests.

### Etap 4 — FEM GPU

Pliki bazowe:

- `native/include/fullmag_fem.h`;
- `crates/fullmag-fem-sys/src/lib.rs`;
- `backends/fem/src/api.cpp`;
- `backends/fem/gpu/cuda/demag_poisson/demag_state.hpp`;
- nowe albo istniejące CUDA kernels snapshot/gather;
- Rust `NativeFemBackend` observable mapping.

Build i runtime verification muszą przejść przez kontenerowe przepisy `justfile`, zgodnie z `AGENTS.md`.

**Gate:** executed-device dowód, CPU/GPU parity i test braku CPU fallbacku.

### Etap 5 — scoped autosave i storage

- rozszerzyć `FieldAutosaveIR`;
- rozszerzyć Python `FieldAutosave`;
- zbudować carrier identity dla Airboxa;
- writer Zarr `[sample, component, point]`;
- reference manifest;
- atomic commit i complete marker;
- bounded backpressure.

**Gate:** round-trip zachowuje wartości, czasy, kroki, indeksy węzłów, source state i reference ID.

### Etap 6 — API

- descriptor i capability;
- meta reference;
- pending/error reason codes;
- atomic publication bundle;
- OpenAPI regeneration;
- contract tests `scope_kind=airbox`.

**Gate:** stale/mismatched carrier jest odrzucony, nie renderowany.

### Etap 7 — Control Room

- selection z katalogu;
- reference badge;
- component/magnitude;
- fixed symmetric series scale;
- jednostki `A/m`, `kA/m`, `mT`;
- live i playback;
- WebGL resource lifecycle tests.

**Gate:** screenshot/visual tests oraz wielokrotne przełączanie quantity bez wycieku zasobów.

### Etap 8 — kwalifikacja FEM

- macierz meshy, boundary variants, amplitud i częstotliwości;
- performance benchmark z quantity off/on;
- storage benchmark dla Airbox-only;
- dokumentacja Python/API/UI/fizyka;
- truthful capability promotion.

### Etap 9 — FDM history, następnie live

Realizować dopiero po zamknięciu kontraktu FEM i artifact carrier, aby FDM publikował identyczną semantykę quantity, ale własny operator numeryczny.

## 19. Walidacja fizyczna i numeryczna

### V1. Zero w stanie odniesienia

Dla $\mathbf M(t)=\mathbf M_{\mathrm{ref}}$:

$$
\|\delta\mathbf H_{\mathrm d}\|_\infty
\leq \varepsilon_{\mathrm{solver}}+\varepsilon_{\mathrm{recovery}}.
$$

Nie należy wymagać bitowego zera po dwóch niezależnych solves, ale route z tym samym resident baseline może dawać bitowe zero.

### V2. Liniowość

Dla perturbacji $a\delta\mathbf M$:

$$
\delta\mathbf H[a\delta\mathbf M]
=a\,\delta\mathbf H[\delta\mathbf M].
$$

Sprawdzić dodatnie i ujemne $a$.

### V3. Parytet dwóch dróg

$$
\mathbf H[\mathbf M]-\mathbf H[\mathbf M_{\mathrm{ref}}]
\approx
\mathbf H[\mathbf M-\mathbf M_{\mathrm{ref}}].
$$

Raportować normy $L^2$, $L^\infty$ i błąd względny dla osobnych części magnetyk/Airbox.

### V4. Pole dipola w dalekim polu

Dla dynamicznego momentu

$$
\delta\mathbf p_m
=\int_{\Omega_m}\delta\mathbf M\,\mathrm dV
$$

porównać dalekie pole z

$$
\delta\mathbf H(\mathbf r)
=\frac{1}{4\pi r^3}
\left[
3(\delta\mathbf p_m\cdot\widehat{\mathbf r})\widehat{\mathbf r}
-\delta\mathbf p_m
\right].
$$

Test dotyczy regionu dostatecznie odległego od próbki, nie bliskiego pola.

### V5. Równania w powietrzu

W $\Omega_{\mathrm{air}}$:

$$
\nabla\cdot\delta\mathbf H\approx0,
\qquad
\nabla\times\delta\mathbf H\approx\mathbf0.
$$

Normy muszą zbiegać wraz z zagęszczeniem meshu i residualem solve.

### V6. Warunek interfejsu

Sprawdzić normalny skok odpowiadający $\delta\mathbf M\cdot\mathbf n$ oraz ciągłość potencjału.

### V7. Zbieżność Airboxa

Niezależnie zmieniać:

- odległość zewnętrznej granicy;
- rozdzielczość Airboxa;
- grading;
- mesh magnetyka;
- Robin vs Dirichlet;
- residual solvera.

Niski residual nie jest dowodem małego błędu truncation.

### V8. Accepted-state correctness

Osobne testy dla Heun, RK4, RK23 i RK45:

- output po accepted endpoint;
- rejected step;
- event/discontinuity;
- pause/resume;
- końcowy snapshot;
- cadence czasowe niepokrywające się z dt.

### V9. CPU/GPU parity

Ten sam mesh, reference, accepted state i scope. Porównać pole przed i po gatherze Airboxa.

### V10. Persistence

- Zarr round-trip;
- checksum reference;
- brak mieszania carrier revisions;
- history compute nie mutuje live runtime;
- import zachowuje reference ID albo jawnie oznacza brak nośnika.

### V11. UI

- stała skala serii;
- poprawna zmiana jednostek;
- brak stale frame po zmianie reference;
- poprawne położenie sampled vectors;
- brak wycieku GPU/WebGL przy przełączaniu `H_demag` ↔ `H_demag_dynamic`.

## 20. Wydajność i telemetria

### 20.1. Wymagania

Gdy quantity nie jest requested:

- zero dodatkowych solves;
- zero pełnodomenowego baseline `H_ref`;
- brak nowych kopii D2H;
- co najwyżej istniejący stage-start checkpoint, jeżeli jest częścią wspólnego runtime contract.

Gdy quantity jest requested:

- jedna materializacja reference na etap;
- odejmowanie/gather tylko w cadence output;
- dodatkowy Poisson solve wyłącznie, gdy wymaga tego selected route albo brak dokładnego endpoint cache;
- brak sync device-wide, jeżeli wystarczą events między streamami.

### 20.2. Metryki

Dodać:

```text
dynamic_demag_reference_capture_count
dynamic_demag_reference_capture_wall_time_ns
dynamic_demag_reference_bytes
dynamic_demag_endpoint_refresh_count
dynamic_demag_direct_delta_solve_count
dynamic_demag_subtract_wall_time_ns
dynamic_demag_gather_wall_time_ns
dynamic_demag_snapshot_bytes
dynamic_demag_samples_written
dynamic_demag_writer_backpressure_ns
```

Provenance ma rozdzielać solve physics od kosztu observation/output.

### 20.3. Benchmark

Porównać:

1. baseline bez quantity;
2. live preview co $N$ kroków;
3. Airbox autosave co $N$ kroków;
4. `H_demag` i `H_demag_dynamic` razem;
5. difference route;
6. direct delta route;
7. full-domain vs Airbox-only.

Raportować wall time, solver iterations, VRAM/RAM, D2H bytes i rozmiar artifactu.

## 21. Definition of Done

Implementacja jest zakończona dopiero, gdy spełnione są wszystkie warunki:

- `H_demag_dynamic` ma jeden kanoniczny wire ID i jednoznaczną dokumentację;
- reference jest zaakceptowanym początkiem etapu, a nie pierwszą klatką output;
- każda klatka wskazuje current `AcceptedStateId` i immutable reference ID;
- field jest liczony na pełnej wspólnej domenie i może być prawidłowo zawężony do Airboxa;
- CPU i GPU FP64 mają testy fizyczne i parity;
- wymuszony GPU nigdy nie wykonuje cichego CPU fallbacku;
- rejected/trial RK state nigdy nie trafia do artifactu ani UI;
- Airbox-only autosave nie zapisuje niepotrzebnie pełnej domeny;
- Zarr/API/UI zachowują carrier i reference provenance;
- skala animacji jest porównywalna między klatkami;
- FDM pozostaje jawnie unsupported do czasu osobnej kwalifikacji;
- publiczna dokumentacja wyjaśnia różnicę między całkowitym, dynamicznym i phasorowym polem stray;
- wszystkie wymagane native FEM buildy i runtime checks przeszły przez zarządzaną ścieżkę `justfile`.

## 22. Rekomendowana kolejność produkcyjna

Najkrótsza bezpieczna ścieżka to:

1. quantity + reference/accepted-state contract;
2. FEM CPU direct/difference oracle;
3. FEM GPU resident baseline i fused subtract/gather;
4. scoped Airbox Zarr;
5. API i Control Room;
6. kwalifikacja;
7. FDM history;
8. FDM live/CUDA.

Nie należy zaczynać od samego UI ani od odejmowania dwóch pobranych klatek w przeglądarce. Browser-side subtraction nie ma dostępu do pełnej tożsamości operatora, może mieszać revisions, nie rozwiązuje accepted-state problemu i nie daje wiarygodnego artifactu naukowego.
