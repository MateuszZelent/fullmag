# GSG: przygotowane badanie zbieżności źródła — propozycja 03.11.2026

## Decyzja i stan

Do zatwierdzenia: jeden zarządzany build naszej grupy 3203, trzy nowe pełne inspekcje V/J/H dla siatek 100/75/50 nm oraz dziewięć niezależnych kontroli H z jawnym profilem referencyjnym. Nie jest to ponowienie historycznej próby H-only. Nie uruchomiono tych obliczeń, nie zmieniono limitów ani bramek kwalifikacji.

Proponowany eksperyment sprawdza wpływ siatki **tego samego pełnego obwodu GSG** w małym oknie obserwacyjnym. Nie kwalifikuje całej próbki ani transmisji z publikacji. Wcześniejsze V/J/H i mapa Universe pozostają zachowane; historyczne Failed nie zostanie zmienione.

Maszynowy projekt `experiment-proposal.json` ma SHA256 **1b7d515a905ad0112db1d3075a1599a2d138995c587287b6d29bd25d2d6a96f2**. Manifest przygotowanych plików `evidence-index.json`: **6d8f1503975dc0ddccc9168e9019b24f960af7608ecef6caf5a08afad01f5762**. Oba są w katalogu kontrolnym opisanym niżej. To nieaktywne propozycje, a nie nowe ustawienia runtime.

## Co faktycznie przygotowano

Użyto `fullmag.runtime.loader.load_problem_from_script(..., lightweight_assets=True)` i `fullmag.model.problem.Problem.to_ir(include_geometry_assets=True)`. Trzy pełne ProblemIR zawierają rzeczywiste siatki źródła, materiałów i przekroju zasilającego. Nie uruchomiono transportu, Biota–Savarta, LLG ani komendy API. Orientacja wszystkich czworościanów jest dodatnia. Szczyt RSS procesu przygotowania: 454140 KiB; czas przygotowania trzech wejść: 24,77 s. Nie jest to prognoza czasu Solve.

| Zadany rozmiar | Węzły źródła | Tet4 źródła | Pary komórka–punkt, 20 punktów | Pary ściana–punkt–precyzja, na jeden punkt referencji |
|---|---:|---:|---:|---:|
| 100 nm | 5990 | 14299 | 285980 | 171588 |
| 75 nm | 10155 | 25516 | 510320 | 306192 |
| 50 nm | 23730 | 72911 | 1458220 | 874932 |

Są to **nowe, zachowane siatki**. Nie są identyczne z historyczną siatką 14304 Tet4 ani wcześniejszym pomiarem samych liczności. Przypięto pełne tablice, a nie tylko nominalny rozmiar elementu. Dodatnia objętość nie oznacza jeszcze odbioru wszystkich kryteriów jakości CAD i interfejsów.

Wszystkie poziomy mają ten sam nośnik: 20 węzłów i 24 Tet4, przestrzeń 4 µm × 100 nm × 17,4 nm. Osie: x = {-2; -0,45; 0; 0,45; 2} µm, y = {-50; 50} nm, z = {-22,4; -5} nm. Obejmują środki signal/return, słabe ogony oraz obie powierzchnie grubości magnetycznej. Jest to jawny **niemagnetyczny nośnik diagnostyczny**, nie siatka LLG ani demag Airbox.

- `.fullmag-mesh`: SHA256 `c0db256c8bf0d5c545123ac9d4154388c74081a74304f02912151ea8d9a52178`.
- Wspólne XYZ float64 LE: SHA256 `d22b100caf3c09f8ae484809ba4cef267d80c6a9d24415dc0153e52377da0684`.
- ProblemIR 100 nm: SHA256 `1744d3830a359e2d17e3cfb184900a6509233facc8773857c4ae8790c0da79b3`.
- ProblemIR 75 nm: SHA256 `ad466216dbbe93fb0de8260711c7466b8344299fe827fc2eb1c05e82b50ba39c`.
- ProblemIR 50 nm: SHA256 `c6f6087b311999218fa9d188d759bd3de767c428ab2eb38b1fcd30549b9cb785`.

