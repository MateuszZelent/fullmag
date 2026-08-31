# Projekt: obrócone interfejsowe DMI i reprodukcja bimeronu Göbel 2019

**Status:** zaakceptowany przez użytkownika 2026-08-31
**Zakres:** Python DSL, `ProblemIR`, planner, FDM CPU/GPU, FEM CPU/GPU,
runtime/API/UI, obserwable, dokumentacja naukowa i scenariusze reprodukcyjne

## Cel

Dodać do Fullmag osobną interakcję Dzyaloshinskii–Moriyi odpowiadającą
obróconemu interfejsowemu DMI z pracy Göbel et al., *Phys. Rev. B* **99**,
060407(R) (2019), DOI `10.1103/PhysRevB.99.060407`. Interakcja ma stabilizować
bimeron w cienkiej warstwie o magnetyzacji tła skierowanej w płaszczyźnie.

Implementacja obejmuje wszystkie cztery produkcyjne lane’y: FDM CPU, FDM GPU,
FEM CPU i FEM GPU. Istniejący analityczny preset bimeronu pozostaje warunkiem
początkowym, nie jest zmieniany ani używany jako substytut dynamiki.

Drugim wynikiem jest odtwarzalny scenariusz cienkiego toru na podstawie
parametrów z materiału uzupełniającego Göbel 2019. Scenariusz ma wykazać
relaksację i bezprądową trwałość bimeronu, a nie ruch wywołany SOT.

## Kontrakt fizyczny

### Energia

Dla znormalizowanej magnetyzacji
\(\mathbf m=(m_x,m_y,m_z)\), stałej materiałowej
\(D\,[\mathrm{J\,m^{-2}}]\) i domeny magnetycznej \(\Omega_m\) energia wynosi

\[
E_\mathrm{rDMI}=
\int_{\Omega_m} D\left(
m_z\partial_xm_x-m_x\partial_xm_z
+m_x\partial_ym_y-m_y\partial_ym_x
\right)\,\mathrm dV.
\]

W zapisie tensorowym jest to

\[
w_\mathrm{rDMI}=D\left(L_{zx}^{x}+L_{xy}^{y}\right),
\qquad D_{21}=D_{32}=D,
\]

przy \(L_{ij}^{k}=m_i\partial_km_j-m_j\partial_km_i\). Znak \(D\)
jest fizycznie istotny i wybiera preferowaną chiralność; walidacja dopuszcza
dodatnią, ujemną i zerową skończoną wartość.

Publiczna nazwa `RotatedInterfacialDMI` opisuje pochodzenie operatora przez
globalny obrót przestrzeni spinowej w modelu Göbela. Nie jest to alias
`InterfacialDMI` i nie zależy od normalnej geometrycznego interfejsu.

### Pole efektywne

Dla przestrzennie stałych \(D\) i \(M_s>0\) wariacja energii daje

\[
\mathbf H_\mathrm{rDMI}=
\frac{2D}{\mu_0M_s}
\begin{pmatrix}
\partial_xm_z-\partial_ym_y\\
\partial_ym_x\\
-\partial_xm_x
\end{pmatrix}.
\]

Operator działa wyłącznie w domenie magnetycznej. Komórki i węzły Airbox nie
otrzymują pola ani energii DMI. Materiałowe \(D\) jest w pierwszej wersji
jednorodne dla interakcji, zgodnie z istniejącym kontraktem interakcji DMI;
komórkowe lub regionowe \(D\) nie jest dodawane przez ten projekt.

### Naturalny warunek brzegowy

Na otwartej granicy o normalnej
\(\mathbf n=(n_x,n_y,n_z)\) człon brzegowy wariacji DMI ma współczynnik

\[
\mathbf b_\mathrm{rDMI}(\mathbf n,\mathbf m)=
\begin{pmatrix}
n_xm_z-n_ym_y\\
n_ym_x\\
-n_xm_x
\end{pmatrix}.
\]

Po połączeniu z wymianą naturalny warunek swobodnej powierzchni brzmi

\[
2A\,\partial_n\mathbf m+D\,\mathbf b_\mathrm{rDMI}=\mathbf 0.
\]

Wektor \(\mathbf b_\mathrm{rDMI}\) jest prostopadły do \(\mathbf m\), więc
warunek jest zgodny z ograniczeniem \(|\mathbf m|=1\). Na osiach periodycznych
nie wolno dodawać korekty otwartej granicy. Granice masek materiałowych są
traktowane jak swobodne powierzchnie magnetyka.

