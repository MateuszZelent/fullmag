# Kontrola odpowiedzi RF k=0 — rzeczywisty Run Fullmaga, 04.11.2026

Raport historyczny z 04.11.2026; podane liczniki i oczekujące decyzje opisują
wyłącznie tamtą chwilę. Aktualny stan: [plan wykonania](2026-10-11-antenna-transport-e2e-implementation.md).

**Sześć zespolonych porównań odpowiedzi RF przeszło. Nie jest to jeszcze
odtworzenie transmisji anteny lub fal spinowych z publikacji.**

## Co policzono i jak czytać wynik

Jeden publiczny Run FDM CPU/double/RK4 wykonał24000 kroków do24ns. Jedna
komórka ma zadane jednorodne pole RF: trzy cosinusy6/7,5/9GHz po0,1A/m.
Materiał: mu0Ms0,89T, alfa0,01, gamma/(2pi)30GHz/T i całe statyczne pole
efektywne0,25T. Demag i wymiana są wyłączone; nie użyto zachowanego pola
anteny. To kontrola jednorodnego modelu A5 przy k=0, nie próbka Co/Ni.

Z zachowanej trajektorii odczytano amplitudy i fazy w ustalonym wcześniej
oknie20–24ns:2000 rzeczywistych próbek co2ps. Wzorzec to bezpośrednie liniowe
odwrócenie A5, z konwencją exp(+i omega t). Parametry, równania, mapowanie
Python/ProblemIR i prerejestracja są w nocie0951, DOC-ANCHOR
`sushruth-k0-rf-control`. Nie dopasowywano częstotliwości, fazy lub amplitudy.

| f (GHz) | Podatność | Fullmag (Re+iIm) | Wzorzec A5 (Re+iIm) | Błąd zespolony względny |
|---|---|---|---|---|
| 6,0 | xx | 9.874296-0.3597886j | 9.874652-0.3598263j | 0.003628% |
| 6,0 | yx | -0.3509867-7.896628j | -0.3510363-7.896913j | 0.003662% |
| 7,5 | xx | 0.8897716-177.998j | 0.8899778-178.0044j | 0.003647% |
| 7,5 | yx | -177.989+0.8901198j | -177.9956+0.8899778j | 0.003653% |
| 9,0 | xx | -8.05871-0.5365081j | -8.059008-0.5364976j | 0.003694% |
| 9,0 | yx | -0.5276711+9.676785j | -0.5276714+9.677142j | 0.003676% |

Podatność jest bezwymiarowa. Wszystkie wyniki spełniły wcześniejszy próg
|chi_meas−chi_A5|<=1e−4+1e−3|chi_A5|. Największy błąd względny wynosi
0.00369351%. To nie błąd względem eksperymentu ani kwalifikacja
pełnego modelu anteny. Funkcja analizująca próbki sama nie uwierzytelnia Run;
osobny odczyt przypiął worker, źródło, CAS końcowego stanu i brak fallbacku.

Wykres `sushruth-k0-rf-control-20261104.png` i SVG: niebieska linia to
wzorzec A5 co5MHz, pomarańczowe markery to rzeczywisty Run przy trzech
częstotliwościach. Pozostałe punkty linii nie są symulacjami Fullmaga.
Wykres obejrzano po renderowaniu; etykiety, jednostki i legenda są czytelne.

## Brakująca próbka i poprawka zapisu

Tabela ma12000 wierszy, choć surowy scalars.csv ma12001. Brakuje wyłącznie
kroku11384 (11,384ns), poza analizowanym oknem20–24ns. Okno pomiarowe jest
kompletne. Nie zmieniono jego zakresu lub kryteriów po zobaczeniu wyniku.
Nie dopisano interpolacji ani wartości analitycznej do historycznego wyniku.

Dokładny accepted_steps.v1.json odtworzył utratę tego samego kroku: różnica
czasu względem zegara tabeli2,001777082378327e−21s przekraczała jej eps2e−21s.
Nadrzędny harmonogram już uznawał tę próbkę za należną przy swojej istniejącej
tolerancji1e−18s. Samo kotwiczenie zegara do wielokrotności okresu nadal
traciło próbkę później; ten wariant odrzucono bez zastosowania w produkcji.
Odtworzenie na zaokrąglonym scalars.csv wskazywało krok11390; do ustalenia
przyczyny użyto dokładnego śladu, nie tego zaokrąglenia.

