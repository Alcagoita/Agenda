# KAN-397 — learned name keywords (PT)

Training rows: **302,033** (`poi` joined to `poi_type`, so a place that is two things teaches both).

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
| New terms proposed | 2110 |

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

It rediscovered 29 of 35 hand-written terms and agreed with the person on 28. The disagreements are the product calls the corpus cannot contain — a `barbeiro` is a men's barber even where most rows so named carry hairdresser tags.

The misses are honest limits rather than tuning opportunities: the terms below sit under the support floor, and lowering it is how one oddly named venue becomes a rule.

## Do not approve terms by score alone

The highest-scoring terms look excellent and are contaminated three ways. Sampled from precision >= 0.90, support >= 50:

```
caixa 898 @0.98 · depositos 521 · geral depositos 520   -> bank
    fragments of the brand "Caixa Geral de Depositos";
    `caixa` alone means box or till
fidelidade 460 @0.98                                    -> store
    an insurance brand that is also an ordinary noun
servicio 605 @0.92 · estacion servicio 581 @0.97        -> gas
    Spanish; "estacion de servicio" is a petrol station
construcao 699 @0.98 · construcoes 526 · materiais 403  -> store
    CONTRACTORS — the rows KAN-411 refused to type as hardware
    after finding 94 shops among 6,747 construction firms
```

Every one clears any threshold worth setting. **Precision and lift measure what the corpus says; they cannot detect that the corpus is wrong.**

Three causes, none fixable by tuning:

1. **Brand fragments.** The guard excludes one-word brands and whole phrases, which is what preserves `padaria` from "A Padaria Portuguesa" — and the same rule leaks `caixa` and `fidelidade`. Separating them needs a signal the statistics do not hold: one is a common noun naming a category, the other a common noun that happens to be a company.
2. **Country contamination.** Spanish terms carry real support in rows labelled `country = 'PT'` — the border leakage seen in KAN-411, now measurable.
3. **Upstream mis-typing.** Contractors are typed `store` in `poi`, so the learner correctly infers that construction words predict `store`. It is reproducing an error we already found, faithfully.

Cause 3 is the one worth stating plainly: **the learner inherits every classification mistake already in the corpus and repeats it with high confidence.** That argues for fixing the corpus and re-running, not against the method.

### Prerequisites before any term is approved

* clean the country boundary (Spanish rows inside PT data)
* decide what contractors are, and stop typing them `store`
* a brand rule that separates a category noun from a company noun, or an explicit exclusion list for the few that matter

Until then this document is **evidence, not a queue of work**. The terms that would survive all three fixes — `biblioteca`, `assistencia tecnica`, `paragem carris`, `paragem stcp`, `ourivesaria`, `confeccoes`, `moveis` — are real, and worth applying once the list can be trusted as a whole.

## Not done here

No classifier change. `NAME_TYPE_KEYWORDS` is untouched, per the ticket: the candidate list and the comparison come first.

## Proposed terms for types the app ships

