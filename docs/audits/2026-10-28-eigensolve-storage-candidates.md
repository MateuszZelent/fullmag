# Kandydatury do sprzątania i wykonanie zatwierdzonego zakresu

Pomiar: 28.10.2026, podczas prac R6. WSL miał około 8,2 GiB wolnego.
`docker system df` raportuje logiczne rozmiary; nie są gwarancją fizycznego
odzysku na tym samym filesystemie WSL. Nie sumować współdzielonych warstw.

| Wolumen | Rozmiar Docker | Właściciel | Decyzja |
|---|---:|---|---|
| `fullmag-dev-frontend-v1-6239a470f4798b23cb3e57a4` | 2,246 GB | Nasz eigensolve worktree | USUNIĘTY po zgodzie i ponownej kontroli konsumentów/mountów. |
| `fullmag-dev-frontend-v1-c2bd34ffdab03a6c0b2cafe2` | 1,893 GB | Nasz eigensolve worktree | USUNIĘTY w tym samym zatwierdzonym zakresie; łącznie około 4,139 GB logicznie. |
| `fullmag-backend-v2-de1be49a7270132c394b357f-package` | 102,5 GB | Nasz eigensolve worktree | Zero konsumentów, ale NIE zatwierdzony do usunięcia: trzeba sprawdzić pakiety current/rollback, receipty i odwołania do wyników. Największy cel dalszej kwalifikacji. |
| `fullmag-backend-v2-ec13b2f2a8724a5065e3d575-build` | 17,15 GB | `fullmag-902a54b7b1f633a7` | Obcy cache, zachować; wymaga kwalifikacji i potwierdzenia użytkowników. |
| `fullmag-backend-v2-a52f715810d41f9a54a6b8aa-build` | 11,78 GB | `airbox-independent-visualization-65e40c0dae79e47a` | Obcy aktywny worktree; zachować. |
| `fullmag-backend-v2-7ee48d9c6ed5820950e670d3-build` | 11,33 GB | `fullmag-8a0aa9b8c1577182` | Obcy cache; zachować. |
| `fullmag-backend-v2-36435b5f6dd33e7bcf7f99cd-build` | 11,17 GB | `viewport-visual-quality-wsl-2026-9eae6bc3c8a0ae8d` | Obcy cache; zachować do kwalifikacji właściciela. |

Adres każdego celu w Dockerze: `/var/lib/docker/volumes/<nazwa>/_data`.
To ścieżka demona Docker, nie potwierdzona lokalizacja na dysku C: ani E:.

Źródła dowodów: `r6-runtime-split-20261028/docker-disk-inventory.txt`,
`unused-fullmag-volume-candidates.json`, `candidate-consumers.json` w katalogu
wizualizacji tego wątku. Inwentarz obejmuje również zatrzymane kontenery.

Nie uruchomiono `maintain-cache`, ponieważ ta komenda usuwa dane i nie oferuje
trybu preview. Na etapie samej analizy nie uruchomiono prune ani usuwania wolumenów.
Późniejsza odrębna zgoda i wykonanie są opisane poniżej.

Potwierdzenie po odtworzeniu usług: frontend `5cf828b9bfca` używa
`fullmag-dev-frontend-v1-b9e273a0aa14723960b0b073` pod `/state/development`,
wspólnego pnpm i control. Nie używa dwóch wymienionych starych cache.
Oba stare wolumeny ponownie miały zero konsumentów (także zatrzymanych).
Są kandydaturami do osobno zatwierdzonego usunięcia całych technicznych
cache frontendu; przed wykonaniem trzeba powtórzyć sprawdzenie mountów.

## Wykonanie po odrębnej zgodzie użytkownika

Użytkownik zatwierdził wyłącznie dwa wymienione cache frontendowe. Ponowiono
kontrolę etykiet, wszystkich konsumentów i mountów aktywnego frontendu, po czym
usunięto dokładnie te dwa wolumeny przez `docker volume rm` bez force. Wynik
`succeeded`; ponowna lista wolumenów potwierdziła brak obu nazw.

Receipt: `r6-runtime-split-20261028/frontend-cache-removal.json`.
Logiczna wielkość usuniętych wolumenów: około 4,139 GB. Wolne miejsce WSL
przed: 8783601664 bajtów, po: 8783925248 bajtów — nie jest to dowód odzyskania 4,139 GB na WSL.
Równolegle trwały zapisy innych grup. Nie zmierzono fizycznego odzysku na
filesystemie demona Docker. Wolumen 102,5 GB i wszystkie obce cache pozostają.

## Rozdzielenie filesystemów

Po sprawdzeniu mountów: `/build`, `/opt/fullmag/package` i control w naszym
kontenerze znajdują się na filesystemie demona `/dev/sde` (około 179 GiB wolnego).
Sesje `/state` znajdują się na `/dev/sdd` (około 8,2 GiB wolnego). Wcześniejsza
sugestia, że 8,2 GiB jest bezpośrednim ograniczeniem przestrzeni buildu, była
nieprecyzyjna. To ograniczenie storage sesji/wyników; przestrzeń buildu trzeba
mierzyć osobno. Wynik `docker system df` nie zastępuje tych pomiarów.
