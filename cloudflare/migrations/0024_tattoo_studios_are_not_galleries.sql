-- KAN-402 — tattoo studios filed as art galleries.
--
-- Foursquare has a Tattoo Parlor category (4bf58dd8d48988d1de931735); it was
-- simply never mapped in poiTypeCategories.json. With nowhere correct to go,
-- these studios landed in whatever adjacent bucket their other tags
-- suggested, and for ten of them that was Art Gallery.
--
-- Tattooing is an art, but `art_gallery` is for somewhere you go to look at
-- art -- MAAT, not a studio where you book a session. So the type is removed
-- rather than kept alongside the new one.
--
-- Deliberately NOT removed, against this ticket's original recommendation:
--
--   hair_care / salon  every one of those venues names itself a barbershop
--                      too ("Old School BarberShop & Tattoo", "Barbearia 31
--                      Tatuagem"). They really do cut hair; the multi-type
--                      model is already correct there.
--   cafe / bar         one each ("Tattoo Cafe", "Rockabella Tattoo Bar"),
--                      both plausibly genuine hybrids. Two records is too
--                      thin a basis for deleting a real category.
--
-- The generic `store` rows need no statement here: `tattoo` is now a mapped
-- type, so KAN-391's replaces_generic_store rule retires the shrug on the
-- next classification pass, which also recomputes primary_poi_type.
DELETE FROM poi_type
WHERE poi_type = 'art_gallery'
  AND fsq_place_id IN (
    '4d67f5a7c406f04d0fc4f44c',  -- Tarambana Tattoo
    '4fd77551e4b071eb339cf14d',  -- Tattooart
    '50c79e27e4b041c64cddca30',  -- Mojo Tattoos
    '50fd6c57e4b01dd47ae4a37d',  -- Tattoo Studium
    '5265084411d2d36bc9bb9a59',  -- Hateball Tattoo
    '53d0d22f498e6c801eb4f16a',  -- Montes Tattoo Customs
    '55c8e332498e2947db0df289',  -- YUTTT TATTOO STUDIO
    '5738c77ecd1015663e8122e9',  -- PRISMA - Cutom Tattoo
    '57f77265498ed1577bab3757',  -- villa tattoo club
    '5842497d18bb4d08ea7dc5f0'  -- Caverinha Designer Tattoo
  );
