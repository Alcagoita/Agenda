import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { S } from './shared';
import type { IconProps } from './shared';

// ── POI icons ──────────────────────────────────────────────────────────────────
//
//   ATM         — credit-card outline + magnetic stripe + chip line
//   Café        — cup body + handle + two steam wisps
//   Market      — shopping cart body; wheel dots are the only solid fills
//   Pharmacy    — diagonal pill capsule with centre divider (Lucide Pill)

interface PoiIconProps extends IconProps {
  /** Google Places primary type string. Built-in types render a specific icon;
   *  Google-mapped types fall back to the nearest semantic icon;
   *  truly unknown strings render a generic map-pin. */
  type: string;
}

/**
 * Maps Google Places API type strings (and common free-text equivalents) to
 * the nearest built-in icon key. Only types NOT already handled by the switch
 * cases below need to be listed here.
 */
export const GOOGLE_TYPE_ICON: Record<string, string> = {
  // Food & drink
  acai_shop:            'cafe',
  bagel_shop:           'cafe',
  bakery:               'bakery',
  bar:                  'cafe',
  bar_and_grill:        'restaurant',
  beer_garden:          'cafe',
  bistro:               'restaurant',
  breakfast_restaurant: 'restaurant',
  brewery:              'cafe',
  brewpub:              'cafe',
  brunch_restaurant:    'restaurant',
  cafe:                 'cafe',
  cafeteria:            'cafe',
  cake_shop:            'store',
  cat_cafe:             'cafe',
  chocolate_shop:       'store',
  coffee_roastery:      'cafe',
  coffee_shop:          'cafe',
  coffee_stand:         'cafe',
  confectionery:        'store',
  deli:                 'restaurant',
  dessert_restaurant:   'restaurant',
  dessert_shop:         'store',
  diner:                'restaurant',
  dog_cafe:             'cafe',
  donut_shop:           'store',
  food:                 'restaurant',
  food_court:           'restaurant',
  ice_cream_shop:       'ice_cream',
  juice_shop:           'cafe',
  kebab_shop:           'restaurant',
  meal_delivery:        'restaurant',
  meal_takeaway:        'restaurant',
  night_club:           'restaurant',
  pastry_shop:          'store',
  pizza_delivery:       'restaurant',
  pizza_restaurant:     'restaurant',
  pub:                  'cafe',
  ramen_restaurant:     'restaurant',
  salad_shop:           'store',
  sandwich_shop:        'restaurant',
  snack_bar:            'cafe',
  tea_house:            'cafe',
  tea_store:            'store',
  wine_bar:             'cafe',
  winery:               'cafe',

  // Health
  chiropractor:         'clinic',
  dental_clinic:        'clinic',
  dentist:              'clinic',
  doctor:               'clinic',
  drugstore:            'pharmacy',
  general_hospital:     'clinic',
  hospital:             'clinic',
  medical_center:       'clinic',
  medical_clinic:       'clinic',
  medical_lab:          'clinic',
  massage:              'salon',
  massage_spa:          'salon',
  physiotherapist:      'clinic',
  sauna:                'salon',
  skin_care_clinic:     'salon',
  wellness_center:      'salon',
  yoga_studio:          'gym',
  veterinary_care:      'clinic',

  // Shopping & retail
  asian_grocery_store:  'supermarket',
  auto_parts_store:     'store',
  bicycle_store:        'store',
  book_store:           'library',
  building_materials_store: 'store',
  butcher_shop:         'store',
  car_dealer:           'store',
  car_rental:           'store',
  cell_phone_store:     'store',
  clothing_store:       'store',
  convenience_store:    'store',
  cosmetics_store:      'store',
  department_store:     'store',
  discount_store:       'store',
  discount_supermarket: 'supermarket',
  electronics_store:    'store',
  farmers_market:       'supermarket',
  flea_market:          'supermarket',
  food_store:           'supermarket',
  florist:              'park',
  furniture_store:      'store',
  garden_center:        'store',
  general_store:        'store',
  gift_shop:            'store',
  grocery_store:        'supermarket',
  grocery_or_supermarket: 'supermarket',
  health_food_store:    'store',
  hardware_store:       'store',
  home_goods_store:     'store',
  home_improvement_store: 'store',
  hypermarket:          'supermarket',
  jewelry_store:        'store',
  laundry:              'store',
  liquor_store:         'store',
  locksmith:            'store',
  market:               'supermarket',
  moving_company:       'store',
  pet_store:            'store',
  shoe_store:           'store',
  shopping_mall:        'store',
  sporting_goods_store: 'store',
  sportswear_store:     'store',
  storage:              'store',
  tattoo_parlor:        'tattoo',
  thrift_store:         'store',
  toy_store:            'store',
  warehouse_store:      'store',
  wholesaler:           'store',
  womens_clothing_store: 'store',

  // Finance / official
  accounting:           'bank',
  business_center:      'bank',
  city_hall:            'bank',
  corporate_office:     'bank',
  courthouse:           'bank',
  embassy:              'bank',
  fire_station:         'bank',
  government_office:    'bank',
  insurance_agency:     'bank',
  local_government_office: 'bank',
  neighborhood_police_station: 'bank',
  police:               'bank',
  real_estate_agency:   'bank',
  coworking_space:      'bank',

  // Transport
  airstrip:             'bus',
  airport:              'bus',
  bike_sharing_station: 'bus',
  bus_station:          'bus',
  bus_stop:             'bus',
  electric_vehicle_charging_station: 'gas',
  ebike_charging_station: 'gas',
  ferry_service:        'bus',
  ferry_terminal:       'bus',
  heliport:             'bus',
  international_airport: 'bus',
  light_rail_station:   'bus',
  parking:              'gas',
  parking_garage:       'gas',
  parking_lot:          'gas',
  park_and_ride:        'bus',
  rest_stop:            'gas',
  subway_station:       'bus',
  taxi_service:         'bus',
  taxi_stand:           'bus',
  toll_station:         'bus',
  train_station:        'bus',
  train_ticket_office:  'bus',
  tram_stop:            'bus',
  transit_depot:        'bus',
  transit_station:      'bus',
  transit_stop:         'bus',
  transportation_service: 'bus',
  truck_stop:           'gas',

  // Education & culture
  art_gallery:          'library',
  art_museum:           'library',
  art_studio:           'library',
  castle:               'library',
  cultural_landmark:    'library',
  history_museum:       'library',
  museum:               'library',
  monument:             'library',
  primary_school:       'school',
  preschool:            'school',
  research_institute:   'school',
  secondary_school:     'school',
  university:           'school',

  // Outdoor & leisure
  aquarium:             'park',
  amusement_park:       'park',
  botanical_garden:     'park',
  campground:           'park',
  city_park:            'park',
  dog_park:             'park',
  garden:               'park',
  hiking_area:          'park',
  historical_landmark:  'park',
  marina:               'park',
  national_park:        'park',
  natural_feature:      'park',
  picnic_ground:        'park',
  rv_park:              'park',
  stadium:              'park',
  state_park:           'park',
  tourist_attraction:   'park',
  visitor_center:       'park',
  water_park:           'park',
  wildlife_park:        'park',
  wildlife_refuge:      'park',
  zoo:                  'park',

  // Auto & fuel
  car_repair:           'gas',
  car_wash:             'gas',
  gas_station:          'gas',
  tire_shop:            'gas',
  truck_dealer:         'store',

  // Beauty & wellness — four distinct errands, not one (KAN-401)
  barber_shop:          'barber',
  hair_care:            'hairdresser',
  hair_salon:           'hairdresser',
  beauty_salon:         'salon',
  beautician:           'salon',
  makeup_artist:        'salon',
  nail_salon:           'nail_salon',
  spa:                  'salon',

  // Post, lodging, worship
  bed_and_breakfast:    'store',
  budget_japanese_inn:  'store',
  church:               'library',
  guest_house:          'store',
  hindu_temple:         'library',
  hostel:               'store',
  hotel:                'store',
  inn:                  'store',
  japanese_inn:         'store',
  lodging:              'store',
  motel:                'store',
  mosque:               'library',
  post_office:          'post',
  resort_hotel:         'store',
  shinto_shrine:        'library',
  synagogue:            'library',
};

