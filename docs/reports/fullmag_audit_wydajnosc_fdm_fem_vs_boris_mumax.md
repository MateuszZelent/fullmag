# Fullmag — audyt architektury i wydajności obliczeniowej FDM/FEM
## Porównanie do Boris i MuMax/MuMax3 oraz plan koniecznego refaktoru architektonicznego

**Autor opracowania:** OpenAI  
**Data:** 2026-03-27  
**Repozytorium analizowane:** `MateuszZelent/fullmag`  
**Zakres:** pełna architektura produktu i runtime, w szczególności ścieżki FDM i FEM, wąskie gardła wydajnościowe, ryzyka skalowania, konsekwencje projektowe oraz rekomendacje refaktoryzacyjne

---

## Spis treści

1. Executive summary  
2. Cel audytu  
3. Metodologia  
4. Kontekst porównawczy: co robią MuMax i Boris inaczej  
5. Aktualna architektura Fullmaga  
6. Ścieżka danych i sterowania: Python → IR → planner → runner → backend → UI  
7. Audyt FDM: gdzie dziś Fullmag będzie przegrywał wydajnościowo  
8. Audyt FEM: gdzie dziś Fullmag będzie przegrywał wydajnościowo  
9. Problemy przekrojowe: rzeczy, które spowalniają jednocześnie FDM i FEM  
10. Największe słabości wydajnościowe — ranking krytyczności  
11. Dlaczego półśrodki nie wystarczą  
12. Dlaczego refaktor trzeba wykonać teraz, a nie później  
13. Architektura docelowa — rekomendacja strategiczna  
14. Proponowany program gruntownego refaktoru  
15. Docelowa architektura FDM  
16. Docelowa architektura FEM  
17. Telemetria, snapshoty, UI i artefakty — jak przestać sabotować solver  
18. Plan migracji etapowej bez utraty kontroli nad poprawnością  
19. Lista decyzji architektonicznych, które trzeba podjąć jawnie  
20. Aneks A — szczegółowa analiza kodu  
21. Aneks B — benchmarki, które trzeba wprowadzić  
22. Aneks C — pytania decyzyjne dla maintainera  
23. Wnioski końcowe  
24. Źródła

---

## 1. Executive summary

Najważniejszy wniosek z całego audytu jest prosty i jednocześnie bardzo mocny:

> **Fullmag ma dziś dobrą architekturę semantyczno-produktową, ale jeszcze nie ma architektury solverowej, która mogłaby realnie konkurować wydajnością z MuMaxem lub Borisem.**

To nie jest krytyka jakości projektu jako takiego. Wręcz przeciwnie: Fullmag ma bardzo rozsądny podział na warstwę opisu problemu (`ProblemIR`), planowanie backendu, wykonanie oraz frontend sterujący. To jest bardzo dobre jako fundament produktu, platformy i długofalowego systemu. Problem polega na tym, że taka architektura jest dobra dla **zarządzania złożonością produktu**, ale nie jest jeszcze dobra dla **maksymalizacji wydajności numerycznej**.

W praktyce oznacza to, że:

- **MuMax/MuMax3** są projektami GPU-first i finite-difference-first: ich gorąca ścieżka wykonania jest ekstremalnie skupiona na tym, żeby jak najtaniej wykonać operator pola efektywnego i krok czasowy na regularnej siatce.  
- **Boris** idzie dalej w stronę silnika multiphysics, ale nadal jego przewaga bierze się z bardzo agresywnej integracji solverów, akceleracji GPU, własnych ścieżek wielofizycznych oraz spójnego jądra obliczeniowego.  
- **Fullmag** ma dziś część tych idei, ale gorący loop solvera nadal jest obciążony decyzjami projektowymi odziedziczonymi po referencyjnej, walidacyjnej i produktowej architekturze: kopiowanie danych host↔device, mieszanie ścieżek referencyjnych z docelowymi, bootstrapowy demag FEM przez transfer-grid FDM, AoS na granicy runtime, callbacki i snapshoty osadzone blisko wykonania, oraz zbyt duża zależność natywnego backendu od CPU-owej logiki przygotowawczej.

### Najważniejsze tezy audytu

1. **Największym problemem Fullmaga nie jest pojedyncza wolna funkcja, tylko brak bezwzględnego oddzielenia architektury produktu od architektury hot path solvera.**
2. **CPU reference engine jest zbyt silnie obecny w kształtowaniu dataflow całego systemu.** To dobry punkt odniesienia fizycznego, ale zły wzorzec organizacji pamięci i pipeline’u wykonania.  
3. **FDM CUDA nie jest jeszcze naprawdę end-to-end GPU-native.** Demag kernel spectra są przygotowywane po stronie CPU i przekazywane do backendu. To jest rozwiązanie bootstrapowe, nie końcowe.  
4. **FEM jest obecnie wydajnościowo najsłabszym miejscem całego systemu**, bo jego demag nie jest mesh-native, tylko opiera się na transfer-grid/FDM bootstrap, a sam backend GPU ma jeszcze charakter bardzo wczesny.  
5. **UI/live callbacks/output scheduling** są dziś zbyt blisko solvera. To bardzo łatwo zniszczy wydajność i zabije skalowanie interaktywnych sesji.  
6. **Jeśli teraz nie zostanie wykonany głęboki refaktor pamięci, operatorów i sesji wykonawczych, późniejsza zmiana stanie się wielokrotnie droższa**, ponieważ obecny model zostanie „zacementowany” przez frontend, API, testy regresyjne, formaty artefaktów i oczekiwania użytkownika.

### Najważniejsza rekomendacja strategiczna

Fullmag powinien przejść z modelu:

> „platforma produktu z backendami solverowymi”

na model:

> „ultra-lean solver core z osobną warstwą orkiestracji produktu”.

To oznacza, że trzeba wyraźnie ustanowić dwa światy:

- **cold path** — Python DSL, IR, planner, konfiguracja, walidacja, frontend, artefakty, API;  
- **hot path** — trwała sesja solvera, trwałe bufory, trwałe plany FFT/preconditionery/operator caches, minimalne kopiowanie, minimalna alokacja, brak ciężkich callbacków, brak serializacji po każdej iteracji.

Bez tej separacji Fullmag pozostanie architektonicznie elegancki, ale będzie systematycznie przegrywał z projektami zaprojektowanymi od początku pod bardzo tani krok solvera.

---

## 2. Cel audytu

Celem tego raportu jest odpowiedź na pytanie:

> **Gdzie implementacje FDM i FEM w Fullmagu będą miały największe słabości wydajnościowe względem Boris i MuMax/MuMax3, oraz jakie gruntowne zmiany trzeba wprowadzić teraz, zanim złożoność projektu utrwali te słabości?**

Raport nie ma charakteru marketingowego. Nie próbuje wykazać, że „wszystko da się łatwo poprawić”. Wręcz przeciwnie: zakłada twardą, audytorską perspektywę.

W szczególności raport:

- analizuje architekturę całego systemu, a nie tylko pojedynczych funkcji,  
- rozdziela problemy **algorytmiczne**, **pamięciowe**, **systemowe** i **produktowe**,  
- wskazuje, które rozwiązania są akceptowalnym bootstrapem, a które stałyby się katastrofalne jako rozwiązania docelowe,  
- proponuje refaktor nie jako „nice to have”, ale jako **decyzję strategiczną**,  
- wyjaśnia, dlaczego odkładanie tej decyzji będzie później kosztować znacznie więcej.

---

## 3. Metodologia

Analiza została oparta na czterech źródłach informacji:

### 3.1. Publiczna dokumentacja i repozytorium Fullmaga

Przeanalizowano:

- README i opis architektury repozytorium,  
- układ workspace i rozdział crate’ów,  
- warstwę `fullmag-plan`,  
- warstwę `fullmag-runner`,  
- warstwę `fullmag-engine`,  
- natywne wrappery FDM/FEM,  
- ścieżki CPU reference i GPU/native.

### 3.2. Kod gorących ścieżek runtime

Najwięcej uwagi poświęcono miejscom, które realnie wpływają na wydajność:

- tworzenie i użycie `FftWorkspace`,  
- implementacja demag FFT/Newell,  
- implementacja exchange field i energii,  
- organizacja kroków integratora Heun/RK4/RK23/RK45,  
- tworzenie backendów natywnych,  
- kopiowanie pól i magnetyzacji host↔device,  
- callbacki live i snapshot scheduling,  
- planowanie geometrii do gridów/mesh assets.

### 3.3. Punkt odniesienia: Boris i MuMax/MuMax3

Jako benchmark architektoniczny potraktowano:

- **MuMax3 / MuMax+** jako wzorzec bardzo wydajnego GPU-first FDM,  
- **BORIS** jako wzorzec bardziej złożonego, multiphysicsowego, ale nadal bardzo wydajnego jądra obliczeniowego.

### 3.4. Kryteria oceny