Minimalna poprawka `crates/fullmag-runner/src/table_autosave.rs::TableStore::append_if_due`
używa maksimum dotychczasowego eps i istniejącego
`schedules::OUTPUT_TIME_TOLERANCE`. Nie zmienia globalnego zegara, kroku LLG,
tolerancji fizycznych, kwadratur lub budżetu GSG. Nie zmienia zapisanych czasów.
Dwie regresje Rust są dodane, ale zgodnie z ograniczeniem nie kompilowano
testów jednostkowych. Diagnostyczny replay arytmetyki: RED12000, GREEN12001,
także dla dokładnego śladu; nie jest to wykonanie nowego binarium.
**Poprawka źródłowa pozostaje bez managed-build/runtime proof.**

## Droga wykonania, zapis i ograniczenia produktu

Przed Run przeszło17 interpretowanych kontroli podatności, demodulacji,
publicznego skryptu i istniejącego wzorca A8. Submit przez zarządzaną receptę
wykonano dokładnie raz. CLI przekroczyło30s; późniejszy GET potwierdził ten
sam run i fingerprint, a istniejąca osobna materializacja zakończyła
przygotowanie. Worker ukończył Run. Nie wysyłano Submit ponownie.

Po drugim wystąpieniu timeoutu porównano dokumentację reqwest i RFC9110§9.2.2.
Rozważono: odczyt i uzgodnienie istniejącego Run; zwiększenie timeoutu po
profilowaniu; optymalizację odczytu archiwum/CAS; zmianę reprezentacji closure.
Wybrano istniejący GET oraz jednokrotną materializację. Pozostałych trzech
wariantów nie wdrożono; nie usunięto provenance i nie poluzowano ochrony.
Źródła: https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.timeout
oraz https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2.

Trajektoria i końcowy stan są zachowane. Tabela nie jest jeszcze osobnym
artefaktem SolutionSet dostępnego UI; wcześniejszy projekt takiej publikacji
czeka na odpowiedź. Scena anteny i sesja3203 pozostały bez zmian. Brak nowego
buildu, transportu, H-only i ponowienia tego Run. Scientific assessment nie
zostało automatycznie podniesione na podstawie kontrolnego raportu.

## Co nadal pozostaje do odtworzenia

Właściwe pole GSG wymaga kwalifikacji zbieżności i niezależnej kontroli.
Nowy eksperyment pozostaje V/J/H0/3 i pełne kontrole H0/9; nie zużyto jego
próby buildu. Trzeba następnie połączyć zakwalifikowane pole z siatką próbki,
policzyć odpowiedź przestrzenną i porównać transmisję. Rozbieżność Fig.3
około0,3–0,46GHz jest nadal otwarta. Niniejsza kontrola jej nie wyjaśnia.

## Piny i pliki wynikowe

- Run: `run-5dc536af5f6d6e3749266c8dab1fd6cb05dc4937bc02ec1ef7151c8527eced2e`.
- Task: `task-4750f68ea0281cbca0915dfea14692bd877307c2709e7223674b83ea372bafb1`.
- Attempt: `attempt-2b2b7e79b1c146e3911d7e7eed179bca`, epoch1.
- Snapshot runtime: `3422d160ec334bbd58cc039961e7a237a1cd84a522711ec3b48849ee567b8226`.
- Skrypt RF: `9f9406d27b2bbad60cd7d6897e89bb6fec31c3dc1bc54a98797b7e3893c88719`.
- Tabela CSV: `ef05fe5d6ce64e797d11b36659fb144d065b09fd63c5407ce63ede970778466c`.
- Końcowy stan CAS: `bc8dd373497e3abc8ce88d711438b8f253afde87abc073d28b637eb72360625b`.

Raport JSON, oryginalna tabela i wykresy są w katalogu artefaktów
`D:/git/fullmag/artifacts/antenna-ui-20261103` z prefiksem
`sushruth-k0-rf-`. Dowody wykonania i diagnostyki:
control volume grupy, `verification/sushruth-k0-rf-control-20261104/`.
Źródło publikacji: Sushruth iin., Phys.Rev.Research2,043203(2020),
https://doi.org/10.1103/PhysRevResearch.2.043203. To kontrola modelu A5,
nie deklaracja zgodności z surowymi danymi autorów.