## Publiczne API i `ProblemIR`

Python DSL otrzymuje niemutowalny konstruktor:

```python
fm.RotatedInterfacialDMI(D=3.0e-3)
```

`D` jest wymaganym, skończonym `float` w
\(\mathrm{J\,m^{-2}}\). `NaN` i nieskończoności są odrzucane w Pythonie i
ponownie w walidacji `ProblemIR`. Zero jest poprawne i zachowuje jawnie
zaautoryzowaną interakcję w provenance, lecz planner może rozwiązać operator
do wyłączonego kosztu wykonawczego.

Kanoniczny fragment `ProblemIR` ma postać:

```json
{
  "kind": "rotated_interfacial_dmi",
  "D": 0.003
}
```

Powstaje osobny wariant `EnergyTermIR::RotatedInterfacialDmi { d }`. Nie jest
on normalizowany do `InterfacialDmi`, `BulkDmi` ani ogólnej macierzy DMI.
Duplikat interakcji jest odrzucany. Requested intent, resolved backend,
precision, device i faktycznie wykonany operator są publikowane w planie,
manifeście i receipt.

Eksport skryptu, authoring API i Control Room używają tej samej nazwy i
parametru. UI nie tworzy alternatywnej reprezentacji tensorowej. Zapis i
ponowne wczytanie sceny musi odtworzyć bitowo tę samą wartość `D`.

## Granice komponentów i przepływ danych

1. Python DSL obniża interakcję do osobnego wariantu `ProblemIR`.
2. Walidator sprawdza wartość, duplikaty i zgodność interakcji z domeną.
3. Planner FDM lub FEM zachowuje `D`, wybiera lane i publikuje capability.
4. Runner przekazuje `D` przez typowany plan ABI bez zmiany jednostki.
5. Backend oblicza pole, energię i gęstość energii w swojej dyskretyzacji.
6. Kanoniczny katalog ilości udostępnia wyniki przez field store, API,
   snapshoty, artefakty i Control Room.

Każdy backend ma osobnego właściciela realizacji. Wspólne równanie, znaki,
jednostki, identyfikatory ilości i kryteria walidacji należą do kontraktu
backend-neutralnego. Nie dodaje się nowej fizyki do ogólnego `Context` ani do
`mfem_bridge.cpp`.

## Realizacja FDM CPU

FDM CPU jest referencją `double`. Operator korzysta z tych samych
zorientowanych ścian komórek dla energii, pola allocating, pola in-place i
wariantu SoA. Dyskretny gradient oraz korekta brakujących ścian muszą tworzyć
parę energia–wariacja, potwierdzoną testem pochodnej kierunkowej.

Wnętrze używa drugiego rzędu na jednorodnej siatce. Otwarte granice i granice
maski używają ghost values wyprowadzonych z połączonego warunku exchange+rDMI.
PBC w osi `x` lub `y` zawija sąsiada i wyłącza korektę otwartej powierzchni.
Pochodne po `z` nie występują w tym operatorze, ale grubość komórki nadal
wchodzi do objętości energii.

## Realizacja FDM GPU

CUDA implementuje równoważny operator w FP64 i FP32 dla pojedynczej siatki i
multilayer. Pole uczestniczy we wszystkich obsługiwanych jawnych integratorach,
relaksacji, redukcji energii, snapshotach i obliczaniu `H_eff`.

Stan, maski, PBC i `D` pozostają na urządzeniu podczas hot loop. Zabronione są
pełne transfery pola na hosta, hostowe obliczanie operatora i cichy fallback
do FDM CPU. Receipt publikuje rzeczywistą funkcję urządzenia, precision i
identyfikator realizacji operatora.

## Realizacja FEM CPU

FEM CPU jest oddzielnym operatorem MFEM w podsystemie interakcji DMI. Składa
pełną pierwszą wariację energii, zamiast wstawiać jedynie silną postać pola.
Dzięki temu człon brzegowy i naturalny warunek wynikają z tego samego
funkcjonału.

Pole węzłowe powstaje przez projekcję residualu z użyciem macierzy masy i
dzielenie przez \(-\mu_0M_s\) zgodnie z istniejącym kontraktem pól FEM.
Operator obsługuje magnetyzację P1 na typowanych elementach `tet4`, `prism6`
i `pyramid5`; Airbox nie wnosi residualu DMI. Klasy PBC są redukowane w tej
samej przestrzeni true DOF co exchange i pozostałe DMI. Nieobsługiwany rząd
aproksymacji kończy się typowanym błędem przed uruchomieniem backendu.

