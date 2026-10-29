# Kontrakt referencyjny: panel Display w mumax3

- Data: 2026-10-27
- Źródło: `external_solvers/3` (fork `MateuszZelent/3`); A-MuMax: `external_solvers/amumax`
- Zasada: `external_solvers/` służy do nauki, nie do kopiowania (`.agents/instructions/scientific.md` §20)

Ścieżki bez prefiksu są względem `external_solvers/3/`; prefiks `AM/` oznacza `external_solvers/amumax/`. Pozycje oznaczone „(wyprowadzone)” wynikają z kodu, nie z uruchomienia.

Uwaga o forku: klasyczne GUI mumax3 startuje tylko z `-legacy-gui` (`engine/gofiles.go:35`, `cmd/mumax3/main.go:435-453`). Domyślny jest `webui/` w stylu A-MuMax, który ma już płaszczyzny XY/YZ/XZ (`webui/sec_preview_plane.go:11-22`, `cuda/resizepreviewplane.go:8-20`). Poniższy kontrakt opisuje ścieżkę klasyczną (`engine/gui.go`, `engine/render.go`, `draw/`), bo to ona definiuje „odczucie mumax3”.

## 1. Kontrolki

| Kontrolka | Zachowanie | Dowód |
|---|---|---|
| Wielkość | Lista wszystkich zarejestrowanych wielkości, sortowana bez rozróżniania wielkości liter, domyślnie `m`. Nieznana nazwa → błąd w logu, stara wielkość zostaje | `engine/html.go:246`, `engine/gui.go:143-149,397-401,547-553` |
| Składowa | `""` (całość), `x`, `y`, `z`; domyślnie całość. Dla wielkości jednoskładnikowej `x/y/z` ignorowane | `engine/html.go:246`, `engine/render.go:116,125` |
| Warstwa (slice) | Suwak; max ustawiany przy każdym odpytaniu na `Nz−1`; serwer clampuje do `[0, Nz−1]`. Etykieta `layer/Nz` | `engine/html.go:248`, `engine/gui.go:415,474`, `engine/render.go:49-55` |
| Skala | Suwak 0..31, `scale = 32 − suwak`, etykieta `1/scale`; skala podnoszona, aż `N/scale ≤ 512` w x i y | `engine/html.go:249`, `engine/gui.go:420-421`, `engine/render.go:26-27,58-70` |
| Zakres | Brak kontrolki; zawsze `auto` | `engine/render.go:122` |
| Lupa | 5×, `image-rendering: pixelated`, odświeżana co `2·tick` | `engine/html.go:37-47,254-259` |

## 2. Potok renderowania

1. Wybór jednej warstwy XY na GPU (`engine/render.go:78,95-97`). Ścieżka bez GPU ignoruje suwak i uśrednia po wszystkich z (`engine/render.go:86-88`, `draw/image.go:74-92,114-131`).
2. Zmniejszanie przez **uśrednianie blokowe** `scale × scale` kernelem CUDA `resize` (`cuda/resize.cu`, `cuda/resize.go:16-17`). Nadmiarowe komórki na brzegu są gubione (wyprowadzone).
3. Kolorowanie (§4) i nakładka strzałek (§5).
4. Kodowanie JPEG q=100, serwowane pod `/render/<q>/<comp>?<nsteps>_<eventCounter>`; URL jest tylko kluczem cache, stan żyje po stronie serwera (`engine/render.go:31-37`, `engine/gui.go:162,471-475`).
5. Render wykonuje się w `InjectAndWait`, czyli blokuje pętlę solvera (`engine/render.go:41`).

Jeden piksel obrazu = `scale × scale` komórek; rozmiar komórki jest ignorowany, a `<img>` nie ma rozmiaru CSS, więc brak fizycznych proporcji (wyprowadzone, `engine/html.go:255`). Wiersze są odwracane: oś y w górę (`draw/image.go:92,130`).

## 3. Odświeżanie

Przeglądarka odpytuje co 300 ms przy włączonym auto-update (`gui/js.go:12-13,134-140`). `img.src` zmienia się tylko, gdy zmieni się `nsteps` albo licznik zdarzeń GUI (`engine/gui.go:157-159,473`, `gui/el.go:24-28`). Odpytanie jest pomijane, gdy silnik jest zajęty (`engine/gui.go:430-432`).

A-MuMax wysyła dane przez websocket msgpack raz na sekundę, tylko przy zmianie `NSteps` (`AM/src/api/websocket.go:128-142`).

## 4. Kolorowanie

### 4.1. Pełny wektor: koło barw HSL

Wektor jest najpierw dzielony przez maksimum |v| w obrazie (`engine/render.go:110-111,127-153`), potem `HSLMap` per piksel (`draw/image.go:76-92`, `draw/hslscale.go`):

```text
s = |v|;  l = 0.5·vz + 0.5;  h = atan2(vy, vx)        // hslscale.go:9-13
s = min(s, 1);  l = min(l, 1)                         // :18-23
H = h·3/π  zawinięte do [0, 6)                         // :25-31
C = (l ≤ 0.5) ? 2·l·s : (2 − 2·l)·s                    // :33-38
X = C·(1 − |fmod(H, 2) − 1|)                           // :39
(r,g,b) = sektor(H): [C,X,0],[X,C,0],[0,C,X],[0,X,C],[X,0,C],[C,0,X]   // :43-56
m = l − C/2;  RGB = uint8(255·(r+m)), …               // :58-61
```

Efekt: +x czerwony, −x cyjan, +z biały, −z czarny, kierunki w płaszczyźnie w pełni nasycone. Gdy max |v| = 0, czynnik `1/0` daje NaN (wyprowadzone, `engine/render.go:143`).

