# KAN-404 phase 2 — what is in poi_candidate

Candidates scanned: **217,106**

Identity index built from 222,782 `poi` rows and 75,490 `osm_poi` rows, matched on normalized name within 75m at similarity >= 0.72.

| outcome | rows | share |
|---|---:|---:|
| Already in the database under another name | 17,325 | 8.0% |
| Fits a type the app already ships | 48,720 | 22.4% |
| Classifiable, but onto a type the app has no PoiType for | 3,514 | 1.6% |
| Needs a product decision | 147,547 | 68.0% |

Of the duplicates, 11,272 match an OSM row and 6,053 match a Foursquare row already in `poi`.

## Absorbed by an existing type

No new app work: no catalog entry, no icon, no translations.

| existing type | rows |
|---|---:|
| `store` | 29,535 |
| `restaurant` | 11,687 |
| `bar` | 3,419 |
| `gym` | 1,451 |
| `school` | 616 |
| `bakery` | 529 |
| `tattoo` | 386 |
| `park` | 309 |
| `cafe` | 287 |
| `hairdresser` | 180 |
| `barber` | 99 |
| `supermarket` | 76 |
| `pharmacy` | 64 |
| `ice_cream` | 51 |
| `florist` | 11 |
| `currency_exchange` | 10 |
| `nail_salon` | 5 |
| `gas` | 3 |
| `bus` | 1 |
| `post` | 1 |

## Classified, but the app has no PoiType for it

These are not free. Each needs a catalog entry, an icon and two
translations before a task can be tagged with it — the difference
that left `gas`, `post`, `clinic` and `bus` matching zero rows until
KAN-398.

| classifier type | rows |
|---|---:|
| `airport` | 1,675 |
| `museum` | 505 |
| `stadium` | 463 |
| `local_government_office` | 364 |
| `hotel` | 243 |
| `movie_theater` | 56 |
| `car_dealer` | 52 |
| `hospital` | 22 |
| `church` | 15 |
| `veterinary_care` | 14 |
| `zoo` | 12 |
| `dentist` | 12 |
| `spa` | 10 |
| `beach` | 7 |
| `car_repair` | 5 |
| `parking` | 4 |
| `hiking_area` | 4 |
| `playground` | 4 |
| `yoga_studio` | 4 |
| `convenience_store` | 4 |
| `art_gallery` | 4 |
| `historical_landmark` | 4 |
| `ferry_terminal` | 3 |
| `night_club` | 3 |
| `physiotherapist` | 2 |
| `brewery` | 2 |
| `golf_course` | 2 |
| `car_rental` | 2 |
| `winery` | 2 |
| `taxi_stand` | 2 |
| `botanical_garden` | 1 |
| `liquor_store` | 1 |
| `water_park` | 1 |
| `cultural_center` | 1 |
| `campground` | 1 |
| `casino` | 1 |
| `community_center` | 1 |
| `shopping_mall` | 1 |
| `cemetery` | 1 |
| `amusement_park` | 1 |
| `fire_station` | 1 |
| `laundry` | 1 |
| `tennis_court` | 1 |

## Still needing a decision, ranked

