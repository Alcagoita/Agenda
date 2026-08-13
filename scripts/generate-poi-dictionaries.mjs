import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const typesPath = path.join(repoRoot, 'src/constants/googlePlaceTypes.ts');
const mapsPath = path.join(repoRoot, 'src/services/maps.ts');
const outEnPath = path.join(repoRoot, 'src/constants/poiDictionary.en.json');
const outPtPath = path.join(repoRoot, 'src/constants/poiDictionary.pt-PT.json');

function titleCase(value) {
  return value.replace(/\b\w/g, letter => letter.toUpperCase());
}

function humanizeType(type) {
  return titleCase(type.replace(/_/g, ' ')).replace(/\bRv\b/g, 'RV');
}

function extractQuotedValues(source, anchor) {
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(`Could not find anchor "${anchor}" while generating POI dictionaries.`);
  }
  const end = source.indexOf('];', start);
  if (end === -1) {
    throw new Error(`Could not find closing delimiter for "${anchor}" while generating POI dictionaries.`);
  }
  const body = source.slice(start, end);
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function extractEnglishOverrides(source) {
  const start = source.indexOf('export const PLACE_TYPE_LABELS');
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  const entries = [...body.matchAll(/^\s*([a-z0-9_]+):\s+'([^']+)'/gm)];
  return Object.fromEntries(entries.map(([, key, value]) => [key, value]));
}

