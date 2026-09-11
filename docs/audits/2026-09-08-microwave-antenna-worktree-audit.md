# Audyt worktree anten mikrofalowych: fizyka, LLG, backend i Control Room

Data: 2026-09-08. Raport dotyczy zawartości roboczej, w tym plików nieśledzonych. Nie jest certyfikatem poprawności solvera ani raportem z pełnej kwalifikacji urządzeń.

Dokument zamknięto 2026-09-09 wraz z [planem refaktoryzacji krok po kroku](../superpowers/plans/2026-09-08-microwave-antenna-refactoring-plan.md). Plan mapuje F01–F13 i pozostałe luki na 19 zadań implementacyjnych; przygotowanie planu nie oznacza wykonania napraw.

## 1. Werdykt

**Kierunek fizyczny i architektoniczny warto zachować. Obecnego stanu nie należy jednak scalać jako gotowego modułu anten mikrofalowych ani używać bez dodatkowej walidacji do ilościowych wniosków naukowych.** Rozdzielenie obliczenia pola przewodnika od dynamiki magnetyzacji jest właściwe. Pełna geometria 3D, jawne prądy powrotne, wektorowa baza pola na amper i późniejsze przemnażanie przez przebieg czasowy są dobrymi fundamentami. Nie oznacza to, że implementacja realizuje już ten model we wszystkich warstwach.

Najważniejsze blokady to utrata kompozycji anteny przy zapisie sceny, brak spójnego kontraktu znaków terminali, aktywacja pobudzenia także w relaksacji, niepełne sprawdzanie aktualności bazy pola i niedomknięta projekcja na obiekt we wspólnej siatce FEM. Publiczny hand-off odrzuca FDM i frequency response. UI nadal interpretuje antenę przede wszystkim jako maskę pola Zeemana. To są problemy przepływu naukowego, a nie wyłącznie brak wizualnego dopracowania.

Ocena użyteczności: **obiecujący komponent rozwojowy dla jawnego, jednokierunkowego wzbudzenia prądowego; jeszcze nie ergonomiczny instrument do rutynowych symulacji mikromagnetycznych.** Największą wartość przyniesie domknięcie jednego zweryfikowanego przebiegu od geometrii do odpowiedzi LLG, następnie FEM-precompute → FDM GPU. Rozbudowa interfejsu przed naprawieniem zachowania modelu utrwaliłaby błędne kontrakty.

(audit-problem-statement)=
## 2. Zakres, rewizje i sposób porównania z master

| Element | Stan w chwili rozpoczęcia audytu |
|---|---|
| Worktree | `D:/git/fullmag/worktrees/microwave-antenna-implementation-20260831` |
| Gałąź | `codex/microwave-antenna-implementation-20260831` |
| HEAD | `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5` |
| Lokalny master | `7faa259c5597ba447c413f2aea0ff66d6110b297` |
| Merge-base | `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5` |
| Historia | HEAD jest przodkiem master; master ma 28 późniejszych commitów |
| Zawartość robocza względem HEAD | 63 zmodyfikowane pliki śledzone i 14 plików nieśledzonych |
| Rozmiar zmiany śledzonej | 4295 dodanych i 399 usuniętych linii |
| Pliki nieśledzone | 15612 linii, łącznie z wcześniejszym obszernym audytem i dokumentacją |
| Zmiany HEAD → master | 643 ścieżki; 18 pokrywa się ze zmienionymi plikami roboczymi |

`git diff master...HEAD` jest pusty, ponieważ nie ma osobnych commitów tej gałęzi po merge-base. Sam taki diff pominąłby praktycznie całą bieżącą pracę nad antenami. Audyt wykorzystuje trzy porównania: HEAD → pliki robocze, HEAD → master i master → pliki robocze. Nie wykonywano fetch; „master” oznacza powyższą lokalną rewizję, nie zapewnienie o najnowszym stanie serwera.

Przejrzano przekrojowo fizykę, nowe kontrakty, najważniejsze zmienione ścieżki, ich wywołujących, testy i zastane ograniczenia. To pełny audyt obszarów modułu, **nie twierdzenie o przeczytaniu każdej linii 643 zmian upstream ani formalny dowód braku innych błędów**. Zmian dokumentacji i symulacji niezwiązanych z antenami na master nie traktowano jako regresji anteny. Inwentarz roboczy znajduje się na końcu raportu.

Oznaczenia: **P1 / Blocker** — usunąć przed udostępnieniem przepływu jako działającego; **P2 / Required** — potrzebne do bezpiecznego, reprodukowalnego użytkowania; **Sugestia** — decyzja produktowa. „Potwierdzone statycznie” oznacza prześledzony kod i konkretny warunek wywołania, nie wykonaną symulację natywną.

(audit-governing-equations)=
## 3. Ocena podstaw fizycznych

### 3.1. Model źródła i rozdzielenie od LLG

Kanoniczny właściciel równań to notatka `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`. Poniższe równania są kryteriami audytu tego kontraktu, a nie nową, konkurencyjną definicją interakcji.

```{math}
:label: audit-antenna-conduction
\nabla\cdot\mathbf J=0,\qquad \mathbf J=-\sigma\nabla V.
```

To poprawny model stacjonarnego przewodnictwa omowego w określonej geometrii, przy odpowiednich terminalach, izolacji pozostałych ścian i ustaleniu cechowania potencjału. Przewężenie zmienia rozkład prądu i może wywołać jego skupienie. Rzeczywista geometria 3D jest tu konieczna; nieskończony pasek o stałym przekroju nie reprezentuje taperu.

```{math}
:label: audit-antenna-basis
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=\sum_p I_{p,0}f_p(t)\mathbf h_p(\mathbf r),
\qquad [\mathbf h_p]=\mathrm{m^{-1}}.
```

W tym zapisie `h_p` to pole na amper. Iloczyn `H/A × A` daje `A/m`. Baza jest rzeczywista i niezależna od częstotliwości; wszystkie składowe danego portu mają wspólny skalarny przebieg. To świadome ograniczenie modelu, nie pełna zespolona odpowiedź elektromagnetyczna.

```{math}
:label: audit-antenna-llg
\mathbf H_{\mathrm{eff}}=\mathbf H_{\mathrm{other}}+\mathbf H_{\mathrm{ant}},
\qquad
E_{\mathrm{ant}}=-\mu_0\int_{\Omega_m}M_s\mathbf m\cdot\mathbf H_{\mathrm{ant}}\,dV.
```

Do LLG trzeba przekazać pełny wektor, ze znakiem i skalą. Moduł pola i pole poprzeczne są produktami analizy. Zastąpienie wektora jego modułem niszczy informację o kierunku wzbudzenia. Nie znaleziono w przejrzanym pakowaniu bazy do FEM potwierdzonego błędu czynnika `mu0`; nie jest to jednak dowód poprawności całej trajektorii LLG.

(audit-symbols-and-si-units)=
### 3.2. Symbole kryteriów audytu

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf J$ | konwencjonalna gęstość prądu | $\mathrm{A\,m^{-2}}$ |
| $\sigma$ | przewodność elektryczna | $\mathrm{S\,m^{-1}}$ |
| $V$ | potencjał elektryczny | $\mathrm V$ |
| $\nabla$ | operator różniczkowania przestrzennego | $\mathrm{m^{-1}}$ |
| $\mathbf r$ | położenie obserwacji | $\mathrm m$ |
| $t$ | czas fizyczny | $\mathrm s$ |
| $p$ | indeks portu | $1$ |
| $I_{p,0}$ | podpisana amplituda prądu portu | $\mathrm A$ |
| $f_p$ | mnożnik czasowy portu | $1$ |
| $\mathbf h_p$ | wektorowa baza pola na amper | $\mathrm{m^{-1}}$ |
| $\mathbf H_{\mathrm{ant}}$ | pole anteny | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | całkowite pole efektywne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{other}}$ | pozostałe składniki pola efektywnego | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{ant}}$ | energia Zeemana od pola anteny | $\mathrm J$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{H\,m^{-1}}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | unormowana magnetyzacja | $1$ |
| $\Omega_m$ | obszar magnetyczny | $\mathrm{m^3}$ |
| $dV$ | element objętości | $\mathrm{m^3}$ |

(audit-assumptions-and-validity)=
### 3.3. Kiedy baza DC jest użyteczna, a kiedy niewystarczająca

**Rozdzielenie solve → LLG jest uzasadnione. Utożsamienie „quasistatic” z „DC rozkład prądu jest zawsze poprawny w GHz” byłoby błędem.** Magnetoquasistatyka może nadal zawierać indukcję, skin effect i proximity effect. Model `div(sigma grad V)=0` ich nie wyznacza. Rozdział 10.7 podręcznika MIT opisuje przejście od rozkładu prawie stałoprądowego do dyfuzji pola i prądu w przewodniku [B3].

