# Operator tenant lists

Transcribed by hand from each shopping centre's own website. The operator is
the authority for what is inside and on which floor — see
docs/poi-classification-rules.md.

Format is `Name|Piso N`, one per line. A trailing zone word (`Piso 0 GARE`)
is kept as written and ignored when reading the floor: it is the same floor
of an adjoining building, and a person finds it from the floor alone.

**Record when each was last verified.** A stale list is worse than none —
it retires real places with false confidence.

| file | centre | covers | verified |
|---|---|---|---|
| `vasco_da_gama_eating.txt` | Centro Comercial Vasco da Gama | eating places (68) | 2026-08-31 |
| `colombo_eating.txt` | Centro Comercial Colombo | eating places (65) | 2026-08-31 |

A list covers only what it covers. These are the eating-places pages, and
say nothing about the ~145 shops in either centre — `mall_tenants.py`
enforces that through its `covers` argument.

## Floors do not come from OSM

OSM's `level` is internally consistent inside one building and not
comparable across buildings. Measured: Colombo agrees with the published
Piso 55 times out of 55; Vasco da Gama's level runs ONE BELOW the Piso in 30
of 35 cases. Take the floor from the list here, and use OSM only where the
operator states none.
