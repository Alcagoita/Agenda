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
  ice_cream_shop:       'store',
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

  // Beauty & wellness
  barber_shop:          'salon',
  beautician:           'salon',
  beauty_salon:         'salon',
  hair_care:            'salon',
  hair_salon:           'salon',
  makeup_artist:        'salon',
  nail_salon:           'salon',
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

    default:
      // Generic map-pin for custom (non-built-in) place types.
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

export function resolvePoiIconType(type: string): string {
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