Przy ocenie każdej decyzji architektonicznej zastosowano następujące pytania:

1. Czy zwiększa koszt pojedynczego kroku solvera?  
2. Czy zwiększa liczbę pełnych przejść po siatce/mesh?  
3. Czy wymusza dodatkowe alokacje?  
4. Czy powoduje host-device traffic w miejscach, gdzie nie powinien istnieć?  
5. Czy wymusza utrzymywanie dwóch niespójnych dyskretyzacji tego samego problemu?  
6. Czy ogranicza skalowanie do większych modeli lub wielu GPU?  
7. Czy utrudnia wprowadzenie bardziej zaawansowanych operatorów w przyszłości?  
8. Czy przenosi kompromis bootstrapowy do architektury docelowej?

---

## 4. Kontekst porównawczy: co robią MuMax i Boris inaczej

Pełna uczciwość wymaga, żeby najpierw zrozumieć, dlaczego MuMax i Boris są tak dobrymi punktami odniesienia.

### 4.1. MuMax/MuMax3

MuMax3 jest projektowany jako **GPU-accelerated finite-difference micromagnetics engine** i jawnie komunikuje bardzo duże przyspieszenie względem CPU dla dużych modeli. Oficjalna strona podaje, że program jest zoptymalizowany pod kątem niskiego zużycia pamięci na GPU i może obsługiwać bardzo duże siatki FD, a centralną ideą systemu jest pełne wykorzystanie regularnej siatki i GPU. citeturn553444search2turn553444search1

To ma bardzo ważne skutki architektoniczne:

- data layout jest podporządkowany GPU,  
- demag jest od początku budowany jako operator naturalny dla regularnej siatki,  
- całe jądro wykonawcze jest zoptymalizowane pod małą liczbę drogich przejść i mały ruch pamięci,  
- solver nie jest obciążony wielowarstwową orkiestracją produktu wewnątrz hot path.

MuMax+ zachowuje tę samą filozofię, tylko z bardziej nowoczesnym, rozszerzalnym stosem programistycznym — nadal GPU-first, nadal finite-difference-first. citeturn553444search7

### 4.2. Boris

BORIS jest ciekawszym punktem odniesienia, bo nie ogranicza się do klasycznej micromagnetyki. Publiczne materiały i publikacje opisują go jako środowisko **multiphysics i multiscale**, integrujące m.in. spin transport, ładunek, ciepło, elastodynamikę, struktury warstwowe i wiele modeli fizycznych, także z wykorzystaniem wielu GPU. citeturn553444search8turn553444search0

To oznacza, że Boris pokazuje coś bardzo istotnego dla Fullmaga:

> da się zbudować system znacznie bardziej ogólny niż MuMax, a mimo to nie utracić bardzo wysokiej wydajności, pod warunkiem że jądro solverowe pozostanie radykalnie spójne i podporządkowane wykonaniu.

### 4.3. Wniosek porównawczy

MuMax i Boris mają wspólny mianownik:

- nie traktują solvera jako „jednego z wielu modułów produktu”,  
- tylko jako **rdzeń systemu**, wokół którego cała reszta jest zorganizowana.

Fullmag jest dziś bardziej zorganizowany jak produkt platformowy z backendami. To świetne dla ergonomii i rozszerzalności semantycznej, ale nie gwarantuje wydajności.

---

## 5. Aktualna architektura Fullmaga

Fullmag jest opisywany jako platforma micromagnetics, w której wspólny interfejs ma opisywać **problem fizyczny, a nie numeryczny układ siatki**, z Python DSL serializującym do `ProblemIR`, Rustem walidującym i planującym backend oraz browserowym control roomem i zarządzanymi runtime’ami. citeturn609711view0turn544679view2

To jest bardzo mocna decyzja architektoniczna. Daje:

- dobrą warstwę semantyki problemu,  
- możliwość zmiany backendu bez zmiany modelu użytkownika,  
- sensowny podział odpowiedzialności między authoring, planning i execution,  
- pole do rozwoju wielu rodzin backendów.

### 5.1. Główne warstwy systemu

Z kodu i struktury repo wynika następujący pipeline:

1. **Python authoring layer** — użytkownik opisuje geometrię, materiały, termy energii i study.  
2. **Canonical IR** — problem serializowany do `ProblemIR`.  
3. **Planner** — `fullmag-plan` obniża `ProblemIR` do `FdmPlanIR`, `FdmMultilayerPlanIR` albo `FemPlanIR`. fileciteturn9file0  
4. **Runner** — `fullmag-runner` wybiera engine CPU/GPU i wykonuje plan, wraz z harmonogramem snapshotów i callbackami live. fileciteturn2file0turn4file0  
5. **Engine / native backend** — referencyjne CPU oraz natywne FDM/FEM. fileciteturn3file0turn5file0turn6file0  
6. **Artifacts / UI** — zapisywanie wyników, streaming, frontend.

### 5.2. Co w tej architekturze jest bardzo dobre

Należy to powiedzieć jasno: kilka decyzji jest znakomitych i absolutnie należy je zachować.

#### Dobre decyzje:

- rozdzielenie semantyki problemu od realizacji backendowej,  
- planner jako oddzielna warstwa,  
- jawny runtime selection i provenance,  
- istnienie reference paths dla walidacji,  
- możliwość porównywania CPU/GPU na tym samym planie,  
- oddzielne crate’y dla IR, planowania, runtime i systemów natywnych.

To są decyzje do obrony.

### 5.3. Gdzie zaczyna się problem

Problem zaczyna się wtedy, gdy warstwa bardzo dobra dla **organizacji projektu** staje się wzorcem dla **gorącego execution path**.

I to jest dziś główne napięcie Fullmaga.

---

## 6. Ścieżka danych i sterowania: Python → IR → planner → runner → backend → UI

Żeby zrozumieć realne koszty, trzeba zobaczyć nie tylko solver, ale cały obieg danych.

### 6.1. `run_problem` jako centralny punkt wykonania

`fullmag-runner` najpierw wywołuje planner, następnie konfiguruje pulę CPU, potem dispatchuje plan do FDM/FDM multilayer/FEM, a na końcu zapisuje artefakty. W wariancie live callback po zakończeniu dla FEM zwraca też pełny payload siatki, a dla FDM spłaszcza końcową magnetyzację. fileciteturn2file0

Na poziomie architektonicznym to jest czytelne i poprawne. Na poziomie performance engineering oznacza to jednak, że:

- runtime nie jest modelowany jako trwała sesja obliczeniowa, tylko jako uruchomienie planu,  
- callbacki i artefakty są częścią standardowego toru wykonania,  
- granica między „liczę” a „obsługuję produkt” nie jest wystarczająco brutalna.

### 6.2. Dynamiczne wybieranie backendu

`dispatch.rs` wybiera między CPU reference i backendami natywnymi. Dla FDM CUDA jest dostępne tylko gdy backend jest zbudowany i wykryty; dla FEM GPU backend jest dodatkowo ograniczony do `fe_order=1`. Algorytmy relaksacji BB/NCG są odrzucane na CUDA i pozostają CPU-only. fileciteturn4file0

To pokazuje realny stan projektu:

- FDM GPU jest bardziej dojrzałe,  
- FEM GPU jest jeszcze bardzo wąskie,  
- część algorytmów pozostaje backend-specific,  
- wydajna ścieżka wykonania nie jest jeszcze głównym kontraktem systemu.

### 6.3. Problem systemowy

W systemie klasy MuMax czy Boris użytkownik może widzieć złożone API, ale sam hot loop wykonuje się w jądrze o bardzo stabilnym modelu pamięci i sterowania.

W Fullmagu nadal widać, że:

- planner,  
- callbacki,  
- snapshoty,  
- flattening danych,  
- host-device synchronizacja,

stanowią zbyt dużą część historii wykonania.

To nie musi jeszcze boleć na małych modelach. Będzie boleć na dużych.

---

## 7. Audyt FDM: gdzie dziś Fullmag będzie przegrywał wydajnościowo

Tu zaczyna się najważniejsza część audytu.

FDM jest naturalnym polem porównania z MuMaxem i w części także z Borisem. Jeśli Fullmag ma kiedyś osiągnąć naprawdę wysoki poziom wydajności, to właśnie w FDM powinien najpierw dojść najdalej.

### 7.1. Najważniejsza obserwacja

Obecny CPU engine w `fullmag-engine` jest wyraźnie silnikiem referencyjnym, ale jego struktura nadal zdradza sposób myślenia całego runtime’u. A to jest ryzykowne.

### 7.2. `FftWorkspace` — dobry krok, ale jeszcze nie rozwiązanie docelowe

W `fullmag-engine` istnieje `FftWorkspace`, który przechowuje plany FFT, bufory padded oraz widma jąder Newella. To jest właściwy kierunek — build once, reuse many times. fileciteturn3file0

Ale zaraz potem widać pierwszy bardzo ważny problem:

- `ExchangeLlgProblem::step()` tworzy workspace lokalnie dla każdego kroku,  
- dopiero `step_with_workspace()` unika tego kosztu. fileciteturn3file0

Wniosek:

> model API nadal dopuszcza kosztowną ścieżkę domyślną, a zoptymalizowana ścieżka jest osobnym wariantem.

Dla referencji to zrozumiałe. Dla architektury produkcyjnej to zły sygnał. W systemie wydajnościowym ścieżka zoptymalizowana musi być domyślna i naturalna, a nie dodatkowa.

### 7.3. FFT na CPU: strided gathers/scatters

`fft3_core` wykonuje transformacje po osi X na danych ciągłych w pamięci, ale dla osi Y i Z używa scratch lines, kopiując dane do bufora, przetwarzając je, a następnie zapisując z powrotem. fileciteturn3file0

To oznacza:

- duży koszt gather/scatter,  
- słabszą lokalność pamięci,  
- większą presję na cache,  
- wzrost udziału bandwidth-bound operations.

Jako CPU reference to jest uczciwe i wystarczające. Ale architektonicznie pokazuje, że cały silnik jest budowany wokół reprezentacji danych, która nie jest naturalnie zoptymalizowana dla operatorów 3D FFT.

MuMax rozwiązuje to inaczej: nie „owija” FFT wokół wygodnej reprezentacji referencyjnej, tylko projektuje reprezentację i operator tak, by hot path był naturalny dla GPU. citeturn553444search2turn553444search7

### 7.4. AoS jako ślad referencyjnego modelu pamięci

W całym CPU engine magnetyzacja i pola operują na `Vec<[f64; 3]>`, czyli de facto na AoS. To jest wygodne semantycznie i czytelne. Ale w gorącym solverze bardzo często wygrywa SoA albo przynajmniej układ silnie podporządkowany backendowi.

Efekty uboczne AoS w tej architekturze:

- trudniejsza wektoryzacja i fuse’owanie operacji,  
- mniej naturalny interfejs dla FFT/demag kernels,  
- bardziej kosztowne przepakowywanie do płaskich buforów,  
- więcej konwersji na granicy z backendem natywnym.

I właśnie to widać w wrapperach natywnych.

### 7.5. AoS↔SoA boundary w FDM CUDA

Wrapper `native_fdm.rs` wprost opisuje siebie jako warstwę `AoS ↔ SoA boundary abstraction`. fileciteturn5file0

To brzmi dobrze jako warstwa kompatybilności, ale jest bardzo niebezpieczne jako sygnał architektoniczny.

Jeżeli core solvera ma być bardzo szybki, to:

- **jego natywnym językiem pamięci powinien być model backendu**,  
- a nie model referencyjny/produktowy, który później trzeba przepakowywać.

Dzisiejszy model oznacza, że Fullmag utrzymuje dwa światy:

1. świat wygodnej reprezentacji semantycznej,  
2. świat wydajnego backendu.

Na krótką metę to pomaga. Na długą metę zwiększa koszt każdej ewolucji operatora, snapshotu, debugowania i integracji nowego backendu.

### 7.6. Krytyczny problem: CUDA FDM nadal zależy od CPU przy budowie operatora demag

To jest jedna z najważniejszych obserwacji całego audytu.

W `native_fdm.rs` przy tworzeniu backendu, jeśli demag jest włączony, widma jąder Newella są liczone przez funkcje z `fullmag_engine`, czyli po stronie CPU/Rust, a dopiero później przekazywane do backendu natywnego. fileciteturn5file0

To znaczy, że Fullmag CUDA FDM nie jest dziś jeszcze w pełni GPU-native. Ma on następujący bootstrapowy model:

1. CPU liczy widma operatora,  
2. Rust tworzy deskryptory,  
3. backend natywny przyjmuje gotowe spectra.

To tworzy kilka problemów naraz:

#### Problem A — duplikacja odpowiedzialności

CPU reference i GPU backend dzielą logikę przygotowania operatora. To zwiększa coupling.

#### Problem B — wolny cold start

Operator demag dla dużych siatek będzie miał koszt budowy odczuwalny jeszcze przed wejściem w runtime GPU.

#### Problem C — zły wektor rozwoju

Jeśli później zechcesz:

- dodać cache operatorów,  
- kompresję,  
- różne precyzje,  
- różne strategie demag,

będziesz rozciągał bootstrap po dwóch światach naraz, zamiast domknąć to w jednym natywnym runtime.

#### Problem D — backend nigdy nie stanie się naprawdę autonomiczny

To bardzo ważne z perspektywy długoterminowej. Prawdziwy szybki backend nie powinien być klientem CPU reference code przy każdej budowie operatora.

### 7.7. Wiele pełnych przejść po danych w jednym kroku

W `observe_vectors_ws()` dzieje się sporo:

- liczony jest exchange field,  
- liczony jest demag field,  
- budowany jest external field,  
- pola są łączone do `effective_field`,  
- dodatkowo liczony jest RHS,  
- liczone są energie exchange/demag/external/total. fileciteturn3file0

To jest bardzo czytelne, ale oznacza dużo pełnych przejść po siatce.

W wielu miejscach Fullmag stawia na przejrzystość i jawność rachunku. To bardzo dobre dla walidacji. Jednak solver wydajnościowy żyje według innej zasady:

> **każde dodatkowe pełne przejście po domenie trzeba traktować jak podejrzanego.**

Jeśli operator i energia mogą zostać policzone z tych samych danych w jednym fused pass, to osobne passy są luksusem, na który runtime produkcyjny nie powinien sobie pozwalać.

### 7.8. Integratory generują dużo tymczasowych wektorów

Heun, RK4, RK23 i RK45 budują kolejne `Vec<Vector3>` dla k1, k2, k3, m1, m2, m3, delta itd. `normalized(add(...))` wykonywane jest wielokrotnie i tworzy dodatkowe przejścia oraz alokacje. fileciteturn3file0

To daje dwa efekty:

- rośnie koszt pamięciowy kroku,  
- trudniej zoptymalizować pipeline pod backend docelowy.

W projektach bardzo wydajnych integrator jest zwykle zaprojektowany razem z reprezentacją pól i stanów. Tutaj integrator jest jeszcze mocno „akademicki” i referencyjny.

### 7.9. `observe`, `demag_field_from_vectors`, `effective_field_from_vectors` nadal tworzą workspaces lokalnie

Mimo że istnieją wersje `_ws`, część API nadal oferuje warianty tworzące workspace lokalnie. fileciteturn3file0

To znowu nie jest dramat dla referencji, ale jest zły jako wzorzec. Prawidłowa architektura wydajnościowa powinna działać tak, że:

- workspace / backend state / operator cache są trwałe,  
- użytkownik runtime nie ma jak przypadkiem wpaść w ścieżkę kosztowną,  
- lifetime operatora jest kontrolowany centralnie.

### 7.10. Snapshoty i kopiowanie pól z CUDA backendu

W `dispatch.rs` ścieżka CUDA FDM przy due outputs wykonuje `copy_m`, `copy_h_ex`, `copy_h_demag`, `copy_h_ext`, `copy_h_eff`, czyli kopiuje pełne pola z urządzenia na host, jeżeli harmonogram tego żąda. To samo może dziać się w callbackach live. fileciteturn4file0turn5file0

To jest poprawne funkcjonalnie. Wydajnościowo jednak jest to jedna z najłatwiejszych dróg do zniszczenia zysków GPU.

Jeżeli użytkownik włączy zbyt częste snapshoty, to solver zacznie zachowywać się jak system demonstracyjny, a nie jak wydajny runtime.

### 7.11. Problem psychologiczny architektury

Najgorsze nie jest nawet to, że te kopie istnieją. Najgorsze jest to, że architektura ich **nie piętnuje jako wyjątków**, tylko traktuje jako normalny element wykonania.

Wydajny backend powinien działać według zasady:

- host-visible fields są rzadkim, drogim luksusem,  
- scalar telemetry jest tania i domyślna,  
- pełne pola są żądane świadomie i oszczędnie.

### 7.12. Wniosek dla FDM

**Fullmag FDM jest dziś architektonicznie wystarczający jako poprawny, rozszerzalny i częściowo akcelerowany runtime. Nie jest jeszcze zaprojektowany jak system, którego główną religią jest minimalny koszt cell-step na GPU.**

I dokładnie dlatego będzie przegrywał z MuMaxem w wielu scenariuszach dużych modeli i z Borisem w scenariuszach, gdzie liczy się agresywna integracja backendu i wielofizyki.

---

## 8. Audyt FEM: gdzie dziś Fullmag będzie przegrywał wydajnościowo

Jeśli FDM jest dziś „nie dość GPU-first”, to FEM jest miejscem, w którym widać największą różnicę między bootstrapem a architekturą końcową.

### 8.1. Najważniejsza teza o FEM

