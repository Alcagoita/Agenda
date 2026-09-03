# KAN-437 Overture backlog review

Run this sequence for every Overture country artifact:

1. Extract and archive the source CSV in R2.
2. Download that immutable CSV locally.
3. Run `report_overture_backlog.py <extract.csv> --out unresolved.tsv`.
4. Review the unresolved report, then stage with `load_overture_candidates.py`.
5. Promote using `promote_overture_candidates.py`.

The report scans the CSV locally. Its only D1 lookup is the small current
type-relation map; it never reads the country-sized Overture tables. It is an
audit input, not a reason to run a per-row D1 job.

A promoted `store` must have a `store_kind`. Category-derived kinds win;
brand inference is permitted only for `shopping` or missing-category rows and
uses the guarded brand matcher. All remaining bare stores stay pending for
post-import review.