Energia i residual korzystają z tej samej reguły kwadratury. Test pojedynczego
elementu oraz test pochodnej kierunkowej zapobiegają rozjazdowi znaków między
energią, polem i warunkiem brzegowym.

## Realizacja FEM GPU

FEM GPU zachowuje ten sam residual elementowy, lecz realizuje go w osobnym
operatorze CUDA/libCEED bez hostowego składania pola w kroku czasowym.
Obsługiwane są P1 `tet4`, `prism6` i `pyramid5`, aby cienka warstwa pryzmatyczna
nie wymuszała zmiany topologii siatki. Geometria elementów, membership
materiałowy, true-DOF/PBC, `M_s` i `D` są przekazywane typowanymi buforami.

GPU energy reduction i residual muszą korzystać z tej samej orientacji
elementów. Brak kernela dla aktywnej topologii, brak bufora lub niezgodna
rewizja mapy kończą krok błędem; nie wolno delegować elementów na CPU.

## Obserwable i zasoby

Powstają kanoniczne ilości:

- `H_rotated_dmi` — pole wektorowe w \(\mathrm{A\,m^{-1}}\);
- `Eden_rotated_dmi` — gęstość energii w \(\mathrm{J\,m^{-3}}\);
- `E_rotated_dmi` — energia skalarna w \(\mathrm J\).

Są dodawane globalnie do katalogu ilości, materializacji `compute_fields`,
field store, API, binarnego kodeka, snapshotów i selektora Control Room.
`H_eff` i `E_total` zawierają nowy składnik dokładnie raz. Żądanie ilości bez
aktywnej interakcji jest odrzucane przez planner takim samym mechanizmem jak
pozostałe ilości zależne od interakcji.

## Scenariusz reprodukcji Göbel 2019

Powstają dwa stage-first scenariusze o wspólnych parametrach fizycznych:

- FDM: siatka komórkowa cienkiego toru;
- FEM: dokładnie jedna magnetyczna warstwa `prism6` przez grubość, bez zamiany
  warstwy na przypadkowe tetraedry.

Wspólny model:

| Wielkość | Wartość |
|---|---:|
| rozmiar toru | \(500\times40\times0.5\,\mathrm{nm^3}\) |
| PBC | oś \(x\) |
| \(M_s\) | \(0.58\,\mathrm{MA\,m^{-1}}\) |
| \(A\) | \(15\,\mathrm{pJ\,m^{-1}}\) |
| \(D\) | \(3\,\mathrm{mJ\,m^{-2}}\) |
| \(K_x\) | \(0.8\,\mathrm{MJ\,m^{-3}}\) |
| \(\alpha\) | \(0.3\) |
| temperatura | \(0\,\mathrm K\) |
| prąd i momenty spinowe | wyłączone |

Stan początkowy używa istniejącego `fm.texture.bimeron` w płaszczyźnie `xy`,
z magnetyzacją tła `+x` i dwoma rdzeniami o przeciwnych znakach `m_z`.
Promień i szerokość ściany są dobrane raz dla obu dyskretyzacji oraz zapisane
w scenariuszach; nie są dopasowywane osobno do wyniku backendu.

Pierwszy etap wykonuje deterministyczną relaksację energii. Drugi etap
wykonuje bezprądową dynamikę LLG z \(\alpha=0.3\), aby odróżnić chwilowe
minimum numeryczne od trwałego stanu. Każdy przebieg zapisuje początkową i
końcową magnetyzację, energię, topological charge, parametry siatki, requested
i resolved execution oraz receipt.

## Bramy akceptacyjne reprodukcji

Przebieg jest zaakceptowany wyłącznie wtedy, gdy jednocześnie:

1. końcowa energia całkowita jest mniejsza od początkowej;
2. nie występują `NaN`, nieskończoności, utrata normy, fallback ani pominięty
   operator;
3. po relaksacji istnieją dwa rozdzielone rdzenie z przeciwnymi znakami `m_z`;
4. końcowy ładunek spełnia \(|Q|\ge 0.8\) i nie zmienia znaku;
5. średnie tło poza obszarem rdzenia pozostaje skierowane wzdłuż `+x`;
6. bimeron nie anihiluje podczas całego bezprądowego etapu LLG;
7. FDM CPU i FDM GPU FP64 spełniają zarejestrowane tolerancje pola, energii,
   \(Q\) i końcowej magnetyzacji dla tego samego kroku czasowego;