> **Fullmag FEM nie jest dziś jeszcze wydajnym FEM runtime. Jest planner-ready i częściowo executable bootstrapem, którego głównym zadaniem jest zachować spójność semantyki problemu i dostarczyć walidacyjny tor rozwoju.**

To nie jest wada sama w sobie. Wadą byłoby udawanie, że to już jest architektura docelowa.

### 8.2. CPU FEM reference jest jawnie wąski

`fem_reference.rs` sam opisuje swój zakres: precomputed `MeshIR`, Exchange, optional bootstrap Demag, optional Zeeman, `LLG(heun)`, double precision. fileciteturn7file0

To bardzo uczciwe. Ale audyt wydajnościowy musi z tego wyciągnąć prosty wniosek:

- to nie jest jeszcze system porównywalny z dojrzałym FEM/H(curl)/matrix-free runtime,  
- to jest tor walidacyjny i bootstrapowy.

### 8.3. Krytyczny problem FEM: demag jest transfer-grid bootstrapem

W CPU reference FEM problem jest tworzony przez `FemLlgProblem::with_terms_and_demag_transfer_grid(..., Some([plan.hmax, plan.hmax, plan.hmax]))`. fileciteturn7file0

W natywnym FEM backendzie GPU w `native_fem.rs` przy `enable_demag` wyznaczany jest bounding box mesha, budowana siatka transferowa z `hmax`, a następnie liczone są widma jąder Newella — znów przez `fullmag_engine`. Potem całość jest przekazywana do backendu FEM. fileciteturn6file0

To ma fundamentalne konsekwencje.

#### Konsekwencja 1 — podwójna dyskretyzacja

Masz jednocześnie:

- mesh FEM, na którym liczysz część problemu,  
- grid transferowy FDM, na którym realizujesz demag.

To zawsze oznacza dodatkowy koszt:

- projekcja z mesha na grid,  
- operator demag na gridzie,  
- projekcja z gridu z powrotem.

Nawet jeśli implementacja jest sprytna, to ten koszt nie zniknie.

#### Konsekwencja 2 — architektura nie jest mesh-native

To nie jest „prawdziwie FEM-owa” droga dla magnetostatyki. To jest most. Most jest dobry jako most. Nie może być wiecznym domem.

#### Konsekwencja 3 — hmax staje się semantycznie przeciążony

`hmax` w FEM zaczyna jednocześnie:

- opisywać poziom siatki FEM,  
- sterować gęstością transfer-gridu demag.

To są dwie różne rzeczy fizycznie i numerycznie. Łączenie ich w jednym parametrze jest bootstrapem, nie końcową architekturą.

#### Konsekwencja 4 — trudno to później „ładnie” rozwinąć

Im więcej funkcji, heurystyk, testów i UI opierzesz na takim bootstrapie, tym trudniej będzie go wymienić na rozwiązanie docelowe.

### 8.4. FEM GPU backend jest jeszcze bardzo wczesny

Komentarz w `native_fem.rs` mówi to wprost: stabilne ABI, wrapper, availability probing, native MFEM step z bootstrap transfer-grid demag na buildach MFEM; mesh-native/libCEED/hypre demag jeszcze pending. fileciteturn6file0

To jest bardzo ważne, bo pokazuje nie tylko „co działa”, ale **jak autor systemu sam rozumie stan projektu**.

A stan projektu jest taki:

- backend istnieje,  
- ale nie ma jeszcze architektury docelowej dla demag i prawdopodobnie dla całego execution stacku.

### 8.5. `fe_order == 1` jako twarde ograniczenie

Dispatcher dopuszcza GPU FEM tylko dla `fe_order == 1`, w innym przypadku następuje fallback na CPU reference. fileciteturn4file0

To nie jest problem „tylko funkcjonalny”. To jest sygnał, że:

- data structures, kernels i operator application nie są jeszcze przygotowane na bardziej ogólny FE order,  
- ścieżka GPU jest nadal bardzo wąska i nie ma jeszcze pełnej generalności.

W dojrzałym solverze wydajnościowym ograniczenia mogą istnieć, ale są zwykle wynikiem świadomej strategii, a nie śladem niedokończonego jądra.

### 8.6. Przy tworzeniu backendu FEM wszystko jest flattenowane i kopiowane

`native_fem.rs` flattenuje:

- nodes,  
- elements,  
- boundary faces,  
- initial magnetization. fileciteturn6file0

To jest normalne na granicy FFI. Problem polega na tym, że nic w tej architekturze nie sugeruje jeszcze istnienia trwałej, zoptymalizowanej reprezentacji mesh runtime, która żyje długo i jest odseparowana od formatu planu.

Jeżeli backend przyjmuje plan jako wejście, tworzy się, liczy, oddaje pola i znika, to oznacza to model „job execution”, a nie model „persistent compute session”.

Dla dużego FEM persistent session jest praktycznie obowiązkowa.

### 8.7. Live callback dla FEM klonuje pełny mesh payload

W `dispatch.rs` i `fem_reference.rs` callback live dla FEM potrafi dostarczać `FemMeshPayload`, zawierający `nodes`, `elements`, `boundary_faces`, a do tego opcjonalnie magnetyzację. fileciteturn2file0turn4file0turn7file0

To jest bardzo niebezpieczny wzorzec.

Nawet jeśli callback nie jest emitowany co krok albo nie zawsze pełny, to architektura już dziś traktuje pełny mesh payload jako naturalny element live update.

Dla małego demo — świetnie.  
Dla dużego FEM runtime — katastrofa.

### 8.8. Merging wielu mesh assets w plannerze jest funkcjonalny, ale nie wydajnościowy

Planner potrafi sklejać wiele disjoint mesh assets w jeden `FemPlanIR`. Wymaga jednak zgodności materiałów i w gruncie rzeczy konkatenacji struktur. fileciteturn9file0

To wystarcza do uruchomienia planu. Nie wystarcza do zbudowania naprawdę wydajnego multi-body FEM runtime.

Brakuje tu jeszcze m.in.:

- świadomego podziału na regiony obliczeniowe i ownership,  
- dojrzałej strategii interfejsów między ciałami,  
- architektury dla heterogenicznych materiałów i solver blocks,  
- przygotowania pod domain decomposition i GPU-aware partitioning.

### 8.9. FEM jako produkt vs FEM jako solver

Największe ryzyko Fullmaga jest takie, że ponieważ semantycznie i produktowo FEM już „istnieje”, zespół może zacząć dodawać kolejne funkcje na tym bootstrapie:

- adaptive workflow,  
- nowe physics terms,  
- nowe UI controls,  
- więcej snapshotów,  
- rozszerzone provenance.

To wszystko będzie wyglądać na postęp. Ale jeśli rdzeń demag i pamięci nie zostanie przebudowany, to powstanie system funkcjonalnie bogaty i wydajnościowo chronicznie niekonkurencyjny.

### 8.10. Wniosek dla FEM

**FEM w Fullmagu wymaga decyzji strategicznej: albo stać się prawdziwym, mesh-native, docelowym backendem, albo pozostać świadomie ograniczonym bootstrapem. Najgorsza opcja to rozwijać go dalej bez rozstrzygnięcia tej kwestii.**

---

## 9. Problemy przekrojowe: rzeczy, które spowalniają jednocześnie FDM i FEM

Część problemów nie dotyczy tylko jednej metody. To są cechy całej architektury runtime.

### 9.1. Brak radykalnego rozdziału cold path vs hot path

To jest prawdopodobnie problem numer jeden.

Dzisiaj planowanie, wybór backendu, scheduling snapshotów, live callbacki i produkcja artefaktów są częścią jednej opowieści o wykonaniu. Oczywiście są logicznie rozdzielone w kodzie, ale nie są jeszcze **architektonicznie izolowane** od gorącej ścieżki.

Skutek:

- łatwiej przenika do runtime’u koszt, który powinien istnieć tylko na obrzeżu systemu,  
- trudniej wyznaczyć twarde performance contracts,  
- łatwiej zaakceptować „tylko jedną dodatkową kopię” albo „tylko jeszcze jeden callback”.

### 9.2. Model „uruchom plan” zamiast „utrzymuj sesję solverową”

Cały `run_problem` jest nadal myślowo blisko modelu:

> plan → execute → write artifacts → done

To dobry model batchowego zadania. Zły model wydajnego środowiska solverowego, zwłaszcza dla:

- relaksacji z długim czasem życia runtime,  
- interactives,  
- continuation studies,  
- parametric sweeps ze współdzielonym operator cache,  
- repeated solves na tej samej geometrii.

### 9.3. Koncentracja na poprawności kontraktu zamiast na trwałości operatorów

Fullmag bardzo dba o to, żeby `ProblemIR` był semantycznie czysty. To jest ogromny plus. Ale architektura wydajnościowa wymaga drugiego, równie silnego kontraktu:

> **operator lifecycle contract**

