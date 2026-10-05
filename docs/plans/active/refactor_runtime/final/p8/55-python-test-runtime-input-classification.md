# P8-55 — testy Python jako odrębne wejścia weryfikacji

Data: 05.10.2026. Stan: regresje i rzeczywisty capture PASS; build po korekcie otwarty.

Po lokalnym commicie `32c2d4431bbd249ff296d9cd330b21111bc5c9d5`
rzeczywisty capture w zmieniającym się checkoutcie zaliczono:
snapshot `ac1532e884648943361a15ce9c5f6fcdc13b6edf5c9050a90c92e48642256aee`,
log `native-build-935539ea338c4991b7b4059eb4b4cc50.log`.
Następny etap zainstalował zweryfikowany pakiet Python, ale odmówił przygotowania
frontendu z `ENOSPC`. Nie nazywamy tego udanym buildem ani runtime proof.

Kolejne próby capture odmawiały zgodności inventory/fingerprint podczas
równoległych zmian. `DEPENDENCY_INPUTS` i native fingerprint obejmowały cały
`packages/fullmag-py`, w tym testy i generowane przez nie debug scene.
`pyproject.toml` pakuje wyłącznie `src/` oraz `py.typed`; zewnętrzne `tests/`
nie należą do instalowanego kodu programu.

Wyłączono wyłącznie `packages/fullmag-py/tests/` z native i dependency
fingerprint. Dopasowano klasyfikację non-runtime w obu istniejących politykach.
Zmiany `src/`, konfiguracji pakietu i pozostałych właściwych wejść nadal
unieważniają pakiet lub wymagają zamknięcia aktywnego środowiska.
Zmiany produkcyjnego kodu podczas capture nadal wymagają spójnego snapshotu;
nie zastąpiono jego kontroli akceptacją niezweryfikowanych źródeł.

Testy są nadal kopiowane, ich rzeczywiste bajty należą do inventory, a każda
manipulacja zamrożonym plikiem jest odmową. Stare snapshoty weryfikujemy
przez zapisane input paths i hashe, nie przez nową politykę live checkoutu.
Domyślne pełne `capture()` nadal uwzględnia dirty tests. Jawne
`qualification_inputs` zachowują ich hashe także przy runtime-only capture.
To rozdzielenie wejść wykonania i wejść dowodu, bez kwalifikacji fizyki.

Trzy rzeczywiste regresje Git fixtures pod storage: PASS, exit 0, receipt
`0721d23651a54b188a2efda2fe6b3d94`:

- add/edit/delete tests nie zmienia runtime/dependency fingerprint; explicit
  qualification i pełny capture zachowują zmiany;
- test zmieniony podczas kopiowania zachowuje rzeczywiste copied bytes;
  późniejszy frozen tamper jest odrzucany;
- zmiana Python `src/` nadal zmienia oba fingerprinty.

Pełny zestaw snapshotu: **15/15 PASS**, receipt
`2a1df992ea04401ea47740ba353ffdd7`, exit 0, niezmienione hashe pięciu helperów.
Review klasyfikacji, pakowania i integralności bez blokera.
Nie kompilowano testów jednostkowych. Pozostaje rzeczywisty
capture/build w zmieniającym się checkoutcie; sukces tych regresji nie
dowodzi ukończenia P8-53 ani całego planu.