const TOKEN_PT = {
  academic: 'académico',
  acai: 'acai',
  accounting: 'contabilidade',
  adventure: 'aventura',
  african: 'africano',
  afghani: 'afegão',
  aircraft: 'aeronaves',
  airport: 'aeroporto',
  airstrip: 'pista de aterragem',
  alley: 'alameda',
  american: 'americano',
  amphitheatre: 'anfiteatro',
  amusement: 'diversões',
  and: 'e',
  apartment: 'apartamentos',
  aquatic: 'aquático',
  aquarium: 'aquário',
  arab: 'árabe',
  area: 'área',
  argentinian: 'argentino',
  art: 'arte',
  arts: 'artes',
  asian: 'asiático',
  association: 'associação',
  astrologer: 'astrólogo',
  athletic: 'atlético',
  auditorium: 'auditório',
  australian: 'australiano',
  austrian: 'austríaco',
  auto: 'automóvel',
  automotive: 'automóvel',
  bagel: 'bagels',
  bakery: 'padaria',
  banquet: 'banquetes',
  bank: 'banco',
  barbecue: 'churrasco',
  barbershop: 'barbearia',
  barber: 'barbeiro',
  basque: 'basco',
  bath: 'banho',
  bathroom: 'casa de banho',
  bavarian: 'bávaro',
  beach: 'praia',
  bed: 'cama',
  belgian: 'belga',
  bistro: 'bistrô',
  bike: 'bicicletas',
  bicycle: 'bicicletas',
  boarding: 'acolhimento',
  body: 'corpo',
  book: 'livros',
  botanical: 'botânico',
  bowling: 'bowling',
  breakfast: 'pequeno-almoço',
  brewery: 'cervejaria',
  bridge: 'ponte',
  british: 'britânico',
  brunch: 'brunch',
  buddhist: 'budista',
  buffet: 'buffet',
  building: 'edifício',
  burrito: 'burritos',
  bus: 'autocarro',
  business: 'negócios',
  butcher: 'talho',
  cake: 'bolos',
  cambodian: 'cambojano',
  camp: 'campo',
  campground: 'parque de campismo',
  camping: 'campismo',
  canadian: 'canadiano',
  candy: 'doces',
  cantonese: 'cantonesa',
  car: 'carro',
  care: 'cuidados',
  caribbean: 'caribenho',
  castle: 'castelo',
  cat: 'gatos',
  catering: 'catering',
  cafe: 'café',
  cafeteria: 'cafeteria',
  center: 'centro',
  centre: 'centro',
  cemetery: 'cemitério',
  charging: 'carregamento',
  charter: 'charter',
  chauffeur: 'motorista',
  check: 'controlo',
  chicken: 'frango',
  childcare: 'apoio infantil',
  childrens: 'infantil',
  chilean: 'chileno',
  chinese: 'chinês',
  chiropractic: 'quiroprática',
  chocolate: 'chocolate',
  church: 'igreja',
  city: 'cidade',
  civic: 'cívico',
  clinic: 'clínica',
  clothing: 'roupa',
  club: 'clube',
  coastal: 'costeiro',
  cocktail: 'cocktails',
  coffee: 'café',
  college: 'faculdade',
  colombian: 'colombiano',
  comedy: 'comédia',
  community: 'comunitário',
  complex: 'complexo',
  confectionery: 'confeitaria',
  consultant: 'consultoria',
  convention: 'convenções',
  convenience: 'conveniência',
  corporate: 'empresarial',
  cosmetics: 'cosmética',
  cottage: 'cottage',
  country: 'país',
  courier: 'estafetas',
  course: 'pista',
  court: 'tribunal',
  courthouse: 'tribunal',
  coworking: 'coworking',
  cuban: 'cubano',
  cultural: 'cultural',
  curry: 'caril',
  cycling: 'ciclismo',
  czech: 'checo',
  dance: 'dança',
  danish: 'dinamarquês',
  dealer: 'concessionário',
  delivery: 'entregas',
  dental: 'dentário',
  department: 'departamento',
  dessert: 'sobremesas',
  destination: 'destino',
  diner: 'diner',
  dim: 'dim',
  discount: 'desconto',
  district: 'distrito',
  dog: 'cães',
  donut: 'donuts',
  dormitory: 'dormitório',
  doctor: 'médico',
  drugstore: 'farmácia',
  dumpling: 'dumplings',
  dutch: 'neerlandês',
  eastern: 'oriental',
  educational: 'educativo',
  egyptian: 'egípcio',
  electric: 'elétrico',
  electronics: 'eletrónica',
  embassy: 'embaixada',
  employment: 'emprego',
  entertainment: 'entretenimento',
  event: 'eventos',
  european: 'europeu',
  ev: 'veículos elétricos',
  exhibit: 'exposição',
  extended: 'estadias prolongadas',
  family: 'familiar',
  farm: 'quinta',
  farmers: 'agricultores',
  farmstay: 'turismo rural',
  fast: 'rápida',
  ferry: 'ferry',
  field: 'campo',
  filipino: 'filipino',
  finance: 'finanças',
  fine: 'alta cozinha',
  fire: 'bombeiros',
  fishing: 'pesca',
  fitness: 'fitness',
  flea: 'feira da ladra',
  flight: 'voo',
  florist: 'florista',
  food: 'comida',
  foot: 'pés',
  fountain: 'fonte',
  french: 'francês',
  fusion: 'fusão',
  furniture: 'mobiliário',
  garden: 'jardim',
  general: 'geral',
  german: 'alemão',
  gift: 'presentes',
  go: 'go',
  golf: 'golfe',
  government: 'governo',
  greek: 'grego',
  grocery: 'mercearia',
  grill: 'grelhados',
  guest: 'hóspedes',
  gym: 'ginásio',
  gyro: 'gyros',
  hall: 'salão',
  halal: 'halal',
  hamburger: 'hambúrgueres',
  hardware: 'ferragens',
  hawaiian: 'havaiano',
  health: 'saudável',
  heliport: 'heliporto',
  hindu: 'hindu',
  historical: 'histórico',
  history: 'história',
  hiking: 'caminhadas',
  home: 'casa',
  hostel: 'hostel',
  hot: 'quente',
  hotel: 'hotel',
  house: 'casa',
  housing: 'habitação',
  hungarian: 'húngaro',
  hypermarket: 'hipermercado',
  ice: 'gelado',
  indian: 'indiano',
  indonesian: 'indonésio',
  indoor: 'interior',
  inn: 'estalagem',
  insurance: 'seguros',
  institute: 'instituto',
  internet: 'internet',
  international: 'internacional',
  irish: 'irlandês',
  island: 'ilha',
  israeli: 'israelita',
  italian: 'italiano',
  japanese: 'japonês',
  jewelry: 'joalharia',
  juice: 'sumos',
  karaoke: 'karaoke',
  kebab: 'kebab',
  korean: 'coreano',
  lab: 'laboratório',
  lake: 'lago',
  landmark: 'marco',
  laundry: 'lavandaria',
  latin: 'latino',
  lebanese: 'libanês',
  library: 'biblioteca',
  light: 'ligeiro',
  liquor: 'bebidas',
  live: 'ao vivo',
  local: 'local',
  locality: 'localidade',
  locksmith: 'serralheiro',
  lodging: 'alojamento',
  lounge: 'lounge',
  malaysian: 'malaio',
  manufacturer: 'fabricante',
  marina: 'marina',
  market: 'mercado',
  massage: 'massagens',
  materials: 'materiais',
  medical: 'médico',
  mediterranean: 'mediterrânico',
  memorial: 'memorial',
  mexican: 'mexicano',
  middle: 'médio',
  miniature: 'miniatura',
  mobile: 'móvel',
  monastery: 'mosteiro',
  mongolian: 'mongol',
  monument: 'monumento',
  moroccan: 'marroquino',
  mosque: 'mesquita',
  motel: 'motel',
  mountain: 'montanha',
  movie: 'cinema',
  moving: 'mudanças',
  museum: 'museu',
  music: 'música',
  nail: 'unhas',
  national: 'nacional',
  nature: 'natureza',
  neighborhood: 'bairro',
  night: 'noturno',
  nonprofit: 'sem fins lucrativos',
  noodle: 'noodles',
  north: 'norte',
  office: 'escritório',
  opera: 'ópera',
  order: 'pedido',
  organization: 'organização',
  outdoor: 'ao ar livre',
  oyster: 'ostras',
  paintball: 'paintball',
  painter: 'pintor',
  pakistani: 'paquistanês',
  park: 'parque',
  parking: 'estacionamento',
  parts: 'peças',
  pastry: 'pastelaria',
  pediatric: 'pediátrico',
  performing: 'performativas',
  persian: 'persa',
  pet: 'animais',
  pharmacy: 'farmácia',
  philharmonic: 'filarmónica',
  photo: 'fotografia',
  physiotherapist: 'fisioterapeuta',
  picnic: 'piqueniques',
  pier: 'cais',
  pizza: 'pizza',
  playground: 'parque infantil',
  plaza: 'praça',
  plumber: 'canalizador',
  police: 'polícia',
  polish: 'polaco',
  portuguese: 'português',
  post: 'correios',
  postal: 'código postal',
  pottery: 'cerâmica',
  preschool: 'pré-escola',
  preserve: 'reserva',
  primary: 'primária',
  private: 'privado',
  psychologist: 'psicólogo',
  public: 'público',
  pub: 'pub',
  racing: 'corridas',
  ranch: 'rancho',
  ramen: 'ramen',
  real: 'imobiliário',
  recreation: 'recreação',
  regional: 'regional',
  research: 'investigação',
  resort: 'resort',
  rest: 'descanso',
  restaurant: 'restaurante',
  retail: 'retalho',
  ride: 'parque de estacionamento',
  river: 'rio',
  road: 'estrada',
  roofing: 'telhados',
  room: 'quarto',
  rowing: 'remo',
  russian: 'russo',
  rv: 'caravanas',
  salad: 'saladas',
  salon: 'salão',
  sandwich: 'sanduíches',
  sauna: 'sauna',
  scenic: 'panorâmico',
  school: 'escola',
  science: 'ciência',
  sculpture: 'escultura',
  seafood: 'marisco',
  secondary: 'secundária',
  service: 'serviço',
  shinto: 'xintoísta',
  shipping: 'envios',
  shoe: 'sapatos',
  shop: 'loja',
  shopping: 'centro comercial',
  shrine: 'santuário',
  skate: 'skate',
  skin: 'pele',
  skiing: 'esqui',
  snack: 'snacks',
  soul: 'soul',
  south: 'sul',
  southwestern: 'sudoeste',
  spa: 'spa',
  spanish: 'espanhol',
  sporting: 'desportivo',
  sports: 'desporto',
  stadium: 'estádio',
  stand: 'quiosque',
  state: 'estadual',
  station: 'estação',
  steak: 'bifes',
  stop: 'paragem',
  storage: 'armazém',
  studio: 'estúdio',
  subway: 'metro',
  summer: 'verão',
  supermarket: 'supermercado',
  supplier: 'fornecedor',
  sushi: 'sushi',
  swiss: 'suíço',
  synagogue: 'sinagoga',
  taco: 'tacos',
  taiwanese: 'taiwanês',
  takeaway: 'take-away',
  tanning: 'bronzeamento',
  tapas: 'tapas',
  taxi: 'táxi',
  tea: 'chá',
  telecommunications: 'telecomunicações',
  television: 'televisão',
  temple: 'templo',
  tennis: 'ténis',
  tex: 'tex-mex',
  thai: 'tailandês',
  theater: 'teatro',
  thrift: 'segunda mão',
  ticket: 'bilhetes',
  tire: 'pneus',
  toll: 'portagem',
  tourist: 'turístico',
  toy: 'brinquedos',
  trail: 'trilho',
  train: 'comboio',
  tram: 'elétrico',
  transit: 'transporte',
  transportation: 'transportes',
  travel: 'viagens',
  truck: 'camiões',
  turkish: 'turco',
  ukrainian: 'ucraniano',
  university: 'universidade',
  vegan: 'vegan',
  vegetarian: 'vegetariano',
  venue: 'recinto',
  veterinary: 'veterinário',
  video: 'videojogos',
  vietnamese: 'vietnamita',
  vineyard: 'vinha',
  visitor: 'visitantes',
  water: 'aquático',
  wear: 'roupa',
  wedding: 'casamentos',
  wellness: 'bem-estar',
  western: 'ocidental',
  wholesale: 'grossista',
  wildlife: 'vida selvagem',
  wine: 'vinho',
  winery: 'adega',
  womens: 'senhora',
  woods: 'bosque',
  yoga: 'ioga',
  zoo: 'jardim zoológico',
};