Czyli: kiedy i gdzie budowane są operatory, gdzie mieszkają, kiedy wygasają, jak są cache’owane, z czym są kompatybilne, kto nimi zarządza.

Dziś ten kontrakt istnieje tylko częściowo.

### 9.4. Snapshoty i telemetria nie mają jeszcze „budżetu wydajnościowego”

System umie robić snapshoty, callbacki live, provenance, scalar traces, field outputs. To jest produktowo świetne.

Brakuje jednak bardzo jawnego modelu:

- ile kosztuje snapshot `m` na 10 mln komórek?  
- ile kosztuje snapshot `H_demag`?  
- kiedy callback live jest w ogóle dozwolony?  
- czy można utrzymać GPU occupancy i pipeline przy częstym host readback?  
- jaki jest dopuszczalny throughput telemetry?

Bez tego produkt bardzo łatwo zabije solver.

### 9.5. Reference code jako zbyt silny wzorzec

Reference code jest fantastyczny dla:

- walidacji,  
- testów parity,  
- dokumentacji implementacji,  
- regresji fizycznej.

Nie może jednak być wzorcem dla:

- layoutu pamięci runtime,  
- granic backendów,  
- polityki snapshotów,  
- struktury hot loop.

Dziś Fullmag jeszcze nie odciął tych dwóch światów wystarczająco mocno.

---

## 10. Największe słabości wydajnościowe — ranking krytyczności

Poniżej przedstawiam ranking najpoważniejszych problemów, od najbardziej strategicznych do bardziej lokalnych.

### Krytyczność A — fundamentalna, blokująca konkurencyjność

#### A1. Brak pełnej separacji hot path od orkiestracji produktu

To jest problem nadrzędny. Bez jego rozwiązania nawet dobrze zoptymalizowane fragmenty będą stale sabotowane przez resztę systemu.

#### A2. GPU FDM nie jest jeszcze end-to-end GPU-native

CPU-side budowa demag kernel spectra i duża rola warstwy referencyjnej w create path oznaczają, że architektura nie jest jeszcze naprawdę „solver-first”. fileciteturn5file0turn3file0

#### A3. FEM demag oparty o transfer-grid bootstrap

To nie jest architektura docelowa. To jest pomost. Jeśli stanie się fundamentem długoterminowym, będzie głównym źródłem przewlekłej nieefektywności. fileciteturn6file0turn7file0

### Krytyczność B — silnie pogarszająca skalowanie

#### B1. Host-device copies dla pól i magnetyzacji jako normalny element runtime

Pole na GPU powinno mieszkać na GPU. Snapshoty powinny być wyjątkiem.

#### B2. AoS / flattening / repacking na granicach backendów

To zwiększa koszty pamięciowe, utrudnia future-proofing operatorów i komplikuje backend evolution.

#### B3. Brak modelu trwałej sesji solvera

Plan execution bez persistent backend state będzie coraz bardziej kosztowny wraz z rozrostem funkcjonalności.

### Krytyczność C — koszt lokalny, ale narastający

#### C1. Wielokrotne pełne passy po danych do obserwabli i energii

#### C2. Integratory z dużą liczbą alokacji i wektorów tymczasowych

#### C3. `fft3_core` z ręcznym gather/scatter dla osi strided

#### C4. Callbacki live z pełnym payloadem siatki FEM

### Krytyczność D — dziś jeszcze akceptowalne, jutro nie

#### D1. Wąski zakres natywnego FEM GPU (`fe_order=1`)

#### D2. Multi-body FEM przez proste merge assets

#### D3. Planner FDM upraszczający geometrię do dense grids i bootstrap masks

---

## 11. Dlaczego półśrodki nie wystarczą

To jest rozdział kluczowy z punktu widzenia decyzji projektowej.

Można sobie wyobrazić trzy klasy reakcji na wyniki audytu.

### Reakcja 1: „Dostroimy kilka funkcji”

Na przykład:

- zoptymalizujemy `fft3_core`,  
- zredukujemy kilka kopii,  
- dodamy trochę cache,  
- ograniczymy callbacki.

To pomoże lokalnie. Nie rozwiąże problemu architektonicznego.

### Reakcja 2: „Zostawmy architekturę, backendy dojrzeją same”

To także jest pułapka. Jeśli backendy dojrzewają w systemie, który nie ma ostrej granicy hot/cold path, to z każdym miesiącem:

- więcej kodu zakłada obecne API,  
- więcej feature’ów zakłada obecny model callbacków,  
- więcej testów zakłada obecne formaty payloadów,  
- więcej UI opiera się na aktualnym przepływie danych.

Wtedy backend przestaje móc ewoluować swobodnie.

### Reakcja 3: „Zróbmy teraz gruntowny refaktor architektury solverowej”

To jest jedyna reakcja, która realnie rozwiązuje problem.

Dlaczego?

Bo prawdziwy problem nie polega na tym, że kilka funkcji jest wolnych. Problem polega na tym, że cały system nie ma jeszcze wyraźnego **kontraktu wydajnościowego** dla jądra solvera.

### 11.1. Jak wygląda półśrodek w praktyce

Półśrodkiem byłoby np.:

- utrzymać obecny model wrapperów i tylko trochę zmniejszyć flattening,  
- zostawić transfer-grid demag w FEM, ale dodać kilka optymalizacji,  
- zostawić live callbacks w obecnej formie, ale wysyłać je rzadziej,  
- nadal opierać natywny create path o CPU-side operator preparation.

To wszystko poprawi benchmarki o jakiś procent. Nie da architektury konkurencyjnej z MuMax/Boris.

### 11.2. Dlaczego półśrodki są nawet groźniejsze niż brak zmian

Bo dają złudzenie postępu.

System stanie się:

- trochę szybszy,  
- trochę bogatszy,  
- trochę bardziej złożony.

A jednocześnie:

- trudniejszy do radykalnej przebudowy,  
- bardziej zależny od starych kontraktów,  
- mniej podatny na pełne GPU-native przeprojektowanie.

Czyli półśrodek zwiększa koszt przyszłego refaktoru.

---

## 12. Dlaczego refaktor trzeba wykonać teraz, a nie później

To jest druga centralna teza raportu.

### 12.1. Każdy miesiąc utrwala niewłaściwe kontrakty

Jeśli dziś zachowasz obecne API i model dataflow, a potem dołożysz:

- adaptivity,  
- więcej study types,  
- nowe energy terms,  
- kolejne snapshot types,  
- persistence i provenance,

to każda z tych funkcji zacznie zależeć od aktualnych założeń runtime.

Później trzeba będzie migrować nie tylko solver, ale też:

- frontend,  
- artefakty,  
- testy,  
- przykłady,  
- dokumentację,  
- narzędzia diagnostyczne.

### 12.2. Wczesny refaktor jest tańszy, bo ma mniej użytkowników wewnętrznych

Dziś złożoność Fullmaga jest duża, ale jeszcze kontrolowalna. To dobry moment, bo:

- zakres executable slices jest jawnie ograniczony,  
- część backendów jest jeszcze bootstrapowa,  
- wiele miejsc samo w kodzie sygnalizuje „pending” albo „scaffold”.

To znaczy, że projekt jest jeszcze mentalnie gotowy na głęboką zmianę.

### 12.3. Później będzie gorzej z powodów psychologicznych

Im bardziej projekt wygląda na „już działający”, tym trudniej biznesowo i mentalnie uzasadnić refaktor. Zawsze pojawia się pokusa:

- „najpierw dokończmy feature X”,  
- „najpierw dopiszmy physics Y”,  
- „najpierw zamknijmy UI Z”.

A potem okazuje się, że nikt już nie chce ruszyć fundamentów.

### 12.4. Później będzie gorzej z powodów technicznych

Po rozroście systemu refaktor oznaczałby migrację:

- wielu crate’ów,  
- publicznych kontraktów,  
- snapshot formats,  
- live payloads,  
- benchmark harnessów,  
- parity tests CPU/GPU/FEM/FDM.

To jest dokładnie ten moment, kiedy koszt rośnie wykładniczo, a nie liniowo.

---

## 13. Architektura docelowa — rekomendacja strategiczna

Poniżej przedstawiam docelowy model architektury, który moim zdaniem najlepiej odpowiada ambicji Fullmaga: być systemem produktowo nowoczesnym, ale solverowo naprawdę mocnym.

### 13.1. Zasada nadrzędna

> **Semantyka problemu pozostaje wspólna, ale każdy backend musi mieć własny natywny execution core i własny natywny model pamięci.**

To jest bardzo ważne. Nie chodzi o to, żeby wyrzucić `ProblemIR`. Chodzi o to, żeby nie próbować z `ProblemIR` albo ze struktury reference runnera zrobić „wspólnego runtime modelu pamięci”.

### 13.2. Cztery warstwy systemu

#### Warstwa 1 — authoring semantics

- Python DSL  
- ProblemIR  
- walidacja fizyczna  
- konfiguracja study

