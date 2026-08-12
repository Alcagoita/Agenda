-- KAN-364: approved community POIs participate in the same canonical-brand
-- nearby filter as Foursquare rows. NULL deliberately means unclassified.
ALTER TABLE curated_poi ADD COLUMN brand TEXT;
CREATE INDEX IF NOT EXISTS idx_curated_poi_brand_geo
  ON curated_poi (brand, geohash);

-- The Foursquare table already has `brand`; this index accelerates the
-- branded-only branch of POST /poi/nearby while preserving the geohash range.
CREATE INDEX IF NOT EXISTS idx_poi_brand_geo
  ON poi (brand, geohash);
CREATE INDEX IF NOT EXISTS idx_poi_type_type_place
  ON poi_type (poi_type, fsq_place_id);