| category path | rows |
|---|---:|
| Business and Professional Services | 11,353 |
| Business and Professional Services > Office | 6,154 |
| Health and Medicine > Medical Center | 4,688 |
| Community and Government > Education | 4,335 |
| Community and Government > Residential Building > Apartment or Condo | 3,817 |
| Travel and Transportation > Road | 3,328 |
| Business and Professional Services > Financial Service | 3,117 |
| Business and Professional Services > Legal Service | 3,074 |
| Landmarks and Outdoors > Structure | 3,031 |
| Business and Professional Services > Factory | 2,728 |
| Business and Professional Services > Advertising Agency | 2,134 |
| Arts and Entertainment | 1,932 |
| Community and Government > Housing Development | 1,884 |
| Landmarks and Outdoors > Farm | 1,875 |
| Community and Government > Education > College and University | 1,874 |
| Business and Professional Services > Real Estate Service > Real Estate Agency | 1,857 |
| Travel and Transportation | 1,846 |
| Landmarks and Outdoors > Other Great Outdoors | 1,763 |
| Landmarks and Outdoors > States and Municipalities > Neighborhood | 1,592 |
| Travel and Transportation > Lodging > Bed and Breakfast | 1,512 |
| Landmarks and Outdoors > States and Municipalities > City | 1,466 |
| Travel and Transportation > Lodging > Vacation Rental | 1,464 |
| Community and Government > Organization > Non-Profit Organization | 1,453 |
| Landmarks and Outdoors > Scenic Lookout | 1,413 |
| Business and Professional Services > Repair Service | 1,405 |
| Travel and Transportation > Lodging > Hostel | 1,370 |
| Business and Professional Services > Office > Tech Startup | 1,218 |
| Business and Professional Services > Health and Beauty Service | 1,212 |
| Business and Professional Services > Office > Coworking Space | 1,173 |
| Travel and Transportation > Travel Agency | 1,138 |
| Community and Government > Education > Driving School | 1,113 |
| Business and Professional Services > Insurance Agency | 1,055 |
| Community and Government > Education > Trade School | 1,018 |
| Sports and Recreation | 1,011 |
| Business and Professional Services > Business Service | 995 |
| Sports and Recreation > Soccer > Soccer Field | 987 |
| Landmarks and Outdoors > Field | 984 |
| Sports and Recreation > Water Sports > Swimming > Swimming Pool | 959 |
| Landmarks and Outdoors > Plaza | 932 |
| Business and Professional Services > Event Space | 894 |
| Travel and Transportation > Transport Hub > Bus Stop | 868 |
| Dining and Drinking > Snack Place | 730 |
| Dining and Drinking > Breakfast Spot | 685 |
| Landmarks and Outdoors > Garden | 675 |
| Community and Government > Education > College and University > College Classroom | 652 |
| Business and Professional Services > Design Studio | 589 |
| Travel and Transportation > Transportation Service > Public Transportation > Bus Line | 575 |
| Community and Government > Education > College and University > Student Center | 551 |
| Business and Professional Services > Construction | 545 |
| Travel and Transportation > Lodging > Resort | 543 |
| Arts and Entertainment > Performing Arts Venue > Music Venue | 541 |
| Landmarks and Outdoors > States and Municipalities > Village | 512 |
| Landmarks and Outdoors > Monument | 498 |
| Travel and Transportation > Tourist Information and Service | 471 |
| Dining and Drinking > Food Truck | 462 |
| Community and Government > Education > Language School | 461 |
| Business and Professional Services > Photography Service > Photography Lab | 460 |
| Community and Government > Assisted Living | 437 |
| Business and Professional Services > Laundromat | 427 |
| Business and Professional Services > Agriculture and Forestry Service | 423 |
| Community and Government > Education > Preschool | 386 |
| Community and Government > Residential Building | 368 |
| Business and Professional Services > Event Service | 367 |
| Arts and Entertainment > Performing Arts Venue > Concert Hall | 366 |
| Travel and Transportation > Train | 361 |
| Business and Professional Services > Legal Service > Law Office | 353 |
| Landmarks and Outdoors > Mountain | 353 |
| Community and Government > Education > College and University > College Lab | 352 |
| Community and Government > Spiritual Center | 344 |
| Landmarks and Outdoors > River | 340 |
| Travel and Transportation > Lodging > Boarding House | 339 |
| Landmarks and Outdoors > Bridge | 331 |
| Business and Professional Services > Funeral Home | 329 |
| Community and Government > Education > Music School | 323 |
| Community and Government > Organization | 313 |
| Business and Professional Services > Shipping, Freight, and Material Transportation Service | 309 |
| Dining and Drinking > Cafe, Coffee, and Tea House > Tea Room | 298 |
| Landmarks and Outdoors > Harbor or Marina | 288 |
| Landmarks and Outdoors > Lake | 284 |
| Arts and Entertainment > Performing Arts Venue > Theater | 282 |
| Travel and Transportation > Transportation Service | 281 |
| Dining and Drinking > Dessert Shop | 277 |
| Community and Government > Education > College and University > College Academic Building | 273 |
| Business and Professional Services > Wholesaler | 264 |
| Community and Government > Education > College and University > College Auditorium | 262 |
| Business and Professional Services > Health and Beauty Service > Massage Clinic | 259 |
| Landmarks and Outdoors > States and Municipalities > Town | 248 |
| Business and Professional Services > Real Estate Service > Real Estate Appraiser | 240 |
| Travel and Transportation > Lodging | 234 |
| Landmarks and Outdoors > Surf Spot | 234 |
| Dining and Drinking > Vineyard | 231 |
| Dining and Drinking > Cafeteria | 230 |
| Business and Professional Services > Tailor | 224 |
| Business and Professional Services > Photography Service > Photography Studio | 223 |
| Arts and Entertainment > Public Art | 222 |
| Arts and Entertainment > Strip Club | 219 |
| Business and Professional Services > Pet Service | 219 |
| Business and Professional Services > Auditorium | 213 |
| Business and Professional Services > Computer Repair Service | 208 |
| Business and Professional Services > Child Care Service > Daycare | 208 |
| Dining and Drinking > Dessert Shop > Pastry Shop | 208 |
| Sports and Recreation > Sports Club | 206 |
| Business and Professional Services > Architecture Firm | 198 |
| Business and Professional Services > Business Center | 198 |
| Travel and Transportation > Platform | 197 |
| Dining and Drinking > Bagel Shop | 191 |
| Business and Professional Services > Metals Supplier | 190 |
| Business and Professional Services > Industrial Equipment Supplier | 188 |
| Landmarks and Outdoors | 184 |
| Health and Medicine > Optometrist | 173 |
| Community and Government > Education > Nursery School | 170 |
| Business and Professional Services > Health and Beauty Service > Barbershop | 169 |
| Arts and Entertainment > Performing Arts Venue | 168 |
| Community and Government > Education > College and University > College Cafeteria | 165 |
| Business and Professional Services > Office > Meeting Room | 164 |
| Business and Professional Services > Convention Center > Conference Room | 164 |
| Community and Government > Education > College and University > Community College | 163 |
| Dining and Drinking > Creperie | 163 |
| Health and Medicine > Nursing Home | 158 |
| Sports and Recreation > Recreation Center | 158 |