Ta warstwa może pozostać bardzo bogata i przyjazna użytkownikowi.

#### Warstwa 2 — planning and lowering

- wybór backendu,  
- dobór operatorów,  
- przygotowanie execution graph,  
- kompilacja planu do backend-specific session descriptor.

Ta warstwa powinna produkować **minimalny, surowy kontrakt wykonawczy**, a nie bogaty obiekt debugowy.

#### Warstwa 3 — persistent execution session

To jest warstwa, której dziś najbardziej brakuje.

Powinna zawierać:

- trwały backend handle,  
- trwałe bufory,  
- trwałe operatory,  
- trwałe FFT plans / sparse operators / preconditioners,  
- trwały telemetry channel.

#### Warstwa 4 — observation and product services

- scalar telemetry,  
- explicit field snapshots,  
- artifact writers,  
- frontend streaming,  
- notebooks / API responses.

Ta warstwa powinna być klientem sesji solverowej, nie częścią kroku solvera.

### 13.3. Co trzeba bezwzględnie wyrzucić z hot path

- tworzenie heavy workspaces domyślnie w API kroku,  
- pełne klonowanie siatek do callbacków,  
- częste pełne readbacki pól z GPU,  
- wszelkie flatten/unflatten poza miejscem absolutnie koniecznym,  
- produktowy scheduling jako część logiki kroku.

---

## 14. Proponowany program gruntownego refaktoru

### Faza 0 — freeze architektoniczny

Przed rozpoczęciem refaktoru trzeba zatrzymać rozszerzanie gorących ścieżek o nowe funkcje, jeśli nie są absolutnie konieczne.

Cel:

- nie dokładać nowych zależności do starego modelu,  
- nie rozszerzać callback payloads,  
- nie poszerzać bootstrap FEM demag jako domyślnej architektury.

### Faza 1 — ustanowienie performance contract

Trzeba formalnie zdefiniować:

- co jest hot path,  
- co jest cold path,  
- jakie dane wolno kopiować w czasie kroku,  
- jakie operacje muszą być persistent,  
- jakie API jest tylko debugowe,  
- jakie benchmarki są bramkami merge.

### Faza 2 — persistent session runtime

Wprowadzić jawny model:

- `CompiledExecutionPlan`,  
- `SolverSession`,  
- `ObservationHandle`,  
- `ArtifactSink`.

Session powinna być tworzona raz i utrzymywać:

- backend state,  
- operator caches,  
- allocated buffers,  
- telemetry state.

### Faza 3 — jeden natywny memory contract per backend

#### FDM

- SoA jako natywna reprezentacja runtime,  
- host-side AoS tylko jako convenience boundary i to możliwie poza hot path.

#### FEM

- mesh-native runtime buffers i field representation,  
- jawny kontrakt dla ownership/DOFs/field vectors/operator application.

### Faza 4 — dekompozycja observation plane

- scalar telemetry tania i asynchroniczna,  
- field snapshots jawnie kosztowne i explicit,  
- live mesh payload usunięty z regularnego callback path.

### Faza 5 — strategiczna decyzja o demag

To najważniejsza faza dla przyszłości Fullmaga.

Trzeba zdecydować:

- czy FDM demag pozostaje regular-grid FFT/Newell jako główny docelowy operator FDM,  
- czy FEM dostaje własną docelową ścieżkę magnetostatyki/open boundary,  
- czy transfer-grid pozostaje tylko fallbackiem/bootstrapem.

### Faza 6 — benchmark-driven hardening

Każda zmiana musi być mierzona nie tylko przez poprawność, ale przez:

- init time,  
- ns/cell-step,  
- bytes copied per step,  
- snapshot cost,  
- demag setup amortization,  
- weak scaling / strong scaling.

---

## 15. Docelowa architektura FDM

To jest sekcja najbardziej konkretna z perspektywy konkurowania z MuMaxem.

### 15.1. Cel

Zbudować FDM backend, który jest:

- GPU-first,  
- persistent,  
- SoA-native,  
- minimalny w ruchu host-device,  
- zdolny do bardzo taniego kroku czasowego na dużych regularnych siatkach.

### 15.2. Natywny kontrakt pamięci

Wewnątrz FDM runtime nie powinno być `Vec<[f64; 3]>` jako reprezentacji podstawowej.

Docelowo:

- `mx[]`, `my[]`, `mz[]`,  
- `hx_ex[]`, `hy_ex[]`, `hz_ex[]`,  
- `hx_demag[]`, `hy_demag[]`, `hz_demag[]`,  
- ewentualnie fused structures tylko tam, gdzie backend tego wymaga.

Dlaczego to ważne:

- łatwiejsze fuse kernel patterns,  
- mniejszy koszt przepakowywania,  
- prostsze API dla FFT i tensor convolution,  
- lepsza ścieżka do single/double mixed precision.

### 15.3. End-to-end GPU-native demag

To jest absolutnie konieczne.

Docelowo natywny backend FDM powinien sam:

- inicjalizować lub odtwarzać operator demag,  
- zarządzać cache operatora,  
- utrzymywać FFT plans,  
- utrzymywać spectra / kernels na urządzeniu,
- a jeśli używa CPU do precompute, to tylko jako offline cache build path, nie jako standardowy runtime create path.

### 15.4. Session lifecycle

Powinien istnieć jawny model:

1. `compile(problem)`  
2. `open_session(compiled_plan)`  
3. `step_many(n)` albo `advance_until(t)`  
4. `sample_scalars()`  
5. `sample_field(name)` tylko na żądanie  
6. `close()`

To pozwala brutalnie ograniczyć overhead orkiestracyjny.

### 15.5. Integratory

Integratory powinny zostać przepisane tak, by:

- pracować na trwałych buforach stage’ów,  
- nie alokować nowych wektorów dla każdego kroku,  
- korzystać z fused normalization/update patterns,  
- mieć wspólny kontrakt dla adaptive control bez mnożenia host-visible struktury danych.

### 15.6. Snapshot discipline

Domyślna polityka:

- scalar telemetry: tak,  
- pole `m`: rzadko,  
- pola pochodne (`H_ex`, `H_demag`, `H_eff`): tylko explicit,  
- brak automatycznego readback full field w typowym interactive loop.

### 15.7. Co to zmienia względem dziś

Zmienia bardzo dużo:

- wrapper przestaje być mostem między równorzędnymi światami,  
- CPU reference przestaje być modelem danych runtime,  
- GPU backend staje się prawdziwym centrum wykonania,  
- łatwiej benchmarkować Fullmag bez wpływu UI/artifacts.

---

## 16. Docelowa architektura FEM

Ta sekcja jest jeszcze ważniejsza strategicznie, bo tu trzeba podjąć decyzję, czym FEM ma właściwie być w Fullmagu.

### 16.1. Dwie możliwe drogi

#### Droga A — FEM jako realny docelowy backend

Wtedy trzeba zainwestować w:

- mesh-native operator application,  
- mesh-native exchange,  
- docelową ścieżkę demag/open-boundary,  
- solver/preconditioner lifecycle,  
- matrix-free lub przynajmniej dobrze ułożony sparse path,
- sensowną strategię GPU execution.

#### Droga B — FEM jako ograniczony backend specjalistyczny

Wtedy trzeba uczciwie powiedzieć:

- Fullmag głównie optymalizuje FDM,  
- FEM pozostaje węższy,  
- transfer-grid demag jest świadomie akceptowany w części przypadków,  
- nie obiecuje się wydajności zbliżonej do core FDM.

### 16.2. Najgorsza możliwa droga

Najgorsze, co można zrobić, to:

- rozwijać FEM feature-by-feature,  
- pozostawiając transfer-grid demag jako de facto permanentny rdzeń.

To da system, który:

- jest skomplikowany,  
- trudny w walidacji,  
- ma podwójną dyskretyzację,  
- ma permanentny koszt projekcji,  
- nigdy nie osiąga ani prostoty FDM, ani czystości docelowego FEM.

### 16.3. Co trzeba zrobić, jeśli wybór padnie na „prawdziwy FEM”

#### A. Oddzielić mesh semantics od runtime mesh state

`MeshIR` nie może być traktowany jak runtime mesh. To powinien być input do kompilacji sesji.

#### B. Ustalić docelowy model magnetostatyki dla FEM

Możliwe opcje:

- air-box + scalar potential,  
- open boundary transform,  
- FEM/BEM coupling,  
- inny jawnie wybrany model.

Ale wybór musi być jawny i strategiczny.

#### C. Ustalić, czy backend jest matrix-free / libCEED-first, czy assembled-matrix-first

Bez tej decyzji trudno racjonalnie projektować pamięć, operatory i GPU path.

#### D. Zdefiniować preconditioner lifecycle

Preconditionery i solver setup nie mogą być efemeryczne. Muszą mieć własny kontrakt trwałości i cache’owania.

### 16.4. Transfer-grid jako fallback, nie fundament