Raportowane w notatce 0950 wskaźniki `L_max f_max/c` i `t_max/delta` są użytecznymi ostrzeżeniami, ale nie certyfikatem dokładności. Pierwszy nie uwzględnia automatycznie wolniejszej propagacji w strukturze dielektrycznej. Drugi sam nie kontroluje bocznego skupienia prądu, sąsiednich przewodników, impedancji pętli ani pojemnościowego zamknięcia obwodu. Cienki metal nie gwarantuje poprawnego RF podziału prądu pomiędzy szerokimi, blisko położonymi powrotami. Próg 0,1 jest polityką inżynierską, a nie granicą wynikającą z uniwersalnego twierdzenia o błędzie.

Dla miedzi przy `sigma = 5.8e7 S/m`, `mu = mu0` przeliczenie wzoru z 0950 daje głębokość wnikania około 2,09 µm przy 1 GHz, 0,661 µm przy 10 GHz i 0,418 µm przy 25 GHz. To obliczenie skali, nie wynik solvera. Grubość 100 nm daje przy 25 GHz stosunek około 0,239, czyli przekracza własny próg ostrzegawczy notatki. Szerokopasmowy sinc trzeba oceniać w całym użytecznym paśmie, a nie wyłącznie w pobliżu wybranego rezonansu.

Wyszukanie `validity`, `eta_skin`, `eta_wave` i `bandwidth` w nowych plikach `antenna*.rs` plannera/runnera nie wykazało implementacji tych dwóch diagnostyk; trafienia dotyczą jedynie szerokości pasma okna FFT. Manifest `SolutionManifest` również nie niesie tych wskaźników. **P2 / Required:** dostarczyć je jako diagnostykę z określonym pasmem i ograniczeniami, nie jako zielony znaczek „fizyka poprawna”.

Literatura potwierdza sens pól wektorowych i selekcji falowej, ale nie kwalifikuje automatycznie tego solvera. Höfinger i współautorzy wykorzystują harmoniczny model RF, porty oraz import zespolonego pola do mikromagnetyki [B1]. Nie jest to ten sam model co rzeczywista baza DC. Praca Gruszeckiego uzasadnia ideę lokalnego dopasowania widma pola do fal spinowych [B2]. Reprodukcja tej idei i reprodukcja ilościowej sprawności elektrycznej są różnymi zadaniami.

### 3.4. Granice interpretacji naukowej

| Zastosowanie | Ocena założeń |
|---|---|
| Porównywanie kształtów lokalnego pola od zadanych prądów | Dobre zastosowanie po zbieżności siatki i kwadratury |
| Zależność selekcji falowej od geometrii przewężenia | Właściwy kierunek; wymaga rzeczywistej geometrii i testów widma |
| FMR i propagacja fal przy narzuconym wektorowym wzbudzeniu | Właściwy model jednokierunkowy po walidacji hand-offu |
| Silnie nieliniowa odpowiedź LLG | Sama LLG może być nieliniowa przy narzuconym polu; interpretacja przez liniową podatność przestaje wtedy wystarczać |
| Impedancja, S11/S21, rezonanse linii, faza propagacji RF | Nie wynikają z bazy DC |
| Moc w dBm → prąd, sprawność transdukcji i napięcie detektora | Brak wymaganej kalibracji portu/obwodu i sprzężenia odbiorczego |
| Automatyczny podział prądu między rozłączonymi powrotami | Nie wynika z samego stacjonarnego solve przewodników |
| Ekranowanie przez prądy wirowe w ferromagnetyku, backreaction | Poza zadeklarowanym jednokierunkowym modelem |

Suma wag równa zero nie dowodzi geometrycznego zamknięcia obwodu. Dwa końce jednego otwartego pręta mają bilans terminali, lecz nie opisują jeszcze przewodu powrotnego zasilania. Trzeba osobno zdefiniować topologię zamknięcia i ocenić wkład pomijanych odległych odcinków. W przeciwnym razie pole bliskie może być przybliżeniem zależnym od arbitralnego ucięcia przewodników.

(audit-discrete-realization)=
## 4. Backend i rzeczywista macierz dostępności

| Warstwa | FEM CPU | FEM GPU | FDM CPU | FDM GPU |
|---|---|---|---|---|
| Solve prądu anteny | Implementacja H1/P1 przez natywne MFEM; bez kwalifikacji runtime w tym audycie | Nie ma wykazanej dedykowanej realizacji antenowego solve | Nie jest właścicielem solve | Nie jest właścicielem solve |
| Pole i baza na amper | Kod przewiduje konserwatywny prąd i Oersted; wymaga dowodu dokładności near-field | Brak dowodu wykonania/parity | Docelowo konsument artefaktu | Docelowo konsument artefaktu |
| Solved drive → LLG przez CLI | Istnieje materializacja i pakowanie, z błędami F03–F05 | Kod współdzielonego pakowania nie jest dowodem rezydencji i poprawności GPU | Jawnie odrzucone w CLI | Jawnie odrzucone w CLI |
| Frequency response/eigen | Hand-off solved drive odrzucony | Hand-off solved drive odrzucony | Brak domkniętego przepływu | Brak domkniętego przepływu |
| UI conductor → solve → LLG | Niedomknięte | Niedomknięte | Niedomknięte | Niedomknięte |

Źródła: `plan_antenna_field_solve_v03`, `execute_antenna_field_solve_plan`, `attach_solved_antenna_drive_bases`, `pack_native_regional_field_drives`. Wiersze oznaczają stan kodu, nie promocję capability do „qualified”. Deklaracja wszystkich lanes jako ukończonych byłaby nieprawdziwa.

Zaletą nowej ścieżki jest rozdzielenie charge-only od spin transportu: antena nie musi tworzyć sztucznego problemu spinowego, żeby policzyć prąd. P1 tetrahedral conductor mesh jest racjonalnym pierwszym ograniczeniem. Jednocześnie nie można traktować testu afinicznego potencjału jako wystarczającej walidacji pola w odległości nanometrów od ostrej krawędzi przewodnika.

Plan mapuje `DirectTetraQuadrature` na istniejącą realizację `BiotSavartMidpoint`. Sama nazwa enuma nie rozstrzyga jakości kwadratury — trzeba kwalifikować faktycznie wywoływany konserwatywny operator, jego raport błędu i politykę near-field. Żądany poziom dokładności musi być widoczny w artefakcie. Odrzucenie nieobsługiwanej realizacji jest poprawniejsze od zastąpienia jej starą nieskończoną anteną, ale powinno nastąpić przed kosztownym solve.

Sprawdzenie natywnego właściciela potwierdza rzeczywistą adaptacyjną kwadraturę i transformację Duffy dla problematycznych targetów w `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp`. Nie jest to wyłącznie centroidowy mock. Jednocześnie istnieje istotny limit rozmiaru opisany w F13.

## 5. Ustalenia wymagające naprawy

### F01 — P1 / Blocker: zapis sceny usuwa kompozycję anteny

**Pochodzenie:** nowa integracja dirty worktree z zastanym modelem sceny. **Dowód:** statyczny, pełna ścieżka transakcji.

`geometry.add-microstrip-antenna` w `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts:768` wysyła nowe `antenna_port_modes` i `antenna_field_solve_stages`. `apply_scene_merge_patch` w `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs:3396` nakłada patch na JSON, a następnie deserializuje do `SceneDocument`. Struktura `crates/fullmag-authoring/src/scene.rs:14` nie ma żadnej z pięciu nowych kolekcji i nie zachowuje nieznanych pól. Dane znikają na tym przejściu.

Dodane `Vec<Value>` w `SceneResource` nie naprawiają właściciela stanu. `SceneResource::from_scene_document` produkuje odpowiedź z już zubożonego dokumentu. `ScriptBuilderState` i adaptery również nie transportują nowych kolekcji. Mock testu frontendowego sprawdza wysłany payload, a test DTO sprawdza samo DTO; żaden nie przechodzi przez tę granicę.

**Skutek:** użytkownik może widzieć geometrię anteny, podczas gdy jej port i solve nie są zachowane w kanonicznym modelu. **Naprawa:** typowane kolekcje w prawdziwym właścicielu sceny, adapterach i eksporcie. **Regresja:** prawdziwa transakcja → GET scene → eksport Python → ponowne lowering, porównanie kompletu obiektów, terminali, portów, stages, projections i drives.

### F02 — P1 / Blocker: znaki prądów portu nie są sprawdzane

