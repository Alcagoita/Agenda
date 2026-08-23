# KAN-397 — learned name keywords (PT)

Training rows: **302,031** (`poi` joined to `poi_type`, so a place that is two things teaches both).

Thresholds: support >= 15, lift >= 4.0, precision >= 0.35.

## Does it rediscover the hand-written list?

The validation that matters. If the method cannot re-find terms a person already found in a language we read, it cannot be trusted with one we do not.

| | |
|---|---:|
| Hand-written terms (KAN-391) | 35 |
| Rediscovered | 29 |
| Missed | 6 |
| Agreed on the type | 28 |
| **Disagreed on the type** | **1** |
| New terms proposed | 2125 |

### Disagreements — read these first

The method chose a different type than the person did. Each is either a product call the data cannot see, or a hand-written mistake.

| token | hand-written | learned | support | precision | lift |
|---|---|---|---:|---:|---:|
| `barbeiro` | barber | hairdresser | 60 | 0.67 | 28.3 |

### Missed by the method

```
floricultura -> florist, manicure -> nail_salon, pedicure -> nail_salon, tatoo -> tattoo, tatuagem -> tattoo, tatuagens -> tattoo
```

## Verdict

**The method is sound enough to use on a language nobody here reads.**

It rediscovered 29 of 35 hand-written terms and agreed with the person on 28 of
them. The one disagreement is exactly the kind the ticket predicted: `barbeiro`
learns as `hairdresser` because most rows named that carry hairdresser tags,
while the hand list says `barber` — a barbeiro is a men's barber, which is a
product call the corpus cannot contain. That is the argument for human approval
in one row.

The six misses are honest limits, not tuning opportunities:

```
floricultura 11 rows · tatuagem 5 · tatuagens · tatoo · manicure · pedicure
```

All below the support floor. Lowering it to catch `tatuagem` at 5 rows is how
one oddly named venue becomes a rule, so the floor stays and a person keeps the
right to add a term the corpus is too thin to prove.

## What it found that the hand list did not

```
biblioteca            library        473 support   0.95 precision
assistencia tecnica   phone_repair   137           0.70
paragem carris        bus             27           1.00
paragem stcp          bus             26           1.00
tattoo studio         tattoo          33           1.00
ink                   tattoo          22           0.85
sapateiro             shoe_repair     33           0.58
arranjos              clothing_repair 34           0.62
```

`biblioteca` matters: `library` is one of the thinnest types in the app, and 473
supporting rows is a large fraction of it. `paragem carris` and `paragem stcp`
are the Lisbon and Porto operators — `bus` sits at 778 nationally, so operator
names are most of what identifies a stop by name.

`ink` is worth calling out because it contradicts an earlier judgement of mine.
While chasing tattoo studios by hand I dismissed `ink` as a false-positive trap,
having matched it as a substring where it hits "Drink" and "Pink". Tokenized
with word boundaries it is 85% precise for `tattoo`. The trap was in my matching,
not in the term.

It also independently proposed `sapateiro`, `arranjos` and `costureira` — the
exact terms hand-written for KAN-411 a day earlier, arrived at from the data
alone. That is the clearest evidence the approach transfers.

## Spanish terms inside Portuguese data

```
educacion · educacion infantil · infantil primaria · apuestas · luckia · recambios
```

These carry real support in rows labelled `country = 'PT'`. They are the
border-town leakage noticed during KAN-411 (`Ferretería`, `Brico Centro
Extremeño`), now measurable rather than anecdotal.

`recambios` is the clearest damage: it means auto parts, and it predicts
`currency_exchange` at lift 1,952 with the lowest precision in the top twenty
(0.48). A term that wrong, that high in the ranking, is a signal about the
corpus rather than the language.

**Until the country boundary is cleaned, a learned PT pack will keep proposing
Spanish vocabulary.** That is a prerequisite for trusting this per country, and
it is not fixed here.

## Recommended shape

* per-country packs, not one global map that grows forever
* a person accepts or rejects each term; never auto-applied
* keep the two-list split — 1,303 terms for types the app ships are actionable,
  822 for types it does not are evidence for KAN-400, and mixing them wastes the
  reviewer's attention
