import { toPositiveInt } from "./numeric_utils_core.js";
import {
  GENERATION_PRESETS as CANONICAL_GENERATION_PRESETS,
} from "./preset_catalog_core.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_START_MS = Date.UTC(2015, 0, 1);
const DATE_END_MS = Date.UTC(2025, 11, 31);
const DATE_DAY_SPAN = Math.floor((DATE_END_MS - DATE_START_MS) / DAY_MS);

const FIRST_NAMES = Object.freeze([
  "James",
  "Mary",
  "John",
  "Patricia",
  "Robert",
  "Jennifer",
  "Michael",
  "Linda",
  "William",
  "Elizabeth",
  "David",
  "Barbara",
  "Richard",
  "Susan",
  "Joseph",
  "Jessica",
  "Thomas",
  "Sarah",
  "Charles",
  "Karen",
  "Christopher",
  "Nancy",
  "Daniel",
  "Lisa",
  "Matthew",
  "Betty",
  "Anthony",
  "Margaret",
  "Mark",
  "Sandra",
  "Donald",
  "Ashley",
  "Steven",
  "Kimberly",
  "Paul",
  "Emily",
  "Andrew",
  "Donna",
  "Joshua",
  "Michelle",
  "Kenneth",
  "Dorothy",
  "Kevin",
  "Carol",
  "Brian",
  "Amanda",
  "George",
  "Melissa",
  "Edward",
  "Deborah",
  "Jason",
  "Stephanie",
  "Ryan",
  "Sharon",
  "Jacob",
  "Cynthia",
  "Nicholas",
  "Amy",
  "Jonathan",
  "Angela",
  "Justin",
  "Brenda",
  "Scott",
  "Pamela",
  "Brandon",
  "Nicole",
  "Frank",
  "Samantha",
  "Gregory",
  "Katherine",
  "Raymond",
  "Christine",
  "Benjamin",
  "Rachel",
  "Patrick",
  "Catherine",
  "Alexander",
  "Carolyn",
  "Tyler",
  "Heather",
  "Aaron",
  "Diane",
  "Ethan",
  "Megan",
  "Austin",
  "Lauren",
  "Zachary",
  "Victoria",
  "Adam",
  "Olivia",
  "Nathan",
  "Sophia",
  "Jose",
  "Isabella",
  "Mason",
  "Aria",
  "Jayden",
  "Zoe",
  "Dylan",
  "Nora",
  "Henry",
  "Lillian",
  "Owen",
  "Addison"
]);

const LAST_NAMES = Object.freeze([
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Miller",
  "Davis",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "White",
  "Clark",
  "Lewis",
  "Robinson",
  "Walker",
  "Young",
  "Allen",
  "King",
  "Wright",
  "Scott",
  "Hill",
  "Green",
  "Adams",
  "Nelson",
  "Baker",
  "Hall",
  "Campbell",
  "Mitchell",
  "Carter",
  "Roberts",
  "Phillips",
  "Evans",
  "Turner",
  "Parker",
  "Edwards",
  "Collins",
  "Stewart",
  "Morris",
  "Murphy",
  "Cook",
  "Rogers",
  "Morgan",
  "Cooper",
  "Peterson",
  "Bailey",
  "Reed",
  "Kelly",
  "Howard",
  "Cox",
  "Ward",
  "Richardson",
  "Watson",
  "Brooks",
  "Wood",
  "Bennett",
  "Gray",
  "Hughes",
  "Price",
  "Sanders",
  "Myers",
  "Long",
  "Ross",
  "Foster",
  "Harrison",
  "Graham",
  "Fisher",
  "Grant",
  "Hart",
  "Spencer",
  "Gardner",
  "Payne",
  "Pierce",
  "Berry",
  "Matthews",
  "Arnold",
  "Wagner",
  "Willis",
  "Ray",
  "Watkins",
  "Olson",
  "Carroll",
  "Duncan",
  "Snyder",
  "Bradley",
  "Andrews",
  "Ruiz",
  "Harper",
  "Fox",
  "Armstrong",
  "Carpenter",
  "Greene",
  "Lawrence",
  "Elliott",
  "Chavez",
  "Sims",
  "Austin",
  "Peters",
  "Kelley"
]);

const CITY_PREFIXES = Object.freeze([
  "North",
  "South",
  "East",
  "West",
  "Lake",
  "Port",
  "Mount",
  "Fort",
  "Grand",
  "New",
  "Old",
  "River",
  "Clear",
  "Pine",
  "Maple",
  "Cedar",
  "Silver",
  "Golden",
  "Stone",
  "Oak"
]);

const CITY_SUFFIXES = Object.freeze([
  "Haven",
  "Point",
  "Falls",
  "Springs",
  "Heights",
  "Valley",
  "Creek",
  "Ridge",
  "Harbor",
  "Grove",
  "Plains",
  "Meadow",
  "Junction",
  "Landing",
  "Crossing",
  "Village"
]);

