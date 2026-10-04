# 05. Czy ten plan doprowadzi UI do poziomu COMSOL / CST?

Odpowiedź krótka: **tak w warstwie, która o tym decyduje — czyli w modelu danych i własności
zasobów — ale plan nie zawiera kilku rzeczy, bez których interfejs nadal nie będzie się tak
zachowywał.** Poniżej rozbite na to, co plan załatwia, czego mu brakuje i co konkretnie
dopisać.

---

## 1. Dlaczego problem UI Fullmaga nie jest problemem UI

Warto to powiedzieć wprost, bo determinuje całą resztę. Trzy zachowania, które najbardziej
odróżniają dziś Fullmaga od COMSOL-a, **nie dają się naprawić w warstwie React**:

1. **Nie można otworzyć programu bez sesji.**
   `apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx:17-28` — gdy
   `sessions.state === "no-session"`, cała powłoka jest zastąpiona przez `EmptyWorkspace`,
   którego jedyną treścią jest przycisk „Create simulation”
   (`EmptyWorkspace.tsx:16-25`). Nie ma drzewa modelu, nie ma „Open”, nie ma niczego.
   COMSOL otwiera się na pustym Model Builderze i pozwala pracować godzinami bez solvera.

2. **Nie można zapisać, czego się nie policzyło.**
   Wszystkie 12 endpointów persystencji leży pod `/v2/sessions/current/persistence/*`
   z odpowiedzią `404 "No active workspace"`
   (`crates/fullmag-api/src/router_v2/handlers/persistence/session.rs:22-217`).

3. **Edycja modelu zabija liczenie.**
   `crates/fullmag-cli/src/scratch_runtime.rs:137-152` — zmiana `scene_revision` to utrata
   własności runtime'u i `terminate_child`. A rewizja jest podbijana **bezwarunkowo przy
   każdym PUT sceny**, także przy zmianie samego stanu edytora
   (`crates/fullmag-api/src/main.rs:3947-3953`).

Żadnego z tych trzech nie da się „obejść lepszym layoutem”. Plan to rozumie i dlatego
atakuje własność danych, a nie kosmetykę. To jest jego największa zaleta i główny powód,
dla którego uważam go za zasadny.

---

## 2. Co plan załatwia dobrze — mapowanie na wzorce COMSOL/CST

| Wzorzec COMSOL / CST | Odpowiednik w planie | Ocena |
|---|---|---|
| Trwały plik projektu (.mph / .cst) otwierany bez solvera | `ProjectDefinition` + rozwinięcie `.fms` (§20, K14), `can_save ≠ can_compute` (§7.1) | Pełne pokrycie |
| Global Definitions: parametry z jednostkami, funkcje, biblioteki materiałów | §7, K05 — AST wyrażeń, wymiar fizyczny, zakresy, wersjonowane materiały | Pełne pokrycie |
| Geometry sequence z Build Selected / Build to Selected / Build All | §8.1 — `GeometryFeature` z ID, referencjami wejść i nazwanymi wyjściami | Pełne pokrycie (z zastrzeżeniem o braku `Rotate`/`Scale` w IR) |
| Selekcje semantyczne przeżywające zmianę geometrii | §8.3 — certyfikat selekcji, jawna ambiguity, narzędzie naprawy | Pokrycie + uczciwe ograniczenie („nie obiecujemy nieomylnego śledzenia”) |
| Mesh jako receptura, wiele receptur na jeden model | §10, `DiscretizationDefinition` vs `DiscretizationArtifact` vs `FunctionSpaceDescriptor` | Pełne pokrycie; mocniejsze niż w COMSOL-u (jawny rozdział trzech pojęć) |
| Study 1 → Study 2 z wejściem z poprzedniego rozwiązania | §11, K06 — typowane porty, `StepOutput(step_id, output_port, case_mapping)` | Pełne pokrycie; `case_mapping` jest dobrym uzupełnieniem |
| Solver configuration jako osobne, edytowalne drzewo | §12 — authored intent / resolved plan / executed receipt | **Lepsze niż COMSOL** — trójpodział jest rzadko spotykany i bardzo wartościowy |
| Results: Solutions → Datasets → Plot Groups → Tables | §19, K12 | Pełne pokrycie |
| Obliczenia w tle, UI interaktywne | §16, §17, P5 | Pokrycie w warstwie kontraktu |
| Porównywanie wyników dwóch badań | §19.5, CAE-40 | Pokrycie, z jawnym wymogiem projekcji |

