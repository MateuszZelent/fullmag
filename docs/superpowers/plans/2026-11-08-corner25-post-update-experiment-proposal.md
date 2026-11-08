# Corner25 po aktualizacji: przygotowanie i jeden warunkowy V/J/H

Status: propozycja do decyzji; żadne z opisanych poniżej przygotowań lub
obliczeń nie zostało uruchomione. Dotychczasowe zgody na pojedyncze próby
przygotowania zostały wykorzystane. Zgoda na ostatnią aktualizację wykluczała
nowe Prepare i Solve.

## Cel

Sprawdzić, czy rzeczywiście drobniejsza siatka przy ośmiu narożach redukuje
korektę zachowawczego prądu względem zachowanego local50
(eta=0,03464604656814306). Następnie porównać V/J/H przy tej samej fizyce.
Nie zmieniamy progów ani modelu w celu osiągnięcia zgodności z publikacją.

Wariant corner25 jest już fizycznie zdefiniowany i zatwierdzony.
Poprzednie przygotowanie wytworzyło 40783 Tet4, ale stary CLI odrzucił
nowe flagi authoringu przed utworzeniem gotowego requestu. Błąd zgodności
pakietu usunięto przez zakończoną aktualizację 3203.

## Konkretny zakres do zatwierdzenia

1. Jedna istniejąca recepta docker-dev-gsg-mesh-prepare z level=corner25,
   w obecnym worktree/grupie. Zachować dotychczasowy cache; jego poprawny
   odczyt może uniknąć Gmsh, ale nie gwarantujemy cache hit.
2. Odebrać gotowy compact request, piny, nośniki i terminalny receipt.
   Porównać fizykę z przypiętym wejściem; zapisać SHA gotowego requestu.
3. Wyłącznie po pełnym poprawnym odbiorze: jedno Submit tego requestu przez
   docker-dev-submit-accepted, z własnym trwałym fence. Brak wcześniejszego
   run_id, zgodny opublikowany profil i wolne zasoby są warunkami startu.
4. Śledzić dokładnie ten run/task do stanu terminalnego; zachować i odczytać
   V/J/H przez publiczne API. Porównać eta i bilanse z zachowanym local50,
   a H na tych samych 20 punktach. Wyniki i wymagane dane zachować na WSL.

Odmowa przygotowania, niespójność wejść lub przekroczone istniejące limity
kończą zakres przed Submit. Odmowa Submit lub Failed solvera kończy serię,
bez kolejnego zgłoszenia lub automatycznego retry. Wygaśnięcie obserwacji
nie oznacza prawa do ponownego Submit. Nie zmieniamy starej historii/fence.

## Zamrożone wejścia

| Wejście | SHA256 |
|---|---|
| gsg_junction_prepare_corner25nm.py | d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148 |
| gsg-convergence-targets.fullmag-mesh | c0db256c8bf0d5c545123ac9d4154388c74081a74304f02912151ea8d9a52178 |
| Poprzedni cache corner25 | 69c7e3322e25fcf309c8eab7698e5b724f4aad6fe51e0c67a82f7704622b06c3 |
| execution-profile.json | 6c88e13526ec18ba0ba2b8f11d200e83ab21f6cea94194af250cf567c298b786 |
| resources-compute.json | aa994c72762e534f059310e821af35470d894ed13cfe3cbd5f7b3b235cf8adcc |

Wejścia pozostają w istniejącym runtime-free-inputs-v1 opisanym w
[wykonanym planie corner25](2026-11-07-gsg-corner25-prepare-proposal.md).
Ponownie sprawdzono wszystkie 10 FIXED_FILES: pełne SHA zgodne.

Rozmiary zadane: 25 nm przy narożach, 50 nm w pozostałych połączeniach,
75 nm na paskach. Ten sam pełny obwód GSG, przewodność, źródło napięciowe,
cięcie i normalizacja. H na tym samym nośniku 20 węzłów / 24 Tet4.
Nie używać prostszego eksportu przywróconej sceny jako zamiennika tego wejścia.

## Runtime, limity i preflight

Worktree: /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011.
Grupa: fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
Development attempt: 894d4efb43eb483eb6179d8d49fd449e.
Config: 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4.
Backend: 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Pakiet: 571513d2972cab78f3e355d0171fde51f3915b2955d875ed6c5664108b7f7578.
Snapshot: 08b4e431e3fefee766ff997dc73ca65de7ed9f1dbd945bf2b7524dcd6bab810c.

Odczytowy qualified_backend przeszedł dla obecnej inkarnacji i archiwum.
Publiczny katalog ma exec:default@1 o SHA256
419204a3ebb26a08b0e75f834c8f2a2bd6056c3804876cfff8067ec10347554e.
Kolejka pusta, active_workers=0, draining=false, brak aktywnej operacji control.
Ponowić te kontrole bezpośrednio przed wykonaniem.

Pozostają istniejące: FEM CPU/double/strict, żądanie 1 CPU i 4 GiB RAM,
512 MiB storage, 0 GPU; volume_inspection_v1 bez zmiany tolerancji/budżetów.
Helper przygotowania: 1 CPU i 4 GiB przestrzeni adresowej, co nie jest
gwarancją limitu rzeczywistego RAM. Request do 96 MiB, spool do 256 MiB.
Oba dotychczasowe warunki >72911 komórek i >4 mln par muszą być false.
Nie zwiększamy limitów kontenera ani żadnego z tych progów.

Bez buildu, restartu, usuwania danych, H-only, kolejnych poziomów siatki,
LLG, nowych profili lub rozszerzenia recovery. Nie obiecujemy czasu nowej
próby przed pomiarem. Pole i diagnostyki pozostają inspection-only;
jedna mniejsza eta nie odblokowuje automatycznie bazy ani reprodukcji Fig.3.

## Kryteria odbioru

Gotowy request i Succeeded oznaczają wykonanie eksperymentu dopiero po
odczycie rzeczywistych V/J/H z tym samym zaakceptowanym stanem prądu.
Osobno raportujemy, czy eta spadła i czy spełniono dotychczasowe bramki.
Failed zachowuje logi i wyniki częściowe, ale nie stanowi odbioru naukowego.
Reprodukcja publikacji pozostaje otwarta do dalszych wymaganych walidacji.