* re-run after any country-boundary fix, since the Spanish terms should vanish

## Not done here

No classifier change. The ticket asks for the candidate list and the comparison
first, and deliberately leaves `NAME_TYPE_KEYWORDS` untouched until the
comparison justifies changing it. It now does — but approving 1,303 terms is a
separate piece of work with a person in it.

## Proposed terms for types the app ships

1303 terms. These are the actionable list — nothing is applied, a person accepts or rejects each.

| token | type | support | occurrences | precision | lift |
|---|---|---:|---:|---:|---:|
| `western union` | money_transfer | 25 | 26 | 0.96 | 6313.4 |
| `sapateiro` | shoe_repair | 33 | 57 | 0.58 | 4996.0 |
| `costureira` | clothing_repair | 15 | 24 | 0.62 | 3775.4 |
| `arranjos` | clothing_repair | 34 | 55 | 0.62 | 3734.2 |
| `centro educacion` | school | 27 | 30 | 0.90 | 2284.3 |
| `educacion infantil` | school | 33 | 39 | 0.85 | 2147.6 |
| `infantil primaria` | school | 29 | 35 | 0.83 | 2103.0 |
| `recambios` | currency_exchange | 32 | 66 | 0.48 | 1952.5 |
| `educacion` | school | 34 | 50 | 0.68 | 1725.9 |
| `tattoo studio` | tattoo | 33 | 33 | 1.00 | 733.1 |
| `tattoos` | tattoo | 33 | 33 | 1.00 | 733.1 |
| `tattoo shop` | tattoo | 16 | 16 | 1.00 | 733.1 |
| `piercing` | tattoo | 20 | 22 | 0.91 | 666.4 |
| `ink` | tattoo | 22 | 26 | 0.85 | 620.3 |
| `tecnica equipamentos` | phone_repair | 15 | 21 | 0.71 | 478.4 |
| `assistencia tecnica` | phone_repair | 137 | 196 | 0.70 | 468.1 |
| `biblioteca publica` | library | 53 | 54 | 0.98 | 459.6 |
| `biblioteca municipal` | library | 279 | 286 | 0.98 | 456.8 |
| `publica municipal` | library | 26 | 27 | 0.96 | 450.9 |
| `biblioteca` | library | 473 | 500 | 0.95 | 443.0 |
| `paragem carris` | bus | 27 | 27 | 1.00 | 388.2 |
| `paragem stcp` | bus | 26 | 26 | 1.00 | 388.2 |
| `gare routiere` | bus | 19 | 19 | 1.00 | 388.2 |
| `terminal rodoviario` | bus | 87 | 90 | 0.97 | 375.3 |
| `camionagem` | bus | 28 | 29 | 0.97 | 374.8 |
| `central camionagem` | bus | 27 | 28 | 0.96 | 374.3 |
| `stcp` | bus | 41 | 43 | 0.95 | 370.2 |
| `estacao rodoviaria` | bus | 17 | 18 | 0.94 | 366.6 |
| `autobuses` | bus | 39 | 42 | 0.93 | 360.5 |
| `rodoviario` | bus | 89 | 96 | 0.93 | 359.9 |
| `carris` | bus | 93 | 102 | 0.91 | 354.0 |
| `rodoviaria` | bus | 46 | 51 | 0.90 | 350.2 |
| `estacion autobuses` | bus | 27 | 30 | 0.90 | 349.4 |
| `autocarro` | bus | 17 | 20 | 0.85 | 330.0 |
| `cajero automatico` | atm | 104 | 104 | 1.00 | 293.8 |
| `multibanco` | atm | 42 | 42 | 1.00 | 293.8 |
| `espanaduero banco` | atm | 22 | 22 | 1.00 | 293.8 |
| `automatico espanaduero` | atm | 22 | 22 | 1.00 | 293.8 |
| `atm` | atm | 703 | 705 | 1.00 | 293.0 |
| `paragem` | bus | 159 | 212 | 0.75 | 291.2 |
| `cajero` | atm | 105 | 108 | 0.97 | 285.6 |
| `publica` | library | 54 | 94 | 0.57 | 269.0 |
| `tea` | tea | 53 | 98 | 0.54 | 256.4 |
| `arquivo` | library | 24 | 44 | 0.55 | 255.4 |
| `terminal` | bus | 123 | 191 | 0.64 | 250.0 |
| `bubble` | tea | 15 | 29 | 0.52 | 245.2 |
| `bus` | bus | 37 | 63 | 0.59 | 228.0 |
| `correios portugal` | post | 151 | 152 | 0.99 | 217.4 |
| `oficina correos` | post | 121 | 122 | 0.99 | 217.1 |
| `correos` | post | 160 | 164 | 0.98 | 213.5 |
| `mrw` | post | 76 | 78 | 0.97 | 213.3 |
| `correios` | post | 312 | 321 | 0.97 | 212.7 |
| `flores plantas` | florist | 18 | 18 | 1.00 | 212.4 |
| `santini` | ice_cream | 21 | 22 | 0.95 | 210.6 |
| `salao cha` | tea | 36 | 82 | 0.44 | 208.2 |
| `floristeria` | florist | 98 | 100 | 0.98 | 208.2 |
| `posto correios` | post | 19 | 20 | 0.95 | 207.9 |
| `comercio flores` | florist | 50 | 52 | 0.96 | 204.2 |
| `floral` | florist | 28 | 30 | 0.93 | 198.2 |
| `poste maroc` | post | 26 | 29 | 0.90 | 196.2 |
| `helados` | ice_cream | 24 | 27 | 0.89 | 196.1 |
| `arte floral` | florist | 17 | 19 | 0.89 | 190.0 |
| `nail` | nail_salon | 47 | 62 | 0.76 | 189.2 |
| `estafetas` | post | 19 | 22 | 0.86 | 189.0 |
| `casa cha` | tea | 22 | 57 | 0.39 | 183.0 |
| `fleurs` | florist | 17 | 20 | 0.85 | 180.5 |
| `amorino` | ice_cream | 15 | 19 | 0.79 | 174.2 |
| `cha` | tea | 113 | 308 | 0.37 | 174.0 |
| `horto` | florist | 40 | 49 | 0.82 | 173.4 |
| `nails` | nail_salon | 179 | 258 | 0.69 | 173.2 |
| `poste` | post | 60 | 76 | 0.79 | 172.8 |
| `heladeria` | ice_cream | 112 | 144 | 0.78 | 171.6 |
| `ice cream` | ice_cream | 28 | 37 | 0.76 | 167.0 |
| `cream` | ice_cream | 32 | 43 | 0.74 | 164.2 |
| `unhas` | nail_salon | 23 | 38 | 0.61 | 151.1 |
| `dazs` | ice_cream | 22 | 34 | 0.65 | 142.8 |
| `parque canino` | park | 20 | 21 | 0.95 | 142.3 |
| `haagen dazs` | ice_cream | 21 | 33 | 0.64 | 140.4 |
| `parque merendas` | park | 77 | 83 | 0.93 | 138.6 |
| `gelato` | ice_cream | 74 | 119 | 0.62 | 137.2 |
| `parque natural` | park | 29 | 32 | 0.91 | 135.4 |
| `pub` | bar | 194 | 358 | 0.54 | 134.8 |
| `merendas` | park | 89 | 99 | 0.90 | 134.3 |
| `artisani` | ice_cream | 17 | 28 | 0.61 | 133.9 |
| `parque lazer` | park | 26 | 29 | 0.90 | 133.9 |
| `gelateria` | ice_cream | 25 | 42 | 0.60 | 131.3 |
| `parque florestal` | park | 18 | 21 | 0.86 | 128.0 |
| `gelados` | ice_cream | 46 | 80 | 0.57 | 126.9 |
| `parque del` | park | 22 | 26 | 0.85 | 126.4 |
| `gelado` | ice_cream | 16 | 28 | 0.57 | 126.1 |
| `irish pub` | bar | 20 | 40 | 0.50 | 124.4 |
| `plantas` | florist | 41 | 72 | 0.57 | 120.9 |
| `ola` | ice_cream | 49 | 90 | 0.54 | 120.1 |
| `parque urbano` | park | 68 | 85 | 0.80 | 119.5 |
| `autocaravanismo` | park | 16 | 20 | 0.80 | 119.5 |
| `gabinete estetica` | nail_salon | 18 | 38 | 0.47 | 118.2 |
| `vivagym` | gym | 22 | 22 | 1.00 | 108.0 |
| `canino` | park | 26 | 36 | 0.72 | 107.9 |
| `parque cidade` | park | 30 | 42 | 0.71 | 106.7 |
| `crossfit` | gym | 75 | 77 | 0.97 | 105.2 |
| `parque municipal` | park | 21 | 30 | 0.70 | 104.6 |
| `fitness center` | gym | 29 | 30 | 0.97 | 104.4 |
| `health club` | gym | 99 | 103 | 0.96 | 103.8 |
| `flores` | florist | 190 | 389 | 0.49 | 103.7 |
| `health fitness` | gym | 24 | 25 | 0.96 | 103.7 |
| `fitness club` | gym | 67 | 70 | 0.96 | 103.4 |
| `gym` | gym | 225 | 236 | 0.95 | 103.0 |
| `actividades desportivas` | gym | 16 | 17 | 0.94 | 101.6 |
| `fitness` | gym | 375 | 400 | 0.94 | 101.2 |
| `gimnasio` | gym | 21 | 23 | 0.91 | 98.6 |
| `una marca` | clinic | 26 | 26 | 1.00 | 97.2 |
| `gaes una` | clinic | 26 | 26 | 1.00 | 97.2 |
| `marca amplifon` | clinic | 26 | 26 | 1.00 | 97.2 |
| `pediatra` | clinic | 18 | 18 | 1.00 | 97.2 |
| `clinica pediatrica` | clinic | 15 | 15 | 1.00 | 97.2 |
| `health` | gym | 142 | 160 | 0.89 | 95.8 |
| `ginasio clube` | gym | 27 | 31 | 0.87 | 94.1 |
| `autocaravanas` | park | 27 | 43 | 0.63 | 93.8 |
| `danca` | gym | 45 | 52 | 0.87 | 93.4 |
| `ice` | ice_cream | 94 | 224 | 0.42 | 92.6 |