**Pochodzenie:** nowy `native_fem/charge_transport.rs`. **Dowód:** statyczny, bez natywnej reprodukcji.

`measured_port_current`, `crates/fullmag-runner/src/native_fem/charge_transport.rs:334`, grupuje terminale według `signed_weight`, ale do bilansu i proporcji używa `current.abs()`. Dla wag `(1, -0.5, -0.5)` pomiary `(-1, +0.5, +0.5)` i `(+1, +0.5, +0.5)` mają identyczne moduły, więc ten certyfikator nie odróżnia ich mimo różnej orientacji fizycznej. Globalne odwrócenie napięć odwraca pole, a dodatnia normalizacja nie odwraca go z powrotem do kanonicznej orientacji portu.

To nie dowodzi, że każdy niepoprawny wektor przepływu przejdzie wszystkie wcześniejsze kontrole zachowawczości. Dowodzi natomiast, że **ten certyfikat zgodności z podpisanymi wagami nie certyfikuje znaków**. Ponadto obecne wagi są referencją kontrolną do solve z terminalami napięciowymi, a nie wykonaniem zapisanego w 0950 kontraktu całkowego prądu/equipotential dla każdej gałęzi.

**Naprawa:** jednoznacznie określić orientację terminalu/gałęzi, sprawdzić podpisane strumienie i związać je z prądem referencyjnym. Rozdzielić pary końców gałęzi od udziałów rozłączonych powrotów. **Regresja:** prawidłowe odwrócenie portu, odwrócenie samych napięć, błędny znak pojedynczego powrotu, asymetryczne proporcje i zamknięcie pętli.

### F03 — P1 / Blocker: AllTimeEvolution obejmuje relaksację

**Pochodzenie:** dirty runtime. **Dowód:** statyczny.

`drive_is_active`, `crates/fullmag-runner/src/antenna_fields.rs:32`, zwraca `true` dla `AllTimeEvolution` bez sprawdzenia rodzaju study. `pack_native_regional_field_drives`, `native_fem.rs:1217`, powtarza tę regułę. Materializacja `materialize_fem_solved_antenna_drive_parts` nie filtruje według study, a CLI podłącza bazy przed wykonaniem niesyntetycznych etapów, obejmujących również FEM relaxation.

Zwykły `field_drive_is_active`, `crates/fullmag-plan/src/util.rs:24`, sprawdza `StudyIR::TimeEvolution`. Antenowy wariant powinien mieć identyczną semantykę. Stałe pobudzenie może zmienić równowagę; zmienne może być podane do ścieżki minimizacji, która nie powinna go otrzymać.

**Naprawa:** wspólna aktywacja na poziomie planowania przed dołączeniem bazy. **Regresja:** `FieldSolve → Relax → TimeEvolution`; w Relax dokładnie brak pola anteny dla domyślnej aktywacji, w TimeEvolution poprawne pole. Jawne wybranie stage musi mieć osobną walidację zgodności z metodą relaksacji.

### F04 — P1 / Blocker: poprawny hash starego pliku nie oznacza aktualnej fizyki

**Pochodzenie:** nowy loader/materializacja artefaktu. **Dowód:** statyczny hand-off.

`materialize_fem_solved_antenna_drive_parts`, `antenna_field_solution.rs:828`, przekazuje loaderowi ID, digest i węzły, ale nie oczekiwane podpisy aktualnej geometrii przewodnika, materiału, terminali i portów. `load_solved_antenna_drive_basis_projected:418` weryfikuje integralność i identyfikację artefaktu, nie zgodność tych zależności z bieżącym modelem.

Zachowanie referencji starego artefaktu po zmianie przewężenia lub wag powrotu może pozostawić akceptowaną bazę starego problemu. Sprawdzanie cache podczas ponownego solve nie zabezpiecza niezależnego konsumenta. Zmiana jednolitej przewodności nie musi zmieniać pola po normalizacji do amperu, ale nadal zmienia deklarowaną proweniencję; zmiana geometrii lub rozkładu przewodności może zmienić również wynik.

**Naprawa:** konsument porównuje podpisy aktualnych zależności; jawny import „zamrożonego źródła z innego modelu” wymaga osobnego kontraktu zamiast udawania aktualnej anteny sceny. **Regresja:** zachowany digest starego pliku po zmianie geometrii, terminali i wag musi być odrzucony; zmiana wyłącznie amplitudy/przebiegu ma zachować bazę.

### F05 — P1 / Blocker: maska targetu działa za późno

**Pochodzenie:** nowa projekcja. **Dowód:** statyczny, niezależnie sprawdzony w dwóch zakresach audytu.

`load_solved_antenna_drive_basis_projected`, `antenna_field_solution.rs:543`, wymaga dopasowania próbek dla wszystkich `target_positions`, a maskę stosuje dopiero później, około linii 582. Materializacja przekazuje pełną `plan.mesh.nodes`. Tymczasem `resolve_field_sampling` legalnie obsługuje bazę obliczoną wyłącznie na siatce wskazanego obiektu.

**Scenariusz:** pole zapisane na węzłach magnesu, późniejszy shared FEM mesh zawiera dodatkowy airbox. Loader odrzuca brak próbki na węźle airboxu, chociaż maska wyłącza go z pobudzenia. **Naprawa:** wymagać próbek tylko dla aktywnego targetu, poza nim wpisywać zero. Osobno zachować jawne odrzucenie niewspieranej interpolacji. **Regresja:** obiekt + airbox, dwa obiekty i target region, w tym węzły na interfejsach.

### F06 — P2 / Required: walidator anten pomija waveform i activation

**Pochodzenie:** nowy `crates/fullmag-ir/src/antenna.rs`. **Dowód:** statyczny.

`validate_antenna_composition` i `validate_antenna_composition_v03` kontrolują referencje oraz skończoność prądu, ale pętle solved drives nie przechodzą przez kanoniczne sprawdzenia przebiegu i list stage IDs obecne dla regional drives w `validation.rs`. Konstruktor Python nie zabezpiecza wejścia JSON/API. Literówka identyfikatora etapu może bezgłośnie wyłączyć pobudzenie.

**Naprawa:** wspólna walidacja przebiegów, list etapów i zgodności z typem study dla obu kontraktów IR. **Regresja:** ujemna częstotliwość, niespójne próbki, puste/powtórzone/nieistniejące stage IDs oraz dynamiczne pobudzenie minimizera.

### F07 — P1 / Blocker użyteczności analizy: brak węzła nie oznacza punktu poza domeną

`sample_antenna_field_on_plane`, `crates/fullmag-runner/src/antenna_spectrum.rs:248`, przy `outside_policy=zero` zeruje dowolny punkt bez pasującej próbki. Carrier nie dostarcza tutaj interpolacji po elementach. Wewnętrzny punkt czworościanu zwykle nie jest węzłem; nie jest przez to poza domeną. Regularna płaszczyzna może dostać sztuczne zera, mimo że fizyczne pole jest tam niezerowe.

Notatka 0950 w sekcji 5.1.2 opisywała pierwotne ograniczenie punktowego carriera. W bieżącej gałęzi carrier może już publikować haszowaną topologię tet4, a sampler wykonuje P1 barycentric interpolation przez deterministyczne point-location BVH. Dla starszych assetów bez topologii pozostaje jawny tryb kompatybilności `identity_coordinates_v1`; nie jest on przedstawiany jako interpolacja FEM. Nadal otwarte są bezpośrednia ewaluacja RT0 na żądanej płaszczyźnie, mieszane topologie oraz pełne rozróżnienie stanów `unsupported_topology`/`missing_payload` w API.

**Wykonane w bieżącej gałęzi:** carrier zapisuje topologię tet4, loader weryfikuje jej digest i indeksy, a sampler wykonuje P1 barycentric interpolation z testem affine vector field. `outside_policy="zero"` działa wyłącznie dla punktu poza AABB carriera; punkt wewnętrzny bez elementu kończy się błędem. **Pozostaje:** bezpośrednia ewaluacja RT0, pełny status API (`missing_payload`/`unsupported_topology`) oraz kwalifikacja mieszanych topologii i obciążenia dużych siatek.

### F08 — P2 / Required: FFT i transformata bezpośrednia mają różne początki fazy

W `antenna_spectrum.rs` ścieżka regularna wykonuje `fft2_in_place` i skaluje współczynniki, natomiast bezpośrednia suma niejednorodna używa fizycznych współrzędnych zaczynających się od `-L/2`. Bez korekty początku regularne współczynniki różnią się fazą od obliczonych dla tej samej siatki falowej sumą bezpośrednią. Moduł kwadratowy może pozostać identyczny, więc test samych pików mocy tego nie wykryje.