Dodatkowo plan ma dwie rzeczy, których COMSOL/CST **nie mają** i które są dla fizyki
mikromagnetycznej wartością samą w sobie:

- **`EquilibriumEvidence` i rozdział „succeeded” od kwalifikacji naukowej** (§11.2, K08).
  To jest dokładnie ten błąd, na którym wykłada się większość narzędzi badawczych.
- **Rozróżnienie `not_recorded` / `not_applicable` / `not_yet_computed` / `unavailable
  on lane` od zera fizycznego** (§19.3, CAE-39).

---

## 3. Czego w planie brakuje, żeby UI **zachowywało się** jak COMSOL

To są rzeczy, których nie da się wyprowadzić z kontraktów danych, a które użytkownik
odczuwa jako „to jest profesjonalne narzędzie” albo „to jest skrypt z formularzem”.

### 3.1. Brak modelu **stanu prezentacji wyniku, który przeżywa odmontowanie modułu**

Plan ma `ViewDocument` i `WorkspaceState` (§5, §23.3), ale nie mówi, **gdzie one żyją**
i co się z nimi dzieje, gdy moduł jest odmontowany.

To nie jest detal. ADR-0016 (accepted) **nakazuje** odmontowywać nieaktywną powierzchnię
3D, a strażnik `apps/control-room/scripts/audit-viewport-main-tab-memory.mjs:397-408`
tego pilnuje. Skoro moduł znika, to kamera, `OrbitControls`, aktywna warstwa, wybrany
przekrój i wybrany komponent **muszą być przechowywane poza modułem**, inaczej każdy powrót
na zakładkę 3D resetuje widok — i to jest realna skarga, którą raport Gemini błędnie
próbuje rozwiązać przez utrzymywanie kanwy.

**Do dopisania w §23.3 i K12:**
> `ViewDocument` jest zasobem o cyklu życia projektu/widoku, nie modułu. Zawiera kamerę,
> tryb manipulacji, aktywne warstwy, wybrany dataset, przekrój, komponent i paletę.
> Montowanie i odmontowanie powierzchni renderującej nie zmienia `ViewDocument`;
> odmontowanie zwalnia wyłącznie zasoby GPU i subskrypcje. Powrót na powierzchnię odtwarza
> widok z `ViewDocument` i z cache'u zasobów, bez ponownego pobierania topologii po sieci.

To jednocześnie spełnia ADR-0016 i usuwa faktyczny problem UX.

### 3.2. Brak warstwy „Messages / Progress / Tasks” jako pierwszorzędnego obywatela

§23.1 wymienia `Operations | Problems | Log | Data / Results browser` w dolnym pasku,
a §23.5 opisuje `Problems`. To za mało jak na zamiennik pełnoekranowego modala.

W COMSOL/CST długie zadanie jest widoczne w **trzech miejscach naraz**: pasek stanu,
panel Progress z możliwością anulowania, oraz **ikona przy konkretnym węźle drzewa**.
Trzeci z tych elementów jest kluczowy, bo wiąże postęp z miejscem w modelu.

**Do dopisania w §23.2:**
> Każdy węzeł drzewa, który może być producentem artefaktu (cecha geometrii, receptura
> dyskretyzacji, krok study, run), prezentuje własny stan przygotowania i wykonania:
> `absent / building / available / failed / blocked` wraz z odsyłaczem do zadania.
> Stan węzła pochodzi z dziennika wykonania, nie z globalnego „ready”. Brak stanu na węźle
> nie jest stanem „gotowy”.

### 3.3. Brak jawnego kontraktu na „co pokazuje viewport, gdy zaznaczę węzeł X”

`raport_gemini/04-…md` §5.4 opisuje to dobrze (kontekstowe adaptery renderowania) i jest to
jedyne miejsce, gdzie ten raport dodaje wartość, której plan nie ma. Plan mówi tylko
„jeden wspólny `Viewport3D` z adapterami domenowymi” (§23.3).

**Do dopisania jako tabela w §23.3:**

