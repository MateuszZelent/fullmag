# P8-51 — automatyczna wersja buildu Fullmaga

03.10.2026. Sam numer `0.1.0` nie rozróżnia kolejnych pakietów. Pozostaje
wersją bazową wydania w `Cargo.toml:[workspace.package]`; każdy build
deweloperski otrzymuje datę UTC, commit oraz identyfikator lokalnych zmian.
To oznaczenie buildu, bez automatycznego publikowania wydania.

## Jeden zapis wersji

`scripts/build_version.py` przyjmuje wcześniej przechwyconą tożsamość
`fullmag.source-snapshot.v2`. Sprawdza digest jej kanonicznego payloadu i
zawartości dirty; nie zastępuje podanego commita bieżącym `HEAD`.
Wersję bazową czyta z Cargo workspace. Stary statyczny numer w manifeście
Python, jeżeli występuje, musi być zgodny z Cargo.

Przykładowe formaty dla zmienionego checkoutu:

| Konsument | Przykład |
|---|---|
| EXE, CLI, API i status bar | `0.1.0-dev.20261003.gabcdef123456.dirty.s012345abcdef+9772` |
| Metadata pakietu Python | `0.1.0.dev20261003+gabcdef123456.dirty.s012345abcdef` |
| Liczbowe Windows VERSIONINFO | `0.1.0.9772` |

Ostatni segment Windows oznacza liczbę dni od 01.01.2000. Wszystkie cztery
segmenty mieszczą się w 16 bitach; pełny tekst `ProductVersion` zachowuje
datę i tożsamość źródeł. `SOURCE_DATE_EPOCH` pozwala odtworzyć datę, a jego
brak wybiera UTC w chwili rozpoczęcia buildu. Ponowne uruchomienie istniejącego
pakietu zachowuje jego wersję, zamiast nadawać mu datę uruchomienia.

## Integracja

Natywny launcher przed instalacją Pythona i kompilacją zapisuje
`windows-runtime/build-source-identity.json` oraz `build-version.json` w
kanonicznym profilu. Ten sam rekord ustawia wersję pakietu Python, stamp
`fullmag-build-info`, `fullmag --version`, zasoby PE CLI/API i konfigurację
Tauri. Istniejące pole `runtime_bundle_version` przekazuje wersję binarnego
backendu do status bar; format i ścieżka zasobu API pozostają bez zmian.

Python używa `dynamic = ["version"]`, standardowego `setuptools.build_meta`
i małego `setup.py` z providerem wersji. Sdist odtwarza wersję ze swojego
`PKG-INFO`, bez szukania nowego commita. Archiwum bez tożsamości i metadata
wymaga jawnego opt-in do niekwalifikowanego buildu. Python 3.10 zachowuje
wsparcie przez `tomli`. Cache uv uwzględnia wejścia wersji, aby starszy wheel
nie zachował numeru poprzedniego buildu.

Launcher przed zapisaniem manifestu sprawdza rzeczywiste `ProductVersion`
i liczbowe VERSIONINFO wszystkich wymaganych EXE oraz zainstalowaną wersję
Python. Manifest wiąże rekord wersji i jego hash z hashami binariów. Wersja
deweloperska i integralny rekord nie stanowią kwalifikacji naukowej ani wydania.

## Dowody i pozostałe bramki

- Generator: 17 interpretowanych regresji PASS, w tym integralność identity,
  zegar UTC, Windows bounds, authority Cargo i atomowy zapis.
- Provider Python: 8 regresji PASS; rzeczywisty PEP 517 wheel i sdist → wheel
  zachowały wcześniej przekazaną wersję i metadata bez Git.
- Rzeczywisty capture tego checkoutu przeszedł konwersję JSON PowerShell i
  walidację generatora; powstały zgodne SemVer/PEP 440/VERSIONINFO.
- Kolejny natywny build zainstalował rzeczywisty editable pakiet
  `0.1.0.dev20261003+gbdc8578d0493.dirty.s081c18f2caeb`, zastępując `0.1.0`.
  Odpowiadający mu rekord EXE to
  `0.1.0-dev.20261003.gbdc8578d0493.dirty.s081c18f2caeb+9772`.
- Kolejny build natywny zakończył obie fazy release kodem 0: CLI/API w 7m15s,
  desktop w 2m22s. Wszystkie trzy EXE mają pełną wersję wskazaną powyżej,
  a liczbowe VERSIONINFO `0.1.0.9772`. Launcher sprawdził metadata EXE,
  zainstalowany Python i hashe przed zapisaniem manifestu.
- `fullmag --version`, zasób statusu API oraz widoczny status bar przeglądarki
  wskazują ten sam build. Po zamknięciu własnego okna testowego cały przebieg
  `just windows-ui dev 3197` zakończył się kodem 0.
- Instalator i kwalifikacja wydania oraz natywny FEM Windows pozostają
  **NOT VERIFIED**. Powstały EXE deweloperskiego pakietu FDM CPU.

Formaty opierają się na
[Python dynamic metadata](https://packaging.python.org/en/latest/specifications/pyproject-toml/),
[Windows VERSIONINFO](https://learn.microsoft.com/en-us/windows/win32/menurc/versioninfo-resource)
oraz [cache keys uv](https://docs.astral.sh/uv/reference/settings/#cache-keys).