**Naprawa:** ujednolicić początek i konwencję zespolonej amplitudy; zapisać je w proweniencji. **Regresja:** porównanie części rzeczywistej i urojonej dla pojedynczego przesuniętego źródła, włącznie z testem translacji i interferencji dwóch anten. Nie utożsamiać tego problemu z błędną osią k lub błędną mocą — wykazany problem dotyczy fazy.

### F09 — P1 / Blocker produktu: nowa antena nie ma zgodnego Inspectora i wyników

`canonicalSourceForObject` w `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts:138` rozpoznaje regionalną maskę lub legacy prescribed mask, nie nowe composition. Nowa komenda nie tworzy takiego pola, więc panel wpada w stan missing; `AntennaObjectPanel.tsx:188` blokuje Save. Explorer w `objectExplorerNodes.ts` nadal opisuje antenę jako „Zeeman mask” ze statusem „ready”.

Nie ma kompletnego przejścia przez port, solve, projection, waveform i wynik. `target_refs: []` w komendzie nie wiąże źródła z magnesem, a dedykowane projekcje i solved drives nie są tworzone. Ribbon „Antenna” prowadzi nadal do regionalnego field-drive stage. Ogólne viewporty nie zastępują obsługi nowych zasobów i ich aktualności.

**Naprawa:** najpierw F01, następnie osobne węzły i Inspectory conductor/material, terminals/port, field solution, projection, drive i spectrum. Status ready wyłącznie z opublikowanego i aktualnego wyniku. **Regresja:** przeglądarkowy scenariusz od pustej sceny do widocznego `H_ant` i odpowiedzi magnetyzacji, wraz z export/reload.

### F10 — P2 / Required: DTO bez generacji OpenAPI i semantycznych typów

Nowe pola `SceneResource` to `Vec<Value>`. W wygenerowanych plikach `apps/control-room/src/kernel/api/generated` nie ma odpowiadających im nowych kolekcji. Komenda czyta je przez ogólny `sceneArray(scene: unknown, key: string)`. Zachowany jest istniejący facade i command registry — problemem nie jest nielegalny bezpośredni fetch, lecz brak typowanego kontraktu i zasobów.

**Naprawa:** schematy oparte na kanonicznych typach, wygenerowany OpenAPI i klient, resource hooks oraz rewizje zależności. Testować odrzucenie nieprawidłowych referencji, ETag/304, invalidation i binary payloads zamiast rozbudowywania dowolnego JSON.

### F11 — P2 / Required: istniejący panel może zmienić eksperyment przy zapisie

**Pochodzenie:** odziedziczony dług, nie nowa regresja dirty diff. `draftWaveform` w `AntennaObjectPanelModel.ts:227` rekonstruuje sinusoidę z `phase_rad=0` i `offset=0`, a sinc z amplitudą 1. Edycja innego pola może nadpisać fazę wcześniej zaimportowaną z Python. `AntennaObjectPanel.tsx:57` wiąże draft z całą rewizją sceny, przez co niezwiązana zmiana sceny może resetować lokalne edycje.

**Naprawa:** zachowywać nieedytowane parametry, śledzić draft względem tożsamości targetu i konfliktów jego pól. Komenda dodania anteny odczytuje i zastępuje całe tablice bez `base_revision`; wymaga testu równoległej zmiany, żeby nie utracić innych obiektów lub transportów.

### F12 — P2 / Required: lifecycle jest zapisany, ale nie jest jeszcze pomiarem postępu

W `execute_synthetic_stage_action`, `crates/fullmag-cli/src/orchestrator.rs:6493`, status przechodzi przez meshing i solving_current do evaluating_field **przed** sprawdzeniem cache i uruchomieniem solve. Widzoczny jest końcowy rekord syntetycznego etapu, nie związanie każdego stanu z rzeczywistym callbackiem wykonania. Enum z `Cancelled`, `Stale` i `Degraded` sam nie dowodzi obsługi anulowania i invalidation.

**Naprawa:** stany emitowane przy rzeczywistych granicach pracy i przekazywane przez standardowy zasób wykonania stage; cache hit nie powinien sugerować ponownego meshingu. Testować failure, cancel, restart oraz ponowną publikację, a nie wyłącznie dozwolone przejścia enuma.

### F13 — P2 / Required: stały limit miliona par ogranicza rozmiar użytecznej anteny

`solve_native_fem_steady_transport_rt0` w `crates/fullmag-runner/src/native_fem/steady_transport.rs` przekazuje `maximum_source_target_pairs: 1_000_000` (około linii 1429). `DirectTetraQuadrature::EvaluateField` w `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp` sprawdza iloczyn liczby elementów i targetów przed podwójną pętlą. Już 1000 elementów przewodnika i 10000 punktów pola daje 10 milionów par i kończy się odrzuceniem. To arytmetyka limitu kodowego, nie zmierzony benchmark.

**Pochodzenie:** ograniczenie istniejącego operatora dziedziczone przez nowy workflow. Sam limit jest rozsądnym zabezpieczeniem referencyjnego kernela. Problemem jest brak wcześniejszej informacji i strategii dla typowej gęstej mapy pola. **Naprawa:** preflight kosztu przed solve prądu, jawny budżet globalny, blokowe przetwarzanie targetów dla kontroli pamięci/anulowania i raport czasu. Blokowanie nie zmniejsza całkowitej złożoności. Nie usuwać limitu bez benchmarku i nie zmniejszać po cichu gęstości mapy; dla większych zadań osobno kwalifikować przyspieszony operator.

(audit-python-api)=
## 6. Ergonomia Python i poprawność dokumentacji

Obecne cienkie obiekty referencyjne są lepsze od powielania geometrii, przewodności i pól w kilku strukturach. Jednak główny przykład w 0950 opisuje **target API**, nie aktualnie wykonywalny workflow: występują w nim między innymi `AntennaFieldSolve`, `FieldSamplingBox`, `CurrentTransport.charge_only`, nazwy `source_object` i `peak_current`. Bieżący kod udostępnia `AntennaFieldSolveStage`, `source_object_id`, `current_transport_id` i `peak_current_a`. Przykład ma także niezdefiniowane wcześniej geometrie i terminale.

`StudyStagesBuilder` w `packages/fullmag-py/src/fullmag/world.py` ma standardowe `add_run`, `add_relax`, `add_field_drive` i `add_frequency_response`, ale brak dedykowanej ścieżki `add_antenna_field_solve` oraz rejestracji nowych kolekcji. Nowy test kompozycji buduje niski poziom `Problem` i sprawdza JSON. To wartościowy test kontraktu, ale nie dowód ergonomicznego `fm.study(...).stages`.

**P2 / Required:** oddzielić przykłady planowanego API od wykonywalnych. Dodać jeden kompletny stage-first przykład oparty na rzeczywistej antenie z przewężeniem, bez ręcznego zgadywania hashy artefaktów. Referencja autora powinna wskazywać wcześniejszy stage/output, a runtime rozwiązywać ją do immutable asset/digest i zachowywać oba poziomy proweniencji.

Poniższy fragment jest celowo tylko wykonalnym audytem konstruktora referencji portu; nie wykonuje solve i nie deklaruje kompletnego problemu:

```python
# %% Audyt aktualnego kontraktu obiektu
import fullmag as fm

mode = fm.AntennaPortMode(
    id="cpw_mode",
    source_object_id="cpw",
    current_transport_id="cpw_charge",
    branches=(
        fm.AntennaPortBranch("signal", 1.0),
        fm.AntennaPortBranch("left_return", -0.5),
        fm.AntennaPortBranch("right_return", -0.5),
    ),
)
payload = mode.to_ir()
assert payload["normalization_current_a"] == 1.0
assert sum(branch["signed_weight"] for branch in payload["branches"]) == 0.0
```

(audit-problem-ir)=
### 6.1. Pełna tabela parametrów audytowanego fragmentu

Tabela dotyczy dwóch konstruktorów powyższego fragmentu, nie zastępuje brakującej pełnej referencji wszystkich klas antenowych w notatce 0950.

| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| `AntennaPortBranch.terminal_selector_ref` | `str` | required | $1$ | niepusty tekst; istnienie referencji sprawdzane w IR/plannerze | referencja terminalu | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].branches[].terminal_selector_ref` |
| `AntennaPortBranch.signed_weight` | `float` | required | $1$ | liczba skończona; bilans kontroluje port | podpisany udział gałęzi | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].branches[].signed_weight` |
| `AntennaPortMode.id` | `str` | required | $1$ | niepusty tekst | identyfikator portu | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].id` |
| `AntennaPortMode.source_object_id` | `str` | required | $1$ | niepusty tekst; istnienie sprawdzane w IR/plannerze | obiekt źródła | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].source_object_id` |
| `AntennaPortMode.current_transport_id` | `str` | required | $1$ | niepusty tekst; istnienie sprawdzane w IR/plannerze | właściciel transportu | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].current_transport_id` |
| `AntennaPortMode.branches` | `Sequence[AntennaPortBranch]` | required | $1$ | co najmniej dwie typed branches, suma wag w tolerancji 1e-12, oba znaki | jawny układ sygnału i powrotów | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].branches` |
| `AntennaPortMode.normalization_current_a` | `float` | `1.0` | $\mathrm A$ | dokładnie 1 A | normalizacja bazy | kontrakt wspólny; solve FEM CPU | `antenna_port_modes[].normalization_current_a` |

Kanoniczny JSON tego fragmentu:

```json
{"id":"cpw_mode","source_object_id":"cpw","current_transport_id":"cpw_charge","branches":[{"terminal_selector_ref":"signal","signed_weight":1.0},{"terminal_selector_ref":"left_return","signed_weight":-0.5},{"terminal_selector_ref":"right_return","signed_weight":-0.5}],"normalization_current_a":1.0}
```

W samej notatce 0950 tabela zawiera zaledwie część nowych parametrów, a checklista nadal mówi o braku implementacji konsumentów. Source map wymienia parametry widma, których nie ma w tabeli. Automatyczny walidator zwrócił cztery błędy dla `public_api.parameters[4]` i `[5]`: brak pełnych wierszy i mapowania Python → IR. Dokumentacja jest przydatną specyfikacją intencji, lecz nie zasługuje obecnie na etykietę kompletnej, wykonanej referencji API.

(audit-round-trip-and-failure-semantics)=
### 6.2. Intencja, rozwiązanie i błędy

`requested intent` powinno zachować geometrię, port, waveform i wybrany backend. `resolved execution` musi osobno opisywać faktyczny solver prądu, operator pola, projekcję, urządzenie i precyzję. Dotychczasowe manifesty i podpisy są dobrym początkiem, ale F04 pokazuje różnicę pomiędzy integralnością artefaktu a aktualnością intencji.

`validation errors` powinny wystąpić przed solve dla niepoprawnych referencji, znaków, etapów i parametrów waveform. `unsupported combinations` powinny być komunikowane już podczas planowania. Obecny jawny błąd CLI dla FDM/frequency response jest uczciwy, ale produktowo zbyt późny i pozostawia deklaracje/helpery bez dostępnego workflow.

## 7. Jak powinno wyglądać użyteczne doświadczenie użytkownika

Ocena projektu: **dwa odrębne wejścia są potrzebne** — „zadane pole regionalne” i „pole z przewodnika”. Wspólna nazwa „Antenna” bez wskazania modelu jest myląca. Nie trzeba tworzyć drugiej aplikacji ani osobnego drzewa dla FDM/FEM.

Docelowy ciąg pracy:

1. Użytkownik wybiera typ źródła i jego ograniczenia, tworzy sygnał oraz powroty; widzi jednostki i orientację lokalną.
2. Edytuje długość, grubość i stacje szerokości/gapów. Widzi minimalne wymiary i wymagania siatki, nie tylko box preview.
3. Wskazuje terminale i kierunki; interfejs pokazuje strzałki podpisanych prądów i kompletność zamknięcia.
4. Uruchamia jawny stage obliczenia bazy. Otrzymuje V, J, H/A, bilans prądu, normę reszt i raport zbieżności/ograniczeń.
5. Wybiera target: obiekt, region lub płaszczyznę. Podgląd pokazuje wektor, składowe i maskę; brak danych jest odróżniony od zera fizycznego.
6. Definiuje prąd i waveform z fazą oraz początkiem czasu; wybiera aktywne etapy. Zmiana waveform nie przelicza przewodnika.
7. Relaksuje bez domyślnego pobudzenia RF, uruchamia LLG, ogląda osobno `H_ant`, dynamiczne `m` i widmo odpowiedzi.
8. Eksportuje kompletny skrypt i artefakty z proweniencją, odtwarza je po restarcie.

`H_ant_basis` powinno mieć jawne jednostki na amper; ekran może pokazywać również `mu0 H` w mT, z poprawnym przeliczeniem. Wykres widma źródła nie może być podpisany jako dyspersja, S21 ani sprawność wzbudzenia. Całka modułów składowych pola w k-przestrzeni nie uwzględnia sama z siebie podatności, polaryzacji własnej modów, tłumienia i detekcji.

Wielkość pola na próbce i jego poprzeczność względem równowagi są użyteczne wskazówki, lecz pełna efektywność wzbudzenia wymaga sprzężenia modalnego/odpowiedzi LLG. W obecnym CLI `execute_antenna_spectrum_requests` przekazuje `None` jako equilibrium samples; samo wpisanie `equilibrium_ref` w żądanie nie oznacza więc dostarczenia równowagi do obliczenia komponentu transverse.

**Wybór z kompromisem:** najpierw stabilna baza DC i import zewnętrznego zespolonego pola albo od razu harmoniczny solver MQS. Pierwszy wariant szybciej domyka praktyczne badania LLG i pozwala porównywać z zewnętrznym RF; drugi daje większą wierność częstotliwościową, lecz znacznie powiększa numerykę i walidację. Rekomendacja: domknąć pierwszy wariant i jego granice, nie blokować użytecznego MVP pełnym Maxwellem.

## 8. Wpływ zmian master i strategia integracji

Wspólne 18 ścieżek obejmuje między innymi `orchestrator.rs`, `step_utils.rs`, plany FEM/FDM, meshing, definicje planu, frontendowe testy API, native regional Zeeman, runtime GPU i `justfile`. Ryzyko jest semantyczne, nie tylko tekstowe: oba zbiory zmian rozszerzają te same struktury i miejsca wykonania.

Konkretny przykład: master rozszerza `project_regional_field_drive_bases` o sprawdzenie nodal integration weights, dokładne globalne uniform field na mixed mesh i odrzucenie niewspieranych profili mieszanych. Dirty worktree dodaje w tym samym miejscu `PREPROJECTED_NODAL`, ale opiera się na starszej wersji. Skopiowanie całego pliku z worktree na master usunęłoby poprawki mixed-mesh; skopiowanie wersji master bez świadomego połączenia usunęłoby obsługę antenowej bazy. **To ryzyko przyszłej integracji, nie zarzut, że gałąź celowo usunęła późniejsze commity.**

Master zawiera również zmiany frozen spins i GPU/multilayer. Nowe pola planu anten nie mogą spowodować pominięcia constraints, maskowania RHS ani zmiany polityki wymuszonego GPU. Nie wykonano merge ani kompilacji po merge; nie ma podstaw do zapewnienia, że scalenie jest bezkonfliktowe.

Rekomendowana kolejność integracji:

1. Utrwalić bieżący zestaw anten jako samodzielny, identyfikowalny patch/commit z plikami nieśledzonymi i poprawić blokery kontraktu.
2. Połączyć z aktualnym master w osobnym kontrolowanym kroku, zachowując mixed-mesh i frozen-spins behavior.
3. Uruchomić najpierw kontrakty modeli, potem kontenerowe natywne testy, następnie runtime i browser.
4. Dopiero wtedy publikować macierz capability i status modułu. Nie promować feature na podstawie liczby nowych typów albo pozytywnego testu samego DTO.

(audit-validation)=
## 9. Wykonana weryfikacja i jej granice

| Kontrola | Wynik | Co rzeczywiście dowodzi |
|---|---|---|
| Git status, pełne SHA, merge-base, diff i inwentarz | Wykonane | Zakres roboczy i relacja do lokalnego master |
| `git diff --check` | PASS | Brak zgłoszonych problemów whitespace w diff śledzonym |
| `test_antenna_composition_contract.py` | 5 passed | Serializacja i wybrane walidacje Python composition |
| `test_current_transport.py`, `test_regional_field_drive.py`, `test_gaussian_plane_wave_antenna.py` | 32 passed, 19 subtests passed, 1 failed | Istniejące kontrakty Python; suite nie jest w całości zielony |
| Przyczyna failure powyżej | `FileNotFoundError: tests/vlad/4.5GHz_fem.py` | Brak fixture, nie wykazana regresja nowego solvera; pliku nie ma ani w HEAD, ani w lokalnym master |
| Source-map validator dla notatki 0950 | FAIL: 4 błędy | Brak pełnych wierszy/mapowania parametrów API |
| Source-map validator dla notatki 0980 | PASS | Poprawność kontrolowanej struktury i kotwic, nie fizyki |
| Source-map validator niniejszego raportu | PASS | Spójne odwołania do deklaracji kodu, tabela audytowanego API i struktura raportu |
| Wykonanie fragmentu Python i porównanie z JSON w raporcie | PASS | Przykład odpowiada obecnemu konstruktorowi i jego lowering |
| Testy walidatorów dokumentacji | 29 tests, OK | Testy narzędzia weryfikującego dokumenty |
| Native FEM build/runtime | Nie wykonano kwalifikacji | Brak dowodu natywnego solve/parity w tym audycie |
| Dry-run bramek `verify-fem-steady-transport-cpu-only-contract` i `verify-fem-charge-transport-abi-contract` | PASS, kod 0 | Poprawne rozwinięcie recipes; nie wykonanie testów |
| Vitest i browser nowej anteny | Nie wykonano | Brak lokalnego `node_modules/.bin/vitest.cmd`; nie instalowano zależności ani nie uruchamiano UI |

