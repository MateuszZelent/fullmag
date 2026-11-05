# Raport PPTX z macierzy bimeron–walec

`build_presentation.ps1` tworzy 16-slajdową prezentację 16:9 z rzeczywistego
indexu wyników `fullmag.bimeron-matrix-results.v1`. Używa lokalnego
`PowerPoint.Application` przez COM; nie instaluje bibliotek do generowania
PPTX. Wszystkie 48 wykresów przypadków jest wstawianych jako osadzone obrazy,
a pełne rekordy JSON i provenance trafiają do notatek prezentera.

## Uruchomienie

Najpierw sprawdź kompletność indexu i plików PNG bez uruchamiania COM:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_presentation.ps1 `
  -ResultsIndex "D:\results\bimeron-matrix\results-index.json" `
  -ResultsRoot "D:\results\bimeron-matrix" `
  -OutputPptx "D:\reports\bimeron-material-matrix.pptx" `
  -ValidateOnly
```

Po udanej walidacji zbuduj deck. Opcjonalnie eksportuj wszystkie slajdy do PNG
do wizualnego QA:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_presentation.ps1 `
  -ResultsIndex "D:\results\bimeron-matrix\results-index.json" `
  -ResultsRoot "D:\results\bimeron-matrix" `
  -OutputPptx "D:\reports\bimeron-material-matrix.pptx" `
  -ExportSlidesDirectory "D:\reports\bimeron-material-matrix-slides"
```

Skrypt odrzuca istniejący deck albo katalog eksportu. `-Force` jawnie zezwala
na ich zastąpienie. Nowy PPTX powstaje najpierw pod nazwą stagingową, przechodzi
kontrolę struktury ZIP, 16 slajdów, 16 stron notatek i osadzonych obrazów, a
potem jest atomowo przenoszony na ścieżkę docelową. Awaria walidacji, COM,
zapisu lub eksportu nie publikuje niekompletnego pliku na ścieżce docelowej.

## Wymagany input

Index musi mieć `schema_version = "fullmag.bimeron-matrix-results.v1"` i
zawierać dokładnie 12 unikalnych kombinacji:

- `material.id`: `current_rdmi`, `yig`, `permalloy`;
- `film_initial`: `bimeron`, `uniform_plus_x`;
- `dot_mx`: `-1`, `1`.

Skrypt wymaga zgodności geometrii filmu 600×600×10 nm, walca R=50 nm/h=30 nm,
szczeliny 5 nm i komórki 2,5 nm. Każdy rekord musi mieć zakończony `status`,
`steps`, `max_steps = 3000`, jawny boolean `converged`, material, energie,
run ID, źródłowy SHA-256, cztery PNG oraz:

```json
"execution": {
  "requested": { "backend": "fdm", "device": "gpu" },
  "resolved":  { "backend": "fdm", "device": "gpu" }
}
```

Tylko jawne pola `execution.requested/resolved` pozwalają deckowi podpisać
przypadek jako FDM GPU. Sam `case_id` lub `status = completed` nie wystarcza.
`converged = false` pozostaje „nie”; limit kroków nie jest używany jako
zastępczy test zbieżności. Wartości null są pokazywane jako `n/d`.

Ścieżki `plots.initial_2d`, `initial_3d`, `final_2d`, `final_3d` są względne
wobec `ResultsRoot`. Każda musi wskazywać istniejący PNG wewnątrz tego rootu;
ścieżki bezwzględne, `..`, symlinki, junctiony i inne punkty reparse są
odrzucane. `plot_provenance.kind` musi być `ui_capture` albo `data_render`.
Pierwszy jest podpisany jako „zrzut widoku UI”, drugi jako „render z zapisanych
danych”; render danych nie jest przedstawiany jako zrzut ekranu.

## Zawartość

1. Tytuł i zakres macierzy.
2. Geometria, metoda i parametry trzech materiałów.
3–14. Po jednym przypadku na slajd: początkowe 3D/2D, końcowe 3D/2D,
    Ms/Aex/Ku/D, kierunek walca, liczba kroków, jawna zbieżność, torque i energia.
15. Zestawienie wszystkich 12 przypadków.
16. Zakres i ograniczenia interpretacji.

Deck opisuje relaksację PG-BB. `wall_time_s` jest czasem zegarowym obliczeń,
a fizyczny czas symulacji wynosi zero. Wynik nie dowodzi parytetu CPU/FEM ani
walidacji eksperymentalnej. Każdy slajd przypadku zawiera kompletny rekord
indexu wraz z run ID, execution, hashami, Zarr path i provenance obrazu w
notatkach prezentera.

Generator odmawia uruchomienia, gdy proces PowerPoint już działa. Tworzy i
zamyka wyłącznie własną prezentację; `Quit()` jest wywoływane tylko wtedy, gdy
można potwierdzić uruchomienie pojedynczej instancji przez ten skrypt. Przy
niepewnej własności procesu skrypt nie zamyka aplikacji.

## Kontrola walidatora

`test_validation.ps1` buduje syntetyczny fixture wyłącznie w katalogu
tymczasowym i testuje: poprawne 12 przypadków, brak przypadku, zły lane
wykonania, traversal przez `..` oraz brak PNG. Wszystkie scenariusze używają
`-ValidateOnly`; fixture nie jest wynikiem symulacji i nie może służyć do
generowania decku.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test_validation.ps1
```