Pierwsze przygotowanie zatrzymał błędny licznik pomocniczy używający nieistniejącego klucza `cell_types`; rzeczywisty MeshIR ma `cells.types`. Zachowano tę próbę i log. Poprawiona próba jest w osobnym `prepared-v2`; nie zastępuje pierwszej historii.

## Stała fizyka i publiczny przepływ

Źródło wyjściowe: `examples/fem_antenna_sushruth_2020_closed_gsg.py::study`, SHA256 `e73b4af090cd65d6963b3d4a1b90216da0025c135841a487b6a7db6ba7565e8b`. Wszystkie warianty są płaskimi skryptami `fm.study`, z jawnym FEM CPU/double/P1/strict. Wykorzystują istniejące `study.domain_mesh(..., region_markers=[])` oraz `FieldTarget.global_domain()`.

| Parametr jawny | Wartość | Znaczenie / pochodzenie |
|---|---|---|
| Szerokość trzech pasków / szczelina | 200 nm / 250 nm | Nominalny przekrój z publikacji; nie dopasowanie Fig. 6 |
| Grubość metalu / izolatora / czapki | 90 nm / 30 nm / 5 nm | Ten sam układ wysokości co zachowana GSG |
| Długość źródła / połączenie / poprzeczka | 20 µm / 2 µm / 200 nm | Jawnie przyjęte końcowe zamknięcie; nie opublikowane pady |
| Przewodność pięciu części | $3{,}5\times10^7\,\mathrm{S\,m^{-1}}$ | Założenie istniejącego modelu, bez strojenia |
| Skok potencjału | $10^{-3}\,\mathrm V$ | Jedno źródło na przekroju wejściowym, nie zadany prąd |
| Przekrój źródła | lokalne x = -1 µm, normalna positive_axis | `StructuredCutPlane`, `ImpressedPotentialJump` |
| Gauge / port | zero_mean / v3 minus_outward | Zachowany signed current z RT0 |
| Transport | ohmic_poisson, one_way, H1 P1 | CG, rtol $10^{-12}$, atol 0, maks. 10000 iteracji |
| Operator H | direct_tetra_quadrature | Ten sam na wszystkich poziomach; bez zmiany na analityczny operator |
| Sampling | Global, jawna domena all-air | Te same XYZ i connectivity na każdym poziomie |
| Port / obwód | signal i dwa powroty, połączenia na obu końcach | Podział prądu wyznacza 3D solve; wagi portu nie narzucają powrotów |

Ścieżka pozostaje Python → ProblemIR → publiczny prepare/plan → managed runtime → accepted V/RT0/H → archiwum/API. Przygotowane pliki są wyłącznie wejściami. Nie mają accepted ownera ani certyfikatu bazy. Nie wolno nadać im provenance historycznego źródła. Przed Submit wymagane jest porównanie pełnej rzeczywistej preparacji z przypiętymi tablicami, przekrojem i materiałami. Dryf zatrzymuje eksperyment; nie wolno cicho przeliczyć siatki i zachować dawnego SHA.

| Realizacja | Zakres eksperymentu |
|---|---|
| FEM CPU | Trzy nowe inspekcje H1/RT0/H w double/P1/strict; baza pozostaje niekwalifikowana |
| FEM GPU | Poza zakresem; brak dowodu równoważności tej ścieżki na GPU |
| FDM CPU | Nieobsługiwany nośnik tego eksperymentu: źródło conforming H1/RT0 Tet4 |
| FDM GPU | Poza zakresem; brak odpowiadającej realizacji FDM tego źródła |

## Proponowane kryteria przed nowymi wynikami

To proponowane kryteria małego eksperymentu GSG, zaczerpnięte z wcześniejszej prerejestracji mikropasku. **Nie są już obowiązującą kwalifikacją GSG.** Nie wolno ich rozluźniać po obejrzeniu wyniku.

Dla każdej siatki zachowujemy signed prąd przekroju $I_h$ w A, pełny wektor $\mathbf H_h$ w A/m oraz $\mathbf K_h=\mathbf H_h/I_h$ w $\mathrm{m^{-1}}$. Bez dopasowywania znaku, amplitudy albo prądu do publikacji. Dla porównania fine–medium, na każdym z 20 punktów:

- $|I_f-I_m|\le10^{-18}\,\mathrm A+0{,}01|I_f|$.
- $\|\mathbf H_f-\mathbf H_m\|\le5\times10^{-4}\,\mathrm{A/m}+5\times10^{-4}\|\mathbf H_f\|$.
- $\|\mathbf K_f-\mathbf K_m\|\le(5\times10^{-4}\,\mathrm{A/m})/|I_f|+5\times10^{-4}\|\mathbf K_f\|$.
- Różnica medium–coarse musi przekraczać fine–medium poza odpowiednią bezwzględną podłogą. Raport zawiera oba przyrosty; z trzech nienested siatek nie wyznaczamy wiarygodnego rzędu zbieżności lub GCI.
- Jeśli publiczny wynik zawiera właściwy estymator błędu RT0/H1, wymagamy $\eta_f\le0{,}05$ oraz $\eta_f\le0{,}8\eta_m\le0{,}64\eta_c$, z wcześniejszym wyjątkiem, gdy porównywane estymatory są oba nie większe niż $10^{-6}$. Brak właściwego estymatora to NOT VERIFIED, nie zero.

Istniejące bramki residual, gauge, jump, lokalnego bilansu, signed cut i unconverged pozostają włączone. Niezależna kontrola używa własnej rekonstrukcji RT0 i pełnego źródła, nie trzech jednorodnych pryzmatów. Każde H wymaga pełnych passów binary64/80/120, lokalnych i globalnych kontroli precyzji/formuły. Native–oracle: $10^{-3}\,\mathrm{A/m}+10^{-3}\|\mathbf H_o\|$; wewnętrzna kontrola referencji: $10^{-6}\,\mathrm{A/m}+10^{-6}\|\mathbf H_{120}\|$. To kontrole wybranych punktów; ich sukces nie dowodzi poprawności całego nośnika ani sumarycznego budżetu błędu bazy.

## Koszt, profil i odmowy

Native zachowuje istniejący `volume_inspection_v1`: 4 mln par, 500 mln wywołań kernela i 500 mln wizyt liści. Kwadratura order 4, depth 6, atol $10^{-9}$ A/m, rtol $10^{-5}$. Tabela potwierdza tylko limit par; adaptacja może wyczerpać pozostały budżet. Nie podnosimy tych limitów w ramach tego projektu.

Niezależne punkty to z góry wybrane indeksy **0, 8, 16**: x = -2, 0, +2 µm, y = -50 nm, z = -22,4 nm. Po trzy punkty na każdej z trzech siatek; jeden wspólny licznik całej dziewiątki, bez resetu między siatkami. Są to środek i ogony, a nie pełna kwalifikacja przekroju.

| Limit referencji | Proponowany profil jawny | Domyślny profil |
|---|---:|---:|
| Oceny ściana–punkt–precyzja / punkt | 1000000 | 100000 |
| Wywołania sqrt/log/log1p/atan2 / punkt | 25000000 | 2000000 |
| Dokładne predykaty / punkt | 4000000 | 500000 |
| Czas punktu | 10800 s | 3600 s |
| Czas całej dziewiątki | 43200 s (12 h) | 28800 s |
| Pary / cały eksperyment | 5000000, bez zmiany | 5000000 |
| Wywołania matematyczne / całość | 100000000, bez zmiany | 100000000 |
| Dokładne predykaty / całość | 20000000, bez zmiany | 20000000 |
| RAM całego procesu | 2 GiB, bez zmiany | 2 GiB |

Potrzeba 4058136 ocen ściana–punkt–precyzja. Konserwatywna predykcja 12 predykatów na jedną unikalną parę ściana–punkt daje 16232544 predykaty. Zgrubne 19 operacji matematycznych na pass daje 77104584 wywołania przed rekonstrukcją i gałęziami wyjątkowymi; pozostały limit jest rezerwą, nie dowodem przyjęcia. Implementacja musi zachować naliczanie rzeczywistej pracy przed wykonaniem i odmowę przy przekroczeniu. Poprzedni pomiar 3 punktów na 14304 komórkach trwał 3777 s; nowe 12 h jest limitem, **nie ETA**.