1288 terms. These are the actionable list — nothing is applied, a person accepts or rejects each.

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
| `central camionagem` | bus | 27 | 28 | 0.96 | 374.4 |
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
| `automatico espanaduero` | atm | 22 | 22 | 1.00 | 293.8 |
| `espanaduero banco` | atm | 22 | 22 | 1.00 | 293.8 |
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
| `plantas` | florist | 41 | 72 | 0.57 | 121.0 |
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
| `gaes una` | clinic | 26 | 26 | 1.00 | 97.2 |
| `marca amplifon` | clinic | 26 | 26 | 1.00 | 97.2 |
| `una marca` | clinic | 26 | 26 | 1.00 | 97.2 |
| `pediatra` | clinic | 18 | 18 | 1.00 | 97.2 |
| `clinica pediatrica` | clinic | 15 | 15 | 1.00 | 97.2 |
| `health` | gym | 142 | 160 | 0.89 | 95.8 |
| `ginasio clube` | gym | 27 | 31 | 0.87 | 94.1 |
| `autocaravanas` | park | 27 | 43 | 0.63 | 93.8 |
| `danca` | gym | 45 | 52 | 0.87 | 93.4 |
| `ice` | ice_cream | 94 | 224 | 0.42 | 92.6 |
| `training` | gym | 24 | 28 | 0.86 | 92.6 |
| `cabinet docteur` | clinic | 29 | 31 | 0.94 | 90.9 |
| `florestal` | park | 20 | 33 | 0.61 | 90.5 |
| `desportivas` | gym | 20 | 24 | 0.83 | 90.0 |
| `parque verde` | park | 15 | 25 | 0.60 | 89.6 |
| `saude familiar` | clinic | 32 | 35 | 0.91 | 88.8 |
| `holmes` | gym | 35 | 44 | 0.80 | 85.9 |
| `docteur` | clinic | 76 | 86 | 0.88 | 85.9 |
| `centro salud` | clinic | 75 | 85 | 0.88 | 85.7 |
| `amplifon` | clinic | 28 | 32 | 0.88 | 85.0 |
| `usf` | clinic | 59 | 68 | 0.87 | 84.3 |
| `pilates` | gym | 46 | 59 | 0.78 | 84.2 |
| `servicos medicos` | clinic | 19 | 22 | 0.86 | 83.9 |
| `belleza cuidado` | salon | 16 | 32 | 0.50 | 82.6 |
| `clarel belleza` | salon | 16 | 32 | 0.50 | 82.6 |
| `cuidado personal` | salon | 16 | 32 | 0.50 | 82.6 |
| `personal hogar` | salon | 16 | 32 | 0.50 | 82.6 |
| `urbano` | park | 71 | 129 | 0.55 | 82.2 |
| `posto medico` | clinic | 21 | 25 | 0.84 | 81.6 |
| `fit` | gym | 71 | 95 | 0.75 | 80.7 |
| `beauty stores` | salon | 20 | 41 | 0.49 | 80.6 |
| `unidade saude` | clinic | 38 | 46 | 0.83 | 80.3 |
| `pharmacie` | pharmacy | 188 | 194 | 0.97 | 79.5 |
| `farmacia lda` | pharmacy | 21 | 22 | 0.95 | 78.3 |
| `farmacia dos` | pharmacy | 16 | 17 | 0.94 | 77.2 |
| `una` | clinic | 27 | 34 | 0.79 | 77.2 |
| `farmacia santa` | pharmacy | 33 | 36 | 0.92 | 75.2 |
| `pediatrica` | clinic | 16 | 21 | 0.76 | 74.0 |
| `farmacia nova` | pharmacy | 64 | 71 | 0.90 | 73.9 |
| `consultorio medico` | clinic | 31 | 41 | 0.76 | 73.5 |
| `psicologia` | clinic | 34 | 45 | 0.76 | 73.4 |
| `perfumeria` | salon | 22 | 50 | 0.44 | 72.7 |
| `estetica cabeleireiro` | hairdresser | 26 | 45 | 0.58 | 72.4 |
| `farmacia sousa` | pharmacy | 20 | 23 | 0.87 | 71.3 |
| `rocher` | salon | 28 | 65 | 0.43 | 71.2 |
| `farmacia maria` | pharmacy | 19 | 22 | 0.86 | 70.8 |
| `obstetricia` | clinic | 16 | 22 | 0.73 | 70.7 |
| `deportivo` | gym | 18 | 28 | 0.64 | 69.4 |
| `farmacia central` | pharmacy | 102 | 121 | 0.84 | 69.1 |
| `farmacia confianca` | pharmacy | 16 | 19 | 0.84 | 69.1 |
| `farmacia oliveira` | pharmacy | 21 | 25 | 0.84 | 68.9 |
| `clinica oftalmologica` | clinic | 17 | 24 | 0.71 | 68.8 |
| `cabeleireiro estetica` | hairdresser | 116 | 213 | 0.54 | 68.3 |
| `salud` | clinic | 84 | 120 | 0.70 | 68.0 |
| `cardiologia` | clinic | 16 | 23 | 0.70 | 67.6 |
| `farmacia moderna` | pharmacy | 28 | 34 | 0.82 | 67.5 |
| `oftalmologica` | clinic | 18 | 26 | 0.69 | 67.3 |
| `farmacia costa` | pharmacy | 22 | 27 | 0.81 | 66.8 |
| `farmacia marques` | pharmacy | 17 | 21 | 0.81 | 66.4 |
| `farmacia sao` | pharmacy | 46 | 57 | 0.81 | 66.2 |
| `farmacia silva` | pharmacy | 29 | 36 | 0.81 | 66.1 |
| `cabeleireiro unisexo` | hairdresser | 20 | 38 | 0.53 | 66.0 |
| `cabeleireiro homens` | hairdresser | 54 | 103 | 0.52 | 65.7 |
| `farmacia martins` | pharmacy | 19 | 24 | 0.79 | 64.9 |
| `ginecologia` | clinic | 16 | 24 | 0.67 | 64.8 |
| `farmacia santos` | pharmacy | 15 | 19 | 0.79 | 64.7 |
| `cabeleireiros unipessoal` | hairdresser | 17 | 33 | 0.52 | 64.6 |
| `cabeleireiros estetica` | hairdresser | 24 | 47 | 0.51 | 64.0 |
| `centro saude` | clinic | 177 | 270 | 0.66 | 63.7 |
| `extensao` | clinic | 15 | 23 | 0.65 | 63.4 |
| `salao cabeleireiro` | hairdresser | 46 | 92 | 0.50 | 62.7 |
| `academia` | gym | 103 | 178 | 0.58 | 62.5 |
| `parque das` | park | 33 | 79 | 0.42 | 62.4 |
| `parc` | park | 29 | 70 | 0.41 | 61.9 |
| `cabeleireiros` | hairdresser | 938 | 1913 | 0.49 | 61.5 |
| `pie` | clinic | 15 | 24 | 0.62 | 60.7 |
| `dance` | gym | 28 | 50 | 0.56 | 60.5 |
| `unisexo` | hairdresser | 35 | 74 | 0.47 | 59.3 |
| `policlinica` | clinic | 31 | 51 | 0.61 | 59.1 |
| `farmacia ferreira` | pharmacy | 18 | 25 | 0.72 | 59.0 |
| `homens` | hairdresser | 55 | 118 | 0.47 | 58.4 |
| `consultorio` | clinic | 140 | 235 | 0.60 | 57.9 |
| `agricola mutuo` | bank | 84 | 84 | 1.00 | 57.8 |
| `barclays` | bank | 82 | 82 | 1.00 | 57.8 |
| `bmci` | bank | 48 | 48 | 1.00 | 57.8 |
| `banco caixa` | bank | 26 | 26 | 1.00 | 57.8 |
| `caja extremadura` | bank | 18 | 18 | 1.00 | 57.8 |
| `attijari` | bank | 17 | 17 | 1.00 | 57.8 |
| `cih` | bank | 17 | 17 | 1.00 | 57.8 |
| `depositos` | bank | 521 | 526 | 0.99 | 57.2 |
| `geral depositos` | bank | 520 | 525 | 0.99 | 57.2 |
| `bmce` | bank | 64 | 65 | 0.98 | 56.9 |
| `totta` | bank | 342 | 348 | 0.98 | 56.8 |
| `societe generale` | bank | 53 | 54 | 0.98 | 56.7 |
| `centro medico` | clinic | 64 | 110 | 0.58 | 56.5 |
| `caixa` | bank | 898 | 921 | 0.98 | 56.3 |
| `attijariwafa` | bank | 37 | 38 | 0.97 | 56.2 |
| `attijariwafa bank` | bank | 33 | 34 | 0.97 | 56.1 |
| `pingo` | supermarket | 554 | 666 | 0.83 | 55.9 |
| `bmce bank` | bank | 29 | 30 | 0.97 | 55.8 |
| `credit maroc` | bank | 28 | 29 | 0.97 | 55.8 |
| `banque` | bank | 80 | 83 | 0.96 | 55.7 |
| `banca pueyo` | bank | 26 | 27 | 0.96 | 55.6 |
| `sgmb` | bank | 24 | 25 | 0.96 | 55.5 |
| `cabinet` | clinic | 157 | 276 | 0.57 | 55.3 |
| `credit` | bank | 44 | 46 | 0.96 | 55.2 |
| `cajasol` | bank | 18 | 19 | 0.95 | 54.7 |
| `lazer` | park | 30 | 82 | 0.37 | 54.6 |
| `populaire` | bank | 67 | 71 | 0.94 | 54.5 |
| `credito` | bank | 234 | 251 | 0.93 | 53.8 |
| `deutsche` | bank | 35 | 38 | 0.92 | 53.2 |
| `rural del` | bank | 58 | 63 | 0.92 | 53.2 |
| `abastecimento moeve` | gas | 95 | 95 | 1.00 | 52.5 |
| `campsa` | gas | 20 | 20 | 1.00 | 52.5 |
| `bomba gasolina` | gas | 17 | 17 | 1.00 | 52.5 |
| `estaciones` | gas | 16 | 16 | 1.00 | 52.5 |
| `cedipsa` | gas | 15 | 15 | 1.00 | 52.5 |
| `petroleos` | gas | 15 | 15 | 1.00 | 52.5 |
| `petronor` | gas | 15 | 15 | 1.00 | 52.5 |
| `posto abastecimento` | gas | 247 | 248 | 1.00 | 52.3 |
| `societe` | bank | 56 | 62 | 0.90 | 52.2 |
| `familiar` | clinic | 34 | 64 | 0.53 | 51.6 |
| `abastecimento` | gas | 250 | 255 | 0.98 | 51.5 |
| `alves bandeira` | gas | 149 | 152 | 0.98 | 51.5 |
| `consulta` | clinic | 20 | 38 | 0.53 | 51.1 |
| `estacion servicio` | gas | 581 | 598 | 0.97 | 51.0 |
| `parafarmacia` | pharmacy | 18 | 29 | 0.62 | 50.9 |
| `combustivel` | gas | 29 | 30 | 0.97 | 50.8 |
| `bank` | bank | 174 | 198 | 0.88 | 50.8 |
| `azoria` | gas | 20 | 21 | 0.95 | 50.0 |
| `caja rural` | bank | 146 | 169 | 0.86 | 49.9 |
| `caja` | bank | 208 | 241 | 0.86 | 49.9 |
| `banesto` | bank | 43 | 50 | 0.86 | 49.7 |
| `pharma` | pharmacy | 15 | 25 | 0.60 | 49.2 |
| `moeve` | gas | 108 | 116 | 0.93 | 48.9 |
| `clinico` | clinic | 27 | 54 | 0.50 | 48.6 |
| `diagnostico` | clinic | 24 | 48 | 0.50 | 48.6 |
| `servicio` | gas | 605 | 656 | 0.92 | 48.4 |
| `station afriquia` | gas | 47 | 51 | 0.92 | 48.4 |
| `combustiveis` | gas | 264 | 291 | 0.91 | 47.7 |
| `comercio combustiveis` | gas | 45 | 50 | 0.90 | 47.3 |
| `gasolina` | gas | 27 | 30 | 0.90 | 47.3 |
| `station service` | gas | 18 | 20 | 0.90 | 47.3 |
| `rural extremadura` | bank | 36 | 44 | 0.82 | 47.3 |
| `del sur` | bank | 58 | 71 | 0.82 | 47.2 |
| `geral` | bank | 605 | 745 | 0.81 | 46.9 |
| `petro` | gas | 16 | 18 | 0.89 | 46.7 |
| `estacao servico` | gas | 297 | 335 | 0.89 | 46.6 |
| `station total` | gas | 30 | 34 | 0.88 | 46.3 |
| `oilibya` | gas | 15 | 17 | 0.88 | 46.3 |
| `combustiveis lubrificantes` | gas | 27 | 31 | 0.87 | 45.7 |
| `fruteria` | supermarket | 19 | 24 | 0.79 | 45.6 |
| `afriquia` | gas | 73 | 85 | 0.86 | 45.1 |
| `gasolineira` | gas | 26 | 31 | 0.84 | 44.1 |
| `banca` | bank | 32 | 42 | 0.76 | 44.0 |
| `medico` | clinic | 160 | 354 | 0.45 | 43.9 |
| `wellness` | gym | 33 | 82 | 0.40 | 43.5 |
| `gasolinera` | gas | 57 | 69 | 0.83 | 43.4 |
| `petrom` | gas | 19 | 23 | 0.83 | 43.4 |
| `estacion` | gas | 592 | 725 | 0.82 | 42.9 |
| `carrefour express` | supermarket | 50 | 79 | 0.63 | 42.5 |
| `carburantes` | gas | 17 | 21 | 0.81 | 42.5 |
| `centro clinico` | clinic | 17 | 39 | 0.44 | 42.4 |
| `hair studio` | hairdresser | 22 | 22 | 1.00 | 41.9 |
| `barberia` | hairdresser | 16 | 16 | 1.00 | 41.9 |
| `peluqueria caballeros` | hairdresser | 16 | 16 | 1.00 | 41.9 |
| `cmh` | gas | 15 | 19 | 0.79 | 41.5 |
| `cred` | gas | 15 | 19 | 0.79 | 41.5 |
| `alimentacion` | supermarket | 23 | 32 | 0.72 | 41.4 |
| `forma` | gym | 19 | 50 | 0.38 | 41.0 |
| `bom dia` | supermarket | 185 | 304 | 0.61 | 40.9 |
| `supermercado dia` | supermarket | 17 | 28 | 0.61 | 40.8 |
| `supermercado jamon` | supermarket | 17 | 28 | 0.61 | 40.8 |
| `coiffeur` | hairdresser | 77 | 80 | 0.96 | 40.4 |
| `peluqueros` | hairdresser | 47 | 49 | 0.96 | 40.2 |
| `unisex` | hairdresser | 20 | 21 | 0.95 | 39.9 |
| `cabeleiro` | hairdresser | 18 | 19 | 0.95 | 39.7 |
| `generale` | bank | 54 | 79 | 0.68 | 39.5 |
| `total` | gas | 79 | 108 | 0.73 | 38.4 |
| `autoservicio` | supermarket | 18 | 27 | 0.67 | 38.4 |
| `lubrificantes` | gas | 34 | 47 | 0.72 | 38.0 |
| `espanaduero` | bank | 42 | 64 | 0.66 | 37.9 |
| `bomba` | gas | 38 | 53 | 0.72 | 37.7 |
| `bandeira` | gas | 151 | 211 | 0.72 | 37.6 |
| `barber shop` | hairdresser | 69 | 77 | 0.90 | 37.6 |
| `agricola` | bank | 240 | 369 | 0.65 | 37.6 |
| `saude` | clinic | 276 | 714 | 0.39 | 37.6 |
| `santos hairshop` | hairdresser | 17 | 19 | 0.89 | 37.5 |
| `area servico` | gas | 81 | 114 | 0.71 | 37.3 |
| `medicos` | clinic | 36 | 94 | 0.38 | 37.2 |
| `peluqueria` | hairdresser | 407 | 460 | 0.88 | 37.1 |
| `barber` | hairdresser | 125 | 142 | 0.88 | 36.9 |
| `cabelereiro` | hairdresser | 22 | 25 | 0.88 | 36.9 |
| `roasters` | cafe | 27 | 32 | 0.84 | 36.3 |
| `banco` | bank | 1406 | 2246 | 0.63 | 36.2 |
| `peluqueria estetica` | hairdresser | 34 | 40 | 0.85 | 35.6 |
| `supermercados jamon` | supermarket | 18 | 34 | 0.53 | 35.6 |
| `barbershop` | hairdresser | 64 | 76 | 0.84 | 35.3 |
| `cabelo` | hairdresser | 28 | 34 | 0.82 | 34.5 |
| `oil` | gas | 21 | 32 | 0.66 | 34.5 |
| `supermercados` | supermarket | 266 | 526 | 0.51 | 34.0 |
| `agence` | bank | 63 | 108 | 0.58 | 33.7 |
| `coiffure` | hairdresser | 114 | 142 | 0.80 | 33.7 |
| `nespresso boutique` | cafe | 21 | 27 | 0.78 | 33.4 |
| `salon coiffure` | hairdresser | 48 | 61 | 0.79 | 33.0 |
| `posto` | gas | 285 | 459 | 0.62 | 32.6 |
| `modelo` | supermarket | 154 | 318 | 0.48 | 32.5 |
| `sanjam` | hairdresser | 18 | 24 | 0.75 | 31.5 |
| `hair` | hairdresser | 242 | 323 | 0.75 | 31.4 |
| `alisuper` | supermarket | 30 | 55 | 0.55 | 31.4 |
| `mini mercado` | supermarket | 153 | 283 | 0.54 | 31.1 |
| `jean` | hairdresser | 45 | 61 | 0.74 | 30.9 |
| `cabelos` | hairdresser | 24 | 33 | 0.73 | 30.5 |
| `nespresso` | cafe | 29 | 41 | 0.71 | 30.4 |
| `louis` | hairdresser | 38 | 53 | 0.72 | 30.1 |
| `comercio frutas` | supermarket | 16 | 31 | 0.52 | 29.7 |
| `pente` | hairdresser | 17 | 24 | 0.71 | 29.7 |
| `salao beleza` | hairdresser | 17 | 24 | 0.71 | 29.7 |
| `carrefour` | supermarket | 89 | 203 | 0.44 | 29.5 |
| `meu super` | supermarket | 93 | 183 | 0.51 | 29.3 |
| `mercearias` | supermarket | 20 | 46 | 0.43 | 29.2 |
| `recheio` | supermarket | 28 | 65 | 0.43 | 29.0 |
| `boulangerie patisserie` | bakery | 31 | 31 | 1.00 | 28.6 |
| `recheio cash` | supermarket | 24 | 49 | 0.49 | 28.2 |
| `gleba` | bakery | 32 | 33 | 0.97 | 27.7 |
| `coviran` | supermarket | 27 | 57 | 0.47 | 27.3 |
| `bagga` | cafe | 46 | 73 | 0.63 | 27.1 |
| `dia` | supermarket | 215 | 539 | 0.40 | 26.8 |
| `clinica pelo` | hairdresser | 19 | 30 | 0.63 | 26.6 |
| `caballeros` | hairdresser | 17 | 27 | 0.63 | 26.4 |
| `boulangerie` | bakery | 96 | 104 | 0.92 | 26.4 |
| `supermarket` | supermarket | 16 | 41 | 0.39 | 26.2 |
| `espresso` | cafe | 17 | 28 | 0.61 | 26.1 |
| `jamon` | supermarket | 48 | 106 | 0.45 | 26.1 |
| `espirito` | bank | 70 | 156 | 0.45 | 25.9 |
| `sur` | bank | 59 | 132 | 0.45 | 25.8 |
| `ines pereira` | hairdresser | 16 | 26 | 0.62 | 25.8 |
| `coffee shop` | cafe | 43 | 72 | 0.60 | 25.7 |
| `instituto beleza` | hairdresser | 52 | 85 | 0.61 | 25.7 |
| `salon` | hairdresser | 216 | 354 | 0.61 | 25.6 |
| `extremadura` | bank | 57 | 129 | 0.44 | 25.5 |
| `bombas` | gas | 34 | 70 | 0.49 | 25.5 |
| `cash carry` | supermarket | 26 | 59 | 0.44 | 25.4 |
| `padaria pao` | bakery | 23 | 26 | 0.88 | 25.3 |
| `padaria flor` | bakery | 15 | 17 | 0.88 | 25.2 |
| `panaderia` | bakery | 172 | 195 | 0.88 | 25.2 |
| `panificacao` | bakery | 35 | 40 | 0.88 | 25.0 |
| `specialty coffee` | cafe | 17 | 30 | 0.57 | 24.4 |
| `padaria central` | bakery | 17 | 20 | 0.85 | 24.3 |
| `carry` | supermarket | 28 | 67 | 0.42 | 24.1 |
| `padarias` | bakery | 19 | 23 | 0.83 | 23.6 |
| `carrefour market` | supermarket | 18 | 44 | 0.41 | 23.5 |
| `salao` | hairdresser | 380 | 692 | 0.55 | 23.0 |
| `mini` | supermarket | 169 | 428 | 0.39 | 22.7 |
| `popular` | bank | 104 | 270 | 0.39 | 22.2 |
| `padaria confeitaria` | bakery | 28 | 36 | 0.78 | 22.2 |
| `casa pao` | bakery | 16 | 21 | 0.76 | 21.8 |
| `patisserie` | bakery | 85 | 112 | 0.76 | 21.7 |
| `panificadora` | bakery | 79 | 105 | 0.75 | 21.5 |
| `padaria pastelaria` | bakery | 231 | 308 | 0.75 | 21.4 |
| `melhor croissant` | bakery | 18 | 24 | 0.75 | 21.4 |
| `croissant minha` | bakery | 17 | 23 | 0.74 | 21.1 |
| `karaoke` | bar | 19 | 19 | 1.00 | 21.1 |
| `spar` | supermarket | 42 | 115 | 0.37 | 21.0 |
| `boutique pao` | bakery | 19 | 26 | 0.73 | 20.9 |
| `dos croissants` | bakery | 16 | 22 | 0.73 | 20.8 |
| `coffee` | cafe | 395 | 821 | 0.48 | 20.7 |
| `pastelaria princesa` | bakery | 15 | 21 | 0.71 | 20.4 |
| `pastelaria pao` | bakery | 44 | 62 | 0.71 | 20.3 |
| `minha rua` | bakery | 17 | 24 | 0.71 | 20.2 |
| `lobby bar` | bar | 22 | 23 | 0.96 | 20.2 |
| `beleza` | hairdresser | 159 | 331 | 0.48 | 20.1 |
| `area` | gas | 91 | 240 | 0.38 | 19.9 |
| `pastelaria padaria` | bakery | 40 | 59 | 0.68 | 19.4 |
| `pastelarias` | bakery | 21 | 31 | 0.68 | 19.3 |
| `croissant` | bakery | 48 | 72 | 0.67 | 19.0 |
| `pain` | bakery | 21 | 32 | 0.66 | 18.7 |
| `pastelaria santa` | bakery | 20 | 31 | 0.65 | 18.4 |
| `pao quente` | bakery | 208 | 323 | 0.64 | 18.4 |
| `pastelaria flor` | bakery | 36 | 56 | 0.64 | 18.4 |
| `panisol` | bakery | 16 | 25 | 0.64 | 18.3 |
| `quente pastelaria` | bakery | 16 | 25 | 0.64 | 18.3 |
| `pastelaria doce` | bakery | 63 | 99 | 0.64 | 18.2 |
| `croissants` | bakery | 21 | 33 | 0.64 | 18.2 |
| `pastelaria sao` | bakery | 25 | 40 | 0.62 | 17.9 |
| `pastelaria estrela` | bakery | 20 | 32 | 0.62 | 17.9 |
| `estilo` | hairdresser | 24 | 57 | 0.42 | 17.7 |
| `pelo` | hairdresser | 33 | 80 | 0.41 | 17.3 |
| `beaute` | hairdresser | 21 | 51 | 0.41 | 17.3 |
| `desejos` | bakery | 15 | 25 | 0.60 | 17.1 |
| `poncha` | bar | 45 | 56 | 0.80 | 16.9 |
| `quente` | bakery | 215 | 365 | 0.59 | 16.8 |
| `xandite` | bakery | 18 | 31 | 0.58 | 16.6 |
| `pao` | bakery | 566 | 977 | 0.58 | 16.5 |
| `pastelaria perola` | bakery | 19 | 33 | 0.58 | 16.4 |
| `style` | hairdresser | 49 | 125 | 0.39 | 16.4 |
| `look` | hairdresser | 36 | 92 | 0.39 | 16.4 |
| `pastelaria delicia` | bakery | 16 | 28 | 0.57 | 16.3 |
| `visual` | hairdresser | 20 | 52 | 0.38 | 16.1 |
| `pastelaria central` | bakery | 18 | 32 | 0.56 | 16.1 |
| `pastelaria nova` | bakery | 23 | 41 | 0.56 | 16.0 |
| `beauty` | hairdresser | 142 | 373 | 0.38 | 16.0 |
| `bakery` | bakery | 36 | 66 | 0.55 | 15.6 |
| `bolos` | bakery | 53 | 98 | 0.54 | 15.4 |
| `pastelaria avenida` | bakery | 15 | 28 | 0.54 | 15.3 |
| `pasteleria` | bakery | 58 | 109 | 0.53 | 15.2 |
| `forninho` | bakery | 22 | 42 | 0.52 | 15.0 |
| `cafe pastelaria` | bakery | 87 | 169 | 0.51 | 14.7 |
| `cocktail bar` | bar | 38 | 55 | 0.69 | 14.6 |
| `lounge bar` | bar | 85 | 124 | 0.69 | 14.5 |
| `sports bar` | bar | 28 | 41 | 0.68 | 14.4 |
| `pan` | bakery | 27 | 54 | 0.50 | 14.3 |
| `horno` | bakery | 23 | 46 | 0.50 | 14.3 |
| `pool bar` | bar | 25 | 37 | 0.68 | 14.2 |
| `shisha` | bar | 30 | 45 | 0.67 | 14.1 |
| `bar lounge` | bar | 19 | 30 | 0.63 | 13.4 |
| `trigo` | bakery | 36 | 77 | 0.47 | 13.4 |
| `docaria` | bakery | 20 | 43 | 0.47 | 13.3 |
| `lobby` | bar | 26 | 42 | 0.62 | 13.1 |
| `gin` | bar | 40 | 66 | 0.61 | 12.8 |
| `pasteis` | bakery | 18 | 42 | 0.43 | 12.2 |
| `doces` | bakery | 69 | 162 | 0.43 | 12.2 |
| `cocktail` | bar | 58 | 101 | 0.57 | 12.1 |
| `nata` | bakery | 53 | 132 | 0.40 | 11.5 |
| `pastelaria snack` | bakery | 36 | 91 | 0.40 | 11.3 |
| `pau canela` | bakery | 20 | 51 | 0.39 | 11.2 |
| `cake` | bakery | 27 | 69 | 0.39 | 11.2 |
| `espiga` | bakery | 22 | 58 | 0.38 | 10.8 |
| `rooftop` | bar | 38 | 74 | 0.51 | 10.8 |
| `tavern` | bar | 18 | 36 | 0.50 | 10.5 |
| `wine bar` | bar | 63 | 127 | 0.50 | 10.5 |
| `beach bar` | bar | 33 | 67 | 0.49 | 10.4 |
| `bolo` | bakery | 19 | 53 | 0.36 | 10.2 |
| `cafe parque` | cafe | 28 | 35 | 0.80 | 10.1 |
| `rock` | bar | 54 | 113 | 0.48 | 10.1 |
| `bar cafe` | bar | 20 | 42 | 0.48 | 10.0 |
| `bares` | bar | 15 | 32 | 0.47 | 9.9 |
| `cafe avenida` | cafe | 45 | 58 | 0.78 | 9.8 |
| `lounge` | bar | 318 | 688 | 0.46 | 9.7 |
| `irish` | bar | 36 | 78 | 0.46 | 9.7 |
| `pool` | bar | 55 | 121 | 0.45 | 9.6 |
| `deck` | bar | 15 | 33 | 0.45 | 9.6 |
| `cafe les` | cafe | 18 | 24 | 0.75 | 9.5 |
| `cafe sol` | cafe | 15 | 20 | 0.75 | 9.5 |
| `cafe stop` | cafe | 15 | 20 | 0.75 | 9.5 |
| `cafe flor` | cafe | 20 | 27 | 0.74 | 9.4 |
| `cafe ponto` | cafe | 20 | 27 | 0.74 | 9.4 |
| `bar das` | bar | 20 | 45 | 0.44 | 9.4 |
| `cafe cantinho` | cafe | 17 | 23 | 0.74 | 9.4 |
| `buondi` | cafe | 38 | 52 | 0.73 | 9.3 |
| `bar` | bar | 4216 | 9626 | 0.44 | 9.2 |
| `sical` | cafe | 50 | 69 | 0.72 | 9.2 |
| `bar dos` | bar | 20 | 46 | 0.43 | 9.2 |
| `cafe sao` | cafe | 35 | 49 | 0.71 | 9.0 |
| `cafe jardim` | cafe | 24 | 34 | 0.71 | 8.9 |
| `cafe novo` | cafe | 19 | 27 | 0.70 | 8.9 |
| `cafe santa` | cafe | 19 | 27 | 0.70 | 8.9 |
| `jazz` | bar | 15 | 36 | 0.42 | 8.8 |
| `cafe das` | cafe | 18 | 26 | 0.69 | 8.8 |
| `beer` | bar | 51 | 123 | 0.41 | 8.7 |
| `piano` | bar | 15 | 38 | 0.39 | 8.3 |
| `bar praia` | bar | 24 | 61 | 0.39 | 8.3 |
| `cafe bar` | bar | 184 | 469 | 0.39 | 8.3 |
| `cafe paris` | cafe | 15 | 23 | 0.65 | 8.3 |
| `cafe bom` | cafe | 20 | 31 | 0.65 | 8.2 |
| `cafe estrela` | cafe | 18 | 28 | 0.64 | 8.1 |
| `mundo cafe` | cafe | 18 | 28 | 0.64 | 8.1 |
| `cafe snack` | cafe | 209 | 326 | 0.64 | 8.1 |
| `bar los` | bar | 15 | 39 | 0.38 | 8.1 |
| `barraca` | bar | 23 | 60 | 0.38 | 8.1 |
| `cafe central` | cafe | 156 | 249 | 0.63 | 7.9 |
| `terraza` | bar | 23 | 62 | 0.37 | 7.8 |
| `cafe praca` | cafe | 16 | 26 | 0.62 | 7.8 |
| `quiosque dos` | cafe | 20 | 33 | 0.61 | 7.7 |
| `cafe` | cafe | 7542 | 12526 | 0.60 | 7.6 |
| `copas` | bar | 26 | 72 | 0.36 | 7.6 |
| `casa benfica` | bar | 22 | 62 | 0.35 | 7.5 |
| `bom bocado` | cafe | 36 | 62 | 0.58 | 7.4 |
| `cafe com` | cafe | 28 | 49 | 0.57 | 7.2 |
| `kafe` | cafe | 20 | 35 | 0.57 | 7.2 |
| `espace` | cafe | 75 | 132 | 0.57 | 7.2 |
| `snack` | cafe | 1297 | 2296 | 0.56 | 7.2 |
| `bufete` | cafe | 18 | 33 | 0.55 | 6.9 |
| `delta` | cafe | 67 | 123 | 0.54 | 6.9 |
| `glacier` | cafe | 15 | 28 | 0.54 | 6.8 |
| `copa` | cafe | 23 | 43 | 0.53 | 6.8 |
| `cafeteria bar` | cafe | 16 | 30 | 0.53 | 6.8 |
| `nicola` | cafe | 33 | 64 | 0.52 | 6.5 |
| `segafredo` | cafe | 19 | 37 | 0.51 | 6.5 |
| `bar cafeteria` | cafe | 25 | 50 | 0.50 | 6.3 |
| `kaffe` | cafe | 22 | 44 | 0.50 | 6.3 |
| `cafes` | cafe | 63 | 127 | 0.50 | 6.3 |
| `ponto encontro` | cafe | 47 | 99 | 0.47 | 6.0 |
| `venezia ice` | cafe | 21 | 45 | 0.47 | 5.9 |
| `coffe` | cafe | 29 | 63 | 0.46 | 5.8 |
| `croissanteria` | cafe | 23 | 50 | 0.46 | 5.8 |
| `churreria` | cafe | 39 | 85 | 0.46 | 5.8 |
| `leitaria` | cafe | 55 | 122 | 0.45 | 5.7 |
| `break` | cafe | 22 | 49 | 0.45 | 5.7 |
| `ramen` | restaurant | 105 | 105 | 1.00 | 5.7 |
| `wok` | restaurant | 80 | 80 | 1.00 | 5.7 |
| `mcdonald` | restaurant | 70 | 70 | 1.00 | 5.7 |
| `steak` | restaurant | 67 | 67 | 1.00 | 5.7 |
| `restaurante chines` | restaurant | 61 | 61 | 1.00 | 5.7 |
| `hamburguer` | restaurant | 59 | 59 | 1.00 | 5.7 |
| `tandoori` | restaurant | 56 | 56 | 1.00 | 5.7 |
| `trattoria` | restaurant | 54 | 54 | 1.00 | 5.7 |
| `restaurante churrasqueira` | restaurant | 49 | 49 | 1.00 | 5.7 |
| `hamburguer gourmet` | restaurant | 46 | 46 | 1.00 | 5.7 |
| `indian restaurant` | restaurant | 46 | 46 | 1.00 | 5.7 |
| `pizzas` | restaurant | 44 | 44 | 1.00 | 5.7 |
| `dos grelhados` | restaurant | 42 | 42 | 1.00 | 5.7 |
| `steak house` | restaurant | 42 | 42 | 1.00 | 5.7 |
| `italian republic` | restaurant | 33 | 33 | 1.00 | 5.7 |
| `bifanas vendas` | restaurant | 32 | 32 | 1.00 | 5.7 |
| `burger ranch` | restaurant | 32 | 32 | 1.00 | 5.7 |
| `restaurante sabores` | restaurant | 31 | 31 | 1.00 | 5.7 |
| `restaurante adega` | restaurant | 29 | 29 | 1.00 | 5.7 |
| `restaurante jardim` | restaurant | 28 | 28 | 1.00 | 5.7 |
| `restaurante tipico` | restaurant | 28 | 28 | 1.00 | 5.7 |
| `shoarma` | restaurant | 28 | 28 | 1.00 | 5.7 |
| `tomatino` | restaurant | 28 | 28 | 1.00 | 5.7 |
| `brasas` | restaurant | 27 | 27 | 1.00 | 5.7 |
| `praca alimentacao` | restaurant | 27 | 27 | 1.00 | 5.7 |
| `quasi` | restaurant | 27 | 27 | 1.00 | 5.7 |
| `kebab house` | restaurant | 25 | 25 | 1.00 | 5.7 |
| `luzzo` | restaurant | 25 | 25 | 1.00 | 5.7 |
| `frango guia` | restaurant | 24 | 24 | 1.00 | 5.7 |
| `joshua` | restaurant | 24 | 24 | 1.00 | 5.7 |
| `quasi pronti` | restaurant | 23 | 23 | 1.00 | 5.7 |
| `restaurante maria` | restaurant | 23 | 23 | 1.00 | 5.7 |
| `joshua shoarma` | restaurant | 22 | 22 | 1.00 | 5.7 |
| `restaurante ponte` | restaurant | 22 | 22 | 1.00 | 5.7 |
| `shoarma grill` | restaurant | 22 | 22 | 1.00 | 5.7 |
| `bifes` | restaurant | 21 | 21 | 1.00 | 5.7 |
| `grelhador` | restaurant | 21 | 21 | 1.00 | 5.7 |
| `churrascao` | restaurant | 20 | 20 | 1.00 | 5.7 |
| `franguinho` | restaurant | 20 | 20 | 1.00 | 5.7 |
| `restaurante flor` | restaurant | 20 | 20 | 1.00 | 5.7 |
| `restaurante lareira` | restaurant | 20 | 20 | 1.00 | 5.7 |
| `wok walk` | restaurant | 20 | 20 | 1.00 | 5.7 |
| `basilico` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `beef` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `espeto` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `pizza pasta` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `street food` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `sushi house` | restaurant | 19 | 19 | 1.00 | 5.7 |
| `restaurante avenida` | restaurant | 18 | 18 | 1.00 | 5.7 |
| `sushicome` | restaurant | 18 | 18 | 1.00 | 5.7 |
| `churrasqueria` | restaurant | 17 | 17 | 1.00 | 5.7 |
| `mexican` | restaurant | 17 | 17 | 1.00 | 5.7 |
| `restaurante grill` | restaurant | 17 | 17 | 1.00 | 5.7 |
| `cataplana` | restaurant | 16 | 16 | 1.00 | 5.7 |
| `indian palace` | restaurant | 16 | 16 | 1.00 | 5.7 |
| `indian tandoori` | restaurant | 16 | 16 | 1.00 | 5.7 |
| `pomodoro` | restaurant | 16 | 16 | 1.00 | 5.7 |
| `dos bifes` | restaurant | 15 | 15 | 1.00 | 5.7 |
| `hamburgueres` | restaurant | 15 | 15 | 1.00 | 5.7 |
| `restaurante antonio` | restaurant | 15 | 15 | 1.00 | 5.7 |
| `restaurante palmeira` | restaurant | 15 | 15 | 1.00 | 5.7 |
| `restaurante tia` | restaurant | 15 | 15 | 1.00 | 5.7 |
| `creme` | cafe | 16 | 36 | 0.44 | 5.6 |
| `caffe` | cafe | 330 | 747 | 0.44 | 5.6 |
| `tentacoes` | cafe | 15 | 34 | 0.44 | 5.6 |
| `sushi` | restaurant | 758 | 770 | 0.98 | 5.6 |
| `picanha` | restaurant | 54 | 55 | 0.98 | 5.6 |
| `steakhouse` | restaurant | 94 | 96 | 0.98 | 5.5 |
| `rodizio` | restaurant | 46 | 47 | 0.98 | 5.5 |
| `grelhados` | restaurant | 89 | 91 | 0.98 | 5.5 |
| `poke` | restaurant | 43 | 44 | 0.98 | 5.5 |
| `das sopas` | restaurant | 41 | 42 | 0.98 | 5.5 |
| `restaurante dom` | restaurant | 40 | 41 | 0.98 | 5.5 |
| `sushi bar` | restaurant | 76 | 78 | 0.97 | 5.5 |
| `ranch` | restaurant | 37 | 38 | 0.97 | 5.5 |
| `ristorante` | restaurant | 108 | 111 | 0.97 | 5.5 |
| `restaurante cantinho` | restaurant | 33 | 34 | 0.97 | 5.5 |
| `chicken` | restaurant | 31 | 32 | 0.97 | 5.5 |
| `cucina` | restaurant | 30 | 31 | 0.97 | 5.5 |
| `osteria` | restaurant | 28 | 29 | 0.97 | 5.5 |
| `tacos` | restaurant | 28 | 29 | 0.97 | 5.5 |
| `dos frangos` | restaurant | 83 | 86 | 0.97 | 5.5 |
| `restaurante santa` | restaurant | 27 | 28 | 0.96 | 5.5 |
| `churrasquinho` | restaurant | 26 | 27 | 0.96 | 5.4 |
| `restaurante japones` | restaurant | 26 | 27 | 0.96 | 5.4 |
| `pasta` | restaurant | 128 | 133 | 0.96 | 5.4 |
| `kebab` | restaurant | 379 | 394 | 0.96 | 5.4 |
| `oakberry` | restaurant | 25 | 26 | 0.96 | 5.4 |
| `restaurante fonte` | restaurant | 25 | 26 | 0.96 | 5.4 |
| `acai natura` | restaurant | 24 | 25 | 0.96 | 5.4 |
| `kebab pizza` | restaurant | 24 | 25 | 0.96 | 5.4 |
| `restaurante mar` | restaurant | 24 | 25 | 0.96 | 5.4 |
| `burger` | restaurant | 404 | 421 | 0.96 | 5.4 |
| `hamburgueseria` | restaurant | 23 | 24 | 0.96 | 5.4 |
| `oakberry acai` | restaurant | 23 | 24 | 0.96 | 5.4 |
| `restaurante paraiso` | restaurant | 23 | 24 | 0.96 | 5.4 |
| `martino` | restaurant | 22 | 23 | 0.96 | 5.4 |
| `mexicano` | restaurant | 22 | 23 | 0.96 | 5.4 |
| `roulotte` | restaurant | 22 | 23 | 0.96 | 5.4 |
| `grelha` | restaurant | 109 | 114 | 0.96 | 5.4 |
| `dos leitoes` | restaurant | 126 | 132 | 0.95 | 5.4 |
| `pregaria` | restaurant | 21 | 22 | 0.95 | 5.4 |
| `restaurante mira` | restaurant | 21 | 22 | 0.95 | 5.4 |
| `restaurante retiro` | restaurant | 21 | 22 | 0.95 | 5.4 |
| `brasa` | restaurant | 160 | 168 | 0.95 | 5.4 |
| `barbecue` | restaurant | 20 | 21 | 0.95 | 5.4 |
| `churrasqueira central` | restaurant | 20 | 21 | 0.95 | 5.4 |
| `restaurante nova` | restaurant | 20 | 21 | 0.95 | 5.4 |
| `restaurante parque` | restaurant | 20 | 21 | 0.95 | 5.4 |
| `sakura` | restaurant | 20 | 21 | 0.95 | 5.4 |
| `doner kebab` | restaurant | 58 | 61 | 0.95 | 5.4 |
| `restaurante beira` | restaurant | 19 | 20 | 0.95 | 5.4 |
| `restaurante dona` | restaurant | 19 | 20 | 0.95 | 5.4 |
| `frangos` | restaurant | 112 | 118 | 0.95 | 5.4 |
| `burgers` | restaurant | 55 | 58 | 0.95 | 5.4 |
| `pizza` | restaurant | 567 | 598 | 0.95 | 5.4 |
| `burguer` | restaurant | 146 | 154 | 0.95 | 5.4 |
| `bitoque` | restaurant | 36 | 38 | 0.95 | 5.4 |
| `restaurante monte` | restaurant | 36 | 38 | 0.95 | 5.4 |
| `japanese` | restaurant | 18 | 19 | 0.95 | 5.4 |
| `leitoes` | restaurant | 140 | 148 | 0.95 | 5.3 |
| `pizzeria` | restaurant | 262 | 277 | 0.95 | 5.3 |
| `casa pasto` | restaurant | 119 | 126 | 0.94 | 5.3 |
| `tacho` | restaurant | 50 | 53 | 0.94 | 5.3 |
| `churrasco` | restaurant | 83 | 88 | 0.94 | 5.3 |
| `restaurante pizzaria` | restaurant | 48 | 51 | 0.94 | 5.3 |
| `delhi` | restaurant | 16 | 17 | 0.94 | 5.3 |
| `farnel` | restaurant | 16 | 17 | 0.94 | 5.3 |
| `restaurant and` | restaurant | 16 | 17 | 0.94 | 5.3 |
| `restaurante farol` | restaurant | 16 | 17 | 0.94 | 5.3 |
| `pasto` | restaurant | 122 | 130 | 0.94 | 5.3 |
| `domino pizza` | restaurant | 15 | 16 | 0.94 | 5.3 |
| `pollo` | restaurant | 15 | 16 | 0.94 | 5.3 |
| `restaurante cozinha` | restaurant | 15 | 16 | 0.94 | 5.3 |
| `restaurante panoramico` | restaurant | 15 | 16 | 0.94 | 5.3 |
| `restaurante serra` | restaurant | 15 | 16 | 0.94 | 5.3 |
| `restaurante estrela` | restaurant | 29 | 31 | 0.94 | 5.3 |
| `restaurante casa` | restaurant | 127 | 136 | 0.93 | 5.3 |
| `frango` | restaurant | 141 | 151 | 0.93 | 5.3 |
| `indian` | restaurant | 168 | 180 | 0.93 | 5.3 |
| `restaurante quinta` | restaurant | 42 | 45 | 0.93 | 5.3 |
| `restaurante solar` | restaurant | 28 | 30 | 0.93 | 5.3 |
| `ristorante pizzeria` | restaurant | 27 | 29 | 0.93 | 5.3 |
| `doner` | restaurant | 65 | 70 | 0.93 | 5.2 |
| `assador` | restaurant | 26 | 28 | 0.93 | 5.2 |
| `taberna londrina` | restaurant | 26 | 28 | 0.93 | 5.2 |
| `garfo` | restaurant | 51 | 55 | 0.93 | 5.2 |
| `churrascaria` | restaurant | 127 | 137 | 0.93 | 5.2 |
| `restaurant bar` | restaurant | 50 | 54 | 0.93 | 5.2 |
| `restaurante central` | restaurant | 25 | 27 | 0.93 | 5.2 |
| `encontro` | cafe | 61 | 148 | 0.41 | 5.2 |
| `adega regional` | restaurant | 60 | 65 | 0.92 | 5.2 |
| `restaurante sao` | restaurant | 60 | 65 | 0.92 | 5.2 |
| `roulote` | restaurant | 60 | 65 | 0.92 | 5.2 |
| `chefe` | restaurant | 48 | 52 | 0.92 | 5.2 |
| `gaucho` | restaurant | 24 | 26 | 0.92 | 5.2 |
| `happy grill` | restaurant | 24 | 26 | 0.92 | 5.2 |
| `grill` | restaurant | 380 | 414 | 0.92 | 5.2 |
| `pizaria` | restaurant | 22 | 24 | 0.92 | 5.2 |
| `restaurante bom` | restaurant | 22 | 24 | 0.92 | 5.2 |
| `restaurante joao` | restaurant | 21 | 23 | 0.91 | 5.2 |
| `esplanada` | cafe | 107 | 263 | 0.41 | 5.2 |
| `tipico` | restaurant | 51 | 56 | 0.91 | 5.1 |
| `italian` | restaurant | 70 | 77 | 0.91 | 5.1 |
| `prato` | restaurant | 50 | 55 | 0.91 | 5.1 |
| `izakaya` | restaurant | 20 | 22 | 0.91 | 5.1 |
| `restaurante praia` | restaurant | 20 | 22 | 0.91 | 5.1 |
| `napoli` | restaurant | 29 | 32 | 0.91 | 5.1 |
| `hot dog` | restaurant | 19 | 21 | 0.90 | 5.1 |
| `restaurante carlos` | restaurant | 19 | 21 | 0.90 | 5.1 |
| `sopas` | restaurant | 75 | 83 | 0.90 | 5.1 |
| `restaurante marisqueira` | restaurant | 56 | 62 | 0.90 | 5.1 |
| `restaurante residencial` | restaurant | 28 | 31 | 0.90 | 5.1 |
| `petiscaria` | restaurant | 37 | 41 | 0.90 | 5.1 |
| `hamburgueria artesanal` | restaurant | 18 | 20 | 0.90 | 5.1 |
| `restaurante regional` | restaurant | 18 | 20 | 0.90 | 5.1 |
| `taj mahal` | restaurant | 18 | 20 | 0.90 | 5.1 |
| `francesinha` | restaurant | 35 | 39 | 0.90 | 5.1 |
| `das sandes` | restaurant | 51 | 57 | 0.89 | 5.1 |
| `asian` | restaurant | 34 | 38 | 0.89 | 5.1 |
| `restaurante perola` | restaurant | 17 | 19 | 0.89 | 5.1 |
| `mahal` | restaurant | 24 | 27 | 0.89 | 5.0 |
| `temperos` | restaurant | 24 | 27 | 0.89 | 5.0 |
| `restaurante santo` | restaurant | 16 | 18 | 0.89 | 5.0 |
| `japones` | restaurant | 31 | 35 | 0.89 | 5.0 |
| `pregos` | restaurant | 31 | 35 | 0.89 | 5.0 |
| `cachorros` | restaurant | 23 | 26 | 0.88 | 5.0 |
| `almoco` | restaurant | 15 | 17 | 0.88 | 5.0 |
| `cachorro` | restaurant | 15 | 17 | 0.88 | 5.0 |
| `kyoto` | restaurant | 15 | 17 | 0.88 | 5.0 |
| `restaurante clube` | restaurant | 15 | 17 | 0.88 | 5.0 |
| `convivio` | cafe | 27 | 69 | 0.39 | 5.0 |
| `adega dos` | restaurant | 28 | 32 | 0.88 | 4.9 |
| `dos pregos` | restaurant | 21 | 24 | 0.88 | 4.9 |
| `cuisine` | restaurant | 48 | 55 | 0.87 | 4.9 |
| `fidelidade loja` | store | 400 | 400 | 1.00 | 4.9 |
| `marmores` | store | 172 | 172 | 1.00 | 4.9 |
| `pronto vestir` | store | 159 | 159 | 1.00 | 4.9 |
| `muebles` | store | 142 | 142 | 1.00 | 4.9 |
| `revestimentos` | store | 124 | 124 | 1.00 | 4.9 |
| `joyeria` | store | 123 | 123 | 1.00 | 4.9 |
| `benetton` | store | 117 | 117 | 1.00 | 4.9 |
| `colors benetton` | store | 110 | 110 | 1.00 | 4.9 |
| `comercio vestuario` | store | 109 | 109 | 1.00 | 4.9 |
| `libreria` | store | 97 | 97 | 1.00 | 4.9 |
| `graficas` | store | 92 | 92 | 1.00 | 4.9 |
| `sociedad construcoes` | store | 90 | 90 | 1.00 | 4.9 |
| `instalacoes electricas` | store | 86 | 86 | 1.00 | 4.9 |
| `artes graficas` | store | 84 | 84 | 1.00 | 4.9 |
| `tecidos` | store | 82 | 82 | 1.00 | 4.9 |
| `livraria papelaria` | store | 81 | 81 | 1.00 | 4.9 |
| `calzados` | store | 76 | 76 | 1.00 | 4.9 |
| `industria mobiliario` | store | 76 | 76 | 1.00 | 4.9 |
| `marmores granitos` | store | 74 | 74 | 1.00 | 4.9 |
| `papelaria tabacaria` | store | 72 | 72 | 1.00 | 4.9 |
| `comercio moveis` | store | 65 | 65 | 1.00 | 4.9 |
| `pavimentos` | store | 63 | 63 | 1.00 | 4.9 |
| `alberto oculista` | store | 58 | 58 | 1.00 | 4.9 |
| `dutti` | store | 58 | 58 | 1.00 | 4.9 |
| `jewelry` | store | 57 | 57 | 1.00 | 4.9 |
| `papelaria livraria` | store | 57 | 57 | 1.00 | 4.9 |
| `fidelidade agencia` | store | 56 | 56 | 1.00 | 4.9 |
| `joalheiros` | store | 55 | 55 | 1.00 | 4.9 |
| `sapatarias` | store | 55 | 55 | 1.00 | 4.9 |
| `isolamentos` | store | 54 | 54 | 1.00 | 4.9 |
| `relogios` | store | 52 | 52 | 1.00 | 4.9 |
| `bigmat` | store | 49 | 49 | 1.00 | 4.9 |
| `comercio electrodomesticos` | store | 49 | 49 | 1.00 | 4.9 |
| `malhas confeccoes` | store | 46 | 46 | 1.00 | 4.9 |
| `ourivesaria relojoaria` | store | 46 | 46 | 1.00 | 4.9 |
| `toys` | store | 46 | 46 | 1.00 | 4.9 |
| `artigos decoracao` | store | 45 | 45 | 1.00 | 4.9 |
| `oysho` | store | 45 | 45 | 1.00 | 4.9 |
| `artigos papelaria` | store | 43 | 43 | 1.00 | 4.9 |
| `loja gato` | store | 42 | 42 | 1.00 | 4.9 |
| `pepe jeans` | store | 42 | 42 | 1.00 | 4.9 |
| `remodelacoes` | store | 42 | 42 | 1.00 | 4.9 |
| `decoracao interiores` | store | 41 | 41 | 1.00 | 4.9 |
| `women secret` | store | 41 | 41 | 1.00 | 4.9 |
| `industria confeccoes` | store | 39 | 39 | 1.00 | 4.9 |
| `tous jewelry` | store | 39 | 39 | 1.00 | 4.9 |
| `moveis decoracoes` | store | 38 | 38 | 1.00 | 4.9 |
| `impressao` | store | 37 | 37 | 1.00 | 4.9 |
| `malas` | store | 36 | 36 | 1.00 | 4.9 |
| `tectos` | store | 36 | 36 | 1.00 | 4.9 |
| `aluminios` | store | 35 | 35 | 1.00 | 4.9 |
| `fabrica calcado` | store | 35 | 35 | 1.00 | 4.9 |
| `servicos limpeza` | store | 34 | 34 | 1.00 | 4.9 |
| `sofas` | store | 33 | 33 | 1.00 | 4.9 |
| `ventilacao` | store | 33 | 33 | 1.00 | 4.9 |
| `carpintaria mecanica` | store | 32 | 32 | 1.00 | 4.9 |
| `peles` | store | 32 | 32 | 1.00 | 4.9 |
| `flying tiger` | store | 31 | 31 | 1.00 | 4.9 |
| `sanitarios` | store | 31 | 31 | 1.00 | 4.9 |
| `tmn` | store | 31 | 31 | 1.00 | 4.9 |
| `acessorios moda` | store | 30 | 30 | 1.00 | 4.9 |
| `caixilharia` | store | 30 | 30 | 1.00 | 4.9 |
| `ensitel` | store | 30 | 30 | 1.00 | 4.9 |
| `stara` | store | 30 | 30 | 1.00 | 4.9 |
| `sunglass hut` | store | 30 | 30 | 1.00 | 4.9 |
| `embalagens` | store | 29 | 29 | 1.00 | 4.9 |
| `etiquetas` | store | 29 | 29 | 1.00 | 4.9 |
| `renovaveis` | store | 29 | 29 | 1.00 | 4.9 |
| `falsos` | store | 28 | 28 | 1.00 | 4.9 |
| `galli` | store | 28 | 28 | 1.00 | 4.9 |
| `instrumentos musicais` | store | 28 | 28 | 1.00 | 4.9 |
| `marcenaria` | store | 28 | 28 | 1.00 | 4.9 |
| `w52` | store | 28 | 28 | 1.00 | 4.9 |
| `comercio pronto` | store | 27 | 27 | 1.00 | 4.9 |
| `industria calcado` | store | 27 | 27 | 1.00 | 4.9 |
| `levi store` | store | 27 | 27 | 1.00 | 4.9 |
| `people phone` | store | 27 | 27 | 1.00 | 4.9 |
| `tectos falsos` | store | 27 | 27 | 1.00 | 4.9 |
| `tiger copenhagen` | store | 27 | 27 | 1.00 | 4.9 |
| `comercio texteis` | store | 26 | 26 | 1.00 | 4.9 |
| `engenharia construcao` | store | 26 | 26 | 1.00 | 4.9 |
| `lion porches` | store | 26 | 26 | 1.00 | 4.9 |
| `mobiliario decoracao` | store | 26 | 26 | 1.00 | 4.9 |
| `throttleman` | store | 26 | 26 | 1.00 | 4.9 |
| `bricolage` | store | 25 | 25 | 1.00 | 4.9 |
| `para construcao` | store | 25 | 25 | 1.00 | 4.9 |
| `accessorize` | store | 24 | 24 | 1.00 | 4.9 |
| `calcados` | store | 24 | 24 | 1.00 | 4.9 |
| `centroxogo` | store | 24 | 24 | 1.00 | 4.9 |
| `comercio peixe` | store | 24 | 24 | 1.00 | 4.9 |
| `energias renovaveis` | store | 24 | 24 | 1.00 | 4.9 |
| `giovanni galli` | store | 24 | 24 | 1.00 | 4.9 |
| `comercio ourivesaria` | store | 23 | 23 | 1.00 | 4.9 |
| `consumiveis` | store | 23 | 23 | 1.00 | 4.9 |
| `estamparia` | store | 23 | 23 | 1.00 | 4.9 |
| `house reeducacao` | store | 23 | 23 | 1.00 | 4.9 |
| `kids junior` | store | 23 | 23 | 1.00 | 4.9 |
| `publicitarios` | store | 23 | 23 | 1.00 | 4.9 |
| `reclamos` | store | 23 | 23 | 1.00 | 4.9 |
| `reeducacao alimentar` | store | 23 | 23 | 1.00 | 4.9 |
| `reparacao electrodomesticos` | store | 23 | 23 | 1.00 | 4.9 |
| `comercio calcado` | store | 22 | 22 | 1.00 | 4.9 |
| `electronico` | store | 22 | 22 | 1.00 | 4.9 |
| `industria moveis` | store | 22 | 22 | 1.00 | 4.9 |
| `luminosos` | store | 22 | 22 | 1.00 | 4.9 |
| `mobiliario escritorio` | store | 22 | 22 | 1.00 | 4.9 |
| `pichelaria` | store | 22 | 22 | 1.00 | 4.9 |
| `sociedad construcao` | store | 22 | 22 | 1.00 | 4.9 |
| `texteis lar` | store | 22 | 22 | 1.00 | 4.9 |
| `acabamentos` | store | 21 | 21 | 1.00 | 4.9 |
| `bimba lola` | store | 21 | 21 | 1.00 | 4.9 |
| `espingardaria` | store | 21 | 21 | 1.00 | 4.9 |
| `componentes electronicos` | store | 20 | 20 | 1.00 | 4.9 |
| `imoveis` | store | 20 | 20 | 1.00 | 4.9 |
| `kidstore` | store | 20 | 20 | 1.00 | 4.9 |
| `natura selection` | store | 20 | 20 | 1.00 | 4.9 |
| `stone stone` | store | 20 | 20 | 1.00 | 4.9 |
| `carpintaria moveis` | store | 19 | 19 | 1.00 | 4.9 |
| `locker` | store | 19 | 19 | 1.00 | 4.9 |
| `loja braga` | store | 19 | 19 | 1.00 | 4.9 |
| `novidades` | store | 19 | 19 | 1.00 | 4.9 |
| `opticas multiopticas` | store | 19 | 19 | 1.00 | 4.9 |
| `ourivesarias` | store | 19 | 19 | 1.00 | 4.9 |
| `reclamos luminosos` | store | 19 | 19 | 1.00 | 4.9 |
| `artigos pesca` | store | 18 | 18 | 1.00 | 4.9 |
| `bota minuto` | store | 18 | 18 | 1.00 | 4.9 |
| `confecciones` | store | 18 | 18 | 1.00 | 4.9 |
| `construcao decoracao` | store | 18 | 18 | 1.00 | 4.9 |
| `euronics` | store | 18 | 18 | 1.00 | 4.9 |
| `fabrica malhas` | store | 18 | 18 | 1.00 | 4.9 |
| `industria malhas` | store | 18 | 18 | 1.00 | 4.9 |
| `instalacoes tecnicas` | store | 18 | 18 | 1.00 | 4.9 |
| `jeans london` | store | 18 | 18 | 1.00 | 4.9 |
| `joalheiro` | store | 18 | 18 | 1.00 | 4.9 |
| `marroquinaria` | store | 18 | 18 | 1.00 | 4.9 |
| `persianas` | store | 18 | 18 | 1.00 | 4.9 |
| `prenatal` | store | 18 | 18 | 1.00 | 4.9 |
| `sociedade equipamentos` | store | 18 | 18 | 1.00 | 4.9 |
| `aquecimento central` | store | 17 | 17 | 1.00 | 4.9 |
| `cimentos` | store | 17 | 17 | 1.00 | 4.9 |
| `comercio confeccoes` | store | 17 | 17 | 1.00 | 4.9 |
| `cutelarias` | store | 17 | 17 | 1.00 | 4.9 |
| `hush` | store | 17 | 17 | 1.00 | 4.9 |
| `impermeabilizacoes` | store | 17 | 17 | 1.00 | 4.9 |
| `joyeros` | store | 17 | 17 | 1.00 | 4.9 |
| `mudancas` | store | 17 | 17 | 1.00 | 4.9 |
| `papelarias` | store | 17 | 17 | 1.00 | 4.9 |
| `publicacoes` | store | 17 | 17 | 1.00 | 4.9 |
| `puppies` | store | 17 | 17 | 1.00 | 4.9 |
| `samsonite` | store | 17 | 17 | 1.00 | 4.9 |
| `sapatos` | store | 17 | 17 | 1.00 | 4.9 |
| `comercio artesanato` | store | 16 | 16 | 1.00 | 4.9 |
| `cozinhas equipamentos` | store | 16 | 16 | 1.00 | 4.9 |
| `estudos projectos` | store | 16 | 16 | 1.00 | 4.9 |
| `materiais para` | store | 16 | 16 | 1.00 | 4.9 |
| `minisom` | store | 16 | 16 | 1.00 | 4.9 |
| `ouriversaria` | store | 16 | 16 | 1.00 | 4.9 |
| `papagaio sem` | store | 16 | 16 | 1.00 | 4.9 |
| `para calcado` | store | 16 | 16 | 1.00 | 4.9 |
| `promod` | store | 16 | 16 | 1.00 | 4.9 |
| `reabilitacao auditiva` | store | 16 | 16 | 1.00 | 4.9 |
| `aerosoles` | store | 15 | 15 | 1.00 | 4.9 |
| `bijouterie` | store | 15 | 15 | 1.00 | 4.9 |
| `britas` | store | 15 | 15 | 1.00 | 4.9 |
| `canalizacao` | store | 15 | 15 | 1.00 | 4.9 |
| `carpintaria marcenaria` | store | 15 | 15 | 1.00 | 4.9 |
| `colchoes companhia` | store | 15 | 15 | 1.00 | 4.9 |
| `decimas` | store | 15 | 15 | 1.00 | 4.9 |
| `equipamentos electronicos` | store | 15 | 15 | 1.00 | 4.9 |
| `fatos` | store | 15 | 15 | 1.00 | 4.9 |
| `granitos marmores` | store | 15 | 15 | 1.00 | 4.9 |
| `hilfiger` | store | 15 | 15 | 1.00 | 4.9 |
| `mike davis` | store | 15 | 15 | 1.00 | 4.9 |
| `sanitop` | store | 15 | 15 | 1.00 | 4.9 |
| `shana` | store | 15 | 15 | 1.00 | 4.9 |
| `uniformes` | store | 15 | 15 | 1.00 | 4.9 |
| `sopa` | restaurant | 27 | 31 | 0.87 | 4.9 |
| `das tapas` | restaurant | 20 | 23 | 0.87 | 4.9 |
| `restaurante cafe` | restaurant | 33 | 38 | 0.87 | 4.9 |
| `construcao civil` | store | 209 | 210 | 1.00 | 4.9 |
| `ourivesaria` | store | 565 | 568 | 0.99 | 4.9 |
| `materiais construcao` | store | 336 | 338 | 0.99 | 4.9 |
| `vestir` | store | 163 | 164 | 0.99 | 4.9 |
| `bbq` | restaurant | 26 | 30 | 0.87 | 4.9 |
| `subway` | restaurant | 26 | 30 | 0.87 | 4.9 |
| `chef` | restaurant | 84 | 97 | 0.87 | 4.9 |
| `interiores` | store | 143 | 144 | 0.99 | 4.9 |
| `oculista` | store | 134 | 135 | 0.99 | 4.9 |
| `calcado` | store | 244 | 246 | 0.99 | 4.9 |
| `material electrico` | store | 120 | 121 | 0.99 | 4.9 |
| `confeccoes` | store | 544 | 549 | 0.99 | 4.9 |
| `moveis` | store | 594 | 600 | 0.99 | 4.9 |
| `mobiliario` | store | 373 | 377 | 0.99 | 4.9 |
| `estores` | store | 92 | 93 | 0.99 | 4.9 |
| `phone` | store | 183 | 185 | 0.99 | 4.9 |
| `antiguidades` | store | 77 | 78 | 0.99 | 4.9 |
| `iluminacao` | store | 75 | 76 | 0.99 | 4.9 |
| `asador` | restaurant | 37 | 43 | 0.86 | 4.9 |
| `granitos` | store | 145 | 147 | 0.99 | 4.9 |
| `sapataria` | store | 287 | 291 | 0.99 | 4.9 |
| `husqvarna` | store | 140 | 142 | 0.99 | 4.9 |
| `confeccao` | store | 68 | 69 | 0.99 | 4.9 |
| `textil` | store | 134 | 136 | 0.99 | 4.9 |
| `restaurant` | restaurant | 780 | 908 | 0.86 | 4.9 |
| `carpintaria` | store | 260 | 264 | 0.98 | 4.9 |
| `retrosaria` | store | 63 | 64 | 0.98 | 4.9 |
| `comercio mobiliario` | store | 61 | 62 | 0.98 | 4.9 |
| `comercio materiais` | store | 59 | 60 | 0.98 | 4.8 |
| `ferreteria` | store | 117 | 119 | 0.98 | 4.8 |
| `construcao` | store | 699 | 711 | 0.98 | 4.8 |
| `smash` | restaurant | 36 | 42 | 0.86 | 4.8 |
| `luigi` | restaurant | 30 | 35 | 0.86 | 4.8 |
| `restaurante sol` | restaurant | 24 | 28 | 0.86 | 4.8 |
| `tokyo` | restaurant | 18 | 21 | 0.86 | 4.8 |
| `malhas` | store | 171 | 174 | 0.98 | 4.8 |
| `aquecimento` | store | 57 | 58 | 0.98 | 4.8 |
| `canalizacoes` | store | 57 | 58 | 0.98 | 4.8 |
| `vidreira` | store | 55 | 56 | 0.98 | 4.8 |
| `copias` | store | 54 | 55 | 0.98 | 4.8 |
| `brindes` | store | 53 | 54 | 0.98 | 4.8 |
| `texteis` | store | 260 | 265 | 0.98 | 4.8 |
| `relojoaria` | store | 103 | 105 | 0.98 | 4.8 |
| `fidelidade` | store | 460 | 469 | 0.98 | 4.8 |
| `materiais` | store | 403 | 411 | 0.98 | 4.8 |
| `molduras` | store | 50 | 51 | 0.98 | 4.8 |
| `joalharia` | store | 48 | 49 | 0.98 | 4.8 |
| `colchoes` | store | 47 | 48 | 0.98 | 4.8 |
| `pull` | store | 92 | 94 | 0.98 | 4.8 |
| `vidraria` | store | 46 | 47 | 0.98 | 4.8 |
| `ferragens` | store | 177 | 181 | 0.98 | 4.8 |
| `vestuario` | store | 218 | 223 | 0.98 | 4.8 |
| `opticas` | store | 43 | 44 | 0.98 | 4.8 |
| `assado` | restaurant | 23 | 27 | 0.85 | 4.8 |
| `informaticos` | store | 41 | 42 | 0.98 | 4.8 |
| `maquinas ferramentas` | store | 41 | 42 | 0.98 | 4.8 |
| `construcoes` | store | 526 | 539 | 0.98 | 4.8 |
| `energias` | store | 39 | 40 | 0.97 | 4.8 |
| `centro copias` | store | 38 | 39 | 0.97 | 4.8 |
| `cafe cervejaria` | cafe | 22 | 58 | 0.38 | 4.8 |
| `triumph` | store | 37 | 38 | 0.97 | 4.8 |
| `sandes` | restaurant | 73 | 86 | 0.85 | 4.8 |
| `curry` | restaurant | 28 | 33 | 0.85 | 4.8 |
| `jeans` | store | 72 | 74 | 0.97 | 4.8 |
| `civil obras` | store | 36 | 37 | 0.97 | 4.8 |
| `decoracoes` | store | 251 | 258 | 0.97 | 4.8 |
| `limpezas` | store | 106 | 109 | 0.97 | 4.8 |
| `bordados` | store | 69 | 71 | 0.97 | 4.8 |
| `brigitte` | store | 34 | 35 | 0.97 | 4.8 |
| `estruturas` | store | 33 | 34 | 0.97 | 4.8 |
| `vernizes` | store | 33 | 34 | 0.97 | 4.8 |
| `adega tipica` | restaurant | 22 | 26 | 0.85 | 4.8 |
| `hamburgaria` | restaurant | 22 | 26 | 0.85 | 4.8 |
| `montagens electricas` | store | 32 | 33 | 0.97 | 4.8 |
| `wear` | store | 32 | 33 | 0.97 | 4.8 |
| `take away` | restaurant | 82 | 97 | 0.85 | 4.8 |
| `electronicos` | store | 62 | 64 | 0.97 | 4.8 |
| `para lar` | store | 31 | 32 | 0.97 | 4.8 |
| `tintas vernizes` | store | 30 | 31 | 0.97 | 4.8 |
| `industria textil` | store | 29 | 30 | 0.97 | 4.8 |
| `modas` | store | 114 | 118 | 0.97 | 4.8 |
| `campones` | restaurant | 16 | 19 | 0.84 | 4.8 |
| `decoracion` | store | 28 | 29 | 0.97 | 4.8 |
| `cortinados` | store | 27 | 28 | 0.96 | 4.8 |
| `foreva` | store | 53 | 55 | 0.96 | 4.8 |
| `publicidade` | store | 79 | 82 | 0.96 | 4.7 |
| `aroma` | cafe | 27 | 72 | 0.38 | 4.7 |
| `divisorias` | store | 26 | 27 | 0.96 | 4.7 |
| `souvenirs` | store | 26 | 27 | 0.96 | 4.7 |
| `meat` | restaurant | 26 | 31 | 0.84 | 4.7 |
| `climatizacao` | store | 100 | 104 | 0.96 | 4.7 |
| `fabrica moveis` | store | 25 | 26 | 0.96 | 4.7 |
| `print` | store | 25 | 26 | 0.96 | 4.7 |
| `cozinhas` | store | 97 | 101 | 0.96 | 4.7 |
| `bifanas` | restaurant | 139 | 166 | 0.84 | 4.7 |
| `comercio ferragens` | store | 24 | 25 | 0.96 | 4.7 |
| `domesticas` | store | 24 | 25 | 0.96 | 4.7 |
| `editora` | store | 24 | 25 | 0.96 | 4.7 |
| `equipamentos electricos` | store | 24 | 25 | 0.96 | 4.7 |
| `prendas` | store | 24 | 25 | 0.96 | 4.7 |
| `velharias` | store | 24 | 25 | 0.96 | 4.7 |
| `carpintarias` | store | 23 | 24 | 0.96 | 4.7 |
| `cimento` | store | 23 | 24 | 0.96 | 4.7 |
| `cin` | store | 23 | 24 | 0.96 | 4.7 |
| `copia` | store | 23 | 24 | 0.96 | 4.7 |
| `optivisao` | store | 23 | 24 | 0.96 | 4.7 |
| `termicos` | store | 23 | 24 | 0.96 | 4.7 |
| `aluminio` | store | 22 | 23 | 0.96 | 4.7 |
| `artefactos` | store | 22 | 23 | 0.96 | 4.7 |
| `tabacos` | store | 22 | 23 | 0.96 | 4.7 |
| `instalacoes` | store | 196 | 205 | 0.96 | 4.7 |
| `boi` | restaurant | 15 | 18 | 0.83 | 4.7 |
| `honest` | restaurant | 15 | 18 | 0.83 | 4.7 |
| `the good` | restaurant | 15 | 18 | 0.83 | 4.7 |
| `bikes` | store | 43 | 45 | 0.96 | 4.7 |
| `joias` | store | 106 | 111 | 0.95 | 4.7 |
| `obras publicas` | store | 62 | 65 | 0.95 | 4.7 |
| `sociedade construcoes` | store | 41 | 43 | 0.95 | 4.7 |
| `electricos` | store | 100 | 105 | 0.95 | 4.7 |
| `equipamento escritorio` | store | 20 | 21 | 0.95 | 4.7 |
| `loja vila` | store | 20 | 21 | 0.95 | 4.7 |
| `sex` | store | 20 | 21 | 0.95 | 4.7 |
| `tipica` | restaurant | 39 | 47 | 0.83 | 4.7 |
| `papeleria` | store | 39 | 41 | 0.95 | 4.7 |
| `confeccoes texteis` | store | 19 | 20 | 0.95 | 4.7 |
| `izibuild` | store | 19 | 20 | 0.95 | 4.7 |
| `kitea` | store | 19 | 20 | 0.95 | 4.7 |
| `quadros` | store | 19 | 20 | 0.95 | 4.7 |
| `sex shop` | store | 19 | 20 | 0.95 | 4.7 |
| `electrodomesticos` | store | 281 | 296 | 0.95 | 4.7 |
| `indiano` | restaurant | 24 | 29 | 0.83 | 4.7 |
| `taberna dos` | restaurant | 24 | 29 | 0.83 | 4.7 |
| `instrumentos` | store | 37 | 39 | 0.95 | 4.7 |
| `bear` | store | 92 | 97 | 0.95 | 4.7 |
| `venezia` | cafe | 24 | 65 | 0.37 | 4.7 |
| `shoes` | store | 55 | 58 | 0.95 | 4.7 |
| `artesanato` | store | 164 | 173 | 0.95 | 4.7 |
| `ale hop` | store | 36 | 38 | 0.95 | 4.7 |
| `plasticos` | store | 36 | 38 | 0.95 | 4.7 |
| `construcoes civis` | store | 18 | 19 | 0.95 | 4.7 |
| `industria alimentar` | store | 18 | 19 | 0.95 | 4.7 |
| `metalicos` | store | 18 | 19 | 0.95 | 4.7 |
| `utilidades domesticas` | store | 18 | 19 | 0.95 | 4.7 |
| `vegetariano` | restaurant | 19 | 23 | 0.83 | 4.7 |
| `tabacaria` | store | 371 | 392 | 0.95 | 4.7 |
| `alho` | restaurant | 33 | 40 | 0.82 | 4.7 |
| `brunch` | cafe | 85 | 231 | 0.37 | 4.7 |
| `condicionado` | store | 85 | 90 | 0.94 | 4.7 |
| `cocinas` | store | 34 | 36 | 0.94 | 4.7 |
| `ferragens ferramentas` | store | 34 | 36 | 0.94 | 4.7 |
| `optica medica` | store | 17 | 18 | 0.94 | 4.7 |
| `bistrot` | restaurant | 28 | 34 | 0.82 | 4.7 |
| `cozinha` | restaurant | 214 | 260 | 0.82 | 4.7 |
| `levi` | store | 33 | 35 | 0.94 | 4.6 |
| `musicais` | store | 33 | 35 | 0.94 | 4.6 |
| `serigrafia` | store | 33 | 35 | 0.94 | 4.6 |
| `colors` | store | 114 | 121 | 0.94 | 4.6 |
| `comercio material` | store | 65 | 69 | 0.94 | 4.6 |
| `telecomunicacoes` | store | 48 | 51 | 0.94 | 4.6 |
| `deborla` | store | 32 | 34 | 0.94 | 4.6 |
| `decorativos` | store | 32 | 34 | 0.94 | 4.6 |
| `artigos desportivos` | store | 16 | 17 | 0.94 | 4.6 |
| `mais optica` | store | 16 | 17 | 0.94 | 4.6 |
| `quatro patas` | store | 16 | 17 | 0.94 | 4.6 |
| `sem penas` | store | 16 | 17 | 0.94 | 4.6 |
| `tien21` | store | 16 | 17 | 0.94 | 4.6 |
| `vidros espelhos` | store | 16 | 17 | 0.94 | 4.6 |
| `das francesinhas` | restaurant | 32 | 39 | 0.82 | 4.6 |
| `pronto comer` | restaurant | 32 | 39 | 0.82 | 4.6 |
| `united` | store | 111 | 118 | 0.94 | 4.6 |
| `grafica` | store | 63 | 67 | 0.94 | 4.6 |
| `comercio artigos` | store | 110 | 117 | 0.94 | 4.6 |
| `manjar` | restaurant | 91 | 111 | 0.82 | 4.6 |
| `automatismos` | store | 31 | 33 | 0.94 | 4.6 |
| `comercio tintas` | store | 46 | 49 | 0.94 | 4.6 |
| `tasquinha` | restaurant | 297 | 363 | 0.82 | 4.6 |
| `republic` | restaurant | 36 | 44 | 0.82 | 4.6 |
| `restaurante cervejaria` | restaurant | 36 | 44 | 0.82 | 4.6 |
| `decor` | store | 45 | 48 | 0.94 | 4.6 |
| `metalicas` | store | 30 | 32 | 0.94 | 4.6 |
| `bike shop` | store | 15 | 16 | 0.94 | 4.6 |
| `construcoes unipessoal` | store | 15 | 16 | 0.94 | 4.6 |
| `metais` | store | 15 | 16 | 0.94 | 4.6 |
| `nokia` | store | 15 | 16 | 0.94 | 4.6 |
| `portas automatismos` | store | 15 | 16 | 0.94 | 4.6 |
| `estofos` | store | 59 | 63 | 0.94 | 4.6 |
| `artigos para` | store | 44 | 47 | 0.94 | 4.6 |
| `artigos` | store | 421 | 450 | 0.94 | 4.6 |
| `noivas` | store | 29 | 31 | 0.94 | 4.6 |
| `restaurante bar` | restaurant | 154 | 189 | 0.81 | 4.6 |
| `das bifanas` | restaurant | 66 | 81 | 0.81 | 4.6 |
| `bife` | restaurant | 22 | 27 | 0.81 | 4.6 |
| `ferramentas` | store | 112 | 120 | 0.93 | 4.6 |
| `montagens` | store | 70 | 75 | 0.93 | 4.6 |
| `tintas` | store | 182 | 196 | 0.93 | 4.6 |
| `meias` | store | 26 | 28 | 0.93 | 4.6 |
| `tasquinha dos` | restaurant | 17 | 21 | 0.81 | 4.6 |
| `brinquedos` | store | 64 | 69 | 0.93 | 4.6 |
| `away` | restaurant | 84 | 104 | 0.81 | 4.6 |
| `piazza` | restaurant | 21 | 26 | 0.81 | 4.6 |
| `equipamentos escritorio` | store | 50 | 54 | 0.93 | 4.6 |
| `tous` | store | 50 | 54 | 0.93 | 4.6 |
| `tabacaria papelaria` | store | 37 | 40 | 0.93 | 4.6 |
| `quiosque` | cafe | 171 | 475 | 0.36 | 4.6 |
| `betao` | store | 36 | 39 | 0.92 | 4.6 |
| `construtora` | store | 24 | 26 | 0.92 | 4.6 |
| `natur house` | store | 24 | 26 | 0.92 | 4.6 |
| `pausa` | cafe | 19 | 53 | 0.36 | 4.5 |
| `sociedade tecnica` | store | 23 | 25 | 0.92 | 4.5 |
| `decoracao` | store | 309 | 336 | 0.92 | 4.5 |
| `utilidades` | store | 57 | 62 | 0.92 | 4.5 |
| `montaditos` | restaurant | 28 | 35 | 0.80 | 4.5 |
| `piri piri` | restaurant | 24 | 30 | 0.80 | 4.5 |
| `ciao` | restaurant | 16 | 20 | 0.80 | 4.5 |
| `flavours` | restaurant | 16 | 20 | 0.80 | 4.5 |
| `terrasse` | cafe | 15 | 42 | 0.36 | 4.5 |
| `opticalia` | store | 44 | 48 | 0.92 | 4.5 |
| `refrigeracao` | store | 33 | 36 | 0.92 | 4.5 |
| `visao` | store | 33 | 36 | 0.92 | 4.5 |
| `well centro` | store | 22 | 24 | 0.92 | 4.5 |
| `publicas` | store | 64 | 70 | 0.91 | 4.5 |
| `librairie` | store | 32 | 35 | 0.91 | 4.5 |
| `note` | store | 32 | 35 | 0.91 | 4.5 |
| `taste` | restaurant | 47 | 59 | 0.80 | 4.5 |
| `madeiras` | store | 63 | 69 | 0.91 | 4.5 |
| `tapetes` | store | 21 | 23 | 0.91 | 4.5 |
| `taj` | restaurant | 35 | 44 | 0.80 | 4.5 |
| `vidros` | store | 62 | 68 | 0.91 | 4.5 |
| `electricas` | store | 152 | 167 | 0.91 | 4.5 |
| `candeeiros` | store | 30 | 33 | 0.91 | 4.5 |
| `infantario` | store | 30 | 33 | 0.91 | 4.5 |
| `transformadora` | store | 30 | 33 | 0.91 | 4.5 |
| `espelhos` | store | 20 | 22 | 0.91 | 4.5 |
| `lareiras` | store | 20 | 22 | 0.91 | 4.5 |
| `obras` | store | 109 | 120 | 0.91 | 4.5 |
| `trevo` | cafe | 18 | 51 | 0.35 | 4.5 |
| `colher` | restaurant | 15 | 19 | 0.79 | 4.5 |
| `hong` | restaurant | 15 | 19 | 0.79 | 4.5 |
| `sistemas` | store | 172 | 190 | 0.91 | 4.5 |
| `grao` | cafe | 43 | 122 | 0.35 | 4.5 |
| `kids` | store | 133 | 147 | 0.90 | 4.5 |
| `electronica` | store | 114 | 126 | 0.90 | 4.5 |
| `kid` | store | 19 | 21 | 0.90 | 4.5 |
| `pet shop` | store | 19 | 21 | 0.90 | 4.5 |
| `fabricacao` | store | 47 | 52 | 0.90 | 4.5 |
| `women` | store | 47 | 52 | 0.90 | 4.5 |
| `electricidade` | store | 122 | 135 | 0.90 | 4.5 |
| `comida` | restaurant | 52 | 66 | 0.79 | 4.5 |
| `mamma` | restaurant | 48 | 61 | 0.79 | 4.4 |
| `material` | store | 203 | 225 | 0.90 | 4.4 |
| `mamma mia` | restaurant | 22 | 28 | 0.79 | 4.4 |
| `lingerie` | store | 63 | 70 | 0.90 | 4.4 |
| `toldos` | store | 36 | 40 | 0.90 | 4.4 |
| `minuto` | store | 27 | 30 | 0.90 | 4.4 |
| `closet` | store | 18 | 20 | 0.90 | 4.4 |
| `fardas` | store | 18 | 20 | 0.90 | 4.4 |
| `tommy` | store | 18 | 20 | 0.90 | 4.4 |
| `take` | restaurant | 98 | 125 | 0.78 | 4.4 |
| `moda` | store | 240 | 267 | 0.90 | 4.4 |
| `eat` | restaurant | 47 | 60 | 0.78 | 4.4 |
| `carvao` | restaurant | 18 | 23 | 0.78 | 4.4 |
| `restaurante lounge` | restaurant | 18 | 23 | 0.78 | 4.4 |
| `ceramica` | store | 104 | 116 | 0.90 | 4.4 |
| `escritorio` | store | 147 | 164 | 0.90 | 4.4 |
| `distribuicao produtos` | store | 43 | 48 | 0.90 | 4.4 |
| `peugas` | store | 17 | 19 | 0.89 | 4.4 |
| `revistas` | store | 17 | 19 | 0.89 | 4.4 |
| `leroy` | store | 59 | 66 | 0.89 | 4.4 |
| `massimo` | store | 59 | 66 | 0.89 | 4.4 |
| `india` | restaurant | 52 | 67 | 0.78 | 4.4 |
| `foot` | store | 32 | 36 | 0.89 | 4.4 |
| `para industria` | store | 24 | 27 | 0.89 | 4.4 |
| `artigos decorativos` | store | 16 | 18 | 0.89 | 4.4 |
| `humana` | store | 16 | 18 | 0.89 | 4.4 |
| `sexshop` | store | 16 | 18 | 0.89 | 4.4 |
| `greens` | restaurant | 17 | 22 | 0.77 | 4.4 |
| `toscana` | restaurant | 17 | 22 | 0.77 | 4.4 |
| `francesinhas` | restaurant | 71 | 92 | 0.77 | 4.4 |
| `instalacao` | store | 38 | 43 | 0.88 | 4.4 |
| `thai` | restaurant | 77 | 100 | 0.77 | 4.4 |
| `tipografia` | store | 30 | 34 | 0.88 | 4.4 |
| `ceramicas` | store | 15 | 17 | 0.88 | 4.4 |
| `leonidas` | store | 15 | 17 | 0.88 | 4.4 |
| `rodrigues filhos` | store | 15 | 17 | 0.88 | 4.4 |
| `dos petiscos` | restaurant | 30 | 39 | 0.77 | 4.3 |
| `projectos` | store | 112 | 127 | 0.88 | 4.3 |
| `sacoor` | store | 52 | 59 | 0.88 | 4.3 |
| `equipamentos industriais` | store | 37 | 42 | 0.88 | 4.3 |
| `hop` | store | 37 | 42 | 0.88 | 4.3 |
| `taska` | restaurant | 46 | 60 | 0.77 | 4.3 |
| `serralharia` | store | 29 | 33 | 0.88 | 4.3 |
| `multiopticas` | store | 86 | 98 | 0.88 | 4.3 |
| `industria comercio` | store | 136 | 155 | 0.88 | 4.3 |
| `fado` | restaurant | 52 | 68 | 0.76 | 4.3 |
| `livros` | store | 42 | 48 | 0.88 | 4.3 |
| `fusion` | restaurant | 45 | 59 | 0.76 | 4.3 |
| `outlet` | store | 160 | 183 | 0.87 | 4.3 |
| `bifana` | restaurant | 16 | 21 | 0.76 | 4.3 |
| `nepal` | restaurant | 19 | 25 | 0.76 | 4.3 |
| `cantina` | restaurant | 148 | 195 | 0.76 | 4.3 |
| `papel` | store | 47 | 54 | 0.87 | 4.3 |
| `brico` | store | 20 | 23 | 0.87 | 4.3 |
| `elevadores` | store | 20 | 23 | 0.87 | 4.3 |
| `espacos` | store | 20 | 23 | 0.87 | 4.3 |
| `cafe restaurante` | restaurant | 250 | 330 | 0.76 | 4.3 |
| `barriga` | restaurant | 25 | 33 | 0.76 | 4.3 |
| `optica` | store | 304 | 350 | 0.87 | 4.3 |
| `foto` | store | 33 | 38 | 0.87 | 4.3 |
| `optico` | store | 46 | 53 | 0.87 | 4.3 |
| `informatica` | store | 191 | 221 | 0.86 | 4.3 |
| `lareira` | restaurant | 52 | 69 | 0.75 | 4.3 |
| `megastore` | store | 19 | 22 | 0.86 | 4.3 |
| `bazar` | store | 167 | 194 | 0.86 | 4.2 |
| `italiano` | restaurant | 54 | 72 | 0.75 | 4.2 |
| `telheiro` | restaurant | 48 | 64 | 0.75 | 4.2 |
| `restaurantes` | restaurant | 30 | 40 | 0.75 | 4.2 |
| `minhoto` | restaurant | 21 | 28 | 0.75 | 4.2 |
| `terrazza` | restaurant | 18 | 24 | 0.75 | 4.2 |
| `barracao` | restaurant | 15 | 20 | 0.75 | 4.2 |
| `dos presuntos` | restaurant | 15 | 20 | 0.75 | 4.2 |
| `mexicana` | restaurant | 15 | 20 | 0.75 | 4.2 |
| `turkish` | restaurant | 15 | 20 | 0.75 | 4.2 |
| `tapas` | restaurant | 316 | 422 | 0.75 | 4.2 |
| `comunicacao` | store | 30 | 35 | 0.86 | 4.2 |
| `loja chinesa` | store | 30 | 35 | 0.86 | 4.2 |
| `desportivos` | store | 24 | 28 | 0.86 | 4.2 |
| `santos filhos` | store | 24 | 28 | 0.86 | 4.2 |
| `alimentares congelados` | store | 18 | 21 | 0.86 | 4.2 |
| `distribuicao alimentar` | store | 18 | 21 | 0.86 | 4.2 |
| `equipamentos para` | store | 18 | 21 | 0.86 | 4.2 |
| `globe` | store | 18 | 21 | 0.86 | 4.2 |
| `higiene limpeza` | store | 18 | 21 | 0.86 | 4.2 |
| `acai` | restaurant | 91 | 122 | 0.75 | 4.2 |
| `bike` | store | 106 | 124 | 0.85 | 4.2 |
| `bicicletas` | store | 70 | 82 | 0.85 | 4.2 |
| `pinturas` | store | 70 | 82 | 0.85 | 4.2 |
| `domino` | restaurant | 32 | 43 | 0.74 | 4.2 |
| `comercio internacional` | store | 29 | 34 | 0.85 | 4.2 |
| `jornal` | store | 29 | 34 | 0.85 | 4.2 |
| `parreirinha` | restaurant | 23 | 31 | 0.74 | 4.2 |
| `loja chines` | store | 17 | 20 | 0.85 | 4.2 |
| `loucas` | store | 17 | 20 | 0.85 | 4.2 |
| `modas confeccoes` | store | 17 | 20 | 0.85 | 4.2 |
| `uomo` | store | 17 | 20 | 0.85 | 4.2 |
| `concept store` | store | 28 | 33 | 0.85 | 4.2 |
| `mia` | restaurant | 54 | 73 | 0.74 | 4.2 |
| `bacalhau` | restaurant | 85 | 115 | 0.74 | 4.2 |
| `pipo` | restaurant | 17 | 23 | 0.74 | 4.2 |
| `marisco` | restaurant | 31 | 42 | 0.74 | 4.2 |
| `copy` | store | 22 | 26 | 0.85 | 4.2 |
| `edificios` | store | 22 | 26 | 0.85 | 4.2 |
| `industriais` | store | 152 | 180 | 0.84 | 4.2 |
| `limpeza` | store | 103 | 122 | 0.84 | 4.2 |
| `electrico` | store | 130 | 154 | 0.84 | 4.2 |
| `food` | restaurant | 281 | 382 | 0.74 | 4.2 |
| `buffet` | restaurant | 50 | 68 | 0.74 | 4.2 |
| `flying` | store | 32 | 38 | 0.84 | 4.2 |
| `lojas` | store | 32 | 38 | 0.84 | 4.2 |
| `cereais` | store | 16 | 19 | 0.84 | 4.2 |
| `imp` | store | 16 | 19 | 0.84 | 4.2 |
| `lacticinios` | store | 16 | 19 | 0.84 | 4.2 |
| `producao comercializacao` | store | 16 | 19 | 0.84 | 4.2 |
| `petiscos` | restaurant | 154 | 210 | 0.73 | 4.1 |
| `gusto` | restaurant | 33 | 45 | 0.73 | 4.1 |
| `industria` | store | 808 | 961 | 0.84 | 4.1 |
| `prego` | restaurant | 63 | 86 | 0.73 | 4.1 |
| `farturas` | restaurant | 41 | 56 | 0.73 | 4.1 |
| `table` | restaurant | 41 | 56 | 0.73 | 4.1 |
| `bistro` | restaurant | 210 | 287 | 0.73 | 4.1 |
| `costura` | store | 73 | 87 | 0.84 | 4.1 |
| `merlin` | store | 57 | 68 | 0.84 | 4.1 |
| `halal` | restaurant | 19 | 26 | 0.73 | 4.1 |
| `namaste` | restaurant | 19 | 26 | 0.73 | 4.1 |
| `piteu` | restaurant | 19 | 26 | 0.73 | 4.1 |
| `petisqueira` | restaurant | 100 | 137 | 0.73 | 4.1 |
| `mercado municipal` | store | 126 | 151 | 0.83 | 4.1 |
| `bar restaurante` | restaurant | 144 | 198 | 0.73 | 4.1 |
| `mercato` | restaurant | 16 | 22 | 0.73 | 4.1 |
| `sociedade industrial` | store | 50 | 60 | 0.83 | 4.1 |
| `centro colombo` | store | 30 | 36 | 0.83 | 4.1 |
| `domesticos` | store | 20 | 24 | 0.83 | 4.1 |
| `horticolas` | store | 20 | 24 | 0.83 | 4.1 |
| `leiloes` | store | 15 | 18 | 0.83 | 4.1 |
| `ribeiro filhos` | store | 15 | 18 | 0.83 | 4.1 |
| `sucessor` | store | 15 | 18 | 0.83 | 4.1 |
| `comer` | restaurant | 53 | 73 | 0.73 | 4.1 |
| `solucoes` | store | 84 | 101 | 0.83 | 4.1 |
| `olivier` | restaurant | 21 | 29 | 0.72 | 4.1 |
| `pans` | restaurant | 21 | 29 | 0.72 | 4.1 |
| `kitchen` | restaurant | 114 | 158 | 0.72 | 4.1 |
| `tasco` | restaurant | 44 | 61 | 0.72 | 4.1 |
| `jornais` | store | 19 | 23 | 0.83 | 4.1 |
| `oak` | store | 19 | 23 | 0.83 | 4.1 |
| `caca` | store | 28 | 34 | 0.82 | 4.1 |
| `taco` | restaurant | 33 | 46 | 0.72 | 4.1 |
| `especiais` | store | 23 | 28 | 0.82 | 4.0 |
| `exportacao` | store | 124 | 151 | 0.82 | 4.0 |
| `arquitectura` | store | 55 | 67 | 0.82 | 4.0 |
| `engenharia` | store | 119 | 145 | 0.82 | 4.0 |
| `bao` | restaurant | 15 | 21 | 0.71 | 4.0 |
| `feira dos` | store | 27 | 33 | 0.82 | 4.0 |
| `taberna` | restaurant | 703 | 986 | 0.71 | 4.0 |
| `king` | restaurant | 123 | 173 | 0.71 | 4.0 |
| `alimentar` | store | 101 | 124 | 0.81 | 4.0 |
| `comercio representacoes` | store | 39 | 48 | 0.81 | 4.0 |

