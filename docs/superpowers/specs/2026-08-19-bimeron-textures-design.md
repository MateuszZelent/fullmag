# Design: bimeron i prawoskrętne bazy tekstur magnetycznych

**Status:** zaakceptowany przez użytkownika 2026-08-19  
**Zakres:** crates/fullmag-plan, publiczny Python DSL, Control Room v2 oraz
legacy catalog referencyjny

## Cel

Dodać analityczny preset "bimeron" opisujący in-plane odpowiednik skyrmionu i
usunąć wspólny błąd orientacji płaszczyzny "xz", który wpływa na wszystkie
presety korzystające z helperów plane_coords i plane_vec_to_world.

Implementacja zachowa dotychczasowe wyniki dla "xy" i "yz". Korekta "xz" będzie
stosowana jednocześnie w evaluatorze Rust oraz referencyjnym evaluatorze
Python, aby FDM/FEM i ścieżka Python miały ten sam kontrakt znaków.

## Kontrakt fizyczny

Tekstura jest definiowana w prawoskrętnej lokalnej bazie (u, v, n):

- "xy": (u, v, n) = (+x, +y, +z);
- "xz": (u, v, n) = (+x, +z, -y);
- "yz": (u, v, n) = (+y, +z, +x).

Dla r = hypot(u, v) oraz phi = atan2(v, u) profil bimeronu ma postać:

~~~text
theta(r) = 2 atan(exp((r - R) / Delta))
         + 2 atan(exp((r + R) / Delta)) - pi
phase    = vorticity * phi + helicity_rad
m_u      = -background_sign * cos(theta)
m_v      = -background_sign * sin(theta) * sin(phase)
m_n      = -background_sign * sin(theta) * cos(phase)
~~~

W kodzie profil będzie liczony stabilnie jako:

~~~text
asin(tanh((r - R) / Delta)) + asin(tanh((r + R) / Delta))
~~~

Parametry radius (R) i wall_width (Delta) są długościami w metrach,
helicity_rad jest kątem w radianach, a vorticity i background_sign są
bezjednostkowymi znakami ograniczonymi do -1 albo +1. radius i wall_width
muszą być dodatnie.

Nie zmieniamy osobno semantyki TextureProjectionMode; projekcja pozostaje
mapowaniem współrzędnych, a parametr plane pozostaje wyborem lokalnej bazy
presetu. Testy obejmą kombinacje używane obecnie przez pipeline, aby nie
ukryć błędu pomiędzy tymi dwoma poziomami.

## Granice zmian

### Backend i referencja Python

- magnetization_textures.rs dostaje bimeron_theta, eval_bimeron oraz
  dispatcher "bimeron".
- plane_coords i plane_vec_to_world dostają prawoskrętną korektę "xz".
- Python texture.bimeron() serializuje ogólny PresetTexture; nie zmieniamy
  InitialMagnetizationIR, ponieważ preset_kind jest już String, a parametry są
  BTreeMap<String, Value>.
- preset_eval.py odtwarza tę samą funkcję i lokalną bazę.
- Python runtime traktuje bimeron jako preset metryczny, więc clamp nie skaluje
  jego fizycznych parametrów.

### Control Room v2

Katalog, typ unii, draft model, serializacja parametrów panelu oraz komendy
authoringu dostają bimeron z parametrami plane, radius, wall_width,
vorticity, helicity_rad i background_sign. Stan pozostaje lokalnym draftem
inspektora; zatwierdzenie nadal przechodzi istniejącą komendą i resource
invalidation. Nie powstaje nowa ścieżka transportowa ani endpoint.

### Legacy UI

apps/legacy_web pozostaje reference-only zgodnie ze strategią migracji. Zostaną
zaktualizowane wyłącznie typy/katalog i metryczna semantyka dopasowania, aby
legacy nie odrzucał poprawnego serializowanego presetu i nie stosował błędnego
skalowania. Nie dodajemy nowej legacy-only architektury ani osobnego transportu.

### Dokumentacja

Nota docs/physics/0530-magnetic-preset-textures.md zostanie rozszerzona o
bimeron, prawoskrętną bazę, wszystkie cztery lane'y FEM/FDM CPU/GPU, mapowanie
Python -> IR, ograniczenia stabilności oraz walidację. Powstanie sąsiedni
0530-magnetic-preset-textures.source-map.json.

## Testowanie i bramy akceptacyjne

Testy Rust sprawdzą: środek -u, dalekie tło +u, przeciwne znaki rdzeni
out-of-plane, normę, walidację parametrów, znak vorticity oraz kierunki "xz"
dla vortexu/skyrmionu/bimeronu.

Testy Python sprawdzą tę samą charakterystykę, stabilność dla bardzo małego
wall_width, serializację texture.bimeron, round-trip SceneDocument,
referencyjną orientację "xz" i runtime’ową listę presetów metrycznych.

Testy TypeScript sprawdzą katalog, domyślny draft, zmianę presetu, parametry
assetu i komendę assign. Typecheck Control Room pozostaje obowiązkowy.

Akceptacja wymaga przejścia testów skupionych oraz formatowania/typechecku.
Wynik nie będzie przedstawiany jako dowód dynamicznej stabilności LLG ani jako
kwalifikacja GPU; preset jest analitycznym warunkiem początkowym.

## Poza zakresem

- brak nowego wariantu |vorticity| > 1;
- brak automatycznego obliczania ładunku topologicznego w runtime;
- brak zmiany znaków istniejących presetów w "xy" lub "yz";
- brak zmiany ProblemIR enumu, OpenAPI i transportu;
- brak promowania bimeronu do równowagowego rozwiązania LLG bez osobnej
  kwalifikacji fizycznej.
