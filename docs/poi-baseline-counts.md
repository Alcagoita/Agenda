# POI baseline — what we hold per app type, before the rebuild

Captured 2026-08-31 (KAN-437).

The database is being rebuilt on Overture. Rather than preserve the old
rows, we keep the COUNTS, so that afterwards we can ask "did we lose
anything" against a number instead of a memory.

## How to read it

* `foursquare` — national, from `poi_type_backup_20260829` (289,532 places).
  Being retired. Roughly half its `store` rows carry no subtype and are
  unreachable, so its totals overstate real coverage.
* `osm` — national, from the PT run of 16-18 August 2026. Predates KAN-408
  (43 tag types) and never covered Lisboa at all, so it understates.
* `overture` — **Odivelas, Lisboa and Alcobaça only** (KAN-431 pilot), not
  national. Do not compare this column directly to the other two.
* `curated` — operator tenant lists and user submissions.

A type absent from every column is one nothing has ever supplied.

| app type | foursquare (PT) | osm (PT) | overture (3 municipalities) | curated |
|---|---:|---:|---:|---:|
| `amusement_park` | 252 | 0 | 41 | 0 |
| `aquarium` | 45 | 0 | 3 | 0 |
| `art_gallery` | 1104 | 0 | 346 | 0 |
| `atm` | 1028 | 340 | 80 | 0 |
| `bakery` | 10575 | 1988 | 919 | 1 |
| `bank` | 5229 | 1631 | 387 | 3 |
| `bar` | 14322 | 2679 | 1136 | 0 |
| `barber` | 510 | 273 | 449 | 0 |
| `beach` | 2007 | 0 | 98 | 0 |
| `botanical_garden` | 776 | 0 | 9 | 0 |
| `bowling_alley` | 97 | 0 | 2 | 0 |
| `brewery` | 1577 | 0 | 44 | 0 |
| `bridge` | 319 | 0 | 7 | 0 |
| `bus` | 1 | 0 | 31 | 1 |
| `butcher` | 731 | 956 | 153 | 0 |
| `cafe` | 23853 | 9202 | 1465 | 3 |
| `campground` | 752 | 0 | 12 | 0 |
| `car_rental` | 1168 | 4 | 96 | 3 |
| `car_wash` | 715 | 0 | 55 | 1 |
| `casino` | 197 | 0 | 4 | 0 |
| `cemetery` | 546 | 0 | 65 | 0 |
| `church` | 3788 | 0 | 662 | 0 |
| `clinic` | 0 | 2161 | 0 | 0 |
| `clothing_repair` | 50 | 0 | 24 | 0 |
| `community_center` | 241 | 0 | 16 | 0 |
| `cultural_center` | 297 | 0 | 89 | 0 |
| `currency_exchange` | 75 | 31 | 8 | 3 |
| `electric_vehicle_charging_station` | 285 | 0 | 33 | 0 |
| `financial_service` | 46 | 31 | 0 | 0 |
| `fishmonger` | 133 | 204 | 34 | 0 |
| `florist` | 1422 | 394 | 225 | 0 |
| `gas` | 3 | 3270 | 210 | 1 |
| `golf_course` | 235 | 0 | 6 | 0 |
| `gym` | 2797 | 586 | 539 | 0 |
| `hairdresser` | 2572 | 732 | 1013 | 0 |
| `hiking_area` | 695 | 0 | 11 | 0 |
| `historical_landmark` | 2514 | 0 | 442 | 0 |
| `hot_spring` | 74 | 0 | 1 | 0 |
| `ice_cream` | 302 | 30 | 151 | 0 |
| `island` | 59 | 0 | 0 | 0 |
| `juice` | 129 | 0 | 37 | 0 |
| `lake` | 280 | 0 | 6 | 0 |
| `laundry` | 1161 | 934 | 369 | 0 |
| `library` | 837 | 302 | 99 | 0 |
| `lighthouse` | 123 | 0 | 4 | 0 |
| `lottery` | 32 | 0 | 99 | 0 |
| `marina` | 283 | 0 | 7 | 0 |
| `money_transfer` | 46 | 17 | 71 | 0 |
| `mosque` | 377 | 0 | 5 | 0 |
| `mountain` | 337 | 0 | 7 | 0 |
| `movie_theater` | 462 | 0 | 50 | 0 |
| `museum` | 1119 | 0 | 163 | 0 |
| `music_venue` | 980 | 0 | 190 | 0 |
| `nail_salon` | 1212 | 5 | 106 | 0 |
| `nature_preserve` | 85 | 0 | 8 | 0 |
| `night_club` | 1822 | 0 | 122 | 0 |
| `park` | 2022 | 2314 | 224 | 0 |
| `pharmacy` | 3688 | 1336 | 435 | 1 |
| `phone_repair` | 451 | 0 | 155 | 0 |
| `playground` | 1031 | 40 | 43 | 2 |
| `plaza` | 1000 | 0 | 115 | 0 |
| `post` | 1 | 824 | 229 | 1 |
| `restaurant` | 53422 | 10382 | 6720 | 11 |
| `river` | 328 | 0 | 17 | 0 |
| `rv_park` | 63 | 0 | 2 | 0 |
| `salon` | 0 | 0 | 1310 | 0 |
| `school` | 119 | 6228 | 1539 | 0 |
| `shoe_repair` | 35 | 0 | 17 | 2 |
| `spa` | 1683 | 0 | 1614 | 0 |
| `stadium` | 671 | 0 | 115 | 0 |
| `store` | 60658 | 27390 | 5858 | 33 |
| `supermarket` | 4508 | 2456 | 1095 | 0 |
| `surf_spot` | 228 | 0 | 6 | 0 |
| `synagogue` | 17 | 0 | 1 | 0 |
| `tattoo` | 412 | 85 | 261 | 0 |
| `tea` | 637 | 0 | 45 | 1 |
| `tennis_court` | 333 | 0 | 17 | 0 |
| `theatre` | 569 | 0 | 138 | 0 |
| `tourist_attraction` | 128 | 0 | 0 | 0 |
| `veterinary_care` | 1221 | 6 | 172 | 0 |
| `viewpoint` | 1358 | 0 | 19 | 0 |
| `water_park` | 213 | 0 | 5 | 0 |
| `waterfall` | 93 | 0 | 0 | 0 |
| `winery` | 1193 | 0 | 19 | 0 |
| `yoga_studio` | 248 | 0 | 79 | 0 |
| `zoo` | 49 | 0 | 0 | 0 |
| **total** | **227056** | **76831** | **30459** | **67** |

## Types no source supplies at all

_none_

## Types only Foursquare supplies

These are the ones a rebuild would lose outright, and the reason the
backup tables are kept until KAN-433 has read them.

* `tourist_attraction` — 128
* `waterfall` — 93
* `island` — 59
* `zoo` — 49