## Proposed terms for types the app has no PoiType for

822 terms, kept separate so they do not consume review time. A term here cannot be used until the type exists, so this is evidence for KAN-400 rather than a list to approve. Strong signals in here are an argument that the type is worth adding.

| token | type | support | occurrences | precision | lift |
|---|---|---:|---:|---:|---:|
| `aerodromo` | airport | 16 | 20 | 0.80 | 3553.3 |
| `bowling` | bowling_alley | 59 | 67 | 0.88 | 2742.0 |
| `luckia` | casino | 42 | 42 | 1.00 | 1541.0 |
| `apuestas luckia` | casino | 40 | 40 | 1.00 | 1541.0 |
| `apuestas` | casino | 43 | 45 | 0.96 | 1472.5 |
| `bingo` | casino | 25 | 27 | 0.93 | 1426.8 |
| `praca touros` | stadium | 43 | 48 | 0.90 | 1264.4 |
| `golf course` | golf_course | 22 | 23 | 0.96 | 1239.9 |
| `course` | golf_course | 27 | 30 | 0.90 | 1166.7 |
| `embaixada` | embassy | 73 | 83 | 0.88 | 1165.1 |
| `tramway` | transit_station | 27 | 41 | 0.66 | 1136.6 |
| `embassy` | embassy | 38 | 45 | 0.84 | 1118.6 |
| `consulado` | embassy | 36 | 43 | 0.84 | 1109.1 |
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
| `campo tenis` | tennis_court | 19 | 20 | 0.95 | 864.3 |
| `mts` | transit_station | 21 | 43 | 0.49 | 842.9 |
| `clube tenis` | tennis_court | 47 | 51 | 0.92 | 838.4 |
| `tennis` | tennis_court | 48 | 55 | 0.87 | 794.0 |
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
| `taxis` | taxi_stand | 215 | 224 | 0.96 | 543.9 |
| `pavilhao` | stadium | 53 | 138 | 0.38 | 542.0 |
| `radio taxis` | taxi_stand | 20 | 21 | 0.95 | 539.7 |
| `instruccion` | courthouse | 15 | 16 | 0.94 | 533.3 |
| `cemiterio sao` | cemetery | 22 | 23 | 0.96 | 530.1 |
| `cemiterio` | cemetery | 403 | 424 | 0.95 | 526.7 |
| `estacao ferroviaria` | train_station | 266 | 274 | 0.97 | 525.5 |
| `administrativo` | courthouse | 21 | 23 | 0.91 | 519.3 |
| `esquadra psp` | police | 23 | 23 | 1.00 | 508.5 |
| `psp esquadra` | police | 16 | 16 | 1.00 | 508.5 |
| `comarca` | courthouse | 52 | 60 | 0.87 | 493.0 |
| `gnr` | police | 146 | 151 | 0.97 | 491.6 |
| `menores` | courthouse | 19 | 22 | 0.86 | 491.2 |
| `police` | police | 27 | 28 | 0.96 | 490.3 |
| `gnr posto` | police | 24 | 25 | 0.96 | 488.1 |
| `posto territorial` | police | 24 | 25 | 0.96 | 488.1 |
| `cementerio` | cemetery | 29 | 33 | 0.88 | 487.0 |
| `guarda nacional` | police | 21 | 22 | 0.95 | 485.4 |
| `nacional republicana` | police | 21 | 22 | 0.95 | 485.4 |
| `policia municipal` | police | 17 | 18 | 0.94 | 480.2 |
| `psp` | police | 151 | 160 | 0.94 | 479.9 |
| `ferry` | ferry_terminal | 34 | 39 | 0.87 | 477.0 |
| `instancia` | courthouse | 20 | 24 | 0.83 | 474.0 |
| `instituto superior` | university | 21 | 22 | 0.95 | 469.6 |
| `escola superior` | university | 39 | 41 | 0.95 | 467.9 |
| `taxi` | taxi_stand | 117 | 142 | 0.82 | 466.9 |
| `esquadra` | police | 67 | 73 | 0.92 | 466.7 |
| `boat` | ferry_terminal | 39 | 46 | 0.85 | 463.9 |
| `museu municipal` | museum | 34 | 36 | 0.94 | 458.6 |
| `ceip` | primary_school | 16 | 16 | 1.00 | 456.9 |
| `commissariat` | police | 16 | 18 | 0.89 | 452.0 |
| `policia local` | police | 37 | 42 | 0.88 | 447.9 |
| `escola eb1` | primary_school | 49 | 50 | 0.98 | 447.8 |
| `policia` | police | 109 | 124 | 0.88 | 447.0 |
| `eb1` | primary_school | 110 | 116 | 0.95 | 433.3 |
| `humanitaria dos` | fire_station | 97 | 97 | 1.00 | 423.0 |
| `humanitaria bombeiros` | fire_station | 35 | 35 | 1.00 | 423.0 |
| `centro escolar` | primary_school | 33 | 36 | 0.92 | 418.9 |
| `associacao humanitaria` | fire_station | 134 | 136 | 0.99 | 416.8 |
| `trail` | hiking_area | 19 | 20 | 0.95 | 415.2 |
| `vereda` | hiking_area | 19 | 20 | 0.95 | 415.2 |
| `consultoria` | accounting | 32 | 61 | 0.52 | 413.7 |
| `palacio justica` | courthouse | 16 | 22 | 0.73 | 413.7 |
| `bombeiros voluntarios` | fire_station | 511 | 523 | 0.98 | 413.3 |
| `voluntarios` | fire_station | 513 | 526 | 0.98 | 412.6 |
| `superior` | university | 62 | 74 | 0.84 | 412.1 |
| `voluntarios vila` | fire_station | 24 | 25 | 0.96 | 406.1 |
| `bombeiros municipais` | fire_station | 23 | 24 | 0.96 | 405.4 |
| `casa museu` | museum | 20 | 24 | 0.83 | 404.7 |
| `centro cultural` | cultural_center | 35 | 89 | 0.39 | 401.3 |
| `escola primaria` | primary_school | 49 | 56 | 0.88 | 399.8 |
| `territorial` | police | 29 | 37 | 0.78 | 398.5 |
| `bombeiros` | fire_station | 602 | 641 | 0.94 | 397.3 |
| `fiscal` | accounting | 15 | 30 | 0.50 | 394.3 |
| `5asec` | laundry | 96 | 96 | 1.00 | 392.3 |
| `lavandaria self` | laundry | 44 | 44 | 1.00 | 392.3 |
| `lavanderia` | laundry | 27 | 27 | 1.00 | 392.3 |
| `speed queen` | laundry | 24 | 24 | 1.00 | 392.3 |
| `washstation` | laundry | 18 | 18 | 1.00 | 392.3 |
| `ecopista` | hiking_area | 15 | 17 | 0.88 | 385.7 |
| `escola basica` | primary_school | 95 | 113 | 0.84 | 384.1 |
| `pressing` | laundry | 36 | 37 | 0.97 | 381.6 |
| `basica` | primary_school | 96 | 116 | 0.83 | 378.2 |
| `campismo municipal` | campground | 15 | 16 | 0.94 | 377.0 |
| `lavandaria` | laundry | 237 | 247 | 0.96 | 376.4 |
| `museo` | museum | 48 | 62 | 0.77 | 375.9 |
| `trilho` | hiking_area | 43 | 50 | 0.86 | 375.9 |
| `dos bombeiros` | fire_station | 134 | 151 | 0.89 | 375.4 |
| `apeadeiro` | train_station | 42 | 61 | 0.69 | 372.7 |
| `numero` | courthouse | 17 | 27 | 0.63 | 358.1 |
| `parque campismo` | campground | 186 | 209 | 0.89 | 357.9 |
| `justica` | courthouse | 22 | 35 | 0.63 | 357.5 |
| `facultad` | university | 17 | 24 | 0.71 | 348.4 |
| `car wash` | car_wash | 32 | 39 | 0.82 | 346.6 |
| `social servico` | city_hall | 41 | 41 | 1.00 | 345.2 |
| `ciencias` | university | 25 | 36 | 0.69 | 341.6 |
| `fisica` | physiotherapist | 23 | 59 | 0.39 | 341.3 |
| `campismo` | campground | 212 | 250 | 0.85 | 341.0 |
| `museu` | museum | 291 | 418 | 0.70 | 338.0 |
| `servico atendimento` | city_hall | 25 | 26 | 0.96 | 331.9 |
| `engomadoria` | laundry | 37 | 44 | 0.84 | 329.8 |
| `unilabs` | medical_lab | 33 | 33 | 1.00 | 323.7 |
| `synlab` | medical_lab | 16 | 16 | 1.00 | 323.7 |
| `laboratoire` | medical_lab | 58 | 59 | 0.98 | 318.2 |
| `empark` | parking | 43 | 43 | 1.00 | 315.3 |
| `telpark` | parking | 37 | 37 | 1.00 | 315.3 |
| `telpark empark` | parking | 34 | 34 | 1.00 | 315.3 |
| `aparcamiento` | parking | 18 | 18 | 1.00 | 315.3 |
| `camping` | campground | 136 | 175 | 0.78 | 312.5 |
| `analyses` | medical_lab | 22 | 23 | 0.96 | 309.6 |
| `levada` | hiking_area | 38 | 54 | 0.70 | 307.6 |
| `laboratorial` | medical_lab | 18 | 19 | 0.95 | 306.7 |
| `medicales` | medical_lab | 17 | 18 | 0.94 | 305.7 |
| `analises clinicas` | medical_lab | 202 | 215 | 0.94 | 304.1 |
| `parque saba` | parking | 27 | 28 | 0.96 | 304.0 |
| `analyses medicales` | medical_lab | 15 | 16 | 0.94 | 303.5 |
| `patologia` | medical_lab | 15 | 16 | 0.94 | 303.5 |
| `laboratorio analises` | medical_lab | 145 | 155 | 0.94 | 302.8 |
| `medico veterinario` | veterinary_care | 16 | 16 | 1.00 | 302.0 |
| `germano sousa` | medical_lab | 27 | 29 | 0.93 | 301.4 |
| `analises` | medical_lab | 235 | 254 | 0.93 | 299.5 |
| `lavage` | car_wash | 34 | 48 | 0.71 | 299.2 |
| `universidade` | university | 74 | 123 | 0.60 | 295.9 |
| `infantil jardim` | playground | 31 | 33 | 0.94 | 295.9 |
| `elefante azul` | car_wash | 46 | 66 | 0.70 | 294.4 |
| `museum` | museum | 20 | 33 | 0.61 | 294.3 |
| `sec` | laundry | 15 | 20 | 0.75 | 294.2 |
| `estacionamento` | parking | 308 | 332 | 0.93 | 292.5 |
| `parque estacionamento` | parking | 175 | 190 | 0.92 | 290.4 |
| `infantil quinta` | playground | 23 | 25 | 0.92 | 289.8 |
| `self service` | laundry | 58 | 79 | 0.73 | 288.0 |
| `lavagem auto` | car_wash | 17 | 25 | 0.68 | 287.2 |
| `associacao dos` | fire_station | 31 | 46 | 0.67 | 285.1 |
| `parque infantil` | playground | 511 | 567 | 0.90 | 283.8 |
| `beatriz godinho` | medical_lab | 18 | 21 | 0.86 | 277.5 |
| `hospital veterinario` | veterinary_care | 66 | 72 | 0.92 | 276.9 |
| `parking` | parking | 160 | 183 | 0.87 | 275.6 |
| `saba` | parking | 33 | 38 | 0.87 | 273.8 |
| `speed` | laundry | 25 | 36 | 0.69 | 272.4 |
| `clinica veterinaria` | veterinary_care | 353 | 394 | 0.90 | 270.6 |
| `consultorio veterinario` | veterinary_care | 25 | 28 | 0.89 | 269.7 |
| `veterinaria` | veterinary_care | 391 | 440 | 0.89 | 268.4 |
| `veterinario` | veterinary_care | 236 | 267 | 0.88 | 267.0 |
| `teatro` | movie_theater | 37 | 103 | 0.36 | 266.6 |
| `primaria` | primary_school | 56 | 96 | 0.58 | 266.5 |
| `atendimento` | city_hall | 40 | 52 | 0.77 | 265.5 |
| `vet` | veterinary_care | 50 | 58 | 0.86 | 260.4 |
| `centro veterinario` | veterinary_care | 99 | 115 | 0.86 | 260.0 |
| `aluguer carros` | car_rental | 36 | 36 | 1.00 | 259.0 |
| `avis aluguer` | car_rental | 35 | 35 | 1.00 | 259.0 |
| `enterprise` | car_rental | 35 | 35 | 1.00 | 259.0 |
| `enterprise rent` | car_rental | 30 | 30 | 1.00 | 259.0 |
| `budget portugal` | car_rental | 29 | 29 | 1.00 | 259.0 |
| `location voiture` | car_rental | 28 | 28 | 1.00 | 259.0 |
| `thrifty` | car_rental | 25 | 25 | 1.00 | 259.0 |
| `thrifty car` | car_rental | 23 | 23 | 1.00 | 259.0 |
| `avis car` | car_rental | 21 | 21 | 1.00 | 259.0 |
| `interrent` | car_rental | 18 | 18 | 1.00 | 259.0 |
| `veterinarios` | veterinary_care | 24 | 28 | 0.86 | 258.9 |
| `lavagem` | car_wash | 49 | 80 | 0.61 | 258.7 |
| `escolar` | primary_school | 35 | 62 | 0.56 | 257.9 |
| `orbitur` | campground | 28 | 44 | 0.64 | 255.9 |
| `faculdade` | university | 27 | 52 | 0.52 | 255.4 |
| `sixt rent` | car_rental | 39 | 40 | 0.97 | 252.6 |
| `playground` | playground | 16 | 20 | 0.80 | 252.0 |
| `europcar` | car_rental | 141 | 145 | 0.97 | 251.9 |
| `joaquim chaves` | medical_lab | 20 | 26 | 0.77 | 249.0 |
| `veterinaire` | veterinary_care | 18 | 22 | 0.82 | 247.1 |
| `sixt` | car_rental | 60 | 63 | 0.95 | 246.7 |
| `car rental` | car_rental | 88 | 93 | 0.95 | 245.1 |
| `laboratorio` | medical_lab | 249 | 329 | 0.76 | 245.0 |
| `escola` | primary_school | 304 | 568 | 0.54 | 244.6 |
| `rent car` | car_rental | 211 | 224 | 0.94 | 244.0 |
| `art gallery` | art_gallery | 21 | 24 | 0.88 | 240.3 |
| `location` | car_rental | 37 | 40 | 0.93 | 239.6 |
| `instituto seguranca` | city_hall | 42 | 61 | 0.69 | 237.7 |
| `arte contemporanea` | art_gallery | 17 | 20 | 0.85 | 233.4 |
| `trabalho` | courthouse | 27 | 66 | 0.41 | 232.7 |
| `colegio` | primary_school | 59 | 116 | 0.51 | 232.4 |
| `clinicos` | medical_lab | 15 | 21 | 0.71 | 231.2 |
| `rent` | car_rental | 257 | 288 | 0.89 | 231.2 |
| `guerin` | car_rental | 31 | 35 | 0.89 | 229.4 |
| `caminho` | hiking_area | 32 | 61 | 0.52 | 229.3 |
| `infantil` | playground | 529 | 739 | 0.72 | 225.4 |
| `hertz` | car_rental | 38 | 44 | 0.86 | 223.7 |
| `rental` | car_rental | 99 | 117 | 0.85 | 219.2 |
| `budget` | car_rental | 54 | 64 | 0.84 | 218.6 |
| `alquiler` | car_rental | 16 | 19 | 0.84 | 218.1 |
| `bodegas` | winery | 66 | 77 | 0.86 | 217.4 |
| `saude lisboa` | hospital | 27 | 27 | 1.00 | 215.7 |
| `hospital distrital` | hospital | 23 | 23 | 1.00 | 215.7 |
| `bloco operatorio` | hospital | 22 | 22 | 1.00 | 215.7 |
| `galeria arte` | art_gallery | 25 | 33 | 0.76 | 208.0 |
| `wash` | car_wash | 56 | 114 | 0.49 | 207.5 |
| `hospital dia` | hospital | 17 | 18 | 0.94 | 203.8 |
| `urgencia` | hospital | 15 | 16 | 0.94 | 202.3 |
| `epe` | hospital | 28 | 30 | 0.93 | 201.4 |
| `carros` | car_rental | 47 | 61 | 0.77 | 199.6 |
| `hopital` | hospital | 49 | 53 | 0.92 | 199.5 |
| `aluguer automoveis` | car_rental | 25 | 33 | 0.76 | 196.2 |
| `administracao regional` | hospital | 27 | 30 | 0.90 | 194.2 |
| `regional saude` | hospital | 27 | 30 | 0.90 | 194.2 |
| `contemporanea` | art_gallery | 19 | 27 | 0.70 | 193.2 |
| `passeio` | hiking_area | 15 | 34 | 0.44 | 192.8 |
| `estacao` | train_station | 345 | 984 | 0.35 | 189.8 |
| `centro hospitalar` | hospital | 58 | 66 | 0.88 | 189.6 |
| `turiscar` | car_rental | 21 | 29 | 0.72 | 187.6 |
| `lisboa vale` | hospital | 26 | 30 | 0.87 | 187.0 |
| `ecole` | university | 23 | 61 | 0.38 | 185.5 |
| `associacao` | fire_station | 179 | 412 | 0.43 | 183.8 |
| `hospital luz` | hospital | 34 | 40 | 0.85 | 183.4 |
| `avis` | car_rental | 92 | 130 | 0.71 | 183.3 |
| `galerie` | art_gallery | 24 | 36 | 0.67 | 183.1 |
| `germano` | medical_lab | 29 | 52 | 0.56 | 180.5 |
| `campus` | university | 22 | 60 | 0.37 | 180.4 |
| `lava` | laundry | 16 | 35 | 0.46 | 179.3 |
| `agrupamento` | campground | 20 | 46 | 0.43 | 174.9 |
| `hospitalar` | hospital | 68 | 85 | 0.80 | 172.6 |
| `hospital sao` | hospital | 36 | 45 | 0.80 | 172.6 |
| `vale tejo` | hospital | 26 | 33 | 0.79 | 170.0 |
| `hammam` | spa | 86 | 92 | 0.93 | 168.8 |
| `tangerina` | convenience_store | 79 | 100 | 0.79 | 168.4 |
| `hospital santa` | hospital | 21 | 27 | 0.78 | 167.8 |
| `ciclo` | primary_school | 16 | 44 | 0.36 | 166.2 |
| `automoveis aluguer` | car_rental | 16 | 25 | 0.64 | 165.8 |
| `gallery` | art_gallery | 62 | 104 | 0.60 | 163.7 |
| `mall` | shopping_mall | 26 | 46 | 0.57 | 162.1 |
| `doutora` | medical_lab | 15 | 31 | 0.48 | 156.6 |
| `adega cooperativa` | winery | 38 | 62 | 0.61 | 155.4 |
| `brewery` | brewery | 15 | 19 | 0.79 | 151.4 |
| `galeria` | art_gallery | 187 | 340 | 0.55 | 151.0 |
| `laboratorios` | medical_lab | 20 | 43 | 0.47 | 150.6 |
| `consultas` | hospital | 16 | 23 | 0.70 | 150.1 |
| `hospital` | hospital | 442 | 640 | 0.69 | 149.0 |
| `playa del` | beach | 32 | 33 | 0.97 | 148.8 |
| `cars` | car_rental | 31 | 54 | 0.57 | 148.7 |
| `clinique` | hospital | 101 | 147 | 0.69 | 148.2 |
| `praia porto` | beach | 20 | 21 | 0.95 | 146.2 |
| `night club` | night_club | 20 | 23 | 0.87 | 144.4 |
| `acima` | shopping_mall | 15 | 31 | 0.48 | 138.8 |
| `bloco` | hospital | 28 | 44 | 0.64 | 137.3 |
| `day spa` | spa | 27 | 36 | 0.75 | 135.4 |
| `hamam` | spa | 15 | 20 | 0.75 | 135.4 |
| `cirurgia` | hospital | 19 | 31 | 0.61 | 132.2 |
| `massage` | spa | 19 | 26 | 0.73 | 131.9 |
| `aluguer` | car_rental | 85 | 167 | 0.51 | 131.8 |
| `praia fluvial` | beach | 160 | 187 | 0.86 | 131.3 |
| `praia dos` | beach | 57 | 67 | 0.85 | 130.6 |
| `praia das` | beach | 31 | 38 | 0.82 | 125.2 |
| `lusiadas` | hospital | 23 | 40 | 0.57 | 124.0 |
| `forte sao` | historical_landmark | 15 | 20 | 0.75 | 121.5 |
| `car` | car_rental | 343 | 739 | 0.46 | 120.2 |
| `plage` | beach | 58 | 75 | 0.77 | 118.7 |
| `praia sao` | beach | 17 | 22 | 0.77 | 118.6 |
| `fluvial` | beach | 170 | 226 | 0.75 | 115.4 |
| `playa` | beach | 166 | 223 | 0.74 | 114.2 |
| `wines` | winery | 26 | 58 | 0.45 | 113.7 |
| `caves` | winery | 20 | 47 | 0.43 | 107.9 |
| `bodega` | winery | 43 | 103 | 0.42 | 105.9 |
| `cuf` | hospital | 25 | 52 | 0.48 | 103.7 |
| `discoteca` | night_club | 83 | 133 | 0.62 | 103.6 |
| `spa` | spa | 512 | 917 | 0.56 | 100.8 |
| `bim` | convenience_store | 33 | 70 | 0.47 | 100.5 |
| `cabinet dentaire` | dentist | 56 | 56 | 1.00 | 98.5 |
| `clinicas dentarias` | dentist | 25 | 25 | 1.00 | 98.5 |
| `oralmed` | dentist | 22 | 22 | 1.00 | 98.5 |
| `smile clinicas` | dentist | 21 | 21 | 1.00 | 98.5 |
| `clinique dentaire` | dentist | 18 | 18 | 1.00 | 98.5 |
| `consultorio dentario` | dentist | 18 | 18 | 1.00 | 98.5 |
| `dental clinic` | dentist | 18 | 18 | 1.00 | 98.5 |
| `reabilitacao oral` | dentist | 17 | 17 | 1.00 | 98.5 |
| `chirurgien` | dentist | 16 | 16 | 1.00 | 98.5 |
| `ortodoncia` | dentist | 16 | 16 | 1.00 | 98.5 |
| `chirurgien dentiste` | dentist | 15 | 15 | 1.00 | 98.5 |
| `vital dent` | dentist | 15 | 15 | 1.00 | 98.5 |
| `praia` | beach | 1064 | 1670 | 0.64 | 97.8 |
| `clinica dental` | dentist | 257 | 260 | 0.99 | 97.4 |
| `dental` | dentist | 408 | 416 | 0.98 | 96.6 |
| `dentaire` | dentist | 100 | 102 | 0.98 | 96.6 |
| `dentaria dra` | dentist | 40 | 41 | 0.98 | 96.1 |
| `medicina dentaria` | dentist | 128 | 132 | 0.97 | 95.5 |
| `dentiste` | dentist | 85 | 88 | 0.97 | 95.2 |
| `dentarias` | dentist | 28 | 29 | 0.97 | 95.1 |
| `cerveceria` | brewery | 72 | 146 | 0.49 | 94.6 |
| `dentaria santa` | dentist | 23 | 24 | 0.96 | 94.4 |
| `pelourinho` | historical_landmark | 18 | 31 | 0.58 | 94.0 |
| `clinica dentaria` | dentist | 450 | 473 | 0.95 | 93.7 |
| `matoscar` | car_dealer | 17 | 20 | 0.85 | 93.4 |
| `oral` | dentist | 51 | 54 | 0.94 | 93.0 |
| `dentaria` | dentist | 825 | 876 | 0.94 | 92.8 |
| `monumento` | historical_landmark | 16 | 28 | 0.57 | 92.5 |
| `unidade` | hospital | 57 | 133 | 0.43 | 92.5 |
| `dent` | dentist | 28 | 30 | 0.93 | 91.9 |
| `medica dentaria` | dentist | 158 | 170 | 0.93 | 91.6 |
| `medico dentario` | dentist | 26 | 28 | 0.93 | 91.5 |
| `prainha` | beach | 16 | 27 | 0.59 | 90.9 |
| `comercio automoveis` | car_dealer | 257 | 312 | 0.82 | 90.5 |
| `dentario` | dentist | 70 | 77 | 0.91 | 89.6 |
| `centre dentaire` | dentist | 20 | 22 | 0.91 | 89.6 |
| `santa madalena` | dentist | 20 | 22 | 0.91 | 89.6 |
| `mercedes benz` | car_dealer | 39 | 48 | 0.81 | 89.3 |
| `medico dentaria` | dentist | 58 | 64 | 0.91 | 89.3 |
| `vitaldent` | dentist | 18 | 20 | 0.90 | 88.7 |
| `land rover` | car_dealer | 16 | 20 | 0.80 | 87.9 |
| `clinica medicina` | dentist | 83 | 93 | 0.89 | 87.9 |
| `casa misericordia` | hospital | 21 | 52 | 0.40 | 87.1 |
| `car comercio` | car_dealer | 19 | 24 | 0.79 | 87.0 |
| `dentista` | dentist | 95 | 110 | 0.86 | 85.1 |
| `volvo` | car_dealer | 45 | 59 | 0.76 | 83.8 |
| `night` | night_club | 26 | 52 | 0.50 | 83.0 |
| `kia` | car_dealer | 17 | 23 | 0.74 | 81.2 |
| `evangelica` | church | 83 | 83 | 1.00 | 80.1 |
| `igreja evangelica` | church | 69 | 69 | 1.00 | 80.1 |
| `parroquia san` | church | 56 | 56 | 1.00 | 80.1 |
| `assembleia deus` | church | 45 | 45 | 1.00 | 80.1 |
| `paroco` | church | 30 | 30 | 1.00 | 80.1 |
| `parroquia santa` | church | 30 | 30 | 1.00 | 80.1 |
| `setimo dia` | church | 29 | 29 | 1.00 | 80.1 |
| `adventista setimo` | church | 28 | 28 | 1.00 | 80.1 |
| `evangelica baptista` | church | 24 | 24 | 1.00 | 80.1 |
| `iasd` | church | 21 | 21 | 1.00 | 80.1 |
| `igreja baptista` | church | 19 | 19 | 1.00 | 80.1 |
| `centro cristao` | church | 16 | 16 | 1.00 | 80.1 |
| `senora asuncion` | church | 16 | 16 | 1.00 | 80.1 |
| `disco` | night_club | 30 | 63 | 0.48 | 79.1 |
| `fabrica igreja` | church | 48 | 49 | 0.98 | 78.4 |
| `parroquia` | church | 174 | 178 | 0.98 | 78.3 |
| `parroquia nuestra` | church | 40 | 41 | 0.98 | 78.1 |
| `igreja adventista` | church | 35 | 36 | 0.97 | 77.8 |
| `igreja paroquial` | church | 227 | 235 | 0.97 | 77.3 |
| `paroquial freguesia` | church | 20 | 21 | 0.95 | 76.2 |
| `igreja nossa` | church | 168 | 177 | 0.95 | 76.0 |
| `igreja dos` | church | 30 | 32 | 0.94 | 75.0 |
| `comercio automovel` | car_dealer | 32 | 47 | 0.68 | 74.8 |
| `clinica medico` | dentist | 61 | 81 | 0.75 | 74.2 |
| `castillo` | historical_landmark | 32 | 70 | 0.46 | 74.0 |
| `church` | church | 49 | 53 | 0.92 | 74.0 |
| `igreja sao` | church | 157 | 171 | 0.92 | 73.5 |
| `paroquia` | church | 84 | 92 | 0.91 | 73.1 |
| `paroquial nossa` | church | 21 | 23 | 0.91 | 73.1 |
| `day` | spa | 29 | 72 | 0.40 | 72.7 |
| `igreja` | church | 1937 | 2139 | 0.91 | 72.5 |
| `automoveis unipessoal` | car_dealer | 29 | 44 | 0.66 | 72.4 |
| `iglesia san` | church | 47 | 52 | 0.90 | 72.4 |
| `santuario nossa` | church | 27 | 30 | 0.90 | 72.0 |
| `congregacao` | church | 18 | 20 | 0.90 | 72.0 |
| `igreja matriz` | church | 232 | 258 | 0.90 | 72.0 |
| `capela nossa` | church | 79 | 88 | 0.90 | 71.9 |
| `jaguar` | car_dealer | 15 | 23 | 0.65 | 71.7 |
| `igreja santo` | church | 43 | 49 | 0.88 | 70.2 |
| `paroquial sao` | church | 35 | 40 | 0.88 | 70.0 |
| `historico` | historical_landmark | 15 | 35 | 0.43 | 69.4 |
| `asuncion` | church | 26 | 30 | 0.87 | 69.4 |
| `igreja santa` | church | 84 | 97 | 0.87 | 69.3 |
| `igreja misericordia` | church | 43 | 50 | 0.86 | 68.8 |
| `sorriso` | dentist | 42 | 61 | 0.69 | 67.8 |
| `iglesia` | church | 146 | 173 | 0.84 | 67.6 |
| `capela santa` | church | 26 | 31 | 0.84 | 67.1 |
| `fiat` | car_dealer | 25 | 41 | 0.61 | 67.0 |
| `clinica medica` | dentist | 193 | 284 | 0.68 | 66.9 |
| `capela sao` | church | 56 | 67 | 0.84 | 66.9 |
| `nissan` | car_dealer | 28 | 46 | 0.61 | 66.9 |
| `crista` | church | 30 | 36 | 0.83 | 66.7 |
| `capilla` | church | 24 | 29 | 0.83 | 66.2 |
| `paroquial` | church | 297 | 359 | 0.83 | 66.2 |
| `opel` | car_dealer | 41 | 69 | 0.59 | 65.3 |
| `smile` | dentist | 85 | 129 | 0.66 | 64.9 |
| `matriz` | church | 239 | 295 | 0.81 | 64.9 |
| `ermida nossa` | church | 20 | 25 | 0.80 | 64.0 |
| `parroquial` | church | 16 | 20 | 0.80 | 64.0 |
| `mcoutinho` | car_dealer | 18 | 31 | 0.58 | 63.8 |
| `capela` | church | 399 | 505 | 0.79 | 63.2 |
| `concessionario` | car_dealer | 56 | 98 | 0.57 | 62.8 |
| `senhora fatima` | church | 29 | 38 | 0.76 | 61.1 |
| `comercio veiculos` | car_dealer | 34 | 63 | 0.54 | 59.3 |
| `citroen` | car_dealer | 49 | 91 | 0.54 | 59.2 |
| `peugeot` | car_dealer | 43 | 80 | 0.54 | 59.1 |
| `motors` | car_dealer | 31 | 58 | 0.53 | 58.7 |
| `ermita` | church | 44 | 60 | 0.73 | 58.7 |
| `seminario` | church | 30 | 41 | 0.73 | 58.6 |
| `assembleia` | church | 46 | 63 | 0.73 | 58.5 |
| `capela santo` | church | 21 | 29 | 0.72 | 58.0 |
| `dente` | dentist | 21 | 36 | 0.58 | 57.5 |
| `ermida` | church | 58 | 81 | 0.72 | 57.3 |
| `entreposto` | car_dealer | 42 | 81 | 0.52 | 57.0 |
| `medica` | dentist | 201 | 351 | 0.57 | 56.4 |
| `nossa senhora` | church | 357 | 513 | 0.70 | 55.7 |
| `senhora piedade` | church | 16 | 23 | 0.70 | 55.7 |
| `centro paroquial` | church | 18 | 26 | 0.69 | 55.4 |
| `toyota` | car_dealer | 21 | 42 | 0.50 | 55.0 |
| `senhora conceicao` | church | 35 | 51 | 0.69 | 54.9 |
| `automoveis` | car_dealer | 561 | 1144 | 0.49 | 53.9 |
| `santuario` | church | 51 | 77 | 0.66 | 53.0 |
| `medicina` | dentist | 137 | 257 | 0.53 | 52.5 |
| `senhora das` | church | 30 | 46 | 0.65 | 52.2 |
| `stand` | car_dealer | 81 | 172 | 0.47 | 51.8 |
| `dra` | dentist | 94 | 179 | 0.53 | 51.7 |
| `mercedes` | car_dealer | 43 | 93 | 0.46 | 50.8 |
| `clinica` | dentist | 1408 | 2817 | 0.50 | 49.2 |
| `social paroquial` | church | 33 | 54 | 0.61 | 48.9 |
| `seguridad social` | local_government_office | 45 | 45 | 1.00 | 48.9 |
| `freguesia vale` | local_government_office | 41 | 41 | 1.00 | 48.9 |
| `atencion informacion` | local_government_office | 29 | 29 | 1.00 | 48.9 |
| `centro atencion` | local_government_office | 29 | 29 | 1.00 | 48.9 |
| `informacion seguridad` | local_government_office | 29 | 29 | 1.00 | 48.9 |
| `direccao geral` | local_government_office | 25 | 25 | 1.00 | 48.9 |
| `despachante oficial` | local_government_office | 22 | 22 | 1.00 | 48.9 |
| `tesoreria general` | local_government_office | 21 | 21 | 1.00 | 48.9 |
| `despachantes` | local_government_office | 20 | 20 | 1.00 | 48.9 |
| `despachantes oficiais` | local_government_office | 19 | 19 | 1.00 | 48.9 |
| `freguesia castelo` | local_government_office | 16 | 16 | 1.00 | 48.9 |
| `nossa` | church | 391 | 641 | 0.61 | 48.8 |
| `san pedro` | church | 24 | 40 | 0.60 | 48.0 |
| `servico financas` | local_government_office | 53 | 55 | 0.96 | 47.1 |
| `registos` | local_government_office | 26 | 27 | 0.96 | 47.1 |
| `freguesia aldeia` | local_government_office | 24 | 25 | 0.96 | 47.0 |
| `reparticao` | local_government_office | 47 | 49 | 0.96 | 46.9 |
| `reparticao financas` | local_government_office | 42 | 44 | 0.95 | 46.7 |
| `dos registos` | local_government_office | 18 | 19 | 0.95 | 46.3 |
| `iefp` | local_government_office | 34 | 36 | 0.94 | 46.2 |
| `direccao regional` | local_government_office | 17 | 18 | 0.94 | 46.2 |
| `freguesia povoa` | local_government_office | 16 | 17 | 0.94 | 46.0 |
| `nossa sra` | church | 23 | 40 | 0.57 | 46.0 |
| `direccao` | local_government_office | 46 | 49 | 0.94 | 45.9 |
| `senhora` | church | 397 | 693 | 0.57 | 45.9 |
| `freguesia vila` | local_government_office | 100 | 107 | 0.93 | 45.7 |
| `financas` | local_government_office | 173 | 186 | 0.93 | 45.5 |
| `freguesia nossa` | local_government_office | 25 | 27 | 0.93 | 45.3 |
| `freguesia vilar` | local_government_office | 25 | 27 | 0.93 | 45.3 |
| `nuestra senora` | church | 69 | 122 | 0.57 | 45.3 |
| `autos` | car_dealer | 16 | 39 | 0.41 | 45.1 |
| `junta freguesia` | local_government_office | 3428 | 3737 | 0.92 | 44.9 |
| `consejeria` | local_government_office | 21 | 23 | 0.91 | 44.7 |
| `imtt` | local_government_office | 21 | 23 | 0.91 | 44.7 |
| `junta` | local_government_office | 3437 | 3769 | 0.91 | 44.6 |
| `ministere` | local_government_office | 31 | 34 | 0.91 | 44.6 |
| `registo predial` | local_government_office | 31 | 34 | 0.91 | 44.6 |
| `freguesia` | local_government_office | 3495 | 3846 | 0.91 | 44.4 |
| `centro guadalinfo` | local_government_office | 18 | 20 | 0.90 | 44.0 |
| `freguesia ribeira` | local_government_office | 18 | 20 | 0.90 | 44.0 |
| `emprego` | local_government_office | 53 | 59 | 0.90 | 43.9 |
| `senhora graca` | church | 17 | 31 | 0.55 | 43.9 |
| `direction` | local_government_office | 26 | 29 | 0.90 | 43.9 |
| `nuestra` | church | 70 | 128 | 0.55 | 43.8 |
| `atencion` | local_government_office | 34 | 38 | 0.89 | 43.8 |
| `centro emprego` | local_government_office | 41 | 46 | 0.89 | 43.6 |
| `geral dos` | local_government_office | 16 | 18 | 0.89 | 43.5 |
| `freguesia rio` | local_government_office | 23 | 26 | 0.88 | 43.3 |
| `municipalizados` | local_government_office | 15 | 17 | 0.88 | 43.2 |
| `senora` | church | 70 | 130 | 0.54 | 43.1 |
| `freguesia sao` | local_government_office | 207 | 235 | 0.88 | 43.1 |
| `tributaria` | local_government_office | 22 | 25 | 0.88 | 43.0 |
| `autoridade` | local_government_office | 21 | 24 | 0.88 | 42.8 |
| `freguesia santa` | local_government_office | 74 | 85 | 0.87 | 42.6 |
| `predial` | local_government_office | 47 | 54 | 0.87 | 42.6 |
| `freguesia santo` | local_government_office | 39 | 45 | 0.87 | 42.4 |
| `guadalinfo` | local_government_office | 19 | 22 | 0.86 | 42.2 |
| `senhora dos` | church | 20 | 38 | 0.53 | 42.1 |
| `conservatoria` | local_government_office | 111 | 130 | 0.85 | 41.8 |
| `direcao` | local_government_office | 25 | 30 | 0.83 | 40.8 |
| `registo` | local_government_office | 113 | 136 | 0.83 | 40.6 |
| `conservatoria registo` | local_government_office | 92 | 111 | 0.83 | 40.5 |
| `senora del` | church | 17 | 34 | 0.50 | 40.0 |
| `municipio` | local_government_office | 162 | 201 | 0.81 | 39.4 |
| `aduaneira` | local_government_office | 15 | 19 | 0.79 | 38.6 |
| `del instituto` | local_government_office | 15 | 19 | 0.79 | 38.6 |
| `deus` | church | 69 | 144 | 0.48 | 38.4 |
| `registo civil` | local_government_office | 64 | 82 | 0.78 | 38.2 |
| `loja cidadao` | local_government_office | 42 | 55 | 0.76 | 37.4 |
| `clinic` | dentist | 65 | 172 | 0.38 | 37.2 |
| `ministerio` | local_government_office | 34 | 45 | 0.76 | 37.0 |
| `municipal lisboa` | local_government_office | 28 | 38 | 0.74 | 36.0 |
| `mforce` | car_repair | 107 | 107 | 1.00 | 35.6 |
| `oficina mforce` | car_repair | 102 | 102 | 1.00 | 35.6 |
| `feu vert` | car_repair | 25 | 25 | 1.00 | 35.6 |
| `carglass` | car_repair | 107 | 109 | 0.98 | 35.0 |
| `norauto` | car_repair | 42 | 43 | 0.98 | 34.8 |
| `catedral` | church | 31 | 72 | 0.43 | 34.5 |
| `comercio pneus` | car_repair | 56 | 58 | 0.97 | 34.4 |
| `euromaster` | car_repair | 96 | 100 | 0.96 | 34.2 |
| `auto pecas` | car_repair | 23 | 24 | 0.96 | 34.1 |
| `oficina volkswagen` | car_repair | 45 | 47 | 0.96 | 34.1 |
| `glassdrive` | car_repair | 141 | 148 | 0.95 | 33.9 |
| `chapa pintura` | car_repair | 20 | 21 | 0.95 | 33.9 |
| `topcar` | car_repair | 20 | 21 | 0.95 | 33.9 |
| `auto reparadora` | car_repair | 116 | 122 | 0.95 | 33.9 |
| `centro inspecoes` | car_repair | 18 | 19 | 0.95 | 33.7 |
| `recauchutagem` | car_repair | 34 | 36 | 0.94 | 33.6 |
| `cidadao` | local_government_office | 55 | 81 | 0.68 | 33.2 |
| `sef` | local_government_office | 19 | 28 | 0.68 | 33.2 |
| `oficina auto` | car_repair | 25 | 27 | 0.93 | 33.0 |
| `roady` | car_repair | 61 | 66 | 0.92 | 32.9 |
| `seguranca social` | local_government_office | 111 | 165 | 0.67 | 32.9 |
| `bosch car` | car_repair | 92 | 100 | 0.92 | 32.8 |
| `midas` | car_repair | 92 | 100 | 0.92 | 32.8 |
| `auto pneus` | car_repair | 33 | 36 | 0.92 | 32.6 |
| `acessorios automoveis` | car_repair | 22 | 24 | 0.92 | 32.6 |
| `sra` | church | 72 | 177 | 0.41 | 32.6 |
| `car service` | car_repair | 115 | 126 | 0.91 | 32.5 |
| `volkswagen comerciais` | car_repair | 20 | 22 | 0.91 | 32.4 |
| `centro inspeccoes` | car_repair | 19 | 21 | 0.90 | 32.2 |
| `inspecoes` | car_repair | 19 | 21 | 0.90 | 32.2 |
| `pneus` | car_repair | 374 | 416 | 0.90 | 32.0 |
| `inspeccoes` | car_repair | 34 | 38 | 0.89 | 31.9 |
| `precision` | car_repair | 25 | 28 | 0.89 | 31.8 |
| `centro social` | church | 40 | 101 | 0.40 | 31.7 |
| `dos pneus` | car_repair | 16 | 18 | 0.89 | 31.7 |
| `reparacoes auto` | car_repair | 47 | 53 | 0.89 | 31.6 |
| `neumaticos` | car_repair | 78 | 88 | 0.89 | 31.6 |
| `bosch` | car_repair | 101 | 114 | 0.89 | 31.6 |
| `escapes` | car_repair | 29 | 33 | 0.88 | 31.3 |
| `controlauto` | car_repair | 43 | 49 | 0.88 | 31.3 |
| `auto mecanica` | car_repair | 53 | 61 | 0.87 | 30.9 |
| `reparacao automovel` | car_repair | 39 | 45 | 0.87 | 30.9 |
| `service auto` | car_repair | 19 | 22 | 0.86 | 30.8 |
| `comercio pecas` | car_repair | 55 | 64 | 0.86 | 30.6 |
| `reparadora` | car_repair | 134 | 156 | 0.86 | 30.6 |
| `express glass` | car_repair | 18 | 21 | 0.86 | 30.5 |
| `misericordia` | church | 57 | 150 | 0.38 | 30.4 |
| `pecas acessorios` | car_repair | 56 | 66 | 0.85 | 30.2 |
| `auto acessorios` | car_repair | 16 | 19 | 0.84 | 30.0 |
| `vulcanizadora` | car_repair | 15 | 18 | 0.83 | 29.7 |
| `provincial` | local_government_office | 23 | 38 | 0.61 | 29.6 |
| `mecanico` | car_repair | 27 | 33 | 0.82 | 29.1 |
| `reparacoes automoveis` | car_repair | 71 | 87 | 0.82 | 29.1 |
| `pneu` | car_repair | 26 | 32 | 0.81 | 28.9 |
| `pecas auto` | car_repair | 43 | 53 | 0.81 | 28.9 |
| `motociclos` | car_repair | 32 | 40 | 0.80 | 28.5 |
| `oficina reparacoes` | car_repair | 28 | 35 | 0.80 | 28.5 |
| `administracion` | local_government_office | 15 | 26 | 0.58 | 28.2 |
| `acessorios auto` | car_repair | 37 | 47 | 0.79 | 28.0 |
| `para automoveis` | car_repair | 35 | 45 | 0.78 | 27.7 |
| `delegacao` | local_government_office | 22 | 39 | 0.56 | 27.6 |
| `ayuntamiento` | local_government_office | 138 | 245 | 0.56 | 27.6 |
| `auto unipessoal` | car_repair | 17 | 22 | 0.77 | 27.5 |
| `reparacao automoveis` | car_repair | 102 | 133 | 0.77 | 27.3 |
| `feuvert` | car_repair | 16 | 21 | 0.76 | 27.1 |
| `talleres` | car_repair | 214 | 281 | 0.76 | 27.1 |
| `garagem auto` | car_repair | 15 | 20 | 0.75 | 26.7 |
| `pecas` | car_repair | 187 | 253 | 0.74 | 26.3 |
| `camara municipal` | local_government_office | 254 | 481 | 0.53 | 25.8 |
| `reparacao veiculos` | car_repair | 26 | 36 | 0.72 | 25.7 |
| `inspeccao` | car_repair | 23 | 32 | 0.72 | 25.6 |
| `taller` | car_repair | 75 | 107 | 0.70 | 25.0 |
| `auto` | car_repair | 1481 | 2141 | 0.69 | 24.6 |
| `motorizados` | car_repair | 16 | 24 | 0.67 | 23.7 |
| `camara` | local_government_office | 260 | 539 | 0.48 | 23.6 |
| `repuestos` | car_repair | 17 | 26 | 0.65 | 23.3 |
| `automoveis lda` | car_repair | 15 | 23 | 0.65 | 23.2 |
| `veiculos motorizados` | car_repair | 15 | 23 | 0.65 | 23.2 |
| `reparacoes` | car_repair | 195 | 302 | 0.65 | 23.0 |
| `chapa` | car_repair | 25 | 39 | 0.64 | 22.8 |
| `racing` | car_repair | 16 | 25 | 0.64 | 22.8 |
| `reparacao` | car_repair | 259 | 418 | 0.62 | 22.1 |
| `seguranca` | local_government_office | 115 | 257 | 0.45 | 21.9 |
| `mecanica` | car_repair | 113 | 186 | 0.61 | 21.6 |
| `santogal` | car_repair | 36 | 60 | 0.60 | 21.4 |
| `skoda` | car_repair | 21 | 35 | 0.60 | 21.4 |
| `soauto vgrp` | car_repair | 15 | 25 | 0.60 | 21.4 |
| `social` | local_government_office | 184 | 429 | 0.43 | 21.0 |
| `oficinas` | car_repair | 24 | 41 | 0.59 | 20.8 |
| `soauto` | car_repair | 21 | 36 | 0.58 | 20.8 |
| `radiadores` | car_repair | 16 | 28 | 0.57 | 20.4 |
| `automovel` | car_repair | 134 | 235 | 0.57 | 20.3 |
| `garagem` | car_repair | 166 | 292 | 0.57 | 20.2 |
| `oficial` | local_government_office | 24 | 58 | 0.41 | 20.2 |
| `automocion` | car_repair | 34 | 60 | 0.57 | 20.2 |
| `oficina` | car_repair | 457 | 814 | 0.56 | 20.0 |
| `motos` | car_repair | 61 | 111 | 0.55 | 19.6 |
| `comercio reparacao` | car_repair | 80 | 148 | 0.54 | 19.3 |
| `veiculos` | car_repair | 134 | 249 | 0.54 | 19.2 |
| `volkswagen` | car_repair | 71 | 133 | 0.53 | 19.0 |
| `bmw` | car_repair | 17 | 32 | 0.53 | 18.9 |
| `comercio acessorios` | car_repair | 21 | 40 | 0.53 | 18.7 |
| `garage` | car_repair | 48 | 92 | 0.52 | 18.6 |
| `airbnb` | lodging | 59 | 59 | 1.00 | 18.5 |
| `pousada juventude` | lodging | 56 | 56 | 1.00 | 18.5 |
| `waytostay` | lodging | 39 | 39 | 1.00 | 18.5 |
| `flats` | lodging | 36 | 36 | 1.00 | 18.5 |
| `bed breakfast` | lodging | 33 | 33 | 1.00 | 18.5 |
| `pierre vacances` | lodging | 26 | 26 | 1.00 | 18.5 |
| `hospedes` | lodging | 24 | 24 | 1.00 | 18.5 |
| `hotel apartamento` | lodging | 24 | 24 | 1.00 | 18.5 |
| `casa hospedes` | lodging | 22 | 22 | 1.00 | 18.5 |
| `hotel casa` | lodging | 22 | 22 | 1.00 | 18.5 |
| `lisbon hostel` | lodging | 22 | 22 | 1.00 | 18.5 |
| `hotel agadir` | lodging | 21 | 21 | 1.00 | 18.5 |
| `turismo habitacao` | lodging | 21 | 21 | 1.00 | 18.5 |
| `holiday inn` | lodging | 19 | 19 | 1.00 | 18.5 |
| `residence pierre` | lodging | 18 | 18 | 1.00 | 18.5 |
| `akisol` | lodging | 17 | 17 | 1.00 | 18.5 |
| `beach hostel` | lodging | 15 | 15 | 1.00 | 18.5 |
| `like home` | lodging | 15 | 15 | 1.00 | 18.5 |
| `rurales` | lodging | 15 | 15 | 1.00 | 18.5 |
| `serviced` | lodging | 15 | 15 | 1.00 | 18.5 |
| `suite hotel` | lodging | 15 | 15 | 1.00 | 18.5 |
| `motor` | car_repair | 59 | 114 | 0.52 | 18.4 |
| `conducao` | car_repair | 15 | 29 | 0.52 | 18.4 |
| `seat` | car_repair | 31 | 60 | 0.52 | 18.4 |
| `guest house` | lodging | 264 | 266 | 0.99 | 18.4 |
| `apartment` | lodging | 121 | 122 | 0.99 | 18.4 |
| `guesthouse` | lodging | 225 | 227 | 0.99 | 18.4 |
| `riad dar` | lodging | 85 | 86 | 0.99 | 18.3 |
| `turismo rural` | lodging | 78 | 79 | 0.99 | 18.3 |
| `hostel` | lodging | 597 | 605 | 0.99 | 18.3 |
| `apartments` | lodging | 372 | 377 | 0.99 | 18.3 |
| `veiculos automoveis` | car_repair | 40 | 78 | 0.51 | 18.3 |
| `honda` | car_repair | 21 | 41 | 0.51 | 18.2 |
| `apartamentos turisticos` | lodging | 52 | 53 | 0.98 | 18.2 |
| `pensao residencial` | lodging | 50 | 51 | 0.98 | 18.2 |
| `suites` | lodging | 178 | 182 | 0.98 | 18.1 |
| `audi` | car_repair | 33 | 65 | 0.51 | 18.1 |
| `charming` | lodging | 38 | 39 | 0.97 | 18.0 |
| `hotel marrakech` | lodging | 36 | 37 | 0.97 | 18.0 |
| `guest` | lodging | 286 | 294 | 0.97 | 18.0 |
| `aparthotel` | lodging | 67 | 69 | 0.97 | 18.0 |
| `apartamentos` | lodging | 254 | 262 | 0.97 | 17.9 |
| `general` | local_government_office | 26 | 71 | 0.37 | 17.9 |
| `houses` | lodging | 29 | 30 | 0.97 | 17.9 |
| `rooms` | lodging | 53 | 55 | 0.96 | 17.8 |
| `renault` | car_repair | 45 | 90 | 0.50 | 17.8 |
| `ford` | car_repair | 16 | 32 | 0.50 | 17.8 |
| `residences` | lodging | 25 | 26 | 0.96 | 17.8 |
| `hotel casablanca` | lodging | 24 | 25 | 0.96 | 17.8 |
| `casa rural` | lodging | 67 | 70 | 0.96 | 17.7 |
| `hotel apartamentos` | lodging | 22 | 23 | 0.96 | 17.7 |
| `hotel santa` | lodging | 22 | 23 | 0.96 | 17.7 |
| `apartamento` | lodging | 82 | 86 | 0.95 | 17.7 |
| `hotel quinta` | lodging | 19 | 20 | 0.95 | 17.6 |
| `aldeamento` | lodging | 18 | 19 | 0.95 | 17.5 |
| `appart` | lodging | 18 | 19 | 0.95 | 17.5 |
| `hotel rural` | lodging | 102 | 108 | 0.94 | 17.5 |
| `hoteis` | lodging | 33 | 35 | 0.94 | 17.5 |
| `hotels` | lodging | 65 | 69 | 0.94 | 17.4 |
| `motel` | lodging | 48 | 51 | 0.94 | 17.4 |
| `grande hotel` | lodging | 16 | 17 | 0.94 | 17.4 |
| `pintura` | car_repair | 39 | 80 | 0.49 | 17.4 |
| `peregrinos` | lodging | 15 | 16 | 0.94 | 17.4 |
| `country house` | lodging | 29 | 31 | 0.94 | 17.3 |
| `boutique hotel` | lodging | 78 | 84 | 0.93 | 17.2 |
| `alojamento` | lodging | 99 | 107 | 0.93 | 17.1 |
| `hotel porto` | lodging | 36 | 39 | 0.92 | 17.1 |
| `hotel vila` | lodging | 36 | 39 | 0.92 | 17.1 |
| `residencial sao` | lodging | 24 | 26 | 0.92 | 17.1 |
| `glass` | car_repair | 22 | 46 | 0.48 | 17.0 |
| `acessorios para` | car_repair | 21 | 44 | 0.48 | 17.0 |
| `alojamento local` | lodging | 49 | 54 | 0.91 | 16.8 |
| `riad` | lodging | 716 | 791 | 0.91 | 16.8 |
| `hospedaria` | lodging | 73 | 81 | 0.90 | 16.7 |
| `hotel` | lodging | 3009 | 3345 | 0.90 | 16.7 |
| `reboques` | car_repair | 20 | 43 | 0.47 | 16.6 |
| `surf camp` | lodging | 25 | 28 | 0.89 | 16.5 |
| `service` | car_repair | 160 | 345 | 0.46 | 16.5 |
| `casas campo` | lodging | 16 | 18 | 0.89 | 16.5 |
| `comerciais` | car_repair | 24 | 52 | 0.46 | 16.4 |
| `residencial` | lodging | 515 | 581 | 0.89 | 16.4 |
| `bed` | lodging | 53 | 60 | 0.88 | 16.4 |
| `holiday` | lodging | 42 | 48 | 0.88 | 16.2 |
| `stay` | lodging | 35 | 40 | 0.88 | 16.2 |
| `park hotel` | lodging | 20 | 23 | 0.87 | 16.1 |
| `resort spa` | lodging | 20 | 23 | 0.87 | 16.1 |
| `viaturas` | car_repair | 18 | 40 | 0.45 | 16.0 |
| `hostal` | lodging | 89 | 103 | 0.86 | 16.0 |
| `apart` | lodging | 19 | 22 | 0.86 | 16.0 |
| `hotel sao` | lodging | 19 | 22 | 0.86 | 16.0 |
| `casas` | lodging | 190 | 221 | 0.86 | 15.9 |
| `vivenda` | lodging | 23 | 27 | 0.85 | 15.8 |
| `pensao` | lodging | 248 | 292 | 0.85 | 15.7 |
| `albergue` | lodging | 56 | 66 | 0.85 | 15.7 |
| `suite` | lodging | 47 | 56 | 0.84 | 15.5 |
| `hotel spa` | lodging | 81 | 99 | 0.82 | 15.1 |
| `charm` | lodging | 27 | 33 | 0.82 | 15.1 |
| `estalagem` | lodging | 69 | 85 | 0.81 | 15.0 |
| `flat` | lodging | 17 | 21 | 0.81 | 15.0 |
| `residence` | lodging | 93 | 115 | 0.81 | 15.0 |
| `pousada` | lodging | 139 | 172 | 0.81 | 15.0 |
| `palace hotel` | lodging | 29 | 36 | 0.81 | 14.9 |
| `villas` | lodging | 66 | 82 | 0.80 | 14.9 |
| `ibis` | lodging | 48 | 60 | 0.80 | 14.8 |
| `beach resort` | lodging | 20 | 25 | 0.80 | 14.8 |
| `eurostars` | lodging | 19 | 24 | 0.79 | 14.7 |
| `spa hotel` | lodging | 15 | 19 | 0.79 | 14.6 |
| `downtown` | lodging | 55 | 70 | 0.79 | 14.5 |
| `habitacao` | lodging | 22 | 28 | 0.79 | 14.5 |
| `surf house` | lodging | 25 | 32 | 0.78 | 14.5 |
| `resort` | lodging | 185 | 237 | 0.78 | 14.5 |
| `turisticos` | lodging | 110 | 141 | 0.78 | 14.4 |
| `collection` | lodging | 46 | 59 | 0.78 | 14.4 |
| `beach house` | lodging | 21 | 27 | 0.78 | 14.4 |
| `inn` | lodging | 135 | 174 | 0.78 | 14.4 |
| `turistica` | lodging | 23 | 30 | 0.77 | 14.2 |
| `lodge` | lodging | 50 | 66 | 0.76 | 14.0 |
| `empreendimentos turisticos` | lodging | 43 | 58 | 0.74 | 13.7 |
| `ferias` | lodging | 20 | 27 | 0.74 | 13.7 |
| `retreat` | lodging | 17 | 23 | 0.74 | 13.7 |
| `studios` | lodging | 55 | 75 | 0.73 | 13.6 |
| `balaia` | lodging | 16 | 22 | 0.73 | 13.5 |
| `lisboa hotel` | lodging | 16 | 22 | 0.73 | 13.5 |
| `vila gale` | lodging | 44 | 61 | 0.72 | 13.4 |
| `hilton` | lodging | 22 | 31 | 0.71 | 13.1 |
| `holidays` | lodging | 16 | 23 | 0.70 | 12.9 |
| `oporto` | lodging | 89 | 129 | 0.69 | 12.8 |
| `turismo` | lodging | 207 | 303 | 0.68 | 12.6 |
| `turistico` | lodging | 19 | 28 | 0.68 | 12.6 |
| `hotelaria turismo` | lodging | 27 | 40 | 0.68 | 12.5 |
| `hoteleiros` | lodging | 81 | 121 | 0.67 | 12.4 |
| `lisbon` | lodging | 320 | 479 | 0.67 | 12.4 |
| `residencia` | lodging | 51 | 78 | 0.65 | 12.1 |
| `melia` | lodging | 15 | 23 | 0.65 | 12.1 |
| `pension` | lodging | 15 | 23 | 0.65 | 12.1 |
| `tulip` | lodging | 15 | 23 | 0.65 | 12.1 |
| `turim` | lodging | 15 | 23 | 0.65 | 12.1 |
| `quinta sao` | lodging | 28 | 43 | 0.65 | 12.1 |
| `country` | lodging | 54 | 83 | 0.65 | 12.0 |
| `nature` | lodging | 52 | 80 | 0.65 | 12.0 |
| `albergaria` | lodging | 60 | 93 | 0.65 | 11.9 |
| `turisticas` | lodging | 20 | 31 | 0.65 | 11.9 |
| `view` | lodging | 47 | 73 | 0.64 | 11.9 |
| `golf resort` | lodging | 25 | 39 | 0.64 | 11.9 |
| `equipamentos hoteleiros` | lodging | 48 | 75 | 0.64 | 11.8 |
| `juventude` | lodging | 65 | 104 | 0.62 | 11.6 |
| `casa campo` | lodging | 30 | 49 | 0.61 | 11.3 |
| `executive` | lodging | 17 | 28 | 0.61 | 11.2 |
| `like` | lodging | 18 | 30 | 0.60 | 11.1 |
| `dar` | lodging | 165 | 276 | 0.60 | 11.1 |
| `village` | lodging | 100 | 170 | 0.59 | 10.9 |
| `luxury` | lodging | 38 | 66 | 0.58 | 10.7 |
| `sociedade hoteleira` | lodging | 16 | 28 | 0.57 | 10.6 |
| `parador` | lodging | 17 | 30 | 0.57 | 10.5 |
| `finca` | lodging | 18 | 32 | 0.56 | 10.4 |
| `herdade` | lodging | 85 | 153 | 0.56 | 10.3 |
| `inatel` | lodging | 25 | 45 | 0.56 | 10.3 |
| `pestana` | lodging | 70 | 127 | 0.55 | 10.2 |
| `palais` | lodging | 27 | 49 | 0.55 | 10.2 |
| `cozy` | lodging | 17 | 31 | 0.55 | 10.2 |
| `quinta vale` | lodging | 17 | 31 | 0.55 | 10.2 |
| `mogador` | lodging | 24 | 44 | 0.55 | 10.1 |
| `rural` | lodging | 287 | 528 | 0.54 | 10.1 |
| `hotelaria` | lodging | 81 | 150 | 0.54 | 10.0 |
| `pine` | lodging | 15 | 28 | 0.54 | 9.9 |
| `camp` | lodging | 32 | 60 | 0.53 | 9.9 |
| `ryad` | lodging | 30 | 57 | 0.53 | 9.7 |
| `villa` | lodging | 307 | 594 | 0.52 | 9.6 |
| `bay` | lodging | 32 | 62 | 0.52 | 9.6 |
| `gale` | lodging | 46 | 90 | 0.51 | 9.5 |
| `bairro alto` | lodging | 24 | 47 | 0.51 | 9.5 |
| `kasbah` | lodging | 37 | 73 | 0.51 | 9.4 |
| `geres` | lodging | 35 | 70 | 0.50 | 9.3 |
| `posada` | lodging | 22 | 44 | 0.50 | 9.3 |
| `tivoli` | lodging | 23 | 48 | 0.48 | 8.9 |
| `empreendimentos` | lodging | 55 | 117 | 0.47 | 8.7 |
| `gardens` | lodging | 15 | 32 | 0.47 | 8.7 |
| `house` | lodging | 648 | 1383 | 0.47 | 8.7 |
| `azenha` | lodging | 20 | 43 | 0.47 | 8.6 |
| `azores` | lodging | 36 | 78 | 0.46 | 8.5 |
| `sana` | lodging | 17 | 37 | 0.46 | 8.5 |
| `surf` | lodging | 128 | 281 | 0.46 | 8.4 |
| `hoteleira` | lodging | 42 | 94 | 0.45 | 8.3 |
| `essaouira` | lodging | 20 | 45 | 0.44 | 8.2 |
| `loft` | lodging | 25 | 58 | 0.43 | 8.0 |
| `river` | lodging | 31 | 73 | 0.42 | 7.9 |
| `quinta` | lodging | 929 | 2295 | 0.40 | 7.5 |
| `colina` | lodging | 25 | 62 | 0.40 | 7.5 |
| `cabanas` | lodging | 31 | 78 | 0.40 | 7.4 |
| `varandas` | lodging | 21 | 53 | 0.40 | 7.3 |
| `eira` | lodging | 34 | 86 | 0.40 | 7.3 |
| `living` | lodging | 28 | 71 | 0.39 | 7.3 |
| `ocean` | lodging | 47 | 120 | 0.39 | 7.3 |
| `monte dos` | lodging | 16 | 41 | 0.39 | 7.2 |
| `investimentos` | lodging | 23 | 59 | 0.39 | 7.2 |
| `alfama` | lodging | 40 | 104 | 0.38 | 7.1 |
| `santa catarina` | lodging | 35 | 91 | 0.38 | 7.1 |
| `palace` | lodging | 111 | 289 | 0.38 | 7.1 |
| `alvor` | lodging | 31 | 81 | 0.38 | 7.1 |
| `quinta dos` | lodging | 53 | 139 | 0.38 | 7.1 |
| `casa avo` | lodging | 16 | 42 | 0.38 | 7.1 |
| `city` | lodging | 82 | 217 | 0.38 | 7.0 |
| `liberdade` | lodging | 29 | 78 | 0.37 | 6.9 |
| `atlas` | lodging | 27 | 73 | 0.37 | 6.8 |
| `sun` | lodging | 25 | 69 | 0.36 | 6.7 |
| `encosta` | lodging | 20 | 56 | 0.36 | 6.6 |
| `breakfast` | lodging | 47 | 134 | 0.35 | 6.5 |

