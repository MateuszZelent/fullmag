# Pochodzenie kwadratury w mieszanym operatorze Poissona airboxu

- Status: `source_visible / native_runtime_unvalidated`
- Właściciel: Fullmag FEM frequency-domain backend
- Data: 2026-10-01
- Zakres: czytelna diagnostyka faktycznej kwadratury i jej powiązania z digestem operatora
- Powiązana fizyka: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Powiązana topologia: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`

(problem-statement)=
## 1. Domena fizyczna i cel

Wspólna domena FEM obejmuje magnetyczne elementy `tet4` lub `prism6` oraz
skalarny blok potencjału Poissona w airboxie. Ten dokument opisuje pochodzenie
kwadratury użytej przy składaniu mieszanego operatora. Nie wprowadza nowej
energii, interakcji ani przybliżenia fizycznego.

Dotychczasowy digest operatora wiązał kwadraturę z niezmiennym hashem, ale
wynik solvera nie pokazywał operatorowi diagnostycznemu, jaka reguła została
rzeczywiście zwrócona przez MFEM. Przyrost publikuje więc mały, deterministyczny
agregat obok hasha. Agregat powstaje z tej samej pętli elementów magnetycznych,
która zasila digest.

(governing-equations)=
## 2. Kontrakt numeryczny

Dla każdego magnetycznego elementu $e$ diagnostyka zapisuje krotkę reguły:

```{math}
:label: eq-quadrature-provenance-record
\mathcal{R}_e =
\left(g_e, p_e, q^{\mathrm{req}}_e,
q^{\mathrm{res}}_e, n_e\right),
\qquad
n_e = \operatorname{GetNPoints}(r_e),
\qquad
q^{\mathrm{res}}_e = \operatorname{GetOrder}(r_e).
```

`$g_e$` jest geometrią MFEM, `$p_e$` rzędem interpolacji FE,
`$q^{\mathrm{req}}_e$` rzędem żądanym przez politykę Fullmag,
`$q^{\mathrm{res}}_e$` rzędem reguły faktycznie zwróconej przez MFEM,
`$r_e$` obiektem `IntegrationRule`, a `$n_e$` liczbą jej punktów.
Wartości są agregowane po identycznych krotkach, z dodatkowym rzeczywistym
`element_count`.

Kwadratura nie zmienia istniejącego preimage hasha. Digest operatora nadal
wiąże między innymi każdy element z jego topologią, rzędem FE, żądanym rzędem,
rozwiązanym rzędem i liczbą punktów:

```{math}
:label: eq-quadrature-provenance-digest-binding
D_{\mathrm{op}} =
\operatorname{SHA256}\!\left(
\operatorname{CanonicalDigestBuilder}
\left[\ldots,\mathcal{R}_e,\ldots\right]\right).
```

Pole JSON jest diagnostyczną reprezentacją tego samego odczytu. Nie jest
drugim źródłem parametrów i nie może zastępować walidacji hasha.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| LaTeX token | Znaczenie | Jednostka SI |
|---|---|---|
| $e$ | indeks magnetycznego elementu FE | $1$ |
| $g_e$ | geometria elementu MFEM, np. `tet4` lub `prism6` | $1$ |
| $p_e$ | rząd interpolacji skończenie-elementowej | $1$ |
| $q^{\mathrm{req}}_e$ | żądany rząd kwadratury polityki backendu | $1$ |
| $q^{\mathrm{res}}_e$ | rząd reguły zwróconej przez MFEM | $1$ |
| $r_e$ | reguła całkowania MFEM | $1$ |
| $n_e$ | liczba punktów reguły `GetNPoints()` | $1$ |
| $D_{\mathrm{op}}$ | SHA-256 digest złożonego operatora | $1$ |
| $\mathcal{R}_e$ | rekord pochodzenia kwadratury elementu | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- Obowiązująca polityka źródłowa dla tego operatora wybiera `tet5` dla
  `tet4` i `prism4` dla `prism6`, a następnie wymaga skończonych dodatnich wag.
- `rule_npoints` nie jest wpisywane na stałe. Jest odczytywane z instancji
  `IntegrationRule`, więc diagnostyka pozostaje zgodna z katalogiem reguł
  konkretnej wersji MFEM.
- Agregat obejmuje tylko elementy z aktywnym znacznikiem magnetycznym, tak
  samo jak istniejąca pętla digestu. `element_count` jest liczbą tych
  elementów, a nie rozmiarem całej siatki.
- Diagnostyka ma `publisher_lane: fem_cpu`. Pole `scope` rozróżnia ścieżkę
  wywołującą: `k0_shared_domain_assembly` dla operatora k0,
  `floquet_sparse_shared_domain_assembly` dla natywnego sparse Matshell
  nonzero-k oraz `floquet_legacy_dynamic_demag_k_assembly` dla starszego
  providera gęstej macierzy dynamicznego demagu. Nie jest to dowód wykonania
  solvera GPU ani parytetu GPU.
- Native build i runtime nie są jeszcze zweryfikowane w tym worktree.

(python-api)=
## 5. Python API

Ten przyrost nie dodaje publicznego parametru Python. Python DSL nadal opisuje
problem fizyczny, a pochodzenie kwadratury powstaje dopiero w natywnym składaniu
FEM. Poniższy fragment pokazuje jedynie odczyt już opublikowanego JSON-u; nie
uruchamia symulacji.

```python
# %%
import json