Transfer-grid demag można zachować jako:

- bootstrap,  
- fallback,  
- narzędzie referencyjne,  
- mechanizm testowy.

Nie wolno go jednak utrwalić jako architektury głównej.

---

## 17. Telemetria, snapshoty, UI i artefakty — jak przestać sabotować solver

To jest rozdział, który zwykle bywa lekceważony, a później zabija wydajność bardziej niż pojedynczy kernel.

### 17.1. Dzisiejszy model

Runner:

- zapisuje artefakty,  
- utrzymuje harmonogram wyjść,  
- może robić field snapshots,  
- może robić callbacki live,  
- w FEM callbackach potrafi doklejać payload siatki. fileciteturn2file0turn4file0turn7file0

Funkcjonalnie to jest bardzo wygodne. Wydajnościowo to jest strefa wysokiego ryzyka.

### 17.2. Co powinno być tanie

- step counter  
- simulation time  
- dt  
- total energy  
- wybrane scalar norms  
- convergence flags

To powinno być możliwe praktycznie bez naruszania stanu solvera.

### 17.3. Co powinno być drogie i jawne

- pełne pole magnetyzacji  
- pełne pole demag  
- pełne pole exchange  
- pełne pole effective  
- pełny payload FEM mesha

Te rzeczy powinny wymagać świadomego żądania i być obciążone jawnie nazwanym kosztem.

### 17.4. Rekomendowany model

#### Scalar channel

Tani, częsty, zawsze dostępny.

#### Snapshot channel

Rzadki, planowany, explicit, asynchroniczny, najlepiej z osobnym staging buffer i opcjonalnie compression/decimation.

#### UI channel

Frontend nie powinien oczekiwać, że solver co chwilę wyśle mu wszystko. Powinien umieć pracować na:

- scalar stream,  
- okazjonalnych snapshotach,  
- osobnych zapytaniach „daj mi pole teraz”.

### 17.5. FEM mesh payload

To trzeba powiedzieć bardzo jasno:

> **pełny mesh payload nie może być częścią regularnego live update API.**

Mesh jest zasadniczo statyczny dla danej sesji. Wystarczy go dostarczyć raz jako metadane sesji albo przez osobny endpoint/handle.

Powtarzanie go w callbackach to architektoniczny błąd.

---

## 18. Plan migracji etapowej bez utraty kontroli nad poprawnością

Refaktor musi być głęboki, ale nie może zniszczyć walidacji fizycznej. Dlatego potrzebny jest plan etapowy.

### Etap 1 — zamrożenie kontraktów referencyjnych

Utrzymać CPU reference jako gold standard poprawności:

- parity tests  
- operator-level tests  
- energy invariants  
- convergence sanity

### Etap 2 — wprowadzenie persistent session bez zmiany semantyki użytkownika

Na zewnątrz użytkownik dalej widzi `run_problem`, ale wewnątrz to już otwiera i zamyka `SolverSession`.

### Etap 3 — oddzielenie observation plane

Przenieść snapshot scheduling i callbacks poza jądro kroku.

### Etap 4 — nowy memory contract dla FDM

To powinien być pierwszy duży backend refactor.

### Etap 5 — GPU-native operator lifecycle dla FDM demag

Dopiero po etapie 4.

### Etap 6 — decyzja strategiczna dla FEM

Tu nie wolno zwlekać. Albo pełna ścieżka, albo ograniczony scope.

### Etap 7 — benchmark harness i performance gates

Bez tego cały refaktor nie będzie sterowany faktami.

---

## 19. Lista decyzji architektonicznych, które trzeba podjąć jawnie

Poniższe pytania nie mogą zostać „rozstrzygnięte przez przypadek”.

### 19.1. Czy FDM ma być głównym backendem wydajnościowym?

Jeśli tak, to:

- cały runtime i benchmark strategy powinny to odzwierciedlać,  
- FDM musi być traktowane jako solver flagship.

### 19.2. Czy FEM ma być naprawdę produkcyjny i wydajny, czy głównie semantyczny/specjalistyczny?

Brak odpowiedzi oznacza dryf architektoniczny.

### 19.3. Czy transfer-grid demag w FEM jest bootstrapem czy fundamentem?

To najważniejsze pytanie dla FEM.

### 19.4. Jaki jest natywny memory contract backendu?

AoS na zewnątrz?  
SoA wewnątrz?  
Jakie są gwarancje?

### 19.5. Czy snapshoty full-field są częścią standardowego wykonania?

Poprawna odpowiedź brzmi: **nie**.

### 19.6. Czy runtime ma model sesji trwałej?

Poprawna odpowiedź brzmi: **musi mieć**.

### 19.7. Czy reference engine ma wpływać na shape runtime API?

Poprawna odpowiedź brzmi: **jak najmniej**.

---

## 20. Aneks A — szczegółowa analiza kodu

### 20.1. `fullmag-runner/src/lib.rs`

Najważniejsze obserwacje:

- `run_problem()` wywołuje planner, buduje thread pool, dispatchuje plan, a potem zapisuje artefakty.  
- `run_problem_with_callback()` robi to samo i dodatkowo emituje `StepUpdate`; dla FEM końcowy update dokleja mesh payload (`nodes`, `elements`, `boundary_faces`), a dla FDM spłaszcza końcową magnetyzację.  
- `with_cpu_parallelism()` buduje nowy `rayon::ThreadPool` dla każdego wywołania.  
- engine resolution utrzymuje wspólną warstwę opisową dla CPU/GPU FDM i FEM.  

**Ocena wydajnościowa:** dobra warstwa orchestration, ale nadal model „run job now”, a nie model trwałej sesji solvera. Przy dużej liczbie uruchomień i bogatym observation plane może to zwiększać koszt cold start i utrudniać cache’owanie operatorów. fileciteturn2file0

### 20.2. `fullmag-engine/src/lib.rs`

Najważniejsze obserwacje:

- `FftWorkspace` przechowuje plany FFT i bufory padded, co jest dobrym krokiem do persistent operator state.  
- `ExchangeLlgProblem::step()` nadal tworzy workspace lokalnie; tylko `step_with_workspace()` unika tego kosztu.  
- wiele funkcji ma zarówno wersję `_ws`, jak i wersję tworzącą workspace wewnętrznie.  
- exchange field to klasyczny stencil drugich różnic.  
- demag korzysta z custom FFT pipeline i buforów kompleksowych, z gather/scatter dla osi strided.  
- `observe_vectors_ws()` buduje wiele pośrednich struktur i wykonuje wiele pełnych passów po domenie.  
- integratory tworzą liczne tymczasowe `Vec<Vector3>`.  
- reprezentacja bazowa to AoS (`Vec<[f64;3]>`).

**Ocena wydajnościowa:** bardzo uczciwy, przejrzysty reference engine; niewłaściwy jako wzorzec dla docelowego hot path. fileciteturn3file0

### 20.3. `fullmag-runner/src/dispatch.rs`

Najważniejsze obserwacje:

- runtime wybiera backend FDM/FEM CPU/GPU na podstawie env i runtime metadata,  
- CUDA FDM i FEM GPU mają osobne ścieżki,  
- BB/NCG są odrzucone na CUDA,  
- `execute_cuda_fdm_impl()` wykonuje snapshot scheduling i device-to-host copies dla pól i magnetyzacji,  
- `execute_native_fem_impl()` przy live callbackach może kopiować magnetyzację z backendu i dokleja mesh payload.

**Ocena wydajnościowa:** to bardzo wygodna warstwa do sterowania produktem, ale zbyt łatwo dopuszcza kosztowny observation path jako normalny element wykonania. fileciteturn4file0

### 20.4. `fullmag-runner/src/native_fdm.rs`

Najważniejsze obserwacje:

- wrapper jawnie deklaruje AoS↔SoA boundary,  
- `create()` flattenuje magnetyzację, active mask i region mask,  
- przy demag liczy Newell kernel spectra po stronie CPU przez `fullmag_engine`,  
- dopiero potem przekazuje wskaźniki spectra do backendu natywnego,  
- `copy_field()` rekonstruuje `Vec<[f64;3]>` na hoście.

**Ocena wydajnościowa:** GPU backend nie jest jeszcze w pełni samowystarczalny; create path i observation path zdradzają silną zależność od host-side logiki. fileciteturn5file0

### 20.5. `fullmag-runner/src/native_fem.rs`

Najważniejsze obserwacje:

- wrapper sam opisuje stan backendu jako scaffold/early stage,  
- flattenuje mesh i magnetyzację,  
- dla demag tworzy transfer grid z bounding box i `hmax`, po czym liczy Newell spectra przez `fullmag_engine`,  
- solver config jest na razie sztywno osadzony,  
- `copy_field()` oddaje node-based host vectors,  
- tests pokazują bootstrapowy charakter backendu.

