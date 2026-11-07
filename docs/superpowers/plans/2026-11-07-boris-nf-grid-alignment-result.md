# Adapter BORIS: zgodność położenia siatek N/F — 07.11.2026

## Wynik i zakres

Naprawiono błąd `_normalize_boris_fields` w
`scripts/compare_boris_fullmag_she_nf.py`: pola warstw N i F mogły mieć
różne początki w X/Y, ale były sklejane w jeden nośnik z początkiem N.
Zgodność liczby komórek, kroku i styku w Z tego nie wykluczała.
Guard odrzuca teraz takie wejście przed konkatenacją. Wspólne przesunięcie
obu warstw pozostaje poprawne i nie zmienia kolejności pól.

To chirurgiczna naprawa istniejącego kontraktu mapowania nośników E1,
bez nowych równań, formatu, wersji adaptera lub polityki admission.
Współrzędne i kroki pozostają w metrach, V w V, J i Q_ia w A/m².
Użyto istniejących tolerancji geometrii: względnej 1e-12 i bezwzględnej 1e-18 m.
Nie zmieniono `validate_boris_artifact` ani zasad dowodzenia tożsamości runtime.

## Weryfikacja

- Osiem przypadków raw OVF: przesunięcie wyłącznie N lub F, w X lub Y,
  o dodatnie albo ujemne 1,25 nm. Przed poprawką wszystkie osiem błędnie
  przechodziło; testy kończyły się DID NOT RAISE. Przypadek wspólnej
  translacji przechodził również przed naprawą.
- Po poprawce 27 testów adaptera, parsera i bilansu przechodzi, exit 0.
  Sprawdzono wspólną translację XYZ, osiem wartości V i 72 składowe Q.
- Zastany test odmowy używał nieobsługiwanego manifestu v1, choć oczekiwał
  późniejszej odmowy runtime. Rozdzielono go na dwie jawne odmowy:
  manifest v1 oraz brak dowodu runtime dla manifestu v2. Walidatora nie zmieniono.
- Niezależny przegląd wszystkich zmienionych linii i bezpośredniego
  przepływu publicznego adaptera nie wykazał wymaganych poprawek.

Kontrole wykonano interpretowanym Pythonem w istniejącym backendzie grupy
3203: 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Pytest przygotowano z PyPI wyłącznie w prywatnym katalogu narzędzi dowodu,
bez zmiany pakietu aplikacji lub hosta. Pierwszy zapis braku pytest oraz
pierwszy odbiór z nieaktualnym testem pozostają zachowane.

## Dowody i źródła

Prywatny control volume grupy, katalog:
`/opt/fullmag/control/verification/boris-nf-grid-alignment-20261107/`.

| Artefakt | SHA256 |
|---|---|
| red-v2.json | 19efce14b20c3d1fa6f90a49944e4a1fde563b0d63961ad806c1ae013db86f56 |
| green-v2.json | 0c067d349099981bee39765b5ce6279a6f53303e24a933081f258ad5af69dbc3 |
| scripts/compare_boris_fullmag_she_nf.py | e51a1721d13e3384716292c920bfbe4a771dc912d2784025e0ea54b0cc490893 |
| scripts/test_compare_boris_fullmag_she_nf.py | 1f6660c42b0b9ffced91576424e700ca46a80b3958e6b87857a05c96518a50d0 |
| scripts/test_verify_boris_nf_interface.py | c73633dda418615cfb807e1fe3f4292fbdf89fc71c74310b53bb6f4129b34f74 |

Przepływ: `compare_boris_fullmag_she_nf.py::main` →
`normalize_boris_artifact` → `verify_boris_nf_interface.py::validate_boris_artifact`
→ `_normalize_boris_fields`. Nowe regresje używają surowego
`verify_boris_tensor_adapter.py::fixture`, bez udawania dowodu runtime.
Nie wykazano przejścia przesuniętego, sfałszowanego artefaktu przez admission;
wykazano błąd czystego mapowania po admission i usunięto go w adapterze.

## Granice odbioru

Nie wykonano BORIS, Fullmag Solve, nowego buildu, restartu lub zwolnienia
rezerwacji. Nie ma nowego dowodu parytetu solverów ani kwalifikacji E1.
Wyniki historyczne nie uzyskują automatycznie poprawnego statusu.
Reprodukcja publikacji, zbieżność źródła i pełny zakres E0–E12 pozostają otwarte.
Decyzje dotyczące corner25 i execution-intent pozostają oddzielne.
