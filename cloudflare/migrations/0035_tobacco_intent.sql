-- KAN-432. Tobacco is a practical composite errand: tobacco/vape shops,
-- lottery counters, cafés and coffee shops. Specialist cigar shops remain
-- intentionally separate.
INSERT OR IGNORE INTO type_relation (search_type, include_type) VALUES
  ('tobacco', 'tobacco'),
  ('tobacco', 'lottery'),
  ('tobacco', 'cafe'),
  ('tobacco', 'coffee_shop');