export function PoiIcon({ type, color, size = 24 }: PoiIconProps) {
  // If the type isn't a built-in case, check the Google mapping before the pin fallback.
  const resolved = resolvePoiIconType(type);

  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' };

  switch (resolved) {
    case 'atm':
      return (
        <Svg {...p}>
          <Rect x="2" y="5" width="20" height="14" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="2" y1="10" x2="22" y2="10" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
          <Line x1="5.5" y1="14.5" x2="9" y2="14.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'cafe':
      return (
        <Svg {...p}>
          <Path d="M8 3 Q7.5 5 8 7"    stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M12 3 Q11.5 5 12 7" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M4 9h14v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M18 11h1a3 3 0 0 1 0 6h-1" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'supermarket':
      return (
        <Svg {...p}>
          <Path
            d="M2 2h2l1.68 8.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 1.95-1.57L21 5H6"
            stroke={color} strokeWidth={1.6} {...S}
          />
          {/* Wheel dots — only solid fills in the icon set */}
          <Circle cx="9"  cy="20" r="1.1" fill={color} stroke="none" />
          <Circle cx="18" cy="20" r="1.1" fill={color} stroke="none" />
        </Svg>
      );

    case 'pharmacy':
      return (
        <Svg {...p}>
          <Path
            d="M10.5 20.5 20 11a4.95 4.95 0 1 0-7-7L3.5 13.5a4.95 4.95 0 1 0 7 7Z"
            stroke={color} strokeWidth={1.6} {...S}
          />
          <Line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'gas':
      return (
        <Svg {...p}>
          <Path d="M3 22V8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v14" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="2" y1="22" x2="14" y2="22" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M13 8h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9l-3-3" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="6" y="11" width="6" height="4" rx="1" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'gym':
      return (
        <Svg {...p}>
          <Line x1="6.5" y1="12" x2="17.5" y2="12" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M3 12h2.5M18.5 12H21" stroke={color} strokeWidth={2} {...S} />
          <Rect x="4" y="9" width="2" height="6" rx="1" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="18" y="9" width="2" height="6" rx="1" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="2" y="10.5" width="2" height="3" rx="0.8" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="20" y="10.5" width="2" height="3" rx="0.8" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'bank':
      return (
        <Svg {...p}>
          <Path d="M3 10h18M12 3l9 7H3l9-7z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="6"  y1="10" x2="6"  y2="18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="10" x2="12" y2="18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="18" y1="10" x2="18" y2="18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="3"  y1="18" x2="21" y2="18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="2"  y1="21" x2="22" y2="21" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'currency_exchange':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M15.5 9.5c-.7-1-1.9-1.5-3.4-1.5-2 0-3.5 1.3-3.5 3s1.5 3 3.5 3c1.5 0 2.7-.5 3.4-1.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="m14 6.5 1.5 1.5-1.5 1.5M10 14l-1.5 1.5 1.5 1.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'money_transfer':
      return (
        <Svg {...p}>
          <Path d="M4 8h12l-2.5-2.5M20 16H8l2.5 2.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M16 8a4 4 0 0 1 4 4M8 16a4 4 0 0 1-4-4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'financial_service':
      return (
        <Svg {...p}>
          <Rect x="3" y="4" width="18" height="16" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="12" cy="12" r="3.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M12 9.5v5M10.5 11h3M10.5 13h3" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'restaurant':
      return (
        <Svg {...p}>
          <Path d="M3 3v6a4 4 0 0 0 4 4h0a4 4 0 0 0 4-4V3" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7" y1="13" x2="7" y2="21" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M17 3v5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M17 12a4 4 0 0 1-4-4V3h8v5a4 4 0 0 1-4 4z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="17" y1="12" x2="17" y2="21" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'bakery':
      return (
        <Svg {...p}>
          <Path
            d="M4 20v-8a8 8 0 0 1 16 0v8H4z"
            stroke={color} strokeWidth={1.6} {...S}
          />
          <Path d="M8 10.5 10.5 13M12 8.5 14.5 11M16 10.5 18 12.5" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="4" y1="20" x2="20" y2="20" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'barber':
      return (
        <Svg {...p}>
          {/* Barber pole: cylinder with its two diagonal stripes. */}
          <Rect x="8.5" y="4" width="7" height="16" rx="3.5" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="8.8" y1="12" x2="15.2" y2="8" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="8.8" y1="16" x2="15.2" y2="12" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'hairdresser':
      return (
        <Svg {...p}>
          {/* Scissors: two finger rings and the crossed blades. */}
          <Circle cx="6" cy="18" r="2.6" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="18" cy="18" r="2.6" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="16.4" y1="16" x2="7" y2="4" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7.6" y1="16" x2="17" y2="4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'nail_salon':
      return (
        <Svg {...p}>
          {/* Polish bottle: cap, neck and body. */}
          <Rect x="10" y="2.5" width="4" height="3.5" rx="0.8" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="6" x2="12" y2="8" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="7.5" y="8" width="9" height="13" rx="2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'tattoo':
      return (
        <Svg {...p}>
          {/* Machine: grip barrel, needle, and the line it lays down. */}
          <Path d="M14.5 3.5 20 9l-3.2 3.2-5.5-5.5L14.5 3.5z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="11.3" y1="6.7" x2="6" y2="12" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6 12 4 20l8-2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'ice_cream':
      return (
        <Svg {...p}>
          {/* Scoop over a cone: circle + tapering triangle, hairline
              outline like every other icon here. */}
          <Circle cx="12" cy="8" r="4.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M7.9 10.2 12 21l4.1-10.8" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="9" y1="14" x2="15" y2="14" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'park':
      return (
        <Svg {...p}>
          <Path d="M12 2C8 2 5 6 7 10H5l7 8 7-8h-2c2-4-1-8-5-8z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="18" x2="12" y2="22" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'library':
      return (
        <Svg {...p}>
          <Path d="M4 19V7a2 2 0 0 1 2-2h1v14H6a2 2 0 0 1-2-2z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M9 5h2a2 2 0 0 1 2 2v12H9V5z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M15.5 5.5l1.9-.7a2 2 0 0 1 2.5 1.2l3.5 9.6a2 2 0 0 1-1.2 2.5l-2 .7-4.7-13.3z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'post':
      return (
        <Svg {...p}>
          <Rect x="2" y="4" width="20" height="16" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M2 6l10 7 10-7" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'store':
      return (
        <Svg {...p}>
          <Path d="M6 2 3 6v2a4 4 0 0 0 8 0V6M13 8a4 4 0 0 0 8 0V6l-3-4" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M5 10v10a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1V10" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'clinic':
      return (
        <Svg {...p}>
          <Rect x="3" y="3" width="18" height="18" rx="3" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="7" x2="12" y2="17" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7"  y1="12" x2="17" y2="12" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'salon':
      return (
        <Svg {...p}>
          <Circle cx="6"  cy="6"  r="2.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="18" cy="6"  r="2.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="6"  cy="20" r="2"   stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="18" cy="20" r="2"   stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="6.5" y1="7.5" x2="17.5" y2="18.5" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="17.5" y1="7.5" x2="6.5" y2="18.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'bus':
      return (
        <Svg {...p}>
          <Rect x="3" y="3" width="18" height="14" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M3 9h18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="3" x2="12" y2="9" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M7 17v2M17 17v2" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="7.5"  cy="17" r="1.5" fill={color} stroke="none" />
          <Circle cx="16.5" cy="17" r="1.5" fill={color} stroke="none" />
        </Svg>
      );

    case 'school':
      return (
        <Svg {...p}>
          <Path d="M12 3L2 9l10 6 10-6-10-6z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="22" y1="9" x2="22" y2="14" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    // ─── KAN-411 ────────────────────────────────────────────────────────
    // Same hairline house style: 24x24, strokeWidth 1.6, no fills.

    case 'tea':
      return (
        <Svg {...p}>
          {/* Cup with a handle and a wisp of steam. */}
          <Path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M16 11h2a2 2 0 0 1 0 4h-2" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M9 6c0-1 1-1.5 1-2.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M12.5 6c0-1 1-1.5 1-2.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'juice':
      return (
        <Svg {...p}>
          {/* Tapered glass with a straw. */}
          <Path d="M7 5h10l-1.4 14a1 1 0 0 1-1 .9H9.4a1 1 0 0 1-1-.9L7 5z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="14" y1="3" x2="11.5" y2="12" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7.5" y1="10" x2="16.5" y2="10" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'phone_repair':
      return (
        <Svg {...p}>
          {/* Handset with a screwdriver across it. */}
          <Path d="M7 3h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="9.5" y1="15.5" x2="11.5" y2="15.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M15 14.5 20 19.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M14 13.5l1.8-1.8 1.4 1.4-1.8 1.8z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'shoe_repair':
      return (
        <Svg {...p}>
          {/* Boot profile, with the sole stitched. */}
          <Path d="M6 5h3.5l1 6.5c.3 1.6 1.4 2.3 3 2.6L20 15v3H6V5z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="6" y1="18" x2="20" y2="18" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="9" y1="20.5" x2="17" y2="20.5" stroke={color} strokeWidth={1.6} strokeDasharray="1.6 1.8" {...S} />
        </Svg>
      );

    case 'clothing_repair':
      return (
        <Svg {...p}>
          {/* Needle with thread through the eye. */}
          <Line x1="4" y1="20" x2="16" y2="8" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M16 8l4-4-1.5 5.5L16 8z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M9 15c2 1.5 4-1.5 6 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'lottery':
      return (
        <Svg {...p}>
          {/* Ticket with a perforation and a lucky star. */}
          <Path d="M3 8h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4V8z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="9" y1="8" x2="9" y2="18" stroke={color} strokeWidth={1.6} strokeDasharray="1.5 1.8" {...S} />
          <Path d="M14.5 10.8l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'tobacco':
      return (
        <Svg {...p}>
          {/* Cigarette and lit end; product-specific without an emoji. */}
          <Path d="M4 11h12v3H4z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M16 11h4v3h-4" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M20 10.5c1 .7 1 2.3 0 3" stroke={color} strokeWidth={1.3} {...S} />
          <Path d="M7 8.5c-.8-.8-.8-1.7 0-2.5M10 8.5c.8-.8.8-1.7 0-2.5" stroke={color} strokeWidth={1.3} {...S} />
        </Svg>
      );

    // ─── KAN-412 ────────────────────────────────────────────────────────
    // Same hairline house style. Every catalog type gets a bespoke glyph
    // rather than falling through to the pin: ten entries all showing the
    // same marker reads as a bug, not as staging. The `default` below stays
    // the fallback for custom, non-built-in types.

    case 'butcher':
      return (
        <Svg {...p}>
          {/* Cleaver: blade with a spine and a handle. */}
          <Path d="M4 4h9v9H4z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="13" y1="6" x2="20" y2="6" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6.5 13v7" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'fishmonger':
      return (
        <Svg {...p}>
          {/* Fish: body, tail, eye. */}
          <Path d="M3 12c3-4 7-5 10-5s5 2 6 5c-1 3-3 5-6 5s-7-1-10-5z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M3 12 1.5 8.5M3 12 1.5 15.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="15.5" cy="10.5" r="1" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'laundry':
      return (
        <Svg {...p}>
          {/* Washing machine: door and control. */}
          <Path d="M4 3h16v18H4z" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="12" cy="14" r="4.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="7.5" cy="6.5" r="0.9" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'veterinary_care':
      return (
        <Svg {...p}>
          {/* Paw: pad and four toes. */}
          <Path d="M8 16.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5-1.8 3.5-4 3.5-4-1.3-4-3.5z" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="7" cy="10" r="1.7" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="11" cy="7.5" r="1.7" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="15" cy="7.5" r="1.7" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="18" cy="10.5" r="1.7" stroke={color} strokeWidth={1.5} {...S} />
        </Svg>
      );

    case 'car_wash':
      return (
        <Svg {...p}>
          {/* Car under falling water. */}
          <Path d="M4 17h16M5.5 17v-3l2-4h9l2 4v3" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="8" cy="18.5" r="1.4" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="16" cy="18.5" r="1.4" stroke={color} strokeWidth={1.5} {...S} />
          <Path d="M7 3v2.5M12 2.5V5M17 3v2.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'car_rental':
      return (
        <Svg {...p}>
          {/* Car with a key fob. */}
          <Path d="M3 15h12M4.5 15v-2.5l1.8-3.5h7l1.8 3.5V15" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="6.5" cy="16.5" r="1.3" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="13" cy="16.5" r="1.3" stroke={color} strokeWidth={1.5} {...S} />
          <Circle cx="18.5" cy="7" r="2.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M18.5 9.5V15l1.6 1" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    case 'movie_theater':
      return (
        <Svg {...p}>
          {/* Clapperboard. */}
          <Path d="M3 9h18v11H3z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M3 9 5 4l16 1-2 4" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M8.5 4.4 6.5 9M13.5 4.7 11.5 9M18 5.1 16 9" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );

    case 'yoga_studio':
      return (
        <Svg {...p}>
          {/* Seated figure: head, folded legs, arms resting. */}
          <Circle cx="12" cy="5" r="2.4" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M12 8v5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M5 18c2-3 5-4.5 7-4.5s5 1.5 7 4.5z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M12 10.5 7.5 13M12 10.5 16.5 13" stroke={color} strokeWidth={1.5} {...S} />
        </Svg>
      );

    case 'playground':
      return (
        <Svg {...p}>
          {/* Slide: ladder, chute, ground line. */}
          <Path d="M5 20V9M8.5 20V9" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M5 12h3.5M5 15.5h3.5" stroke={color} strokeWidth={1.4} {...S} />
          <Path d="M8.5 9 19 17.5V20" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="6.75" cy="5" r="1.8" stroke={color} strokeWidth={1.5} {...S} />
        </Svg>
      );

    case 'electric_vehicle_charging_station':
      return (
        <Svg {...p}>
          {/* Charging post with a bolt. */}
          <Path d="M5 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M9.8 7.5 8 11.5h3l-1.8 4" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M14 9h3a2 2 0 0 1 2 2v5a1.5 1.5 0 0 1-3 0v-3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );

    // ── KAN-408 · Nature and Landmarks ──
    case 'beach':
      return (
        <Svg {...p}>
          <Path d="M3 19h18" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 19V9" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 9c-4 0-7 2-8 4 3-1 6-1 8 0 2-1 5-1 8 0-1-2-4-4-8-4z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'hiking_area':
      return (
        <Svg {...p}>
          <Path d="M3 19h18" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 19l6-10 4 6 2-3 6 7" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'botanical_garden':
      return (
        <Svg {...p}>
          <Path d="M12 21V10" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 12c-3 0-5-2-5-5 3 0 5 2 5 5z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 14c3 0 5-2 5-5-3 0-5 2-5 5z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'amusement_park':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 4v16M4 12h16" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'aquarium':
      return (
        <Svg {...p}>
          <Path d="M4 12c3-4 9-4 12 0-3 4-9 4-12 0z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M16 12l4-3v6z" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="8" cy="11" r="0.9" fill={color} />
        </Svg>
      );
    case 'zoo':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="13" r="5" stroke={color} strokeWidth={1.6} {...S} /><Path d="M8 8l-1-3 3 1M16 8l1-3-3 1" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'water_park':
      return (
        <Svg {...p}>
          <Path d="M4 9h9a4 4 0 010 8H8" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 20c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'campground':
      return (
        <Svg {...p}>
          <Path d="M12 4L4 20h16z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 12l-4 8M12 12l4 8" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'rv_park':
      return (
        <Svg {...p}>
          <Path d="M3 8h13a5 5 0 015 5v3H3z" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="8" cy="18" r="1.8" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'golf_course':
      return (
        <Svg {...p}>
          <Path d="M11 20V4l8 4-8 4" stroke={color} strokeWidth={1.6} {...S} /><Path d="M5 20h14" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'stadium':
      return (
        <Svg {...p}>
          <Path d="M4 9c0-2 3.5-3 8-3s8 1 8 3-3.5 3-8 3-8-1-8-3z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M4 9v6c0 2 3.5 3 8 3s8-1 8-3V9" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'tennis_court':
      return (
        <Svg {...p}>
          <Rect x="3" y="5" width="18" height="14" rx="1" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 5v14M3 12h18" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'bowling_alley':
      return (
        <Svg {...p}>
          <Path d="M12 3c2 0 3 3 3 7s-1 11-3 11-3-7-3-11 1-7 3-7z" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="12" cy="7" r="0.9" fill={color} />
        </Svg>
      );
    case 'casino':
      return (
        <Svg {...p}>
          <Rect x="4" y="4" width="16" height="16" rx="2" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="9" cy="9" r="1.1" fill={color} /><Circle cx="15" cy="15" r="1.1" fill={color} />
        </Svg>
      );
    case 'night_club':
      return (
        <Svg {...p}>
          <Path d="M9 18V6l10-2v12" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="7" cy="18" r="2" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="17" cy="16" r="2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'brewery':
      return (
        <Svg {...p}>
          <Path d="M6 7h9v13H6z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M15 10h3v5h-3" stroke={color} strokeWidth={1.6} {...S} /><Path d="M9 4v3M12 4v3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'winery':
      return (
        <Svg {...p}>
          <Path d="M8 4h8l-1 6a3 3 0 01-6 0z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 13v6M9 20h6" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'spa':
      return (
        <Svg {...p}>
          <Path d="M12 20c0-5 3-8 7-9-1 5-3 8-7 9z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 20c0-5-3-8-7-9 1 5 3 8 7 9z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'cemetery':
      return (
        <Svg {...p}>
          <Path d="M8 20V10a4 4 0 018 0v10z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 7V4M10 5.5h4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'church':
      return (
        <Svg {...p}>
          <Path d="M6 20V11l6-4 6 4v9z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 7V3M10 4.5h4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'mosque':
      return (
        <Svg {...p}>
          <Path d="M6 20v-7a6 6 0 0112 0v7z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 6V3" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="12" cy="5" r="1.4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'synagogue':
      return (
        <Svg {...p}>
          <Path d="M12 4l7 4v12H5V8z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 10l3 5H9zM12 16l-3-5h6z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'museum':
      return (
        <Svg {...p}>
          <Path d="M3 9l9-5 9 5" stroke={color} strokeWidth={1.6} {...S} /><Path d="M5 9v9M12 9v9M19 9v9M3 20h18" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'art_gallery':
      return (
        <Svg {...p}>
          <Rect x="4" y="4" width="16" height="16" rx="1" stroke={color} strokeWidth={1.6} {...S} /><Path d="M7 16l3.5-4.5L13 15l2-2.5 2.5 3.5z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'cultural_center':
      return (
        <Svg {...p}>
          <Path d="M4 20V8l8-4 8 4v12z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M9 20v-6h6v6" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'community_center':
      return (
        <Svg {...p}>
          <Path d="M4 20V10l8-5 8 5v10z" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="9.5" cy="14" r="1.4" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="14.5" cy="14" r="1.4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'historical_landmark':
      return (
        <Svg {...p}>
          <Path d="M4 20V8h4V5l4-2 4 2v3h4v12z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M10 20v-5h4v5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'tourist_attraction':
      return (
        <Svg {...p}>
          <Path d="M12 3l2.6 5.6 6.1.8-4.4 4.2 1.1 6-5.4-2.9L6.6 19.6l1.1-6L3.3 9.4l6.1-.8z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    // ── KAN-408 · the material that was waiting in poi_candidate ──
    case 'viewpoint':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="10" r="3" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 10c3-4 15-4 18 0-3 4-15 4-18 0z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 17v4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'waterfall':
      return (
        <Svg {...p}>
          <Path d="M7 3v10M12 3v12M17 3v10" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 18c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'river':
      return (
        <Svg {...p}>
          <Path d="M3 7c4-2 6 2 10 0s6-2 8 0" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 13c4-2 6 2 10 0s6-2 8 0" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 19c4-2 6 2 10 0s6-2 8 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'mountain':
      return (
        <Svg {...p}>
          <Path d="M3 19l6-11 4 6 2-3 6 8z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M7.5 12.5l1.5-2 1.5 2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'lake':
      return (
        <Svg {...p}>
          <Path d="M4 14c2-3 5-4 8-4s6 1 8 4c-2 3-5 4-8 4s-6-1-8-4z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M8 7l2-3 2 3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'island':
      return (
        <Svg {...p}>
          <Path d="M4 18h16" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 18V9" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 9c-3 0-5 1-6 3 2-1 4-1 6 0 2-1 4-1 6 0-1-2-3-3-6-3z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'surf_spot':
      return (
        <Svg {...p}>
          <Path d="M4 17c3-9 9-13 16-13-1 8-6 13-13 14" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 21c2-1.2 4-1.2 6 0s4 1.2 6 0 4-1.2 6 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'hot_spring':
      return (
        <Svg {...p}>
          <Path d="M4 20h16" stroke={color} strokeWidth={1.6} {...S} /><Path d="M6 20c0-4 2-6 6-6s6 2 6 6" stroke={color} strokeWidth={1.6} {...S} /><Path d="M10 9c0-1.5 2-2 2-3.5M14 9c0-1.5-2-2-2-3.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'nature_preserve':
      return (
        <Svg {...p}>
          <Path d="M12 3l8 4v6c0 4-4 7-8 8-4-1-8-4-8-8V7z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M12 16v-5M12 11c-2 0-3-1-3-3 2 0 3 1 3 3z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'plaza':
      return (
        <Svg {...p}>
          <Rect x="3" y="3" width="18" height="18" rx="1" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'bridge':
      return (
        <Svg {...p}>
          <Path d="M3 16h18" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 16c0-5 4-8 9-8s9 3 9 8" stroke={color} strokeWidth={1.6} {...S} /><Path d="M8 16v-4.5M16 16v-4.5M12 16V9" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'lighthouse':
      return (
        <Svg {...p}>
          <Path d="M9 20l1-11h4l1 11z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M10 9V6h4v3" stroke={color} strokeWidth={1.6} {...S} /><Path d="M4 6l3 1M20 6l-3 1" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'marina':
      return (
        <Svg {...p}>
          <Path d="M12 8v11" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="12" cy="5.5" r="1.8" stroke={color} strokeWidth={1.6} {...S} /><Path d="M6 13c0 4 3 6 6 6s6-2 6-6" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'theatre':
      return (
        <Svg {...p}>
          <Path d="M4 6h16v7a8 8 0 01-16 0z" stroke={color} strokeWidth={1.6} {...S} /><Path d="M9 10.5h.01M15 10.5h.01" stroke={color} strokeWidth={1.6} {...S} /><Path d="M9 15c1.8 1.5 4.2 1.5 6 0" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'music_venue':
      return (
        <Svg {...p}>
          <Path d="M9 18V6l10-2v12" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="7" cy="18" r="2" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="17" cy="16" r="2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    default:
      // Generic map-pin for custom (non-built-in) place types, and the
      // agreed fallback for any catalog type shipped before its artwork.
      return (
        <Svg {...p}>
          <Path
            d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
            stroke={color} strokeWidth={1.6} {...S}
          />
          <Circle cx="12" cy="9" r="2.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
  }
}

/**
 * Types that draw themselves and must never be remapped (KAN-412).
 *
 * The heuristics below are for UNKNOWN strings — Google/classifier types the
 * app has no icon for. Every one of these has its own hand-drawn case, and
 * every one of them was being swallowed on the way there: `..._station`
 * turned the EV charger into a bus stop, `car_wash` fell into the fuel
 * branch, `veterinary_care` matched the medical branch, `playground` matched
 * `park`, and `movie_theater` came out as a library. Eight of ten new icons
 * were unreachable.
 *
 * `florist`, `bar` and `hairdresser` are deliberately NOT here: the first two
 * have no case of their own and are meant to borrow `park` and `cafe`, and
 * un-remapping `hairdresser` would change shipped UI, which belongs to
 * whichever ticket decides salon iconography — not this one.
 */
export const SELF_DRAWN_ICON_TYPES = new Set([
  // KAN-408 — Nature and Landmarks. Without these the heuristics assigned
  // actively wrong icons: a church became a library, a beach became a park.
  'viewpoint',, 'waterfall',, 'river',
  'mountain',, 'lake',, 'island',
  'surf_spot',, 'hot_spring',, 'nature_preserve',
  'plaza',, 'bridge',, 'lighthouse',
  'marina',, 'theatre',, 'music_venue',
  'beach',, 'hiking_area',, 'botanical_garden',
  'amusement_park',, 'aquarium',, 'zoo',
  'water_park',, 'campground',, 'rv_park',
  'golf_course',, 'stadium',, 'tennis_court',
  'bowling_alley',, 'casino',, 'night_club',
  'brewery',, 'winery',, 'spa',
  'cemetery',, 'church',, 'mosque',
  'synagogue',, 'museum',, 'art_gallery',
  'cultural_center',, 'community_center',, 'historical_landmark',
  'tourist_attraction',
  'financial_service',
  'butcher', 'fishmonger', 'laundry', 'veterinary_care', 'car_wash',
  'car_rental', 'movie_theater', 'yoga_studio', 'playground',
  'electric_vehicle_charging_station',
]);

export function resolvePoiIconType(type: string): string {
  // Before GOOGLE_TYPE_ICON and before the heuristics: a type that has its
  // own icon is already the answer, and every rule past this point can only
  // move it somewhere worse.
  if (SELF_DRAWN_ICON_TYPES.has(type)) return type;

  if (GOOGLE_TYPE_ICON[type]) {
    return GOOGLE_TYPE_ICON[type];
  }

  if (type.endsWith('_restaurant')) { return 'restaurant'; }
  if (type.endsWith('_cafe') || type.endsWith('_bar')) { return 'cafe'; }
  if (type.endsWith('_store') || type.endsWith('_shop')) { return 'store'; }
  if (type.endsWith('_park') || type.endsWith('_garden')) { return 'park'; }
  if (type.endsWith('_school')) { return 'school'; }
  if (type.endsWith('_pub') || type.endsWith('_stand')) { return 'cafe'; }
  if (
    type.endsWith('_station') ||
    type.endsWith('_stop') ||
    type.endsWith('_terminal') ||
    type.endsWith('_airport')
  ) { return 'bus'; }
  if (
    type.includes('hospital') ||
    type.includes('clinic') ||
    type.includes('doctor') ||
    type.includes('dent') ||
    type.includes('medical')
  ) { return 'clinic'; }
  if (
    type.includes('salon') ||
    type.includes('spa') ||
    type.includes('beaut') ||
    type.includes('hair') ||
    type.includes('massage') ||
    type.includes('tanning') ||
    type.includes('bath')
  ) { return 'salon'; }
  if (
    type.includes('government') ||
    type.includes('police') ||
    type.includes('courthouse') ||
    type.includes('embassy') ||
    type.includes('city_hall') ||
    type.includes('fire_station')
  ) { return 'bank'; }
  if (
    type.includes('church') ||
    type.includes('temple') ||
    type.includes('mosque') ||
    type.includes('shrine') ||
    type.includes('synagogue')
  ) { return 'library'; }
  if (
    type.includes('market') ||
    type.includes('supermarket') ||
    type.includes('grocery')
  ) { return 'supermarket'; }
  if (
    type.includes('parking') ||
    type.includes('charging_station') ||
    type.includes('gas') ||
    type.includes('fuel') ||
    type.includes('rest_stop')
  ) { return 'gas'; }
  if (
    type.includes('hotel') ||
    type.includes('inn') ||
    type.includes('hostel') ||
    type.includes('lodging') ||
    type.includes('motel') ||
    type.includes('guest_house') ||
    type.includes('resort')
  ) { return 'store'; }
  if (
    type.includes('museum') ||
    type.includes('theater') ||
    type.includes('theatre') ||
    type.includes('auditorium') ||
    type.includes('opera') ||
    type.includes('philharmonic') ||
    type.includes('planetarium') ||
    type.includes('studio') ||
    type.includes('sculpture') ||
    type.includes('historical') ||
    type.includes('landmark') ||
    type.includes('monument')
  ) { return 'library'; }
  if (
    type.includes('fitness_center')
  ) { return 'gym'; }
  if (
    type.includes('center') ||
    type.includes('venue') ||
    type.includes('hall') ||
    type.includes('camp') ||
    type.includes('casino') ||
    type.includes('bowling') ||
    type.includes('golf') ||
    type.includes('karaoke') ||
    type.includes('playground') ||
    type.includes('arcade') ||
    type.includes('sports') ||
    type.includes('athletic') ||
    type.includes('swimming_pool') ||
    type.includes('tennis_court') ||
    type.includes('fishing') ||
    type.includes('race_course') ||
    type.includes('roller_coaster') ||
    type.includes('ferris_wheel') ||
    type.includes('observation_deck') ||
    type.includes('plaza') ||
    type.includes('beach') ||
    type.includes('island') ||
    type.includes('lake') ||
    type.includes('river') ||
    type.includes('mountain') ||
    type.includes('woods') ||
    type.includes('nature_preserve') ||
    type.includes('fountain') ||
    type.includes('vineyard')
  ) { return 'park'; }
  if (
    type.includes('academic_department') ||
    type.includes('educational_institution') ||
    type.includes('school_district')
  ) { return 'school'; }
  if (
    type.includes('apartment') ||
    type.includes('condominium') ||
    type.includes('housing_complex') ||
    type.includes('private_guest_room') ||
    type.includes('camping_cabin') ||
    type.includes('cottage') ||
    type.includes('farmstay')
  ) { return 'store'; }
  if (
    type.includes('farm') ||
    type.includes('ranch') ||
    type.includes('stable') ||
    type.includes('manufacturer') ||
    type.includes('supplier') ||
    type.includes('factory')
  ) { return 'store'; }
  if (
    type.includes('service') ||
    type.includes('agency') ||
    type.includes('consultant') ||
    type.includes('organization') ||
    type.includes('provider') ||
    type.includes('lawyer') ||
    type.includes('electrician') ||
    type.includes('plumber') ||
    type.includes('contractor') ||
    type.includes('tailor') ||
    type.includes('tour_') ||
    type.includes('travel_') ||
    type.includes('child_care') ||
    type.includes('employment')
  ) { return 'bank'; }

  return type;
}

export function FoodTypeIcon({ color, size = 24 }: IconProps) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' };
  return (
    <Svg {...p}>
      <Path d="M5 10h14v1.5a7 7 0 0 1-14 0V10z" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M7 18h10" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M8 7c1.2-1 2.4-1 3.6 0M12.4 7c1.2-1 2.4-1 3.6 0" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M4 10h16" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}
