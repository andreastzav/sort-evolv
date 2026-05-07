import { toPositiveInt } from "./numeric_utils_core.js";

const MAGIC_BYTES = Object.freeze([0x46, 0x54, 0x42, 0x4c]); // FTBL
const CURRENT_FORMAT_VERSION = 2;

const HEADER_V2_BYTE_LENGTH = 13; // magic(4) + version(1) + rowCount(4) + schemaLen(4)
const ROW_BYTE_LENGTH = 28;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_EPOCH_UTC_MS = Date.UTC(1970, 0, 1);
const MAX_UINT16 = 65535;
const MAX_UINT32 = 0xffffffff;

const DICTIONARY_ORDER = Object.freeze(["firstName", "lastName", "city", "segment"]);

const COLUMN_KEYS = Object.freeze([
  "index",
  "firstName",
  "lastName",
  "age",
  "city",
  "date",
  "segment",
  "cohort",
  "randomA",
  "randomB",
]);

const DEFAULT_EMBEDDED_SCHEMA = Object.freeze({
  format: "FTBL",
  schemaVersion: 1,
  endianness: "little",
  rowByteLength: ROW_BYTE_LENGTH,
  dictionaryColumns: DICTIONARY_ORDER.slice(),
  columns: [
    { key: "index", type: "uint32", offset: 0 },
    { key: "firstName", type: "dict:uint16", offset: 4 },
    { key: "lastName", type: "dict:uint16", offset: 6 },
    { key: "age", type: "uint8", offset: 8 },
    { key: "city", type: "dict:uint16", offset: 10 },
    { key: "date", type: "days:int32", offset: 12, epoch: "1970-01-01" },
    { key: "segment", type: "dict:uint16", offset: 16 },
    { key: "cohort", type: "uint16", offset: 18 },
    { key: "randomA", type: "uint32", offset: 20 },
    { key: "randomB", type: "uint32", offset: 24 },
  ],
});

function toUInt32(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback >>> 0;
  }

  return Math.floor(parsed) >>> 0;
}

function toUInt16(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback & 0xffff;
  }

  const normalized = Math.floor(parsed);
  return Math.min(MAX_UINT16, normalized) & 0xffff;
}

function toUInt8(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback & 0xff;
  }

  const normalized = Math.floor(parsed);
  return Math.min(255, normalized) & 0xff;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}