const PT_OVERRIDES = {
  atm: 'Multibanco',
  art_gallery: 'Galeria de arte',
  cafe: 'Café',
  supermarket: 'Mercado',
  pharmacy: 'Farmácia',
  restaurant: 'Restaurante',
  bakery: 'Padaria',
  bar: 'Bar',
  bank: 'Banco',
  beach: 'Praia',
  beauty_salon: 'Salão de beleza',
  book_store: 'Livraria',
  botanical_garden: 'Jardim botânico',
  bowling_alley: 'Bowling',
  bus_station: 'Estação de autocarros',
  bus_stop: 'Paragem de autocarro',
  campground: 'Parque de campismo',
  car_dealer: 'Concessionário automóvel',
  car_rental: 'Aluguer de carros',
  car_repair: 'Oficina automóvel',
  car_wash: 'Lavagem de carros',
  city_hall: 'Câmara municipal',
  clothing_store: 'Loja de roupa',
  coffee_shop: 'Cafetaria',
  community_center: 'Centro comunitário',
  convenience_store: 'Loja de conveniência',
  corporate_office: 'Escritório empresarial',
  country: 'País',
  courthouse: 'Tribunal',
  cultural_center: 'Centro cultural',
  dentist: 'Dentista',
  department_store: 'Loja de departamento',
  doctor: 'Médico',
  drugstore: 'Farmácia',
  electric_vehicle_charging_station: 'Posto de carregamento elétrico',
  electronics_store: 'Loja de eletrónica',
  ferry_terminal: 'Terminal de ferry',
  fire_station: 'Quartel de bombeiros',
  fitness_center: 'Centro de fitness',
  florist: 'Florista',
  furniture_store: 'Loja de mobiliário',
  gas_station: 'Posto de combustível',
  general_hospital: 'Hospital geral',
  general_store: 'Loja geral',
  gift_shop: 'Loja de presentes',
  golf_course: 'Campo de golfe',
  grocery_store: 'Mercearia',
  gym: 'Ginásio',
  hair_care: 'Cabeleireiro',
  hair_salon: 'Cabeleireiro',
  hiking_area: 'Área de caminhadas',
  historical_landmark: 'Marco histórico',
  historical_place: 'Local histórico',
  home_goods_store: 'Loja para o lar',
  hotel: 'Hotel',
  ice_cream_shop: 'Gelataria',
  insurance_agency: 'Agência de seguros',
  internet_cafe: 'Cibercafé',
  jewelry_store: 'Joalharia',
  library: 'Biblioteca',
  light_rail_station: 'Estação de metro ligeiro',
  locality: 'Localidade',
  local_government_office: 'Serviço municipal',
  lodging: 'Alojamento',
  market: 'Mercado',
  medical_center: 'Centro médico',
  medical_lab: 'Laboratório médico',
  movie_rental: 'Aluguer de filmes',
  movie_theater: 'Cinema',
  museum: 'Museu',
  nail_salon: 'Salão de unhas',
  national_park: 'Parque nacional',
  night_club: 'Discoteca',
  park: 'Parque',
  parking: 'Estacionamento',
  parking_garage: 'Garagem de estacionamento',
  parking_lot: 'Parque de estacionamento',
  pet_store: 'Loja de animais',
  physiotherapist: 'Fisioterapeuta',
  police: 'Polícia',
  post_office: 'Correios',
  primary_school: 'Escola primária',
  rv_park: 'Parque de autocaravanas',
  school: 'Escola',
  secondary_school: 'Escola secundária',
  shoe_store: 'Loja de sapatos',
  shopping_mall: 'Centro comercial',
  spa: 'Spa',
  sporting_goods_store: 'Loja de artigos desportivos',
  stadium: 'Estádio',
  store: 'Loja',
  subway_station: 'Estação de metro',
  sushi_restaurant: 'Restaurante de sushi',
  taxi_stand: 'Praça de táxis',
  tea_house: 'Casa de chá',
  tennis_court: 'Campo de ténis',
  theater: 'Teatro',
  tourist_attraction: 'Atração turística',
  train_station: 'Estação de comboios',
  transit_station: 'Estação de transportes',
  university: 'Universidade',
  veterinary_care: 'Cuidados veterinários',
  water_park: 'Parque aquático',
  yoga_studio: 'Estúdio de ioga',
  zoo: 'Jardim zoológico',
};

