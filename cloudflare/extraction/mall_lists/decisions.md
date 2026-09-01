# Mall tenant decisions

Rulings already given. **Read this before proposing anything** — every line
here is a question that has been answered, and asking it again wastes the
reviewer's time. `mall_tenants.py` has no memory; this file is it.

## Confirmed matches — the tenant IS the row we hold

The matcher scored these below its confident bar. They are the same shop.

| operator directory | we hold | mall |
|---|---|---|
| `5 À SEC` | `5àSec` | Colombo, Vasco da Gama |
| `TIFFOSI` | `Tifossi` | Colombo |
| `MERREL CATERPILLER` | `Merrell` | Colombo |
| `SALSA JEANS` | `Salsa Denim Innovation` | Colombo |
| `T.Hair Barber's` | `T-Hair for Men` | Colombo |
| `ORIENTE-SE – TATTOOS & PIERCINGS` | `Oriente-Se Artigos Orientais` | Colombo |
| `BERTRAND LIVREIROS` | `Livraria Bertrand` | Vasco da Gama |
| `PANS & COMPANY` | `Pans and Company` | both |
| `XIAOMI STORE PORTUGAL` | `Mi Store Portugal` | Colombo — renamed |
| `LEROY MERLIN` | `AKI` | Colombo — rebrand, renamed |
| `H3` | `H3 Hambúrguer Gourmet` | Strada — too short for the containment rule |

## Confirmed NOT matches — different businesses

Similar names, different shops. The default answer to a partial name match
is no.

`KIK` / `KIWOKO` / `Kiko` are three chains · `PRIMOR` ≠ `Primark` ·
`PIMKIE` ≠ `PRIMARK` · `Clarks` ≠ `Claire's` · `Tous` ≠ `Toys R Us` ·
`Cinemas NOS` ≠ `Loja NOS` · `Lanidor` ≠ `PANDORA` · `Chicco` ≠ `ECCO` ·
`Asics` ≠ `iServices` · `Elena Mirò` ≠ `CELEIRO` · `Loja Huawei` ≠
`Hawkers` · `Inglot` ≠ `NOTE!` · `Macmoda` ≠ `MAC` · `Furla` ≠ `SFERA` ·
`Café do Ponto` ≠ `Ponto do Café` (Strada — two separate shops, however
much the names invite merging) · `Carpisa` ≠ `Parfois` ·
`Hubside.Store` ≠ `SEASIDE` · `Western Union` ≠
`MISTER MINIT` · `Cacifo Locky` ≠ `FOOT LOCKER` · `Timberland` ≠
`Silverland` · `Kiro` ≠ `Kiko` · `Mais Optica` ≠ `MultiOpticas`

## One shop, two doors — both rows are valid

`Springfield` / `Springfield Woman` · `ZARA` / `Zara Home` ·
`MANGO` / `MANGO TEEN` · `INTIMISSIMI` / `Intimissimi Uomo` ·
`BOTA MINUTO` at Vasco da Gama (Piso -1 and Piso -1 GARE) ·
`BigFoot` / `BigFoot Sport` at Strada — one shop with two doors, one row ·
`Wells` / `Wells Ótica` at Strada — two shops sharing one unit, so TWO rows:
the parapharmacy and the optician are different businesses at one address

## One unit listed under two names — keep ONE

`TOP ATLÂNTICO` / `TOP ATLÂNTICO – VIAGENS E TURISMO` (Colombo, Piso 0) ·
`VODAFONE` / `Vodafone Empresas` (Colombo, Piso 0) ·
`BERSHKA` / `BERSKA` (Vasco da Gama, a typo on the operator's page)

## Kept despite being absent from the directory

* `Well's` — inside Continente at Vasco da Gama. A concession is not a unit.
* `Brown Bar Benefit` — the Benefit bar inside Sephora, Colombo.
* `Luggage Storage Lisbon` — real, in Gare do Oriente, not a mall unit.

## Types that exist because a tenant needed them

A shop whose type the app lacked used to be held back. It is not a reason to
drop a real place — the type gets added.

* `travel_agency` — AGÊNCIA ABREU and TOP ATLÂNTICO (both malls), Viagens El
  Corte Inglés (Strada). These carried `store_kind=any` while the kind did
  not exist; `any` is a generic store by another name, so it is not an
  answer.
* `copy_shop` — Centro de Cópias (Strada).

## Reading the operator's pages

* **`Encerrado`** means closed RIGHT NOW — opening hours. It appears against
  every unit on Colombo's page. It says nothing about whether a shop exists,
  and reading it as "closed for good" retired ActivoBank and CTT, both real.
* **`ABRE BREVEMENTE`** means not open yet. Do not add: a shop that has not
  opened is a place that does not exist.
* **`Clínica`** in a Portuguese name is not a medical clinic. `Clínica do
  Pêlo` is a waxing salon.
