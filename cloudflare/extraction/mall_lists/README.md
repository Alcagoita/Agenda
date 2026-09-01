# Operator tenant lists

Transcribed by hand from each shopping centre's own website. The operator is
the authority for what is inside and on which floor — see
docs/poi-classification-rules.md.

Format is `Name|Piso N`, one per line. A trailing zone word (`Piso 0 GARE`)
is kept as written and ignored when reading the floor: it is the same floor
of an adjoining building, and a person finds it from the floor alone.

`Name|` — an empty second field — means the operator publishes no floor for
that unit. Write it empty rather than as a bare `Piso`, which reads as a
floor named "Piso" and is not one.

`Name|Piso N|opening` marks a unit the operator has announced but not
opened. `read_tenant_list` skips these: a shop that has not opened is a
place that does not exist, and adding it would put a point on the map for
something nobody can walk into.

**Record when each was last verified.** A stale list is worse than none —
it retires real places with false confidence.

| file | centre | covers | verified |
|---|---|---|---|
| `vasco_da_gama_eating.txt` | Centro Comercial Vasco da Gama | eating places (68) | 2026-08-31 |
| `colombo_eating.txt` | Centro Comercial Colombo | eating places (65) | 2026-08-31 |
| `vasco_da_gama_stores.txt` | Centro Comercial Vasco da Gama | shops (154) | 2026-08-31 |
| `colombo_stores.txt` | Centro Comercial Colombo | shops (235) | 2026-08-31 |
| `strada.txt` | Strada Outlet Odivelas | shops and eating (113) | 2026-09-01 |

A list covers only what it covers. An eating-places page says nothing about
the shops in the same centre — `mall_tenants.py` enforces that through its
`covers` argument.

## Floors do not come from OSM

OSM's `level` is internally consistent inside one building and not
comparable across buildings. Measured: Colombo agrees with the published
Piso 55 times out of 55; Vasco da Gama's level runs ONE BELOW the Piso in 30
of 35 cases. Take the floor from the list here, and use OSM only where the
operator states none — Strada publishes no floors at all, so every floor
there comes from OSM with nothing to check it against.