Polecenia Python wykonano z wyłączonym zapisem bytecode i cache pytest. Interpreter dla testów: `D:/fullmag-cache/contract-python/Scripts/python.exe`; `PYTHONPATH` wskazywał `packages/fullmag-py/src`. Walidatory dokumentacji wykonano istniejącym Pythonem 3.14.2 z katalogu uv użytkownika. Nie zmieniano kodu produkcyjnego, testów ani istniejącego wcześniejszego raportu audytowego.

Raport jest wewnętrznym Markdown w `docs/audits`, nie publikacją w Sphinx. Nie wykonywano renderowania publicznego manuala ani nie oznaczono notatki 0950 jako zaakceptowanej. Towarzysząca mapa źródeł dotyczy audytowanych twierdzeń i przykładu, a nie kwalifikacji wszystkich opisanych capabilities.

Odczytano repozytoryjny `justfile`. Właściwe nowe bramki to `just verify-fem-charge-transport-abi-contract` i `just verify-fem-solved-antenna-drive-contract`. Nie zastąpiono ich hostowym `cargo`/`cmake`. Ich obecność nie jest wynikiem PASS. Bez wykonania właściwego kontenerowego przebiegu i sprawdzenia artefaktów nie można kwalifikować native FEM ani GPU.

Odczyt Docker po ponowieniu poza sandboxem potwierdził Linux engine. Nie stwierdzono braku Dockera jako blokady; audyt nie uruchamiał kosztownego rebuilda ani runtime qualification.

### 9.1. Wymagane bramki przed użyciem naukowym

| Bramka | Minimalny dowód akceptacji |
|---|---|
| Port i prąd | Podpisane strumienie, bilans dla każdej składowej spójnej, orientacja i proporcje powrotów; wykrycie błędnych znaków |
| Przewodnictwo | Afiniczny pręt, kilka poziomów siatki, niejednorodna przewodność, zwężenie, odrębne przewodniki i gauge |
| Oersted | Skończony przewodnik/pętla z niezależnym rozwiązaniem odniesienia, symetrie, zmiana znaku, far-field i near-field |
| Zbieżność | Co najmniej trzy siatki i osobno zacieśnianie kwadratury; błędy L2/Linf pola na stałych punktach z dala od idealnie ostrych osobliwości |
| Artefakt | Save/load/restart, korupcja, atomowość, zmiana fizycznych zależności i poprawny reuse przy zmianie waveform |
| Projekcja | Constant/linear vector field, maski object/region, shared airbox, remesh, interpolacja i jawne outside-domain |
| LLG | Jednorodny benchmark precesji/FMR, liniowość małych amplitud, znak/faza, wszystkie wspierane RK i czas ich podetapów |
| Stages | FieldSolve → Relax bez RF → Run z RF, stage_local/global, aktywacja wybranych etapów, restart w środku workflow |
| CPU/GPU | Ten sam artefakt, statyczne H, waveform i krótka trajektoria; osobny dowód urządzenia i precyzji każdej lane |
| Widmo | Zgodność complex FFT/direct, okna i normalizacja, stałe pole, przesunięcie, aliasing i brak sztucznych zer |
| Benchmark spin-wave | CPW szeroka/przewężona, zgodność zmian widma źródła, odpowiedź m(k,omega) i niezależna dyspersja |
| UI | Prawdziwy backend, transakcja/export/reload, identyczność Inspector root, focus/scroll, brak niepowiązanego disabled/dimming, bounded requests |
| Viewport | Widoczny canvas, nieutracony WebGL context, niezerowy drawing buffer; osobna kontrola field-map lifecycle |

Tolerancje należy ustalić na podstawie analitycznego orakla, rozdzielczości i celu naukowego przed pomiarem, a nie dopasować po uzyskaniu wyniku. Nie wolno utożsamiać małej reszty liniowego solve z małym błędem pola ani parzystości pola z poprawną amplitudą.

## 10. Kolejność napraw i kryterium zakończenia

| Etap | Zakres | Warunek zakończenia |
|---|---|---|
| A — zachowanie modelu | F01, F02, F03, F04, F06 | Brak utraty semantyki; znaki, aktualność i stage activation mają negatywne testy |
| B — pole i projekcja | F05, F07, F08; zbieżność prądu/Oersted | Prawdziwe target mapping i zgodna faza; niezależny raport numeryczny |
| C — jeden pełny workflow | Stage-first Python, publikacja i ponowne wczytanie, FEM LLG | Wykonywalny skrypt conductor → basis → Relax → Run z wynikami |
| D — Control Room | F09–F12, typed API i resource hooks | UI tworzy i odtwarza ten sam eksperyment; browser regression |
| E — główna ścieżka produktu | FEM precompute → FDM CPU → FDM GPU, potem FEM GPU | Osobne gates transferu i trajektorii, bez silent fallback |
| F — rozszerzenia fizyczne | Harmoniczne/importowane zespolone bazy, później detekcja i porty | Osobne capability, równania, walidacja i proweniencja |

**Warunek pozytywnego ponownego audytu:** usunięte blokery cichej zmiany modelu/wyniku, wykonany co najmniej jeden kompletny workflow z reprodukowalnymi artefaktami, prawdziwy UI round-trip oraz macierz, która nie nazywa niewykonanych lanes gotowymi. Pełne Maxwell, S-parametry i dwukierunkowe sprzężenie nie są konieczne do sensownego MVP, jeśli granice przybliżenia pozostają jawne.

(audit-limitations)=
## 11. Ograniczenia audytu i prace odroczone

Nie przeprowadzono pełnego builda Rust/native, GPU parity, badań siatkowych, benchmarku publikacyjnego, pomiarów wydajności ani oględzin działającej przeglądarki. Ocena ergonomii wynika z kodu workflow i komponentów, nie z testu użyteczności z użytkownikami. Nie naprawiano wykrytych usterek, ponieważ zadaniem było przygotowanie audytu.

Nie stwierdzono na tej podstawie „wszystko jest fizycznie błędne”. Poprawne założenia są oddzielone od błędów implementacji, świadomych ograniczeń, długu zastanego i braków dowodowych. W szczególności brak wykonania testu oznacza „niezweryfikowane”, a nie „test nie przechodzi”. Stan plików nieśledzonych może zmienić się bez zmiany HEAD; dlatego same SHA commitów nie identyfikują audytowanego kodu i dołączono inwentarz hashy plików.

(audit-scientific-bibliography)=
## 12. Źródła naukowe