**Ocena wydajnościowa:** największe wąskie gardło strategiczne całego systemu. Jeśli ta architektura nie zostanie zastąpiona czymś mesh-native albo jawnie ograniczona do fallbacku, FEM będzie przewlekle kosztowny i niespójny numerycznie jako docelowa ścieżka. fileciteturn6file0

### 20.6. `fullmag-runner/src/fem_reference.rs`

Najważniejsze obserwacje:

- CPU FEM reference wyraźnie jest narrow executable slice,  
- używa `with_terms_and_demag_transfer_grid`,  
- `observe_state()` tworzy bogaty pakiet obserwabli,  
- live callbacki są sprzężone z observation path i payloadem siatki.

**Ocena wydajnościowa:** dobra warstwa walidacyjna, zła jako model końcowy. fileciteturn7file0

### 20.7. `fullmag-plan/src/lib.rs`

Najważniejsze obserwacje:

- planner jest bardzo rozbudowany i dobrze waliduje subset executable,  
- dla FDM obniża geometrię do dense regular grids i active masks,  
- imported geometry bez precomputed grid assets jest odrzucane,  
- multi-layer FDM ma obecnie restrykcyjne założenia co do wspólnego XY i strategii convolution,  
- FEM planning opiera się o precomputed mesh assets, merge wielu ciał jest konkatenacyjny i ograniczony,  
- planner sam przyznaje, że FEM native MFEM/libCEED/hypre GPU execution remains in progress.

**Ocena wydajnościowa:** planner jest mocny semantycznie, ale nie może stać się ukrytą warstwą utrwalającą kompromisy bootstrapowe w runtime. fileciteturn9file0

---

## 21. Aneks B — benchmarki, które trzeba wprowadzić

Jeżeli Fullmag ma być rozwijany świadomie, potrzebuje benchmark suite z prawdziwego zdarzenia.

### 21.1. Benchmarki FDM

1. **Demag init time**  
   - czas budowy operatora  
   - czas odczytu z cache  
   - pamięć zajęta przez spectra/kernels

2. **ns per cell-step**  
   - exchange only  
   - exchange + demag  
   - exchange + demag + external

3. **Snapshot cost**  
   - `m` only  
   - `H_demag` only  
   - all fields  
   - scalar-only

4. **CPU reference vs CUDA parity overhead**  
   - ile kosztuje warstwa wrappera  
   - ile kosztują flatten/unflatten

5. **Scaling by grid size**  
   - small  
   - medium  
   - large  
   - memory-limited

### 21.2. Benchmarki FEM

1. **Mesh setup time**  
2. **Demag transfer-grid setup time**  
3. **Projection overhead mesh↔grid**  
4. **Step time with exchange only**  
5. **Step time with exchange + demag**  
6. **Readback cost for node fields**  
7. **Effect of `fe_order` once rozszerzony beyond 1**

### 21.3. Benchmarki systemowe

1. **Cold start vs warm session**  
2. **Run with artifacts off vs on**  
3. **Run with live callback off vs on**  
4. **Run with scalar stream only vs full fields**  
5. **Persistent session reuse across parameter sweep**

### 21.4. Benchmarki porównawcze względem zewnętrznych tooli

Nie chodzi o idealnie uczciwy benchmark jeden do jednego — to jest często niemożliwe. Chodzi o sensowny reality check:

- thin film strip  
- box relaxation  
- vortex/skyrmion-like test cases  
- multilayer stack  
- duży model memory-bound

Dla FDM te benchmarki powinny być porównywane z MuMaxem/MuMax+ tam, gdzie fizyka pokrywa się najlepiej. MuMax jest projektowany właśnie jako bardzo wydajny GPU finite-difference engine, więc to jest naturalny benchmark odniesienia. citeturn553444search2turn553444search7

Dla bardziej złożonych, multiphysicsowych i wielowarstwowych scenariuszy warto patrzeć również na BORIS jako punkt odniesienia architektonicznego. citeturn553444search8turn553444search0

---

## 22. Aneks C — pytania decyzyjne dla maintainera

To są pytania, na które warto odpowiedzieć przed rozpoczęciem głębokiego refaktoru.

### 22.1. Tożsamość projektu

- Czy Fullmag chce wygrać przede wszystkim ergonomią i architekturą produktu?  
- Czy chce też wygrać surową wydajnością solvera?  
- Jeśli oba, który cel ma priorytet przy konflikcie decyzji?

### 22.2. Priorytet backendów

- Czy FDM jest backendem flagowym?  
- Czy FEM ma docelowo zbliżać się wydajnością do FDM, czy ma rozwiązywać inne klasy problemów?

### 22.3. Observation philosophy

- Czy użytkownik ma mieć łatwy dostęp do pełnych pól w każdej chwili?  
- Czy raczej ma dostawać tanie skalarne sygnały i tylko okazjonalne pełne snapshoty?

### 22.4. Runtime lifecycle

- Czy przyszły system ma wspierać długowieczne sesje solverowe?  
- Czy ma wspierać continuation, pausing, steering, repeated solves na tych samych operatorach?

### 22.5. Demag strategy for FEM

- Czy inwestujemy w mesh-native demag/open-boundary?  
- Czy transfer-grid ma pozostać fallbackiem?  
- Czy zaakceptujemy ograniczony zakres zastosowań FEM do czasu budowy architektury docelowej?

---

## 23. Wnioski końcowe

### 23.1. Werdykt audytu

**Fullmag jest dziś bardzo obiecującą platformą obliczeniową o mocnej semantyce problemu i rozsądnym podziale warstw. Jednocześnie nie ma jeszcze jądra solverowego zaprojektowanego z brutalnym priorytetem na wydajność w stylu MuMaxa lub Boris.**

Największe słabości wydajnościowe nie wynikają z pojedynczego błędu implementacyjnego. Wynikają z tego, że projekt jest jeszcze na etapie, gdzie:

- referencyjność i walidowalność wciąż kształtują runtime,  
- observation plane jest zbyt blisko solvera,  
- FDM CUDA nie jest jeszcze w pełni autonomiczny,  
- FEM opiera się na bootstrapowym demag transfer-grid,  
- nie istnieje jeszcze w pełni sformalizowana architektura persistent execution session.

### 23.2. Najważniejszy komunikat praktyczny

Jeżeli celem jest naprawdę konkurencyjny, nowoczesny system micromagnetics / multiphysics, to:

> **nie wolno dopuszczać, by obecne bootstrapy przekształciły się po cichu w architekturę końcową.**

To dotyczy zwłaszcza:

- demag w FEM,  
- observation/callback modelu,  
- granicy host↔device,  
- roli CPU reference code w organizacji runtime.

### 23.3. Najważniejsza rekomendacja wykonawcza

**Trzeba wykonać teraz gruntowny refaktor architektury solverowej.**

Nie „lekki tuning”.  
Nie „jeszcze kilka optymalizacji”.  
Nie „wrócimy do tego po kolejnych feature’ach”.

Tylko:

1. oddzielenie hot path od produktu,  
2. wprowadzenie persistent session runtime,  
3. ustanowienie natywnego memory contract per backend,  
4. uczynienie FDM GPU prawdziwie GPU-native,  
5. strategiczne rozstrzygnięcie przyszłości FEM.

### 23.4. Ostateczna teza

Jeśli ten refaktor zostanie wykonany teraz, Fullmag ma szansę połączyć dwie rzeczy bardzo rzadko spotykane w jednym systemie:

- elegancką, wspólną semantykę opisu problemu,  
- naprawdę wydajne, wyspecjalizowane jądra obliczeniowe.

Jeśli ten refaktor nie zostanie wykonany teraz, Fullmag najprawdopodobniej stanie się systemem:

- bardzo ciekawym,  
- dobrze zaprojektowanym produktowo,  
- bogatym w funkcje,

ale chronicznie przegrywającym tam, gdzie najbardziej liczy się koszt kroku solvera.

I właśnie dlatego decyzję trzeba podjąć teraz.

---

## 24. Źródła

### Fullmag

- Repozytorium Fullmag: `https://github.com/MateuszZelent/fullmag`  
- README / opis architektury i executable slice  
- `crates/fullmag-engine/src/lib.rs`  
- `crates/fullmag-runner/src/lib.rs`  
- `crates/fullmag-runner/src/dispatch.rs`  
- `crates/fullmag-runner/src/native_fdm.rs`  
- `crates/fullmag-runner/src/native_fem.rs`  
- `crates/fullmag-runner/src/fem_reference.rs`  
- `crates/fullmag-plan/src/lib.rs`

### MuMax / MuMax+

- MuMax3 official website  
- MuMax3 publication / implementation references  
- MuMax+ paper and project materials

### Boris

- Boris Computational Spintronics page  
- Boris-related publication/materials on multiphysics and multi-GPU execution

### Dodatkowy kontekst metodyczny

- materiały porównawcze dot. finite-difference micromagnetics i wydajności GPU  
- materiały porównawcze dot. FEM/FDM trade-offs w micromagnetics

