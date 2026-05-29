// US/Canadian state constants & helpers
// Pure module — no init() needed.

// Sales-tax nexus states (true = state also taxes freight charges)
// taxFreight: true  = state taxes separately stated freight on taxable sales
// taxFreight: false = state exempts separately stated freight charges
// Source: https://www.taxjar.com/sales-tax/sales-tax-and-shipping (2025)
//
// fallbackZip: a well-known-valid ZIP in each state's largest commercial
// market. Used by lib/taxjar.js when TaxJar rejects the rep-entered ZIP
// with "to_zip X is not used within to_state Y" — we retry with this
// ZIP so the rep at least gets a city/state-level rate to work from.
// The returned rate reflects whatever local surtax that fallback ZIP
// carries (e.g. FL 33101 → 7% with Miami-Dade surtax), not necessarily
// the original delivery ZIP's exact rate.
const NEXUS_STATES = {
  CA: { taxFreight: false, fallbackZip: '90001' },  // Los Angeles
  CO: { taxFreight: false, fallbackZip: '80201' },  // Denver
  FL: { taxFreight: false, fallbackZip: '33101' },  // Miami
  GA: { taxFreight: true,  fallbackZip: '30301' },  // Atlanta
  IL: { taxFreight: false, fallbackZip: '60601' },  // Chicago
  MA: { taxFreight: false, fallbackZip: '02101' },  // Boston
  NC: { taxFreight: true,  fallbackZip: '27601' },  // Raleigh
  OH: { taxFreight: true,  fallbackZip: '43215' },  // Columbus
  PA: { taxFreight: true,  fallbackZip: '19101' },  // Philadelphia
  TN: { taxFreight: true,  fallbackZip: '37201' },  // Nashville
  TX: { taxFreight: true,  fallbackZip: '78701' },  // Austin
  VA: { taxFreight: false, fallbackZip: '23218' },  // Richmond
  WI: { taxFreight: true,  fallbackZip: '53201' },  // Milwaukee
  WA: { taxFreight: true,  fallbackZip: '98101' },  // Seattle
};

const STATE_ABBR_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
  'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
  'west virginia':'WV','wisconsin':'WI','wyoming':'WY','washington dc':'DC',
  'alberta':'AB','british columbia':'BC','manitoba':'MB','new brunswick':'NB',
  'newfoundland and labrador':'NL','newfoundland':'NL','nova scotia':'NS',
  'ontario':'ON','prince edward island':'PE','quebec':'QC','saskatchewan':'SK',
};

const STATE_FULL_NAME = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
  'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
  'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire',
  'NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina',
  'ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania',
  'RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee',
  'TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington',
  'WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','DC':'Washington DC',
  'AB':'Alberta','BC':'British Columbia','MB':'Manitoba','NB':'New Brunswick',
  'NL':'Newfoundland and Labrador','NS':'Nova Scotia','ON':'Ontario',
  'PE':'Prince Edward Island','QC':'Quebec','SK':'Saskatchewan',
};

// Always returns 2-letter abbreviation - used for freight/tax APIs
function toStateAbbr(val) {
  if (!val) return '';
  const trimmed = val.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_ABBR_MAP[trimmed.toLowerCase()] || trimmed.toUpperCase();
}

// Always returns full name - used for HubSpot contact creation
function toStateFull(val) {
  if (!val) return '';
  const trimmed = val.trim();
  if (trimmed.length > 2) {
    const lower = trimmed.toLowerCase();
    const abbr = STATE_ABBR_MAP[lower];
    if (abbr) return STATE_FULL_NAME[abbr] || trimmed;
    return trimmed;
  }
  const upper = trimmed.toUpperCase();
  return STATE_FULL_NAME[upper] || trimmed;
}

function isCanadianProvince(stateAbbr) {
  const CA_PROVINCES = new Set(['AB','BC','MB','NB','NL','NS','ON','PE','QC','SK','NT','NU','YT']);
  return CA_PROVINCES.has((stateAbbr || '').toUpperCase().trim());
}

// ZIP-3 prefix → US state. Used by lib/taxjar.js to derive a state
// when the rep has entered just a ZIP code (the convenience flow on
// the Quote Builder). Ranges follow USPS Sectional Center Facility
// assignments. A handful of ZIPs span state lines; for nexus-state
// sales-tax purposes that's negligible — the next call still hits
// TaxJar with the real ZIP, which corrects the rate at the city level.
// Non-state territories (PR/military APO/etc.) intentionally omitted —
// they have no US sales-tax nexus.
const ZIP3_RANGES = [
  [   5,   5, 'NY' ], // Holtsville (PO boxes)
  [  10,  27, 'MA' ], [  28,  29, 'RI' ], [  30,  38, 'NH' ], [  39,  49, 'ME' ],
  [  50,  59, 'VT' ], [  60,  69, 'CT' ], [  70,  89, 'NJ' ],
  [ 100, 149, 'NY' ], [ 150, 196, 'PA' ], [ 197, 199, 'DE' ],
  [ 200, 205, 'DC' ], [ 206, 219, 'MD' ], [ 220, 246, 'VA' ], [ 247, 268, 'WV' ],
  [ 270, 289, 'NC' ], [ 290, 299, 'SC' ],
  [ 300, 319, 'GA' ], [ 320, 349, 'FL' ], [ 350, 369, 'AL' ], [ 370, 385, 'TN' ],
  [ 386, 397, 'MS' ], [ 398, 399, 'GA' ],
  [ 400, 427, 'KY' ], [ 430, 459, 'OH' ], [ 460, 479, 'IN' ], [ 480, 499, 'MI' ],
  [ 500, 528, 'IA' ], [ 530, 549, 'WI' ], [ 550, 567, 'MN' ],
  [ 570, 577, 'SD' ], [ 580, 588, 'ND' ], [ 590, 599, 'MT' ],
  [ 600, 629, 'IL' ], [ 630, 658, 'MO' ], [ 660, 679, 'KS' ], [ 680, 693, 'NE' ],
  [ 700, 714, 'LA' ], [ 716, 729, 'AR' ], [ 730, 749, 'OK' ], [ 750, 799, 'TX' ],
  [ 800, 816, 'CO' ], [ 820, 831, 'WY' ], [ 832, 838, 'ID' ], [ 840, 847, 'UT' ],
  [ 850, 865, 'AZ' ], [ 870, 884, 'NM' ], [ 889, 898, 'NV' ],
  [ 900, 961, 'CA' ], [ 967, 968, 'HI' ],
  [ 970, 979, 'OR' ], [ 980, 994, 'WA' ], [ 995, 999, 'AK' ],
];

function zipToState(zip) {
  if (!zip) return '';
  const trimmed = String(zip).trim();
  // Accept only well-formed US ZIPs (5 digits, optionally +4). This
  // rejects Canadian postal codes like "M5V 1A1" which happen to
  // contain digits and would otherwise false-match into a US range.
  if (!/^\d{5}(-\d{4})?$/.test(trimmed)) return '';
  const prefix = parseInt(trimmed.slice(0, 3), 10);
  if (isNaN(prefix)) return '';
  for (const [min, max, st] of ZIP3_RANGES) {
    if (prefix >= min && prefix <= max) return st;
  }
  return '';
}

module.exports = {
  NEXUS_STATES,
  STATE_ABBR_MAP,
  STATE_FULL_NAME,
  toStateAbbr,
  toStateFull,
  isCanadianProvince,
  zipToState,
};