| Zaznaczony węzeł | Co pokazuje wspólny viewport | Czego nie robi |
|---|---|---|
| Cecha geometrii | bryły półprzezroczyste, podświetlona cecha, gizmo | nie buduje meshu |
| Selekcja / region | podświetlony zbiór + kardynalność z certyfikatu selekcji | nie zmienia selekcji przez „najbliższą ścianę” |
| Receptura dyskretyzacji | krawędzie siatki / linie gridu + miary jakości adekwatne do metody | nie pokazuje jakości tetraedrów dla FDM |
| Moduł fizyki / źródło | zakres działania (scope) i kierunek wymuszenia | nie renderuje wyniku |
| Solution / Dataset / Plot | dane z przypiętego datasetu | nie przejmuje widoku przy live update innego runu |

Ostatni wiersz odpowiada scenariuszowi **CAE-43** i jest, moim zdaniem, najczęstszym
źródłem pomyłek naukowych w narzędziach tej klasy.

### 3.4. Brak „efektywnej konfiguracji” i provenance override w UI

ADR-CAE-05 mówi: *„UI musi pokazywać efektywną konfigurację i override provenance”* —
i to jest jedyne miejsce, gdzie to pada. W §12 są trzy warstwy (authored / resolved /
executed), ale nie ma wymogu ich **jednoczesnej prezentacji**.

W COMSOL-u wartość w polu solvera zawsze niesie informację „domyślna / zmieniona przez
Ciebie / wymuszona przez study”. Bez tego użytkownik nie wie, dlaczego jego tolerancja
nie zadziałała.

**Do dopisania w §12:**
> Inspektor konfiguracji pokazuje przy każdej wartości jej pochodzenie: preset, nadpisanie
> użytkownika, nadpisanie study/case albo rozstrzygnięcie plannera. Wartość rozstrzygnięta
> różniąca się od zapisanej intencji jest widoczna zawsze, nie tylko po rozwinięciu
> szczegółów. `Executed receipt` jest dostępny z poziomu runu bez otwierania logu.

### 3.5. Brak wymogu, by drzewo było **jedynym** miejscem dodawania encji

To brzmi banalnie, a jest decydujące dla „poczucia COMSOL-a”. Dziś w Fullmagu istnieje
`sceneModelTreeAdapter.ts` (1 101 linii) tłumaczący `SceneResource` na drzewo — czyli
drzewo jest **projekcją**, a dodawanie encji dzieje się gdzie indziej. Plan zakłada
`ProjectModelTree` jako projekcję definicji, ale nie stawia wymogu odwrotności.

**Do dopisania w §23.2:**
> Każda encja modelu jest tworzona, duplikowana, wyłączana i usuwana z poziomu drzewa
> (menu kontekstowe lub wstążka kontekstowa węzła nadrzędnego). Powierzchnie alternatywne
> (viewport, formularze, skróty, Python) wykonują tę samą komendę domenową. Nie istnieje
> encja, którą da się utworzyć wyłącznie poza drzewem.

To jest warunek spełnienia CAE-44 („menu, ribbon, shortcut i Python wykonują tę samą
akcję”) w praktyce, a nie tylko w kontrakcie.

### 3.6. Brak jednostek prezentacji w kontrakcie UI

§7 punkt 6 mówi: *„Display units nie zmieniają równania”* — dobrze. Ale nigdzie nie ma,
**gdzie** display unit jest przechowywany. Jeśli w `ViewDocument`, to jest per-widok;
jeśli w definicji parametru, to zanieczyszcza model. COMSOL trzyma to jako preferencję
modelu z możliwością nadpisania per pole.

**Do rozstrzygnięcia w K05:** display unit jest atrybutem prezentacji parametru,
przechowywanym razem z definicją (bo użytkownik oczekuje, że `120[nm]` pozostanie `nm`
po ponownym otwarciu), ale **nie wchodzi do fingerprintu** — zmiana jednostki prezentacji
nie unieważnia żadnego artefaktu.

---

## 4. Czego plan świadomie nie obiecuje — i słusznie

Odnotowuję, bo to jest odpowiedź na pytanie „czy zbliży do COMSOL/CST”, a różnica między
„zbliży” a „dorówna” jest tu uczciwie postawiona:

- **Jądro CAD (B-Rep, STEP, Parasolid).** §8.2: *„Nie budujemy własnego jądra CAD od zera
  w ramach naprawy architektury.”* Zgadzam się. Dziś `GeometryEntryIR` ma prymitywy,
  falowody, CSG i `Translate` — do poziomu geometrii COMSOL-a brakuje bardzo dużo,
  a to jest osobny produkt, nie osobna faza.
- **Model Manager klasy enterprise, uprawnienia wieloorganizacyjne, współedycja.** §24.
- **Pełny multiphysics.** §9 opisuje porty i wymagania sprzężeń, ale wprost mówi, że
  dostępność kroku wynika z rejestru capabilities, nie z obecności w tabeli (§11).
- **Automatyczna optymalizacja, adjoint, modele zastępcze.** §11.4 — „porty są
  przewidziane, implementacja nie jest domniemana”.

Ta powściągliwość jest zaletą dokumentu, nie jego brakiem. Plan, który obiecywałby
dorównanie COMSOL-owi w jednej refaktoryzacji, byłby niewiarygodny.

---

## 5. Co realnie zobaczy użytkownik po każdej fazie

Przydatne do rozmowy z zespołem — plan tego nie zawiera, a warto:

| Faza | Co użytkownik zauważy | Czego jeszcze nie |
|---|---|---|
| P0 | nic | — |
| P1 | Program otwiera się bez sesji. Można stworzyć projekt, dodać bryłę, zapisać, zamknąć i otworzyć — bez GPU i bez solvera. | Parametry nadal bez jednostek; brak Undo; solver nadal zabijany przy edycji podczas liczenia. |
| P2 | `120[nm]` w polach, zależna geometria, Undo/Redo, drafty w inspektorze z Apply/Revert. | Studies nadal globalne. |
| P3 | Dwa badania na jednym modelu, osobne konfiguracje solvera, historia runów. | Edycja podczas liczenia nadal ryzykowna. |
| P3a *(propozycja)* | Brak — zmiana wewnętrzna. | — |
| P4 | Build Geometry / Build Grid / Build Mesh / Compute jako cztery różne przyciski; błąd meshu nie odbiera edytora. | — |
| **P5** | **Punkt zwrotny:** można edytować model podczas liczenia; brak modala; live steering z ACK. | Wyniki nadal efemeryczne. |
| P6 | Katalog Solutions/Datasets/Plots; otwarcie starego wyniku bez solvera; porównanie dwóch runów. | — |
| P7 | Kilka projektów w kartach; histereza z kontynuacją; kolejka runów. | — |
| P8 | Usunięcie pozostałości; deklaracja kwalifikacji. | — |

**Wniosek praktyczny:** pierwszy moment, w którym użytkownik powie „to jest inny program”,
to **P1** (otwiera się bez sesji, zapisuje niekompletny model), a drugi — **P5**
(edycja podczas liczenia). Warto to zakomunikować, bo P2–P4 to trzy fazy bez widowiskowego
efektu, a plan nie mówi tego wprost i łatwo w tym miejscu stracić poparcie dla prac.

---

## 6. Ocena końcowa w tym wymiarze

**Czy plan pozwoli poprawić UI prawidłowo, produkcyjnie i profesjonalnie?**
Tak. Wszystkie trzy blokady strukturalne (brak projektu, persystencja przypięta do sesji,
zabijanie runtime'u przez rewizję sceny) są zaadresowane u źródła, a nie obejściem.

**Czy zbliży Fullmaga do workflow COMSOL/CST?**
Tak, do poziomu, który uznałbym za „ten sam gatunek narzędzia”: Model Builder z
parametryzacją, niezależne Studies z portami, osobne konfiguracje solvera, trwałe Results.
Nie do poziomu równorzędności funkcjonalnej — i plan tego nie twierdzi.

**Pod jakim warunkiem?**
Pod warunkiem dopisania sześciu rzeczy z §3 tego dokumentu (stan prezentacji przeżywający
unmount, stan per węzeł drzewa, kontrakt „co pokazuje viewport dla zaznaczenia”,
provenance efektywnej konfiguracji, drzewo jako jedyne miejsce tworzenia encji, miejsce
przechowywania display units) — oraz **odrzucenia rekomendacji z raportu Gemini dotyczącej
`ViewportTabHost`**, która w obecnym brzmieniu łamie ADR-0016 i istniejący audyt pamięci.