# %%
diagnostics = r'''{
  "shared_domain_operator_provenance": {
    "schema_version": "poisson_airbox_shared_domain_operator_provenance.v1",
    "publisher_lane": "fem_cpu",
    "scope": "floquet_sparse_shared_domain_assembly",
    "operator_digest": "sha256:example",
    "quadrature": {
      "schema_version": "poisson_airbox_shared_domain_quadrature.v1",
      "policy": "p1_geometry_aware_tet5_prism4_positive",
      "element_count": 1,
      "entries": []
    }
  }
}'''
payload = json.loads(diagnostics)
assert payload["shared_domain_operator_provenance"]["publisher_lane"] == "fem_cpu"
assert payload["shared_domain_operator_provenance"]["quadrature"]["element_count"] >= 0
```

(problem-ir)=
## 6. ProblemIR i normalizacja

Nie zmienia się `ProblemIR`, lowering, walidacja ani semantyka requested versus
resolved execution. `quadrature` jest natywnym polem diagnostycznym wyniku i
nie jest wejściem, które można ustawić z Python DSL albo z UI.

(round-trip-and-failure-semantics)=
## 7. Round-trip, intent i błędy

Istniejące żądanie operatora, digest i manifest pozostają źródłem prawdy.
Po udanym składaniu wynik może zawierać pole
`shared_domain_operator_provenance`. Pole jest dołączane addytywnie do
`diagnostics_json` i `result_json`; istniejące dane nie są nadpisywane.
Jeżeli solver zakończy się błędem po składaniu, helper ponownie dołącza
pochodzenie do diagnostyki błędu. Dotyczy to także wyniku providera
nonzero-k po udanym składaniu; scope zachowuje informację, czy operator
pochodził ze sparse Matshell, legacy dynamic-demag-k czy ścieżki k0.
Niepoprawny lub pusty JSON solvera pozostaje niezmieniony, ponieważ helper nie
tworzy zastępczego wyniku. Błędy walidacji przed składaniem i nieudane
składanie nie otrzymują rekordu, którego operator nie został poprawnie
utworzony. Kontrola duplikatu sprawdza wyłącznie pole bezpośrednio w obiekcie
root JSON; identyczny tekst zagnieżdżony w `operator_diagnostics` nie blokuje
publikacji pola top-level. Append toleruje końcowe białe znaki i zachowuje je
po dopisaniu pola.

`requested intent` i `resolved execution` pozostają własnością istniejącego
kontraktu modalnego. `validation errors` nadal kończą się dotychczasowym
statusem i powodem. `unsupported combinations`, w tym nieobsługiwane
geometrie, są odrzucane przed publikacją rekordu; diagnostyka nie udaje wtedy
runtime proof.

(discrete-realization)=
## 8. Realizacja dyskretna

`frequency_domain_p1_quadrature` jest wspólnym punktem wyboru reguły dla
magnetycznych bloków P1. W pętli digestu backend pobiera raz geometrię, rząd
FE, żądany rząd, `rule.GetOrder()` i `rule.GetNPoints()`. Te same wartości są
użyte do uporządkowania mapy wpisów i zapisania JSON-u.

Wpisy mapy są sortowane leksykograficznie po pełnej krotce, dlatego kolejność
nie zależy od kolejności wstawiania do mapy ani od niedeterministycznego źródła
diagnostyki. Liczby punktów nie są kopiowane z dokumentacji MFEM do kodu.

(implementation-mapping)=
## 9. Mapowanie implementacyjne

| Element kontraktu | Implementacja |
|---|---|
| wybór reguły i dodatnie wagi | `frequency_domain_p1_quadrature` |
| agregacja geometrii, FE i reguły | `quadrature_provenance_json` oraz mapa `QuadratureProvenanceKey` |
| zachowanie istniejącego hasha | `assemble_poisson_airbox_shared_domain` pozostawia dotychczasowy `CanonicalDigestBuilder` |
| publikacja obok hasha | `shared_domain_operator_provenance_json` i `append_shared_domain_operator_provenance` |
| regresja wartości runtime | `main` w natywnym teście shared-domain; test przygotowany, ale nieuruchomiony |

(validation)=
## 10. Walidacja i dowody

- `scripts/test_poisson_airbox_quadrature_provenance.py` jest interpretowanym
  wiring checkiem i nie dowodzi wartości reguł MFEM w runtime.
- `poisson_airbox_shared_domain_test.cpp` zawiera przygotowaną regresję, która
  porównuje `resolved_quadrature_order` i `rule_npoints` z wartościami
  `GetOrder()` oraz `GetNPoints()` dla `tet4` i `prism6`.
- `modal_eigen_contract_test.cpp` zawiera przygotowaną regresję kontraktu:
  przekazuje zagnieżdżone `shared_domain_operator_provenance` w
  `operator_diagnostics_json` przez `solve_modal_eigen_contract` i sprawdza,
  że po udanym składaniu powstaje osobne pole top-level w obu wynikach.
- Skrypt interpretowany sprawdza dodatkowo kontrakt dla obiektu pustego z
  białymi znakami i końcowych białych znaków. Jest to model kontraktu
  source-only, a nie wykonanie implementacji C++.
- Kompilacja i uruchomienie testu natywnego pozostają `NOT VERIFIED` z powodu
  obowiązującego zakazu budowania testów jednostkowych.
- Dokumentacja wymaga walidacji source-map i testów kontraktu dokumentacji;
  wynik tych kontroli jest raportowany oddzielnie od runtime FEM.

(limitations)=
## 11. Ograniczenia

Ten przyrost nie dowodzi dodatnich wag dla każdej wersji MFEM, zbieżności siatki,
zbieżności airboxu, poprawności demagnetyzacji, częstotliwości własnych ani
zgodności z COMSOL-em lub TetraX. Dowodzi jedynie, że po uruchomieniu natywnego
składania można powiązać czytelny zapis faktycznej reguły z hashem tego samego
operatora. Informacja o assembly CPU nie jest kwalifikacją GPU.

(scientific-bibliography)=
## 12. Bibliografia naukowa

- MFEM, dokumentacja `IntegrationRule` i katalogu reguł całkowania, wersja
  [4.10](https://docs.mfem.org/4.10/classmfem_1_1IntegrationRule.html).
- MFEM, źródła wydania [v4.10](https://github.com/mfem/mfem/tree/v4.10).
- Dokumentacja Fullmag mixed-P1 shared-domain:
  `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Źródło | Odpowiedzialność | Dowód |
|---|---|---|---|
| Rekord JSON pochodzi z faktycznej reguły | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `quadrature_provenance_json` | agregacja geometry/FE/order/npoints | source-visible; native NOT VERIFIED |
| Digest zachowuje dotychczasowy kontrakt | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `quadrature_provenance_json` | diagnostyka jest addytywna, bez zmiany preimage | source-visible |
| Pole trafia do diagnostyki wyniku | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` + `append_json_field` | dołączenie operator digest + quadrature | source-visible |
| Runtime wartości są sprawdzane przez MFEM | `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` + `main` | porównanie z `GetOrder()` i `GetNPoints()` | prepared; NOT VERIFIED |
| Zagnieżdżone pole nie blokuje top-level provenance | `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` + `main` | regresja przez `solve_modal_eigen_contract` | prepared; NOT VERIFIED |
