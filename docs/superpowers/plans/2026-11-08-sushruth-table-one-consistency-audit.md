# Odczytowa kontrola spójności Table I Sushruth2020

Data:08.11.2026. Status: wykonana diagnostyka arytmetyczna, nie wynik solvera
Fullmaga i nie reprodukcja publikacji. Bez nowego Prepare, Submit, Solve,
H-only, LLG, native buildu, restartu lub zmiany istniejących wyników.

## Cel i wynik

Oddzielić spójność danych referencyjnych od błędu naszej dyskretyzacji.
Właściciel równań, jednostek, założeń i mapy implementacji pozostaje
[nota0951](../../physics/0951-sushruth-2020-forward-volume-reference.md#spójność-pochodnych-wielkości-table-i--prerejestracja-08112026).
Źródło: [publikacja APS](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203),
Table I, równania2–5 i Appendix A. Autorzy M.Sushruth i in., Physical Review
Research2,043203(2020), DOI10.1103/PhysRevResearch.2.043203, CC BY4.0.

Odczyt wydawniczego PDF i main.tex z arXiv potwierdza literalny zapis105m/s.
Zależność długości, prędkości i szerokości linii daje przy wspólnym k wynik
około8.26 razy różny od wpisanych długości. Dokładne liczby i konwencje są
w nocie właściciela i maszynowym wyniku. Tabela nie określa k; nie traktujemy
tej różnicy jako dowodu błędu autorów. Nie używamy jej do dopasowania Fig.3.

Nasz wzorzec transmisji nie używa tablicowej prędkości105m/s jako wejścia.
Dlatego sama zmiana tego wiersza nie naprawi rozbieżności krzywych.
Kwalifikacja źródła GSG i zgodność z publikacją nadal są otwarte.

## Weryfikacja

Najpierw zapisano plan kontroli w nocie i trzy testy. Przy braku nowego
modułu test zakończył się oczekiwanym błędem importu. Po implementacji
te same trzy testy przeszły,0.057s, exit0, Python3.10.12.
Zakres: jednostki Hz/rad/s, niezależne centralne różnice dyspersji,
symetrie oraz zgodność ze statyczną podatnością istniejącego wzorca.
Tolerancje zapisano przed wykonaniem; nie są progami zgodności z publikacją.

Nie zmieniono reference_sushruth_2020_response.py, kerneli, parametrów
solverów, publicznego Python DSL, ProblemIR, planera, API ani runtime.
Dokumentacja rozróżnia cztery realizacje; żadna nie została uruchomiona
w ramach tego audytu. Odbiór strukturalny noty jest osobnym sprawdzeniem,
nie kwalifikacją naukową Fullmaga.

Walidator noty i source-map zakończył się exit0. Pierwsze wykonanie wykryło
niedokładnie powtórzone opisy pięciu symboli w mapie; ujednolicono je z tabelą
bez zmiany równań, kodu lub wyników. Testy kontraktu dokumentacji:41PASS,
1.323s. Odbiór zmienionych stron względem bazowego commita zostanie zapisany
po utworzeniu commita. Nie publikowano public_docs i nie uruchamiano Sphinx.

## Kod i dowody wykonania

| Dokument | SHA256 |
|---|---|
| scripts/reference_sushruth_2020_table_one.py::audit_table_one / _dispersion | 408b52e4edef07d9ad1231af429ea804423dc57c270f10393252fd187382fa8c |
| scripts/test_sushruth_table_one_audit.py::class SushruthTableOneAuditTests | ef6e94b9e32790793c2eeac6d4ced0434912e3e3431b635caf2ea09e9dda8f5e |
| table-one-audit.json | 4bd240539daf848e639c94c5068d52bfbee0466273d7e4be5d7f1351a1b867b4 |
| execution.json | b4ab6efca1faf3417618456f0b9c06634d60e9c34890e0ca50394d8df3cc7f2d |
| red.stderr.log | f08cf7223f21fae5b2ec06cda8923a971bea2eccd205d53d8698a13a4c3feff3 |
| green.stderr.log | fc4983657709fc818bb1ca30a155d7a50050be20775ef96f7e92c2b93b66a0b9 |

Kontrolny prefiks w Dockerze:
verification/sushruth-table-one-audit-20261108/.
Istniejący backend05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Kod uruchomiono bezpośrednio przez interpretowany unittest w tej grupie,
nie jako native build lub dowód przejścia publicznego toru symulacji.

Pełna odczytana kopia dowodów jest na ext4 WSL:
 /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011/examples/sushruth_2020_closed_gsg/table_one_consistency_20261108
11plików/9577452B, UID1000, katalog0700, pliki0600; odczyt bajtów i hashów PASS.
Manifest SHA256 f3615a496bd9011bab89101465e02870d977899cc2355c9ffa37e4879e5e6082.
To wynik diagnostyczny JSON; nie przedstawiamy go jako archiwum symulacji Zarr.

## Pierwotne materiały wejściowe

| Materiał | Bajty | SHA256 |
|---|---:|---|
| sushruth-published-043203.pdf |1464155|9e2249ec39543ae7e16dd1af43ad1756a7b4f704a62fd9b2e5972334e2e3ca1f|
| sushruth-published-table1-page-20261104.png |86049|85321af254a12a5e8b2144ad9c3d3d1402631a26b732d323d7477de8cc1b5948|
| sushruth-arxiv-2001.11483v1-source.tar |8016677|3f4a0b06f64182ad842437dc00738afad144c07a0840a0adebcaf8b9cb084b89|

Istniejące pliki skopiowano do powyższego katalogu WSL bez nowego pobierania.
Źródło arXiv odczytano z archiwum bez rozpakowywania do filesystemu.
Nie wykonywano kodu z materiałów autorów i nie wysyłano wiadomości zewnętrznych.

## Następny krok

Naprawa preflightu restartu nadal oczekuje osobnej zgody; nie ponowiono
zatrzymanej sekwencji. Po zgodzie: wdrożyć i sprawdzić poprawkę selektora
w rzeczywistym pakiecie, przygotować corner25 i dopiero po pełnym odbiorze
wykonać jedno zatwierdzone V/J/H. Ten audyt nie zastępuje tych bramek.