## Duplicate examples

```
0.90 fsq  Galp Carregamento Elétrico  ==  galp
0.90 osm  Farmácia Laranjeira Pais  ==  farmacia laranjeira
0.75 osm  Epralima  ==  panilima
0.90 osm  Dido - Sistemas e Produtos de Higiene  ==  dido
0.73 fsq  Fotosport, Continente de Portimão  ==  carlos santos hairshop continente de portimao
1.00 fsq  Monte Rosa - Alojamento Rural  ==  monte rosa alojamento rural
0.90 osm  Rodrigo Silva  ==  agencia funeraria rodrigo silva
0.73 fsq  Câmara Municipal de Seia  ==  municipio de seia
1.00 osm  MultiOpticas  ==  multiopticas
1.00 osm  Farmácia Moreira Padrão  ==  farmacia moreira padrao
0.90 fsq  Hertz, Aluguer de Viaturas, Braga  ==  hertz
0.90 osm  Viselbi - Bicicletas de Viseu  ==  viselbi
0.91 fsq  Farmácia Almeida  ==  pharmacia almeida
1.00 osm  Polo de Formação Profissional  ==  polo de formacao profissional
1.00 osm  Farmácia Xavier da Cunha  ==  farmacia xavier da cunha
0.90 fsq  Turiarcos - Agência Viagens e Turismo  ==  turiarcos
0.90 osm  Fernandes & Monteiro  ==  fernandes e monteiro
1.00 osm  Jardim Infantil Nossa Senhora da Conceição  ==  jardim infantil nossa senhora da conceicao
1.00 osm  Bankinter  ==  bankinter
0.81 fsq  Almamater Lisbon Apartments  ==  almameter apartments
0.86 fsq  Clínica Médica Arrifana de Sousa, S.A.  ==  cmas clinica medica arrifana de sousa mcn
0.90 osm  Diogo Marques  ==  farmacia diogo marques
0.90 osm  Ath - Clínica Médica do Montijo  ==  clinica medica do montijo
0.90 fsq  Restaurante Canecão 2  ==  o canecao 2
0.90 fsq  Clínica Médico - Dentária Pinheiro Manso  ==  pinheiro manso
0.80 fsq  I.r.v. - Instituto de Recuperação Vascular, Unipessoal  ==  instituto de recuperacao vascular
0.90 fsq  Abrigo da Montanha Alojamento Familiar  ==  abrigo da montanha
1.00 osm  N'Soluções  ==  n solucoes
0.74 fsq  Tabacaria Restauradores  ==  ctt ec restauradores
0.81 osm  Churrascaria Ideal  ==  churrasqueira ideal
0.90 fsq  Women'secret, Forum Castelo Branco  ==  forum castelo branco
1.00 osm  Shell  ==  shell
0.90 osm  Marisqueira Ribamar  ==  marisqueira de ribamar
0.75 fsq  Toti Kids Lisboa - Centro Colombo  ==  boutique dos relogios centro colombo
1.00 osm  Colégio Educa A Brincar  ==  colegio educa a brincar
1.00 osm  Papelaria Machado  ==  papelaria machado
0.90 osm  Majorali - Papelaria Livraria Tabacaria e Perfumaria  ==  majorali
0.90 fsq  Polícia Judiciária - Directoria Geral  ==  policia judiciaria
0.90 osm  Dietsaúde - Centro Dietético e Estética, Unipessoal  ==  dietsaude
1.00 osm  Donna Viagem  ==  donna viagem
```
