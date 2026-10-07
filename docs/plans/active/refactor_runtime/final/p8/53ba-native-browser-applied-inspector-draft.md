# P8-53BA — zatwierdzony szkic Inspectora po natywnym restarcie

Data: 06.10.2026. Bramka P8-53, ścieżka Apply. AZ potwierdził odmowę
przy szkicu i jawny Revert; ta próba ma potwierdzić zachowanie zmiany
zatwierdzonej do kanonicznej sceny. Nie jest to wykonanie solvera.

## Kryteria odbioru

1. Niepusty model z geometrią, regionem i przypisanym materiałem.
2. Zmiana anizotropii w Inspectorze bez Apply tworzy rzeczywisty lokalny szkic.
3. Jawny Apply Anisotropy aktualizuje kanoniczną scenę; panel wskazuje committed,
   a lokalny dirty state ustępuje po ACK zasobu.
4. Dopiero po Apply następuje capture aktualnej sceny i dirty project document.
5. Normalny restart stosuje gotowy D, zachowując moduł anizotropii i jego
   parametry oraz dokładny dokument projektu; nowy API/session scope.
6. Viewport visible, contextLost false, niezerowy drawing buffer.
7. Brak silent Discard ani drugiego submit po pending/unknown.
8. Wszystkie własne procesy terminalnie odebrane.

## Trasa i stan

`just verify-windows-development-workspace-browser efc0a57a5be44d8894eee537d9b86298`
korzysta z uprzednio sprawdzonych C i D; nie kompiluje ponownie backendu.
Produkt pochodzi z frozen D, a strona diagnostyczna ma odrębny snapshot
i SHA-256. Runtime receipt i dodatkowe obserwacje CUA pozostają oddzielnymi
dowodami. Publiczny restart i cały plan pozostają otwarte.

## Wynik — PASS

Receipt `02254ad5af7e419db05d32657dfe78cf`: **completed, exit 0**, 7 kontroli.
Produkt frozen D; bieżąca diagnostyka SHA-256
`6fea8ec8756c99b1ec980e754bab4ce631f74e1ed199bd960017a6fe59ca23b0`.
NoEmit i lint staged route exit 0. Nie wykonano nowego buildu backendu ani
kompilacji testów jednostkowych.

Przez zwykłe UI utworzono Thin Film `new-thin-film-muvyx17q`, region
`Applied draft region` i przypisano `mat:new-thin-film`. Present checked
i Ku1 `34567` utworzyły lokalny szkic (Apply Inspector enabled). Następnie
Apply Anisotropy dał ACK: `Uniaxial anisotropy updated.`, scena revision 5,
scene/material fetch ready i Apply Inspector disabled. Nie użyto Revert.

Kanoniczna scena z receiptu zawierała na tym samym obiekcie:

```json
{
  "kind": "uniaxial_anisotropy",
  "enabled": true,
  "params": {"axis": [0, 0, 1], "ku1": 34567}
}
```

Capture nastąpił po Apply. Restart backend i Check restart dotyczyły jednego
intentu; nowy kernel został opublikowany bez reload. Po odtworzeniu wybrano
`Magnetic Parameters +1`: Present checked, Ku1 `34567`, oś `[0,0,1]`,
scena revision 5, mode committed, scene/material ready. Dokładne porównanie
całej sceny obejmuje również `physics_stack`, a nie tylko liczniki encji.

| Własność | Przed | Po |
|---|---|---|
| API PID / pin | 10036 / `dca5cd63-d623-4de8-9f71-20c54002c7ff` | 86772 / `f0617481-722a-439d-b013-ecb38cdf1100` |
| Session ID | `session-18dbcab1d01a56f800002734` | `session-18dbcae2ccd62eb4000152f4` |
| Kernel generation / paused | 0 / false | 1 / false |
| Project document | `project-5a52233bd3024a0abe626aa8953f4d3b`, revision 2, dirty true | identyczny |
| Archive SHA-256 | `19196f0806fc37173c1f15531b28e256e496b415ce24962213c67320ff4627ee` | identyczny |
| Document scene SHA-256 | `dd86522410349259969ed7269ff69f9fe5fdcfacf5c7a0c3596c91fd811405b3` | identyczny |
| WebGL | visible, contextLost false, 706×281 | visible, contextLost false, 706×297 |

Finish proof został potwierdzony (`verified:true`). Jedna późniejsza
obserwacja DOM miała timeout CDP; odczyt AX tej samej karty potwierdził
ukończony wynik. Nie odświeżono karty i nie wysłano drugiego intentu.
W trakcie owned teardown UI zgłosiło utratę API, co nie zostało pomylone
z błędem odtworzenia. Własna karta 14 została zamknięta.

Wszystkie 13 native/source procesów waited: initializer, CLI, noEmit, lint,
stare API i 7 helpers exit 0; nowe API exit 1 w owned teardown. Next również
waited exit 1. Rezultat wrappera jest terminalny, exit 0.
Screenshots i pełne DOM zachowano w katalogu visualizations zadania:
`fullmag-applied-draft-before.jpg`, `fullmag-applied-draft-before-dom.txt`,
`fullmag-applied-draft-restored.jpg`, `fullmag-applied-draft-restored-dom.txt`.
Parametry Inspectora i WebGL są dodatkowymi dowodami CUA; receipt sam nie
zapisuje parametrów canvas. Screenshot odtworzonego viewportu został obejrzany.

## Pozostałe bramki P8-53

Zamknięta jest ścieżka Apply jednego szkicu anizotropii w idle FDM workspace,
nie wszystkie formularze ani kwalifikacja fizyki. Read-only inventory
dotychczasowej bramki native (receipt `fab9fb906f4b49acaf139b54c3a6177b`,
287 checks) wykazało pusty resident service i syntetyczne store/lease fixtures.
Nie jest to dowód odmowy restartu podczas działającego solve ani wyścigu
rzeczywistego Start z freeze. Następny test musi obserwować rzeczywisty
worker: freeze wygrywa → Start 409 bez dispatch; Start wygrywa → restart
odrzucony bez zatrzymania zaakceptowanej pracy. Publiczny restart i procenty
całego planu pozostają bez awansu do tych dowodów.