A-MuMax używa tego samego koła dla stożków 3D: `setHSL(atan2(y,x)/2π, |v|, (z+1)/2)` (`AM/frontend/src/lib/preview/preview3D.ts:136-139`).

### 4.2. Składowa skalarna

`ColorMap` czarny→biały, liniowy, clamp do [0, 1] (`draw/colorscale.go:11-25`). Min/max to zwykłe ekstrema warstwy, bez trybu symetrycznego (`draw/image.go:51-52,100-113`); przy min == max zakres ±1 (`draw/image.go:67-70`). A-MuMax: ECharts heatmap (renderer SVG), paleta rozbieżna niebieski–biały–czerwony przy min < 0 < max, inaczej biały→czerwony (`AM/frontend/src/lib/preview/preview2D.ts:24-30,178-196`).

## 5. Strzałki

- Tylko w widoku pełnego wektora (`draw/image.go:26-28,42-49,87-89`).
- Odstęp stały: 16 pikseli obrazu (`engine/render.go:102`), czyli `16·scale` komórek.
- Siatka strzałek `N/16`, uśrednianie blokowe przez `data.Downsample` (`draw/arrows.go:14-19`, `data/resample.go:33-36`); środki w `(i + 0,5)·16` (`draw/arrows.go:22-24`).
- Każda strzałka to wypełniony trójkąt: długość `0,4·16·|m|·cos(asin(mz))` (rzut na płaszczyznę), połowa szerokości `0,2·16·|m|`; brak strzałki przy |m| = 0; kolor czarny, alfa 100 (`draw/arrows.go:52,56-73`).

## 6. Puste komórki, regiony, snapshot

- `m` poza geometrią jest zerowane (`engine/geom.go:119`) i renderuje się jako nieprzezroczysty szary (127,127,127) bez strzałki (wyprowadzone). W widoku skalarnym zera próżni wchodzą do auto min/max (`draw/image.go:52`). Uśrednianie blokowe miesza zera na brzegach geometrii (wyprowadzone).
- Regiony nie mają specjalnego traktowania; `regions` to wielkość skalarna w odcieniach szarości (`engine/regions.go:18`).
- `Snapshot` używa tego samego kodu `draw` (`engine/save.go:123-128` → `draw/encode.go:17-45`), ale z pełną rozdzielczością, średnią po wszystkich warstwach, bez normalizacji i bez wyboru składowej. `SnapshotAs` bez rozszerzenia dokleja `.ovf` i cicho zawodzi (`engine/save.go:113-115,164-165`, `draw/encode.go:29-31`).

## 7. Co przenieść do Fullmag

| Cecha mumax3 | Przeniesienie do Fullmag | Uwagi |
|---|---|---|
| Jeden rząd kontrolek: wielkość, składowa, warstwa, skala | Pasek nad mapą (D2D-01) | Stan nadal w `visualization/state.planar`, nie lokalnie |
| Koło barw HSL dla pełnego wektora | Składowa prezentacyjna `direction` (D2D-02) | Układ świata jak w mumax3; reużyć `magnetizationHslRgb` z widoku 3D (nasycenie 1 zamiast |v|, normalizacja per piksel, szary 0,6 zamiast NaN), żeby 2D i 3D kolorowały identycznie; dla pól innych niż `m` jawna legenda „tylko kierunek” |
| Półprzezroczyste strzałki nad kołem barw | Glify z grotami (D2D-04) | Długość z rzutu w płaszczyźnie jak w mumax; dodatkowo minimalna długość w px i glif normalny |
| Warstwa = indeks komórki | Tryb `cell-layer` (decyzja 7 z 31.08) | Odczyt `k / Nz−1 · z = …` |
| Uśrednianie blokowe pod limitem pikseli | Tylko jako jawny tryb podglądu dużych siatek (D2D-03) | Domyślnie 1 komórka = 1 piksel; średnia zmniejsza normę `m`, więc nie może być domyślną klatką analityczną |
| Odświeżanie tylko przy zmianie kroku lub kontrolek | Rewizja pola + tożsamość klatki | Już zgodne z doktryną field-store; w FEM wymaga taniego etapu polowego (D2D-05) |
| Oś y w górę | Zachowane | Już zgodne |
| Ten sam kod dla GUI i snapshotu | `render.png` z tej samej klatki | Już zgodne z ADR 0020 |

## 8. Czego nie przenosić

- Renderu blokującego solver (Fullmag próbkuje w API z opublikowanych pól).
- JPEG (artefakty; Fullmag przesyła surowe f64 i koloruje w workerze).
- Szarego tła próżni i zer w auto-zakresie (Fullmag ma maskę zajętości; P1-12 do naprawy).
- Braku proporcji fizycznych, osi i legendy.
- Snapshotu ignorującego warstwę i składową.
- Ograniczenia do jednej płaszczyzny XY.
- NaN przy zerowym wektorze.

## 9. Granica analogii dla FEM

mumax3 może być prosty, bo dane leżą na regularnej siatce: warstwa to wycinek tablicy, a zmiana warstwy to zmiana offsetu. W FEM nie ma warstw danych, a wartość w pikselu wymaga lokalizacji elementu i ewaluacji funkcji kształtu. Parytet ergonomii dla FEM (ta sama kontrolka „Warstwa”, ta sama szybkość odświeżenia przy nowym kroku) wymaga więc innej mechaniki pod spodem; projekt jest w [04-projekt-techniczny-fem.md](04-projekt-techniczny-fem.md).