- **B1:** Höfinger i in., *k-Selective Electrical-to-Magnon Transduction with Realistic Field-distributed Nanoantennas*, [pełny tekst arXiv:2511.10346v1](https://arxiv.org/html/2511.10346v1). Źródło dla rozdzielenia wektorowego pola RF od odpowiedzi mikromagnetycznej; jego model harmoniczny jest bardziej rozbudowany niż baza DC tego worktree.
- **B2:** Gruszecki i in., *Microwave excitation of spin wave beams in thin ferromagnetic films*, Scientific Reports 6, 22367 (2016), [rekord i streszczenie arXiv](https://arxiv.org/abs/1509.05061), [DOI](https://doi.org/10.1038/srep22367). Źródło dla lokalnego dopasowania widma wzbudzenia; w audycie nie odtworzono obliczeń publikacji.
- **B3:** Haus i Melcher, *Electromagnetic Fields and Energy*, [MIT, rozdział 10.7: Skin Effect](https://www.mit.edu/course/6/6.013_book/www/chapter10/10.7.html), [rozdział 3: quasistatyka](https://web.mit.edu/6.013_book/www/chapter3/chap3.html). Źródło dla rozróżnienia stacjonarnego przewodnictwa i magnetoquasistatycznej dyfuzji pola.

(audit-implementation-mapping)=
(audit-source-code-index)=
## 13. Indeks źródeł implementacji

Numery linii w ustaleniach odnoszą się do audytowanej zawartości roboczej. Trwałą kotwicą jest para ścieżka + symbol. Hash pliku w inwentarzu uzupełnia brak immutable commita dla dirty zmian.

| Ścieżka | Symbol | Odpowiedzialność / dowód |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaPortBranch` | Podpisana referencja terminalu |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaPortMode` | Port i normalizacja |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class SolvedAntennaDrive` | Prąd, waveform, aktywacja |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaFieldSolveStage` | Publiczny obecny kontrakt solve |
| `crates/fullmag-ir/src/antenna.rs` | `validate_antenna_composition_v03` | Walidacja bieżącego IR |
| `crates/fullmag-ir/src/antenna.rs` | `validate_antenna_composition` | Walidacja nowszego kontraktu |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `plan_antenna_field_solve_v03` | Wybór solve, mesh i sampling |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `resolve_field_sampling` | Domeny próbkowania |
| `crates/fullmag-plan/src/antenna_projection.rs` | `resolve_fem_antenna_projection_mask` | Maska celu FEM |
| `crates/fullmag-plan/src/util.rs` | `field_drive_is_active` | Kanoniczna aktywacja regional field |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `measured_port_current` | Certyfikat prądu/normalizacja |
| `crates/fullmag-runner/src/antenna_stage.rs` | `antenna_field_solution_signatures` | Podpisy zależności |
| `crates/fullmag-runner/src/antenna_stage.rs` | `AntennaFieldStageState` | Lifecycle artefaktu |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `load_solved_antenna_drive_basis_projected` | Integralność i dopasowanie próbek |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `materialize_fem_solved_antenna_drive_parts` | Artefakt → plan FEM |
| `crates/fullmag-runner/src/antenna_fields.rs` | `drive_is_active` | Aktywacja anteny |
| `crates/fullmag-runner/src/native_fem.rs` | `pack_native_regional_field_drives` | Baza H/A → natywny Zeeman |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `sample_antenna_field_on_plane` | Sampling plane i outside policy |
| `crates/fullmag-cli/src/orchestrator.rs` | `attach_solved_antenna_drive_bases` | Publiczny hand-off i odrzucanie lanes |
| `crates/fullmag-cli/src/orchestrator.rs` | `execute_antenna_spectrum_requests` | Widmo z opublikowanego artefaktu |
| `crates/fullmag-authoring/src/scene.rs` | `SceneDocument` | Kanoniczny właściciel sceny |
| `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | `apply_scene_merge_patch` | Granica utraty nieznanych pól |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | `project_regional_field_drive_bases` | Native projection i nakładanie zmian master |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `main` | Natywny test kontraktu, nieuruchomiony w audycie |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `solve_charge` | Wykonanie stacjonarnego H1/P1 przewodnictwa; brak kwalifikacji runtime w audycie |
| `crates/fullmag-runner/src/antenna_fields.rs` | `dynamic_antenna_drive_terms` | Baza wektorowa na amper mnożona przez prąd i waveform |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | `regional_field_drive_energy` | Natywna energia Zeemana i wagi całkowania |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | Istniejący wrapper RT0/Oersted i limit liczby par |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp` | `class DirectTetraQuadrature` | Natywny właściciel adaptacyjnego pola 3D |

## 14. Inwentarz audytowanego zestawu roboczego

Poniższy inwentarz zostaje wygenerowany z Git i aktualnych bajtów plików. Nie obejmuje plików niniejszego raportu, utworzonych po ustaleniu zakresu. Kolumna „master” oznacza, że tę samą ścieżkę zmieniono także między HEAD i master; nie oznacza potwierdzonego konfliktu tekstowego.


| Plik | Status | master | SHA-256 zawartości |
|---|---|---|---|
| `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts` | M | — | `685083a320437023d13ad3257ae6911b231860a911c6b9c17473aaddc4788415` |
| `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts` | M | — | `636d0d7548b5c46d6e2f55443c2887fa1a6c4d2dc7e2b978a58623c7be91e865` |
| `backends/fem/CMakeLists.txt` | M | — | `4f37669c21a81bc3acfc172ebee50b666c302cd3dbf85935907fc220f8777fdc` |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | M | tak | `b1203b590ba7718bfb142756da817286ccbe9375ea83fc116073ecbbeab3135a` |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.hpp` | M | — | `f5fd0ef7993e1d219360fdebfa92e912f8e028015aa8fdffa2f113b45622a371` |
| `backends/fem/cpu/mfem/transport/steady_transport.cpp` | M | — | `36d8c839ba34aec96e189f6f157146eb8e8b68cbaedb82c8cc3c15fa29b8cff0` |
| `backends/fem/cpu/mfem/transport/steady_transport.hpp` | M | — | `91a49b177f11d5cb0a8737c9126d9351777d7f0de375e5dc2c9a14a0ee21e2b2` |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | M | — | `0afe2c2541fc63aacb7777f7ac5b3808605c76da2fad6ec14e2fdbdae146e793` |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | ?? | — | `c720a03aa225ee1e45fc074fe70e954854e816b7b3ef2bd910fd2b8b4e64f64a` |
| `backends/fem/tests/zeeman_contract.cpp` | M | tak | `4109cd3d803197781c3cffaf0e63624fa83b28748a290c4b2f0c6301b9b37d82` |
| `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | M | — | `34abe89afba06b53305610f0ffb085f4d55066a9fbd0bcd007867ab0e9647989` |
| `crates/fullmag-api/src/router_v2/tests.rs` | M | tak | `f0fac20cc0776115c2f78eb1c31a20dc7f8ec0798a48a61bd50d10de53a0f330` |
| `crates/fullmag-api/src/schemas/authoring.rs` | M | — | `e435ed06cbf2a3e679562ab0fd363e079398607fcd7b2c28fa33c7df190c5d06` |
| `crates/fullmag-authoring/src/builder.rs` | M | — | `3cf09bece155b87f688836bb0727a1a877d1f1faffd2da6ef5776eddf15db104` |
| `crates/fullmag-cli/src/main.rs` | M | — | `140f64e9c4a344440fc9c497df2282f52644dffbc6a5bb6dd07cfb7361446a79` |
| `crates/fullmag-cli/src/orchestrator.rs` | M | tak | `1495d20df3161548896f6db30e24fe3d0be26a8cd43b2f11cd85e7e2f4f57a74` |
| `crates/fullmag-cli/src/step_utils.rs` | M | tak | `a07961d9f933a4208908095a2e49eb43d7d26514e063dbdb7d4762bf1efaa09d` |
| `crates/fullmag-cli/src/types.rs` | M | — | `da401291fdd0bc50f28fc4712308159aa25abe08cae935954364eaaf81931c65` |
| `crates/fullmag-engine/src/fem.rs` | M | tak | `cbe0182717a6bf53753d3a7a97d3a8f701778ae2c64e56e0f07fcf9a84283907` |
| `crates/fullmag-fem-sys/src/lib.rs` | M | — | `8c03f26b354f3565e8e065281df2240b393f132a5200006768faebaf68ac2b6e` |
| `crates/fullmag-ir/src/antenna.rs` | ?? | — | `923a6eeb4581fe499a5d37ee3a08e42eb16e8b7afab50d00526a8367145a749a` |
| `crates/fullmag-ir/src/lib.rs` | M | — | `50804f33e53cda8258d5ca0d8791e8d32a5673a216eaabe6615b27394cdb9b65` |
| `crates/fullmag-ir/src/physics_object.rs` | M | — | `a3e1e6f8455b479d5e83a9233fb74a640dae3a73017305c4ffccc65d2a608b4f` |
| `crates/fullmag-ir/src/plan.rs` | M | tak | `39f6661ff21d6c4817de1fef6e86e89831cf52ca6f3116e4dd8952221ce6d338` |
| `crates/fullmag-ir/src/spin_transport.rs` | M | — | `6cfba1ddb8ecdd0c837efb1261898453b490f04c1eb1be357c406874fd1137c2` |
| `crates/fullmag-ir/src/validation.rs` | M | — | `175b9391721a8030ef9aed28dcd84283e2fd66aba8279349124703ed435770d6` |
| `crates/fullmag-ir/tests/antenna_composition_ir.rs` | ?? | — | `153c02dcff9590be13e9ca3a3dd6fb17c315a7598dff09d8e3a73b2d1c9957a4` |
| `crates/fullmag-plan/src/antenna_composition.rs` | ?? | — | `7894c29dd2aa515edcd522c71ad163c56f86235eb8f4abd191d587f5f608bd3d` |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | ?? | — | `35188f6a9c95a9f2250f4d2de818f1a959dc74fec75bdd2057810ea29e60e6ab` |
| `crates/fullmag-plan/src/antenna_projection.rs` | ?? | — | `ce3bc47f98406974c0648a3356e607642496abe9a12ad3cb500c4bbf83b3c69f` |
| `crates/fullmag-plan/src/current_transport.rs` | M | — | `4c1439a0953d97a3159e659f4f9d9358dc0d93c259bbd49b9196d3d8c66382aa` |
| `crates/fullmag-plan/src/fdm.rs` | M | tak | `b1f629f1b53911eb01c7b45c77f04cb1dd9c8342478286f20c921263b232e08f` |
| `crates/fullmag-plan/src/fem.rs` | M | tak | `87da84761935e577c5b472f1b98438d6d15d23c8b8cc73b9f34206c151cbcdfb` |
| `crates/fullmag-plan/src/lib.rs` | M | — | `9be5ba9738912caff3725fc2198df9dd2299872b50d876802b354bb2931ee979` |
| `crates/fullmag-plan/src/mesh.rs` | M | tak | `0786d65ec1c2d2e807c6ae30ccd80d760ad680b9e9f1a31b8a17cafaae7441a3` |
| `crates/fullmag-plan/src/oersted.rs` | M | — | `857827f8d2907ecd7bae9e3affe23bfbd6bfe86ad18ecf67a1fa2083cbcb4e71` |
| `crates/fullmag-plan/src/spin_transport.rs` | M | — | `e2125b116ae6f5da5f62ec4fa132f023f9386d3c579c5f6e467e9ea062086e1c` |
| `crates/fullmag-plan/src/surface_selectors.rs` | M | — | `64647e89bf8aeae06b18261758715d8ef1f4310e09b69f7ab1b08f1c2d4e12f8` |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | ?? | — | `1f3c68b1b8d64d602915d40239d26b4a8526cfaea2359e8ebef26636decdadac` |
| `crates/fullmag-runner/src/antenna_fields.rs` | M | — | `b2a2386cf555d94d07b152af76b439d71c6f79c2db3a8fb211930225b1870361` |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | ?? | — | `136ab8a77b62f6f7887790c51374b48b5a3f5d4222d134ba9d8c1de51aa72d20` |
| `crates/fullmag-runner/src/antenna_stage.rs` | ?? | — | `b461ec76b598f3f2426bd1997195c79ebf6abb1d10ccb0f133a458568e1531ec` |
| `crates/fullmag-runner/src/artifacts.rs` | M | — | `41bde397c9a9c8b067747f4ee03497eba72342a6f18b2ed8822bd4d34bd9cfc4` |
| `crates/fullmag-runner/src/dispatch.rs` | M | — | `cdd73d39bae562268ac426c5370d31e3fbf8120451ec2cef0d8bac1ef066a1ce` |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | M | — | `9ea588867c8ff0d7006cf4e824e1c0d96fe64f3c41c32966ce746268fb461a4a` |
| `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs` | M | tak | `44b8155140902bf9865f859372326b1de596e9c25c0283fc31d63dddff5e72a3` |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | M | tak | `adaa13860b59a0cfb80c63aa7dd6fff34a5c5446743e46960a976c79ab9d6a2d` |
| `crates/fullmag-runner/src/fem/runtime_contract.rs` | M | — | `7abd340c33d388d2d5709ad6fa3ff3da5d3cf57b1e0f54a6db8e493942aa19e2` |
| `crates/fullmag-runner/src/fem_reference.rs` | M | tak | `26470718486c9e2024b215a5a75ecd4e3a4d18498bc8469a78d284e970ddc787` |
| `crates/fullmag-runner/src/fem_reference/tests.rs` | M | — | `c0ceb659d6bd9776bbc626ad913bde0b2614b85dc5161000df02d0a663afe388` |
| `crates/fullmag-runner/src/frequency_response.rs` | M | — | `4b51a7dd595bac5eb0669bffab4d1c54c0fd1567a7276ea40047016c3a67ca07` |
| `crates/fullmag-runner/src/hysteresis.rs` | M | — | `6f8d6cd22ce777c96b6722204f163fd4d9c4ac59d6f01100c3be6931a02f3535` |
| `crates/fullmag-runner/src/interactive_runtime.rs` | M | tak | `48a3dfc0f74683813f48cfd86dff1bc8c90257126c2d5de76478b0c85a3bfa33` |
| `crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs` | M | — | `6383e9471222344e7cd4ab86d3abc75326a5bd2a8e5b91dbe24aae2eeb979329` |
| `crates/fullmag-runner/src/lib.rs` | M | tak | `691abaad46166909e344e4ee8456d1e1926a5a02bf5c2dc2417abc6c8ab43c46` |
| `crates/fullmag-runner/src/native_fem.rs` | M | — | `389f8e993f7116d47e2852de69378dd2399daf243b8bd2a62b2eac6caa7be810` |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | ?? | — | `e0d83b7e0ec3e712ccdf181745ca90fdcea43aa31e9b89cc425ff41ae1d2293c` |
| `crates/fullmag-runner/src/native_fem/tests.rs` | M | — | `e33d125cf52c8430d0b2bfa7210fb83ae270b9ad8a409870ee21d03338e0e9dd` |
| `crates/fullmag-runner/src/physics_graph_execution.rs` | M | — | `861964ac1b48816b1aba17f41a268fe6152d7d44c337f0a45eb347eb3f4c7ff6` |
| `crates/fullmag-runner/src/quantities.rs` | M | — | `cfd78a4aea02fb2efe12df846c898e59e65944a96dbd4cec93bbbb0610420d88` |
| `crates/fullmag-runner/src/types.rs` | M | tak | `545c342496b527f74e6b44a4e884d016c6dba7ed888507318f46ebe368c662ac` |
| `docs/adr/0017-staged-antenna-field-basis-workflow.md` | M | — | `d178f31341d8a99d813a109143c04c286f12623ce98d8b7d66b73eafbc9a90ce` |
| `docs/audits/2026-08-24-microwave-antenna-module-production-audit-and-remediation-plan.md` | ?? | — | `995495bfe78e11cd77d0a89322df03d477534fe5a4953039875ec80019fcb7e7` |
| `docs/audits/2026-08-24-microwave-antenna-module-production-audit-and-remediation-plan.source-map.json` | ?? | — | `9c473dd2dfc01d2de15c61347bf73c280973c72b384015b76355c430670f870a` |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | M | — | `eab4f650c64fc710c17e39733f4fba872e16d8bdf62c6472ae90d11ebe3846c6` |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json` | ?? | — | `a45a635b17cb337ff5c239ddc4275a76f581c01d44be8b839599296142816082` |
| `docs/physics/0980-dynamic-current-and-oersted-coupling.md` | M | — | `af690652b2aa20fc09486027e8fd1b203e70108ebf9916cb3683ed9f01e78378` |
| `docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json` | M | — | `59d03d85cac3f01dad74361aef59f301b84b152a71968b10586a8bcedd68e30b` |
| `docs/specs/problem-ir-v0.md` | M | — | `0965bdde5605a5ce5f159be4771b09970af5d670b484823a96b23e24cf3f69c0` |
| `justfile` | M | tak | `cd9bf516d122f287c0c894b4de79cce54889a82689740e560c4388393ad7bba2` |
| `native/include/fullmag_fem.h` | M | — | `ebb7291f6bc290a07d027cf29eda4c8af9c0ad4ace448e8e8c48b5265446c5b1` |
| `packages/fullmag-py/src/fullmag/__init__.py` | M | — | `3bb67366fe303bbd5f01c68230f672a9ca2ec6d7ef70b3cf21434ae19c359f37` |
| `packages/fullmag-py/src/fullmag/model/__init__.py` | M | — | `0af1c466cc919dfd4766aaed53c70d0be4304df7333c6121fb9181a2a3cbbd0d` |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | M | — | `a0a5b19e7b0ded7fd0933029fcb0b89e597288717c1df39519db66aae3fb2dd5` |
| `packages/fullmag-py/src/fullmag/model/physics_scope.py` | M | — | `338e083f54071ff13fa100dfea4a765d07152be8391edf44acc6fe2bd61780fb` |
| `packages/fullmag-py/src/fullmag/model/problem.py` | M | tak | `05a9dc4efcda3a92d61b209738301c3fca1fe5826d697adf92e7ddc97f64f2a3` |
| `packages/fullmag-py/tests/test_antenna_composition_contract.py` | ?? | — | `4f4cf269b7e3fa2591f99eaeb0af172a3bb1e408579f6362d3905891c654d5bc` |