const CUISINE_STYLE = {
  afghani: 'afegão',
  african: 'africano',
  american: 'americano',
  argentinian: 'argentino',
  asian: 'asiático',
  asian_fusion: 'de fusão asiática',
  australian: 'australiano',
  austrian: 'austríaco',
  bangladeshi: 'bangladechiano',
  basque: 'basco',
  bavarian: 'bávaro',
  belgian: 'belga',
  brazilian: 'brasileiro',
  british: 'britânico',
  burmese: 'birmanês',
  cajun: 'cajun',
  californian: 'californiano',
  cambodian: 'cambojano',
  cantonese: 'cantonês',
  caribbean: 'caribenho',
  chicken: 'de frango',
  chinese: 'chinês',
  chinese_noodle: 'de noodles chineses',
  chilean: 'chileno',
  colombian: 'colombiano',
  croatian: 'croata',
  cuban: 'cubano',
  czech: 'checo',
  danish: 'dinamarquês',
  dessert: 'de sobremesas',
  dim_sum: 'de dim sum',
  dutch: 'neerlandês',
  eastern_european: 'da Europa de Leste',
  ethiopian: 'etíope',
  european: 'europeu',
  falafel: 'de falafel',
  family: 'familiar',
  fast_food: 'de comida rápida',
  filipino: 'filipino',
  fine_dining: 'de alta cozinha',
  fish_and_chips: 'de fish and chips',
  fondue: 'de fondue',
  french: 'francês',
  fusion: 'de fusão',
  german: 'alemão',
  greek: 'grego',
  gyro: 'de gyros',
  halal: 'halal',
  hamburger: 'de hambúrgueres',
  hawaiian: 'havaiano',
  hot_dog: 'de cachorros-quentes',
  hot_pot: 'de hot pot',
  hungarian: 'húngaro',
  indian: 'indiano',
  indonesian: 'indonésio',
  irish: 'irlandês',
  israeli: 'israelita',
  italian: 'italiano',
  japanese: 'japonês',
  japanese_curry: 'de caril japonês',
  japanese_izakaya: 'izakaya japonês',
  kebab: 'de kebab',
  korean: 'coreano',
  korean_barbecue: 'de churrasco coreano',
  latin_american: 'latino-americano',
  lebanese: 'libanês',
  malaysian: 'malaio',
  mediterranean: 'mediterrânico',
  mexican: 'mexicano',
  middle_eastern: 'do Médio Oriente',
  mongolian_barbecue: 'de churrasco mongol',
  moroccan: 'marroquino',
  noodle: 'de noodles',
  north_indian: 'do norte da Índia',
  oyster_bar: 'bar de ostras',
  pakistani: 'paquistanês',
  persian: 'persa',
  peruvian: 'peruano',
  pizza: 'de pizzas',
  polish: 'polaco',
  portuguese: 'português',
  ramen: 'de ramen',
  romanian: 'romeno',
  russian: 'russo',
  salad: 'de saladas',
  sandwich: 'de sandes',
  scandinavian: 'escandinavo',
  seafood: 'de marisco',
  shawarma: 'de shawarma',
  soul_food: 'de soul food',
  soup: 'de sopas',
  south_american: 'sul-americano',
  south_indian: 'do sul da Índia',
  southwestern_us: 'do sudoeste dos EUA',
  spanish: 'espanhol',
  sports_bar: 'sports bar',
  sri_lankan: 'cingalês',
  steak_house: 'de carnes',
  sushi: 'de sushi',
  swiss: 'suíço',
  taco: 'de tacos',
  taiwanese: 'taiwanês',
  tapas: 'de tapas',
  tex_mex: 'tex-mex',
  thai: 'tailandês',
  tibetan: 'tibetano',
  tonkatsu: 'de tonkatsu',
  turkish: 'turco',
  ukrainian: 'ucraniano',
  vegan: 'vegano',
  vegetarian: 'vegetariano',
  vietnamese: 'vietnamita',
  western: 'ocidental',
  yakiniku: 'de yakiniku',
  yakitori: 'de yakitori',
};