const CITY_CORE_NAMES = Object.freeze([
  "Aurora",
  "Bristol",
  "Concord",
  "Dover",
  "Edison",
  "Fairfield",
  "Georgetown",
  "Hudson",
  "Irving",
  "Jamestown",
  "Kingston",
  "Lexington",
  "Madison",
  "Newton",
  "Orlando",
  "Princeton",
  "Riverton",
  "Somerset",
  "Trenton",
  "Union",
  "Vernon",
  "Winchester",
  "York",
  "Zephyr"
]);

const LOW_CARDINALITY_SEGMENTS = Object.freeze([
  "consumer",
  "business",
  "enterprise",
  "public",
  "nonprofit",
  "partner"
]);

const COLUMN_DEFINITIONS = Object.freeze([
  { key: "index", label: "Index", type: "number" },
  { key: "firstName", label: "First Name", type: "string" },
  { key: "lastName", label: "Last Name", type: "string" },
  { key: "age", label: "Age", type: "number" },
  { key: "city", label: "City", type: "string" },
  { key: "date", label: "Date", type: "date" },
  { key: "segment", label: "Segment", type: "string" },
  { key: "cohort", label: "Cohort", type: "number" },
  { key: "randomA", label: "Random A", type: "number" },
  { key: "randomB", label: "Random B", type: "number" }
]);

export const COLUMN_TYPE_BY_KEY = Object.freeze(
  COLUMN_DEFINITIONS.reduce((accumulator, entry) => {
    accumulator[entry.key] = entry.type;
    return accumulator;
  }, Object.create(null))
);

export const GENERATION_PRESETS = CANONICAL_GENERATION_PRESETS;

function buildCities() {
  const cities = [];
  const seen = new Set();

  for (let i = 0; i < CITY_PREFIXES.length; i += 1) {
    for (let j = 0; j < CITY_CORE_NAMES.length; j += 1) {
      const city = `${CITY_PREFIXES[i]} ${CITY_CORE_NAMES[j]}`;
      if (!seen.has(city)) {
        seen.add(city);
        cities.push(city);
      }
    }
  }

  for (let i = 0; i < CITY_CORE_NAMES.length; i += 1) {
    for (let j = 0; j < CITY_SUFFIXES.length; j += 1) {
      const city = `${CITY_CORE_NAMES[i]} ${CITY_SUFFIXES[j]}`;
      if (!seen.has(city)) {
        seen.add(city);
        cities.push(city);
      }
    }
  }

  return Object.freeze(cities);
}

const CITY_VALUES = buildCities();

if (CITY_VALUES.length < 250) {
  throw new Error("City cardinality requirement not met: expected >= 250 values.");
}

function normalizeSeed(seed) {
  const parsed = Number(seed);
  if (!Number.isFinite(parsed)) {
    return 123456789;
  }

  return (parsed >>> 0) || 123456789;
}

function createMulberry32(seed) {
  let state = normalizeSeed(seed);
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIntInclusive(randomSource, minValue, maxValue) {
  const span = maxValue - minValue + 1;
  return minValue + Math.floor(randomSource() * span);
}

function pickOne(randomSource, values) {
  return values[Math.floor(randomSource() * values.length)];
}

function toIsoDateFromOffset(dayOffset) {
  const timestamp = DATE_START_MS + dayOffset * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createRow(index, rowCount, randomSource) {
  return {
    index,
    firstName: pickOne(randomSource, FIRST_NAMES),
    lastName: pickOne(randomSource, LAST_NAMES),
    age: randomIntInclusive(randomSource, 18, 92),
    city: pickOne(randomSource, CITY_VALUES),
    date: toIsoDateFromOffset(randomIntInclusive(randomSource, 0, DATE_DAY_SPAN)),
    segment: pickOne(randomSource, LOW_CARDINALITY_SEGMENTS),
    cohort: randomIntInclusive(randomSource, 1, 12),
    randomA: randomIntInclusive(randomSource, 1, rowCount),
    randomB: randomIntInclusive(randomSource, 1, rowCount)
  };
}

export function generateRows(rowCount, options = {}) {
  const targetCount = toPositiveInt(rowCount, 0);
  if (targetCount <= 0) {
    return [];
  }

  const startIndex = toPositiveInt(options.startIndex, 1);
  const totalRowCount = toPositiveInt(options.totalRowCount, targetCount);
  const seed = normalizeSeed(options.seed);
  const randomSource = createMulberry32(seed);
  const rows = new Array(targetCount);

  for (let i = 0; i < targetCount; i += 1) {
    rows[i] = createRow(startIndex + i, totalRowCount, randomSource);
  }

  return rows;
}

export function findGenerationPresetById(presetId) {
  for (let i = 0; i < GENERATION_PRESETS.length; i += 1) {
    if (GENERATION_PRESETS[i].id === presetId) {
      return GENERATION_PRESETS[i];
    }
  }

  return null;
}

export function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}