function normalizeDateString(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "1970-01-01";
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function isoDateToDayNumber(value) {
  const normalizedIso = normalizeDateString(value);
  const parsed = Date.parse(`${normalizedIso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.floor((parsed - DATE_EPOCH_UTC_MS) / DAY_MS);
}

function dayNumberToIsoDate(dayNumber) {
  const numericDay = Number.isFinite(dayNumber) ? dayNumber : 0;
  const timestamp = DATE_EPOCH_UTC_MS + numericDay * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createStringDictionary(rows, key) {
  const values = [];
  const valueToId = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const value = normalizeString(row[key]);
    if (valueToId.has(value)) {
      continue;
    }

    if (values.length >= MAX_UINT16) {
      throw new Error(`Dictionary overflow for ${key}: more than ${MAX_UINT16} unique values.`);
    }

    valueToId.set(value, values.length);
    values.push(value);
  }

  return {
    values,
    valueToId,
  };
}

function encodeDictionaryValues(values, textEncoder, key) {
  const encodedValues = new Array(values.length);
  let totalBytes = 0;

  for (let i = 0; i < values.length; i += 1) {
    const encoded = textEncoder.encode(values[i]);
    if (encoded.length > MAX_UINT16) {
      throw new Error(`Dictionary value too large for ${key} at index ${i}.`);
    }

    encodedValues[i] = encoded;
    totalBytes += 2 + encoded.length;
  }

  return {
    encodedValues,
    totalBytes,
  };
}

function writeDictionary(view, offset, encodedValues) {
  let cursor = offset;

  for (let i = 0; i < encodedValues.length; i += 1) {
    const bytes = encodedValues[i];
    view.setUint16(cursor, bytes.length, true);
    cursor += 2;

    new Uint8Array(view.buffer, view.byteOffset + cursor, bytes.length).set(bytes);
    cursor += bytes.length;
  }

  return cursor;
}

function readDictionary(view, textDecoder, offset, count, key) {
  const values = new Array(count);
  let cursor = offset;

  for (let i = 0; i < count; i += 1) {
    if (cursor + 2 > view.byteLength) {
      throw new Error(`Corrupt dictionary header for ${key} at entry ${i}.`);
    }

    const byteLength = view.getUint16(cursor, true);
    cursor += 2;

    if (cursor + byteLength > view.byteLength) {
      throw new Error(`Corrupt dictionary payload for ${key} at entry ${i}.`);
    }

    const bytes = new Uint8Array(view.buffer, view.byteOffset + cursor, byteLength);
    values[i] = textDecoder.decode(bytes);
    cursor += byteLength;
  }

  return {
    values,
    nextOffset: cursor,
  };
}

function normalizeBinaryInput(binaryInput) {
  if (binaryInput instanceof Uint8Array) {
    return binaryInput;
  }

  if (binaryInput instanceof ArrayBuffer) {
    return new Uint8Array(binaryInput);
  }

  if (ArrayBuffer.isView(binaryInput)) {
    return new Uint8Array(
      binaryInput.buffer,
      binaryInput.byteOffset,
      binaryInput.byteLength
    );
  }

  throw new TypeError("Expected binary input to be Uint8Array, ArrayBuffer, or typed array.");
}

function buildSchema(options = {}) {
  const baseSchema = JSON.parse(JSON.stringify(DEFAULT_EMBEDDED_SCHEMA));

  if (options.schema && typeof options.schema === "object") {
    const customSchema = options.schema;
    for (const key in customSchema) {
      if (Object.prototype.hasOwnProperty.call(customSchema, key)) {
        baseSchema[key] = customSchema[key];
      }
    }
  }

  baseSchema.dictionaryColumns = Array.isArray(baseSchema.dictionaryColumns)
    ? baseSchema.dictionaryColumns.slice()
    : DICTIONARY_ORDER.slice();

  return baseSchema;
}

function buildDictionaries(rows, dictionaryColumns) {
  const dictionaries = Object.create(null);
  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    const key = dictionaryColumns[i];
    dictionaries[key] = createStringDictionary(rows, key);
  }

  return dictionaries;
}

function assertValidRowsInput(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Expected rows to be an array.");
  }

  if (rows.length > MAX_UINT32) {
    throw new Error("Row count exceeds format limit (uint32).");
  }

  return rows;
}

function decodeRowsFromBody(view, offset, rowCount, dictionariesByKey) {
  const rows = new Array(rowCount);
  let cursor = offset;

  for (let i = 0; i < rowCount; i += 1) {
    const index = view.getUint32(cursor, true);
    cursor += 4;
    const firstNameId = view.getUint16(cursor, true);
    cursor += 2;
    const lastNameId = view.getUint16(cursor, true);
    cursor += 2;
    const age = view.getUint8(cursor);
    cursor += 1;
    cursor += 1; // reserved byte
    const cityId = view.getUint16(cursor, true);
    cursor += 2;
    const dateDay = view.getInt32(cursor, true);
    cursor += 4;
    const segmentId = view.getUint16(cursor, true);
    cursor += 2;
    const cohort = view.getUint16(cursor, true);
    cursor += 2;
    const randomA = view.getUint32(cursor, true);
    cursor += 4;
    const randomB = view.getUint32(cursor, true);
    cursor += 4;

    rows[i] = {
      index,
      firstName: dictionariesByKey.firstName[firstNameId] ?? "",
      lastName: dictionariesByKey.lastName[lastNameId] ?? "",
      age,
      city: dictionariesByKey.city[cityId] ?? "",
      date: dayNumberToIsoDate(dateDay),
      segment: dictionariesByKey.segment[segmentId] ?? "",
      cohort,
      randomA,
      randomB,
    };
  }

  return {
    rows,
    nextOffset: cursor,
  };
}

function decodeVersion2(bytes, view) {
  const rowCount = view.getUint32(5, true);
  const schemaByteLength = view.getUint32(9, true);

  const schemaStart = HEADER_V2_BYTE_LENGTH;
  const schemaEnd = schemaStart + schemaByteLength;
  if (schemaEnd > view.byteLength) {
    throw new Error("Binary payload is truncated for schema block.");
  }

  const schemaBytes = new Uint8Array(view.buffer, view.byteOffset + schemaStart, schemaByteLength);
  const schemaText = new TextDecoder().decode(schemaBytes);
  let schema = null;
  try {
    schema = JSON.parse(schemaText);
  } catch (error) {
    throw new Error("Failed to parse embedded schema JSON.");
  }

  const dictionaryColumns =
    schema && Array.isArray(schema.dictionaryColumns) && schema.dictionaryColumns.length > 0
      ? schema.dictionaryColumns.slice()
      : DICTIONARY_ORDER.slice();

  let offset = schemaEnd;
  const dictionaryCounts = Object.create(null);
  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    if (offset + 2 > view.byteLength) {
      throw new Error("Binary payload is truncated for dictionary count table.");
    }

    const key = dictionaryColumns[i];
    dictionaryCounts[key] = view.getUint16(offset, true);
    offset += 2;
  }

  const textDecoder = new TextDecoder();
  const dictionariesByKey = Object.create(null);
  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    const key = dictionaryColumns[i];
    const dictionary = readDictionary(
      view,
      textDecoder,
      offset,
      dictionaryCounts[key],
      key
    );
    dictionariesByKey[key] = dictionary.values;
    offset = dictionary.nextOffset;
  }

  for (let i = 0; i < DICTIONARY_ORDER.length; i += 1) {
    const requiredKey = DICTIONARY_ORDER[i];
    if (!Array.isArray(dictionariesByKey[requiredKey])) {
      dictionariesByKey[requiredKey] = [];
    }
  }

  const expectedTotalBytes = offset + rowCount * ROW_BYTE_LENGTH;
  if (expectedTotalBytes > view.byteLength) {
    throw new Error("Binary payload is truncated for declared row count.");
  }

  const decoded = decodeRowsFromBody(view, offset, rowCount, dictionariesByKey);

  return {
    rows: decoded.rows,
    rowCount,
    byteLength: bytes.byteLength,
    version: CURRENT_FORMAT_VERSION,
    schema,
    dictionaries: {
      firstName: dictionariesByKey.firstName,
      lastName: dictionariesByKey.lastName,
      city: dictionariesByKey.city,
      segment: dictionariesByKey.segment,
    },
    columns: COLUMN_KEYS.slice(),
  };
}

export function encodeRowsToBinary(rows, options = {}) {
  const sourceRows = assertValidRowsInput(rows);
  const textEncoder = new TextEncoder();
  const rowCount = sourceRows.length;

  const schema = buildSchema(options);
  const schemaBytes = textEncoder.encode(JSON.stringify(schema));
  if (schemaBytes.byteLength > MAX_UINT32) {
    throw new Error("Schema block is too large for format limits.");
  }

  const dictionaryColumns =
    Array.isArray(schema.dictionaryColumns) && schema.dictionaryColumns.length > 0
      ? schema.dictionaryColumns.slice()
      : DICTIONARY_ORDER.slice();
  const dictionaries = buildDictionaries(sourceRows, dictionaryColumns);

  const encodedDictionaries = Object.create(null);
  let dictionaryPayloadByteLength = 0;
  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    const key = dictionaryColumns[i];
    const encoded = encodeDictionaryValues(dictionaries[key].values, textEncoder, key);
    encodedDictionaries[key] = encoded;
    dictionaryPayloadByteLength += encoded.totalBytes;
  }

  const dictionaryCountTableByteLength = dictionaryColumns.length * 2;
  const totalBytes =
    HEADER_V2_BYTE_LENGTH +
    schemaBytes.byteLength +
    dictionaryCountTableByteLength +
    dictionaryPayloadByteLength +
    rowCount * ROW_BYTE_LENGTH;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  // Header V2
  view.setUint8(0, MAGIC_BYTES[0]);
  view.setUint8(1, MAGIC_BYTES[1]);
  view.setUint8(2, MAGIC_BYTES[2]);
  view.setUint8(3, MAGIC_BYTES[3]);
  view.setUint8(4, CURRENT_FORMAT_VERSION);
  view.setUint32(5, rowCount, true);
  view.setUint32(9, schemaBytes.byteLength, true);

  let offset = HEADER_V2_BYTE_LENGTH;
  new Uint8Array(view.buffer, view.byteOffset + offset, schemaBytes.byteLength).set(schemaBytes);
  offset += schemaBytes.byteLength;

  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    const key = dictionaryColumns[i];
    view.setUint16(offset, dictionaries[key].values.length, true);
    offset += 2;
  }

  for (let i = 0; i < dictionaryColumns.length; i += 1) {
    const key = dictionaryColumns[i];
    offset = writeDictionary(view, offset, encodedDictionaries[key].encodedValues);
  }

  for (let i = 0; i < rowCount; i += 1) {
    const row = sourceRows[i] || {};

    const indexValue = toUInt32(row.index, i + 1);
    const firstNameValue = normalizeString(row.firstName);
    const lastNameValue = normalizeString(row.lastName);
    const cityValue = normalizeString(row.city);
    const segmentValue = normalizeString(row.segment);

    const firstNameId = dictionaries.firstName.valueToId.get(firstNameValue);
    const lastNameId = dictionaries.lastName.valueToId.get(lastNameValue);
    const cityId = dictionaries.city.valueToId.get(cityValue);
    const segmentId = dictionaries.segment.valueToId.get(segmentValue);

    const ageValue = toUInt8(row.age, 0);
    const dateDay = isoDateToDayNumber(row.date);
    const cohortValue = toUInt16(row.cohort, 0);
    const randomAValue = toUInt32(row.randomA, 0);
    const randomBValue = toUInt32(row.randomB, 0);

    view.setUint32(offset, indexValue, true);
    offset += 4;
    view.setUint16(offset, firstNameId, true);
    offset += 2;
    view.setUint16(offset, lastNameId, true);
    offset += 2;
    view.setUint8(offset, ageValue);
    offset += 1;
    view.setUint8(offset, 0); // reserved
    offset += 1;
    view.setUint16(offset, cityId, true);
    offset += 2;
    view.setInt32(offset, dateDay, true);
    offset += 4;
    view.setUint16(offset, segmentId, true);
    offset += 2;
    view.setUint16(offset, cohortValue, true);
    offset += 2;
    view.setUint32(offset, randomAValue, true);
    offset += 4;
    view.setUint32(offset, randomBValue, true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

export function decodeTableBinary(binaryInput) {
  const bytes = normalizeBinaryInput(binaryInput);
  if (bytes.byteLength < 5) {
    throw new Error("Binary payload is too small to contain a valid header.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (view.getUint8(i) !== MAGIC_BYTES[i]) {
      throw new Error("Invalid binary table magic header.");
    }
  }

  const version = view.getUint8(4);
  if (version === CURRENT_FORMAT_VERSION) {
    if (bytes.byteLength < HEADER_V2_BYTE_LENGTH) {
      throw new Error("Binary payload is too small for FTBL v2 header.");
    }

    return decodeVersion2(bytes, view);
  }

  throw new Error(`Unsupported binary format version: ${version}.`);
}

export function createBinaryTableFileName(rowCount, options = {}) {
  const safePrefix =
    typeof options.prefix === "string" && options.prefix.trim() !== ""
      ? options.prefix.trim()
      : "table";
  const countPart = toPositiveInt(rowCount, 0);

  return `${safePrefix}-${countPart || "rows"}.bin`;
}

export function formatByteCount(byteCount) {
  const value = Number(byteCount);
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(2)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}