Nowy profil ma być jawnie wybrany tylko dla tej przypiętej dziewiątki; dotychczasowe LIMITS, precyzje, tolerancje, limit 8192 bitów i wheel mpmath 1.3.0 pozostają bez zmian. Nowy profil nie jest jeszcze zaimplementowany. Przed wykonaniem wymagane są regresje odmowy, hashy, sumowania budżetu i zgodności profilu domyślnego oraz uzupełnienie kanonicznej noty 0950 i jej source-map zgodnie ze scientific-documentation-contract. Ta propozycja nie deklaruje gotowości publikacyjnej.

## Kolejność po zatwierdzeniu

1. Wdrożyć i sprawdzić wyłącznie jawny profil referencji, dokumentację oraz regresje. Zweryfikować aktywne zadania, zachować wyniki i wykonać jeden managed build grupy 3203. API tej grupy będzie czasowo niedostępne.
2. Przygotować i przypiąć rzeczywiste publiczne wejścia. Porównać z zamrożonymi payloadami; brak zgodności zatrzymuje dalsze wykonanie.
3. Wykonać kolejno 100 → 75 → 50 nm: po jednej nowej pełnej inspekcji V/J/H. Bez automatycznych ponowień; pierwszy błąd zatrzymuje serię. Zachować wszystkie logi i wyniki częściowe bez uznawania ich za accepted.
4. Tylko jeśli trzy wyniki są kompletne i mają zgodne provenance, wykonać po trzy niezależne kontrole i ocenić uprzednio zapisane kryteria. Udostępnić raport z prądami, H/I, różnicami, licznikami i czasami.

Nie obejmuje: zmiany historycznych Failed, kolejnego H-only, nowego katalogu domen, podnoszenia zasobów Docker, automatycznej promocji bazy, pełnego filmu, wpływu końcowych połączeń, ważności RF, FFT, Relax lub Run LLG. Te wymagania E0–E12 pozostają otwarte.

## Źródła i dowody

- Zatwierdzony obwód GSG i projekt domen: `.superpowers/brainstorm/2026-11-02-antenna-magnetic-domains/design.md`.
- Kanoniczna fizyka, wcześniejsza prerejestracja i ograniczenia GSG: `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`, sekcje „Zachowane gates oraz Python/IR/backend contract” i opis zamkniętego GSG; zmiany polityki wymagają aktualizacji noty przed wykonaniem.
- `packages/fullmag-py/src/fullmag/runtime/antenna_coincident_materialization.py::materialize_antenna_coincident_loops`: przygotowanie rzeczywistej siatki i materiałów; nie accepted solve.
- `packages/fullmag-py/src/fullmag/meshing/persistence.py::save_mesh_artifact`: istniejący format nośnika `.fullmag-mesh`.
- `crates/fullmag-ir/src/antenna.rs::antenna_closed_loop_direct_budget` i `crates/fullmag-plan/src/antenna_current_source.rs::closed_loop_direct_field_policy`: niezmieniony budżet native.
- `scripts/antenna_rt0_surface_oracle.py::evaluate_retained_rt0` oraz `scripts/antenna_triangle_surface_oracle.py::Budget`: niezależna rekonstrukcja, trzy precyzje, naliczanie pracy i odmowy.
- Publikacja: [Sushruth et al., Phys. Rev. Research 2, 043203 (2020)](https://doi.org/10.1103/PhysRevResearch.2.043203). Nie utożsamiamy diagnostyki źródła z odtworzeniem jej transmisji.

Dowody w prywatnym control volume grupy 3203, katalog:
`verification/retained-current-h-only-20261102/accepted-store-v2/producer-dispatch-build/lock-scope-fix-build/work-budget-preflight-20261103/public-gsg-universe-275-01-version-fixed/gsg-convergence-inputs-20261103/prepared-v2/`.

`preparation-report.json`: SHA256 `0103411c5435ce7f841ecda922fa223d0381c7c014c433b75904dd10e95a40a6`; `geometry-verification.json`: SHA256 `9cbede8c4108185b7ce75fdffc14464b9a1f9b82bffa9acf2bcd2ce1d3078c5d`. Pliki ProblemIR, skrypty i nośnik są zachowane obok raportów. Zmiany źródeł nie zostały zacommitowane; współdzielony indeks pozostał bez zmian.
