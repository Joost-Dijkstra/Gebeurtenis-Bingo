# Party Bingo MVP

Mobile-first realtime bingo webapp voor feestjes en sociale bijeenkomsten. In plaats van cijfers speelt iedereen met gebeurtenissen die door de groep zelf zijn toegevoegd.

## Bestanden

- `index.html`: single-page interface
- `style.css`: mobile-first styling
- `app.js`: frontend logica, realtime updates en RPC-calls
- `supabase.sql`: database schema, RLS, realtime-publicatie en RPC-functies

## Snelle setup

1. Maak een Supabase-project aan.
2. Open de SQL editor in Supabase en voer `supabase.sql` uit.
3. Open `index.html` in een browser voor lokaal testen, of serve/publiceer de map via een simpele static server.
4. Plak in de app je Supabase project URL en anon key.
5. Maak een lobby of join met een code.

## MVP flow

1. Host maakt een lobby aan.
2. Alle spelers voegen gebeurtenissen toe aan een gezamenlijke lijst.
3. Host sluit de gebeurtenissenfase.
4. Host kiest `3x3` of `4x4`.
5. Iedere speler kiest exact zijn eigen kaart.
6. Host start het spel.
7. Iedereen kan gebeurtenissen wereldwijd markeren als `gebeurd`.
8. Kaartvakjes worden automatisch afgevinkt en bingo wordt live gedetecteerd.

## Extra spelregels in deze versie

- Spelers kunnen in de kaart-bouwfase hun gekozen gebeurtenissen nog herschikken binnen de kaart via touch-drag.
- Er zijn twee doorlopende klassementen:
- `Eerste rij`: horizontaal, verticaal of diagonaal.
- `Volle kaart`: volledige kaarten met plek 1, 2, 3, enzovoort.
- Een volle kaart stopt het spel niet; de ranglijst blijft doorgaan.

## Andere spelers uitnodigen

- Een spelcode alleen is niet genoeg; andere spelers moeten ook dezelfde webapp kunnen openen.
- Als je de app opent via een lokaal bestandspad zoals `E:/.../index.html`, werkt die URL niet op andere telefoons.
- Gebruik voor echte multiplayer dus een publieke URL, bijvoorbeeld via Netlify, Vercel, GitHub Pages of een eigen webserver.
- Vul die publieke URL daarna optioneel in de app in als `Publieke app URL`, zodat de knop `Kopieer link` meteen een bruikbare uitnodiging maakt.

## GitHub Pages

- Deze app werkt als statische site op GitHub Pages.
- `index.html` is de startpagina en gebruikt relatieve paden naar `style.css` en `app.js`, dus hosting vanuit de repository root werkt goed.
- Na publicatie kun je in de app als `Publieke app URL` je GitHub Pages URL invullen, zodat gedeelde invite-links direct correct zijn.

## Architectuurkeuzes

- Alle writes lopen via Supabase RPC-functies.
- Spelers krijgen een lokale sessietoken per browser, zodat gevoelige acties niet alleen op een zichtbaar player id leunen.
- Realtime updates luisteren op `games`, `players`, `events` en `player_card_entries`.
- Scorebord en kaartstatus worden client-side afgeleid uit de live data.

## Belangrijke MVP-beperkingen

- Er is geen volledig auth-systeem; sessies zijn browsergebonden.
- De host kan het spel pas starten als alle gejoinde spelers een complete kaart hebben opgeslagen.
- De UI gebruikt browser prompts voor snelle host-correcties en merges, zodat de MVP compact blijft.
- Voor een bestaand Supabase-project met de eerdere versie gebruik je [migration-awards-and-layout.sql](E:/eigen apps/Gebeurtenis Bingo/migration-awards-and-layout.sql) om de nieuwe awards-tabel en triggerlogica toe te voegen.