8. FEM CPU i FEM GPU FP64 spełniają analogiczne tolerancje w tej samej siatce;
9. FDM i FEM zgadzają się jakościowo co do topologii, chiralności i trwałości,
   lecz nie są uznawane za bitowo ani punktowo równoważne dyskretyzacje;
10. FP32 przechodzi osobną bramkę time-to-accuracy i nie jest promowane przez
    sam fakt przejścia FP64.

Progi parity numerycznej są ustalane przez niezależne manufactured solutions
i testy pojedynczego operatora przed uruchomieniem reprodukcji. Nie wolno
rozluźniać ich na podstawie wyniku scenariusza bimeronu.

## Testy i dowody

### Kontrakt i authoring

- Python constructor, walidacja i `to_ir()`;
- serde i walidacja `ProblemIR`;
- planner/capability dla czterech lane’ów;
- round-trip Python–IR–authoring API–Python;
- katalog ilości i materializacja wszystkich trzech obserwabli.

### Testy fizyczne operatora

- stała magnetyzacja w domenie periodycznej daje zerowe pole i energię;
- liniowe pola manufactured solution dają analityczne składowe
  `H_rotated_dmi`;
- sinusoidalna tekstura sprawdza znak, skalę i zbieżność siatkową;
- zmiana znaku `D` odwraca preferowaną chiralność;
- pochodna kierunkowa energii zgadza się z działaniem residualu;
- naturalny boundary tilt jest niezerowy dla właściwego kierunku i zerowy dla
  konfiguracji bazowej;
- maska z otworem nie jest traktowana jak periodyczne wnętrze.

### Parity backendów

- FDM CPU: allocating, in-place i SoA;
- FDM CUDA: FP64/FP32, single-grid, multilayer i wszystkie obsługiwane
  integratory;
- FEM CPU: `tet4`, `prism6`, `pyramid5`, PBC i mixed topology;
- FEM GPU: te same topologie i mapy true DOF bez host fallbacku;
- energia, pole i jeden zaakceptowany krok LLG dla wspólnego fixture.

### Dowód runtime

Natywne buildy i runtime są wykonywane przez repozytoryjne, kontenerowe
receptury `just`. Dowód GPU zawiera identyfikator urządzenia, precision,
manifest źródła, requested/resolved execution, brak fallbacku i zakończony
receipt. Testy źródłowe ani sam build nie są dowodem stabilizacji bimeronu.

## Obsługa błędów

System kończy się jawnie przed wykonaniem, gdy:

- `D` nie jest skończone;
- interakcja występuje więcej niż raz;
- aktywna domena nie ma dodatniego `M_s` lub exchange wymaganego przez
  naturalny warunek brzegowy;
- backend nie obsługuje aktywnej topologii albo rzędu FEM;
- PBC, maska lub mapa true DOF jest niekompletna;
- GPU nie ma wymaganego kernela, bufora albo capability;
- żądana ilość nie może zostać zmaterializowana.

Nie ma ostrzeżenia połączonego z pominięciem interakcji, zamianą jej na inny
typ DMI ani przejściem GPU→CPU.

## Dokumentacja

Przed kodem produkcyjnym powstanie publikacyjna nota w kanonicznym poddrzewie
DMI pod `docs/physics/`, z sąsiednim source map. Nota obejmie równania,
wszystkie symbole i jednostki SI, wariację, warunek brzegowy, cztery
realizacje, Python API, `ProblemIR`, provenance, bibliografię i pełny indeks
źródeł. Publiczny przykład będzie używał `fm.study(...)` i etapów
`study.stages.add_*`.

## Poza zakresem

- ogólna macierz DMI 3×3;
- przestrzennie zmienne lub tensorowe `D`;
- nowe tekstury początkowe;
- reprodukcja ruchu SOT i prędkości z Fig. 3 pracy Göbela;
- atomistyczne Monte Carlo i sfrustrowana wymiana dalszych sąsiadów;
- twierdzenie o eksperymentalnej identyfikacji materiału na podstawie
  symulacji micromagnetycznej.

## Kryterium ukończenia

Zadanie jest ukończone dopiero po przejściu kontraktów API/IR/plannera,
testów energii i wariacji, parity czterech lane’ów, zarządzanych runtime’ów
CPU/GPU oraz obu scenariuszy reprodukcyjnych FDM i FEM. Brak dowodu dla
któregokolwiek lane’u pozostaje `NOT VERIFIED`; nie jest zastępowany dowodem
z innego backendu.
