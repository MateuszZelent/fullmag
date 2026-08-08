# Zakres, obecność i aktywacja modułów fizycznych

Status: kontrakt normatywny dla autora sceny, `ProblemIR`, planera i Control
Room. Dokument nie podnosi samodzielnie statusu wykonawczego żadnego backendu.

## 1. Problem fizyczny

Scena opisuje problem fizyczny, a nie listę struktur danych backendu. Moduł
fizyczny istnieje wtedy i tylko wtedy, gdy użytkownik zapisał odpowiadający mu
rekord w Python DSL albo w autorze UI. Wartość napędu równa zero nie usuwa
modułu: jest jawnym stanem `inactive`/`configured` i pozostaje częścią
proweniencji. Brak rekordu prądu nie jest równoważny z rekordem prądu o
`j = 0`.

Reguła ta jest istotna dla sprzężeń: spin transport, STT/SOT i pole Oersteda
mogą zależeć od nazwanego źródła prądu, lecz nie wolno ich awansować do stanu
aktywnego, gdy źródło nie istnieje. Zależność niespełniona jest publikowana
jako `blocked`, nigdy jako cichy domyślny prąd.

## 2. Wielkości i jednostki

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf j_c$ | konwencjonalna gęstość prądu | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_\mathrm{oe}$ | pole Oersteda użyte w RHS LLG | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_\mathrm{ext}$ | zadane pole indukcji | $\mathrm T$ |
| $\mu_s$ | potencjał spinowy | $\mathrm V$ |
| $\lambda_\mathrm{sf}$ | długość relaksacji spinowej | $\mathrm m$ |
| $\sigma$ | przewodność elektryczna | $\mathrm{S\,m^{-1}}$ |

Dla źródła dynamicznego obowiązuje etapowa zależność

\[
 (m_k,\,j_{c,k},\,t_k)\ \longrightarrow\ H_{\mathrm{oe},k}
 \ \longrightarrow\ \mathrm{RHS}_{\mathrm{LLG},k}.
\]

`j_c` jest wielkością podpisaną względem konwencjonalnego kierunku prądu.
Wartość `0 A/m²` jest fizycznym stanem wyłączenia napędu, nie brakiem modułu.
Konwersja $\mathbf B=\mu_0\mathbf H$ odbywa się wyłącznie w miejscu, które
wymaga indukcji lub energii Zeemana.

## 3. Zakres i domena rozwiązania

`applies_to` odpowiada temu, na jakie obiekty/regiony działa moduł fizycznie;
`solve_domain` odpowiada obszarowi, w którym rozwiązywane jest jego równanie.
Te pola są niezależne i nie mogą być wyprowadzone z kolejności wektorów,
właściciela siatki ani etykiety UI.

Dozwolone zakresy:

| Zakres | Semantyka |
|---|---|
| `global` | całe zadanie, np. jednorodne pole zewnętrzne |
| `object` | jeden obiekt o stabilnym `object_id` |
| `region` | jawny region obiektu o stabilnym `region_id` |
| `interface` | dokładnie jedna para stron interfejsu |
| `cross_object` | sprzężenie obejmujące wymienione obiekty |
| `unresolved` | zachowany rekord, którego celu nie można bezpiecznie rozstrzygnąć |

W FEM `solve_domain` mapuje się na markery elementów i jawne atrybuty ścian,
a interfejs na parę stron z orientacją normalnej. W FDM mapuje się na maskę
komórek i maskę ścian. Identyfikatory i proweniencja pozostają wspólne; różna
jest tylko realizacja dyskretna.

## 4. Obecność, aktywacja i zdolność wykonania

| Stan | Znaczenie |
|---|---|
| `configured` | rekord został zapisany, lecz nie ma jeszcze uruchomienia |
| `active` | rekord i wszystkie nazwane zależności są spełnione, a napęd jest włączony |
| `inactive` | rekord istnieje, lecz jawny napęd/envelope ma wartość wyłączoną lub zero |
| `blocked` | zależność, zakres albo warunek walidacji nie jest spełniony |
| `unsupported` | rekord zachowany bez interpretacji przez bieżący kontrakt |

`capability` opisuje możliwość wybranego lane (np. `reference_executable`,
`development_executable`, `semantic_only`). Nie wolno utożsamiać `active` z
kwalifikacją produkcyjną.

## 5. Zależności STT/SOT/SHE/Oersted

Każdy moduł ma stabilne `id`, ścieżkę źródłową i payload rodziny. Typowe
krawędzie to:

\[
 \text{current} \to \text{spin transport} \to \text{torque},\qquad
 \text{current} \to \text{Oersted},
\]

oraz sprzężenie interfejsowe między dwoma regionami. Krawędź jest `active`
tylko wtedy, gdy oba końce istnieją, mają zgodny zakres i przechodzą walidację
planera. Rekord legacy bez celu pozostaje `unresolved` z przyczyną i wskaźnikiem
JSON Pointer.

## 6. Lowering Python → ProblemIR → runtime

Python DSL zapisuje obecność, zakres, napęd, zależności i parametry
konstytutywne. Autor sceny normalizuje rekordy do wersjonowanego
`PhysicsGraphIR`; payload rodziny (np. `CurrentTransport`, `SpinTransport`,
`OerstedField`) pozostaje nienaruszony. `ProblemIR` przechowuje graph jako
kanoniczną warstwę semantyczną, a planner dodaje lane-specific markery/maski.
Runtime publikuje tę samą tożsamość modułu, stan aktywacji, rewizję źródła i
status capability w artefaktach.

Brak bieżącego modułu w Python IR/UI oznacza pusty zbiór źródeł. `j=0` w
istniejącym module oznacza natomiast jawnie nieaktywny napęd i nie może usuwać
inspektora, proweniencji ani zależnych ostrzeżeń.

## 7. Ograniczenia i walidacja

Normalizacja musi być deterministyczna względem kolejności wektorów, odrzucać
duplikaty ID oraz wskazania nieistniejących obiektów/regionów. Nieznane rekordy
są zachowywane jako `unsupported`. Ambiwalentne rekordy legacy są
`unresolved`; planner zgłasza błąd zamiast wybierać obiekt przez przypadek.

Minimalne bramki:

1. sześć fixture'ów kontraktowych (pusta scena, brak prądu, łańcuch lokalny,
   napęd globalny, interfejs cross-object, rekord nierozstrzygnięty),
2. test stabilności ID po zmianie kolejności rodzin,
3. test rozdzielenia `applies_to` i `solve_domain`,
4. test, że zależny moduł nie staje się aktywny bez źródła,
5. osobne testy numeryczne FEM/FDM oraz proweniencji; test graphu nie jest
   dowodem zgodności solverów.

Dokument pozostaje zgodny z notami `0960`, `0970` i `0980`. W szczególności
kontrakt grafu nie promuje semantycznego SHE/Oersteda do wykonania, a dla FEM
Oersted wymaga kanonicznego `ConservativeCurrentView` RT0/H(div), zamknięcia
bilansu i identyfikacji rewizji źródła.

## 8. Bibliografia lokalna

- Fullmag, `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`.
- Fullmag, `docs/physics/0970-spin-hall-drift-diffusion-transport.md`.
- Fullmag, `docs/physics/0980-dynamic-current-and-oersted-coupling.md`.
- J. C. Slonczewski, *Current-driven excitation of magnetic multilayers*,
  J. Magn. Magn. Mater. 159 (1996).
- A. Manchon et al., *Current-induced spin-orbit torques in ferromagnetic and
  antiferromagnetic systems*, Rev. Mod. Phys. 91 (2019).
