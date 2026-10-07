# Kontrakt źródłowy ramy falowodu i signed k

Przyrost S09 obejmuje wyłącznie walidowaną ramę geometrii oraz projekcję globalnego wektora falowego. Publiczny Python DSL i writer ProblemIR pozostają w wersji 0.3. Typed StudyIRV04, siatka 2D, provider MFEM, admission i publikacja wyników wymagają dalszej implementacji. Ten helper nie włącza obliczeń falowodu.

Decyzja: [ADR0035](../adr/0035-eigen-spatial-representation-contract.md). Właściciel fizyki: [0828, rozdzielenie realizacji](../physics/0828-fem-frequency-domain-floquet-demag.md) oraz [0831, miara przekroju](../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md). Baza tangentowa magnetyzacji jest osobna od ramy geometrycznej opisanej tutaj.

## Typy i zachowanie

Źródło: [waveguide_frame.rs](../../crates/fullmag-ir/src/waveguide_frame.rs), symbole `WaveguideFrameIR`, `validate_waveguide_frame`, `ValidatedWaveguideFrameIR::project_global_k`.

| Dane | Jednostka SI | Kontrakt |
|---|---|---|
| `origin_m` | $\mathrm m$ | wymagany skończony wektor 3D, bez przesunięcia przez normalizator |
| `e_u`, `e_v`, `axis_unit` | $1$ | wszystkie wymagane; odchylenie norm wejściowych od 1 maksymalnie 1e-12; ortogonalna prawoskrętna rama |
| `normalization_lengths` | $1$ | dodatnie normy osi wejściowych; nie są długościami w metrach |
| `geometry_tolerance` | $1$ | jeden stały kontrakt 1e-12; odrębny od tolerancji solvera |
| `requested_axis_norm_errors` | $1$ | rzeczywiste odchylenia norm wejściowych użyte w walidacji |
| `canonical_orthogonality_dots` | $1$ | podpisane iloczyny w kolejności u/v,u/axis,v/axis |
| `canonical_determinant` | $1$ | rzeczywisty wyznacznik kanonicznej ramy, bliski +1 |
| `requested_global_k_rad_per_m` | $\mathrm{rad\,m^{-1}}$ | skończony globalny wektor użytkownika, zachowany bez zmiany |
| `signed_k_rad_per_m` | $\mathrm{rad\,m^{-1}}$ | resolved podpisana projekcja na zadany kierunek osi |
| `reconstructed_global_k_rad_per_m` | $\mathrm{rad\,m^{-1}}$ | faktycznie zapisany wynik rekonstrukcji w binary64 |
| `collinearity_error` | $1$ | względny błąd rzeczywistej rekonstrukcji, maksymalnie 1e-12 |

Surowy `WaveguideFrameIR` ma lokalne `deny_unknown_fields`. Wynik walidacji i próbka signed k mają prywatne pola, publiczne accessors i wyłącznie Serialize. Nie można otrzymać zwalidowanego typu przez Deserialize, pomijając walidator. Nie stanowią one certyfikatu naukowego ani niezależnego persisted artifact schema.

Normalizer dzieli każdą oś przez jej dodatnią długość, po wcześniejszym sprawdzeniu norm wejściowych. Nie zmienia znaków, nie wyprowadza brakującej osi i nie stosuje Gram–Schmidta. Odwrócenie osi wraz z odpowiednią zmianą pozostałej ramy odwraca znak resolved scalar k. Kierunek użytkownika nie jest wybierany automatycznie.

Dokładne Γ jest rozpoznawane bitowo, także dla signed zero. Niezerowy subnormalny request nie może trafić do Γ przez numeryczne porównanie z zerem. Skalowana projekcja i norma unikają przepełnienia normy dużego k; niereprezentowalny scalar, rekonstrukcja lub metryka są odrzucane. Kontrola względna nie używa absolutnej podłogi SI, która dopuściłaby małe poprzeczne k.

Każde wejście do walidacji ramy i projekcji k wymaga zachowania liczb subnormalnych. Guard używa rzeczywistych operacji przez `black_box`: najmniejsza dodatnia liczba subnormalna pomnożona przez 2 musi mieć bits=2, a `MIN_POSITIVE/2` bits=0x0008000000000000. Niespełnienie warunku daje `UnsupportedFloatEnvironment` bez zmiany środowiska FP. Kontrola jest ponawiana przy projekcji, ponieważ zwalidowaną ramę można przenieść na inny wątek. Sprzętowe wykonanie guarda i FTZ/DAZ pozostają NOT VERIFIED; source-only dowód nie kwalifikuje środowiska.

## Dowody źródłowe i pozostałe bramki

[Wspólne fixtures](../../crates/fullmag-ir/tests/fixtures/waveguide_frame_cases.v1.json) zawierają 18 przypadków z niezależnego Decimal oracle ze 100 cyframi precyzji. Regresje w module przygotowano dla parsera, geometrii, signed k, rzeczywistych metryk, bardzo małych i dużych wartości oraz błędów typu. Tymczasowy zakaz kompilacji unit tests pozostaje w mocy: testy Rust nie były kompilowane ani wykonane. Interpretowana emulacja 18/18 i parser nie dowodzą Rust runtime ani publicznego round-trip.

Obecne realizacje FDM CPU/GPU i FEM CPU/GPU nie otrzymują przez ten przyrost nowej capability. Produkcyjny owner przekroju, complete triangle/edge incidence, bindings materiałów i równowagi, frame/mesh fingerprint, sample index, canonical V04 reader/writer oraz API/UI nadal wymagają osobnych bramek. Normy modów i istniejący pełny solver 3D pozostają odrębnymi kontraktami.

Nie dodawać na tym etapie publicznego parametru przestrzennego do ignorowanego wire 0.3. Pierwszy atomowy cutover V04 musi użyć tego samego kontraktu i fixtures dla Rust/Python, zachować requested intent i odrzucać waveguide jako unavailable do czasu implementacji providera.

## Odtwarzalne referencje kontraktu

`python -B scripts/generate_waveguide_frame_fixtures.py` porównuje bajty wspólnego fixture z niezależnym oracle, po ujednoliceniu CRLF/LF; domyślnie nic nie zapisuje. `--write` służy wyłącznie świadomemu odtworzeniu wersjonowanego fixture. To sprawdzenie referencji, nie wykonanie helpera Rust.

`python -B scripts/verify_waveguide_scalar_air_island_reference.py` wykonuje dokładny kontrprzykład P1 z zamkniętą wyspą powietrza: 49 węzłów, 72 trójkąty i 25 free scalar DOF. Cały konformny operator skalarny z zewnętrznym Dirichletem ma dodatnie exact LDL pivots, choć wewnętrzna wyspa air nie dotyka tego brzegu. Algebraiczny quadratic form dla jej indicatora wynosi 8 (bez jednostki fizycznej energii). Referencja chroni przed błędnym wymaganiem osobnego Dirichleta dla każdej składowej air; nie jest pomiarem FEM Fullmag.

Źródła: [generator](../../scripts/generate_waveguide_frame_fixtures.py), symbol `decimal_oracle`; [referencja P1](../../scripts/verify_waveguide_scalar_air_island_reference.py). Właściwy validator produkcyjnej topologii nadal wymaga implementacji i nie może zostać zastąpiony tym pojedynczym przykładem.
