# P8-53CS — fazowy mesher: dowody negatywne i retencja

Data: 15.10.2026. Źródła prób: `86adb08f82fcb927c691ff6f5676b3668dc9b555`
z lokalnym numeric WIP. Nie wdrożono fazowego kandydata do produkcyjnego
generatora. Wyniki nie podnoszą procentów P0–P8.

## Faktycznie wykonane próby

| Receipt | Wynik |
|---|---|
| `323e49c5cc224b14b0b75a1ab9642650`, `44b3279634d243febd60fc90259b8f49` | Driver FAILED, child exit 2; dziesięć wcześniejszych obserwacji zachowano, fazowa próba nie została poprawnie odebrana z powodu błędu przywracania stanu. Nie są dowodem zachowania meshera. |
| `d72bda9045624b6d8424b0e4cc9e9413` | 10 observed + 2 error; faza air odtworzyła 96 prismów zamiast zachować 288 tetraedrów. |
| `4e7237f76e664bd4a871e058bb790e8c` | Wyłączenie widoczności ukończonych volume entities w fazie air dało ten sam błąd 288→96. |
| `befc77910a74495b8e3cf35adf944174` | Usunięcie zużytych constraints wyłącznie z magnetycznych volume entities także nie zatrzymało odtworzenia prismów. Nie usuwano constraints powierzchni ani PBC. |
| `77021568d4d544d196b9fa67466e5f70` | Dodatkowy surowy odczyt po fazie air potwierdził zmianę body XY; nie jest to wyłącznie zmiana reprezentacji prism/tet. |

Cztery końcowe receipty mają driver `completed`/exit 0, ponieważ zebrały
zamknięty zestaw 12 prób, ale dwie próby fazowe mają **status error**.
Źródła były stabilne, procesy odczekane, bez timeout/terminate/kill.
Obie próby fazowe przywróciły opcje i widoczność Gmsh.

W ostatnim receipcie body XY po konwersji fazy magnetycznej i po fazie air:

| Authored air target | Po fazie magnetycznej | Po fazie air |
|---|---|---|
| 30 nm | `cfde72dc4908edae368648415002c8596e0658bbb9341595311a1ad3c0798630` | `899b245f7abbf499c0ac7f2d8f632696f00433750d1250c555f69fbadeeb82c0` |
| 50 nm | `c1dd74d3d58fa9a3580adb003bd4f15ae5831187deea0e28d793bbb9c2c0602f` | `0ae106a140d56625f95ac4d164271684cfe44bf1a751db36fe69359f546360f5` |

Zatem także pierwsza faza nie osiąga niezależności od authored air target.
Samo rozdzielenie wywołań `generate(3)` nie naprawia problemu. Dalsza diagnoza
musi rozdzielić zależności konstrukcji CAD/source entities od pól aktywnych
na ich zależnościach; nie wolno zadeklarować, że winne są wyłącznie tagi CAD.
Nie złagodzono oryginalnej asercji owner XY, PBC ani L+1 planes.

## Ocena danych po etapie

Zastosowano skill `fullmag-build-stage-cleanup`. Resolver wskazuje katalog:
`C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\windows-exact-layer-mesh-diagnostics`.
Każdy poniższy cel to jego podkatalog o dokładnym ID receiptu.

| ID celu | Bajty plików | Decyzja i dowód |
|---|---:|---|
| `323e49c5cc224b14b0b75a1ab9642650` | 561596 | Zachować failed receipt i log błędu drivera |
| `44b3279634d243febd60fc90259b8f49` | 561595 | Zachować failed receipt i log przywracania stanu |
| `d72bda9045624b6d8424b0e4cc9e9413` | 613670 | Zachować negatywny baseline fazowy |
| `4e7237f76e664bd4a871e058bb790e8c` | 613670 | Zachować kontrolę widoczności |
| `befc77910a74495b8e3cf35adf944174` | 614677 | Zachować kontrolę volume constraints |
| `77021568d4d544d196b9fa67466e5f70` | 633052 | Zachować surowe odciski body XY |

To własne wykonania drivera rozpoznane przez receipty i odczekane procesy,
nie przez samą nazwę katalogu. Logi, manifesty, źródła wariantów i obserwacje
pozostają potrzebne do diagnozy; nie ma dowodu zbędności ani planu usuwania.
Ponowna ocena dopiero po odebraniu poprawki meshera i zapewnieniu trwałego
archiwum dowodów. Nie wykonano usuwania, migracji storage ani prune.
Zmierzono 88403787776 wolnych bajtów na woluminie katalogu runów; nie jest
to pomiar odzyskanego miejsca ani gwarancja szczytu kolejnego ciężkiego buildu.

## Integracja niezależnych napraw

Naprawy fixture aplikacji opisane w 53CR opublikowano jako
`90d35237d529ad55e9a30a868e11473eb7399bad`. Odbiór CI pozostaje wymagany.
Cały plan nadal **IN PROGRESS**. Historyczny restart A→B→C z panelu UI nie
jest już bramką produktu po decyzji z 14.10.2026; aktualny Windows workflow
wymaga zapisu projektu, zakończenia workspace i jawnego ponownego startu CLI.