## Proposed terms for types the app has no PoiType for

822 terms, kept separate so they do not consume review time. A term here cannot be used until the type exists, so this is evidence for KAN-400 rather than a list to approve. Strong signals in here are an argument that the type is worth adding.

| token | type | support | occurrences | precision | lift |
|---|---|---:|---:|---:|---:|
| `aerodromo` | airport | 16 | 20 | 0.80 | 3553.3 |
| `bowling` | bowling_alley | 59 | 67 | 0.88 | 2741.9 |
| `luckia` | casino | 42 | 42 | 1.00 | 1541.0 |
| `apuestas luckia` | casino | 40 | 40 | 1.00 | 1541.0 |
| `apuestas` | casino | 43 | 45 | 0.96 | 1472.5 |
| `bingo` | casino | 25 | 27 | 0.93 | 1426.8 |
| `praca touros` | stadium | 43 | 48 | 0.90 | 1264.3 |
| `golf course` | golf_course | 22 | 23 | 0.96 | 1239.9 |
| `course` | golf_course | 27 | 30 | 0.90 | 1166.6 |
| `embaixada` | embassy | 73 | 83 | 0.88 | 1165.1 |
| `tramway` | transit_station | 27 | 41 | 0.66 | 1136.6 |
| `embassy` | embassy | 38 | 45 | 0.84 | 1118.6 |
| `consulado` | embassy | 36 | 43 | 0.84 | 1109.0 |
| `charging station` | electric_vehicle_charging_station | 144 | 144 | 1.00 | 1059.8 |
| `electric charging` | electric_vehicle_charging_station | 131 | 131 | 1.00 | 1059.8 |
| `powerdot` | electric_vehicle_charging_station | 35 | 35 | 1.00 | 1059.8 |
| `tesla supercharger` | electric_vehicle_charging_station | 15 | 15 | 1.00 | 1059.8 |
| `consulat` | embassy | 22 | 28 | 0.79 | 1040.8 |
| `golf club` | golf_course | 17 | 22 | 0.77 | 1001.7 |
| `ambassade` | embassy | 24 | 32 | 0.75 | 993.5 |
| `yoga` | yoga_studio | 107 | 133 | 0.80 | 991.8 |
| `electric` | electric_vehicle_charging_station | 132 | 142 | 0.93 | 985.1 |
| `golfe` | golf_course | 31 | 46 | 0.67 | 873.6 |
| `campo tenis` | tennis_court | 19 | 20 | 0.95 | 864.2 |
| `mts` | transit_station | 21 | 43 | 0.49 | 842.9 |
| `clube tenis` | tennis_court | 47 | 51 | 0.92 | 838.4 |
| `tennis` | tennis_court | 48 | 55 | 0.87 | 793.9 |
| `metro` | subway_station | 140 | 296 | 0.47 | 789.2 |
| `fiscalidade` | accounting | 32 | 32 | 1.00 | 788.6 |
| `contabilidade fiscalidade` | accounting | 25 | 25 | 1.00 | 788.6 |
| `mosquee` | mosque | 186 | 191 | 0.97 | 780.2 |
| `tenis` | tennis_court | 156 | 186 | 0.84 | 763.0 |
| `mosque` | mosque | 33 | 35 | 0.94 | 755.4 |
| `padel` | tennis_court | 68 | 82 | 0.83 | 754.4 |
| `contabilidade gestao` | accounting | 17 | 18 | 0.94 | 744.8 |
| `cinemas` | movie_theater | 45 | 45 | 1.00 | 742.1 |
| `cines` | movie_theater | 15 | 15 | 1.00 | 742.1 |
| `casino` | casino | 45 | 95 | 0.47 | 729.9 |
| `contabilidade` | accounting | 151 | 167 | 0.90 | 713.0 |
| `tesla` | electric_vehicle_charging_station | 18 | 28 | 0.64 | 681.3 |
| `cine teatro` | movie_theater | 18 | 20 | 0.90 | 667.9 |
| `clinica fisioterapia` | physiotherapist | 17 | 23 | 0.74 | 647.1 |
| `court` | tennis_court | 27 | 39 | 0.69 | 629.8 |
| `centro fisioterapia` | physiotherapist | 34 | 48 | 0.71 | 620.1 |
| `golf` | golf_course | 142 | 297 | 0.48 | 619.8 |
| `cinema` | movie_theater | 75 | 93 | 0.81 | 598.5 |
| `fisioterapia` | physiotherapist | 100 | 150 | 0.67 | 583.6 |
| `fisio` | physiotherapist | 16 | 24 | 0.67 | 583.6 |
| `familia menores` | courthouse | 16 | 16 | 1.00 | 568.8 |
| `tribunal familia` | courthouse | 15 | 15 | 1.00 | 568.8 |
| `auto taxis` | taxi_stand | 24 | 24 | 1.00 | 566.7 |
| `juzgado` | courthouse | 40 | 41 | 0.98 | 554.9 |
| `cemiterio municipal` | cemetery | 26 | 26 | 1.00 | 554.2 |
| `cemiterio paroquial` | cemetery | 16 | 16 | 1.00 | 554.2 |
| `cine` | movie_theater | 47 | 63 | 0.75 | 553.6 |
| `judicial` | courthouse | 145 | 149 | 0.97 | 553.5 |
| `tribunal judicial` | courthouse | 141 | 145 | 0.97 | 553.1 |
| `tribunal comarca` | courthouse | 32 | 33 | 0.97 | 551.6 |
| `tribunal trabalho` | courthouse | 25 | 26 | 0.96 | 546.9 |
| `tribunal` | courthouse | 333 | 348 | 0.96 | 544.3 |

