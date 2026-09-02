# KAN-438 nearby baseline — before Foursquare removal

Captured from production at **2026-09-02T19:53:13Z** using the same authenticated
`POST /poi/nearby` endpoint used by the app.

* Centre: `38.799399723386465, -9.177702205963065`
* Radius: `300 m`
* Limit: `50` per requested type

Counts are per requested type bucket, not unique physical places. A place may
therefore occur in more than one bucket (for example, `cafe` and
`coffee_shop`). Types absent below returned zero.

| type | count |
| --- | ---: |
| restaurant | 24 |
| store | 15 |
| cafe | 14 |
| coffee_shop | 14 |
| bakery | 8 |
| hair_care | 8 |
| atm | 3 |
| playground | 3 |
| veterinary_care | 3 |
| doctor | 2 |
| city_hall | 1 |
| convenience_store | 1 |
| florist | 1 |
| grocery_store | 1 |
| hotel | 1 |
| laundry | 1 |
| lodging | 1 |
| nail_salon | 1 |
| park | 1 |
| pharmacy | 1 |
| plaza | 1 |
| shopping_mall | 1 |
| supermarket | 1 |
| taxi_stand | 1 |
| tea | 1 |

## ATM source check

Two results were official `multibanco` POIs (121.5 m and 286.6 m away). The
third, at 294.4 m, was still a Foursquare ATM. After KAN-438 is merged and
deployed, rerun this exact request: the Foursquare ATM must be absent while
the two official MULTIBANCO rows remain.