function tokenize(type) {
  return type.split('_').filter(Boolean);
}

function humanizePtTokens(type) {
  return tokenize(type)
    .map(token => TOKEN_PT[token] ?? token)
    .join(' ');
}

function sentenceCase(value) {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

function buildNounPhrase(type) {
  return humanizePtTokens(type).replace(/\s+/g, ' ').trim();
}

function translateType(type, enLabel) {
  if (PT_OVERRIDES[type]) { return PT_OVERRIDES[type]; }

  if (type.endsWith('_restaurant')) {
    const base = type.slice(0, -'_restaurant'.length);
    const style = CUISINE_STYLE[base];
    if (style) {
      return style.startsWith('de ') || style.startsWith('do ') || style.startsWith('da ')
        ? `Restaurante ${style}`
        : `Restaurante ${style}`;
    }
    return `Restaurante ${buildNounPhrase(base)}`;
  }

  if (type.endsWith('_shop')) {
    const base = type.slice(0, -'_shop'.length);
    return sentenceCase(`Loja de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_store')) {
    const base = type.slice(0, -'_store'.length);
    if (base === 'discount_supermarket') { return 'Supermercado de desconto'; }
    if (base === 'general') { return 'Loja geral'; }
    if (base === 'grocery') { return 'Mercearia'; }
    return sentenceCase(`Loja de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_station')) {
    const base = type.slice(0, -'_station'.length);
    return sentenceCase(`Estação de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_office')) {
    const base = type.slice(0, -'_office'.length);
    return sentenceCase(`Escritório de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_center')) {
    const base = type.slice(0, -'_center'.length);
    return sentenceCase(`Centro de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_hall')) {
    const base = type.slice(0, -'_hall'.length);
    return sentenceCase(`Salão de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_agency')) {
    const base = type.slice(0, -'_agency'.length);
    return sentenceCase(`Agência de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_service')) {
    const base = type.slice(0, -'_service'.length);
    return sentenceCase(`Serviço de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_clinic')) {
    const base = type.slice(0, -'_clinic'.length);
    return sentenceCase(`Clínica de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_park')) {
    const base = type.slice(0, -'_park'.length);
    if (!base) { return 'Parque'; }
    return sentenceCase(`Parque de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_museum')) {
    const base = type.slice(0, -'_museum'.length);
    return sentenceCase(`Museu de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_theater')) {
    const base = type.slice(0, -'_theater'.length);
    return sentenceCase(`Teatro de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_school')) {
    const base = type.slice(0, -'_school'.length);
    if (!base) { return 'Escola'; }
    return sentenceCase(`Escola de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_house')) {
    const base = type.slice(0, -'_house'.length);
    return sentenceCase(`${buildNounPhrase(base)} house`);
  }

  if (type.endsWith('_club')) {
    const base = type.slice(0, -'_club'.length);
    return sentenceCase(`Clube de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_office')) {
    const base = type.slice(0, -'_office'.length);
    return sentenceCase(`Escritório de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_garage')) {
    const base = type.slice(0, -'_garage'.length);
    return sentenceCase(`Garagem de ${buildNounPhrase(base)}`);
  }

  if (type.endsWith('_lot')) {
    const base = type.slice(0, -'_lot'.length);
    return sentenceCase(`${buildNounPhrase(base)} lot`);
  }

  if (type.endsWith('_plaza')) {
    const base = type.slice(0, -'_plaza'.length);
    return sentenceCase(`${buildNounPhrase(base)} plaza`);
  }

  if (type.endsWith('_cafe')) {
    const base = type.slice(0, -'_cafe'.length);
    return sentenceCase(`Café ${buildNounPhrase(base)}`);
  }

  const fallback = humanizePtTokens(type);
  return sentenceCase(fallback === type ? enLabel : fallback);
}

const typesSource = fs.readFileSync(typesPath, 'utf8');
const mapsSource = fs.readFileSync(mapsPath, 'utf8');
const types = extractQuotedValues(typesSource, 'export const SUPPORTED_GOOGLE_PLACE_TYPES');
const englishOverrides = extractEnglishOverrides(mapsSource);

// Brush-specific types are backed by the POI Worker rather than Google. Keep
// them in the same bundled dictionary so More Details remains fully offline.
const APP_ONLY_TYPES = {
  currency_exchange: { en: 'Currency exchange', 'pt-PT': 'Câmbio' },
  money_transfer: { en: 'Money transfer', 'pt-PT': 'Transferência de dinheiro' },
  financial_service: { en: 'Financial service', 'pt-PT': 'Serviço financeiro' },
};

const enDictionary = {};
const ptDictionary = {};

for (const type of types) {
  const enLabel = englishOverrides[type] ?? humanizeType(type);
  enDictionary[type] = enLabel;
  ptDictionary[type] = translateType(type, enLabel);
}

for (const [type, labels] of Object.entries(APP_ONLY_TYPES)) {
  enDictionary[type] = labels.en;
  ptDictionary[type] = labels['pt-PT'];
}

fs.writeFileSync(outEnPath, JSON.stringify(enDictionary, null, 2) + '\n');
fs.writeFileSync(outPtPath, JSON.stringify(ptDictionary, null, 2) + '\n');

console.log(`Wrote ${Object.keys(enDictionary).length} POI labels to ${path.relative(repoRoot, outEnPath)} and ${path.relative(repoRoot, outPtPath)}`);
