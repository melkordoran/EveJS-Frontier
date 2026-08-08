const path = require("path");

const {
  TABLE,
  clearReferenceCache,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));

const CREATION_TABLES = Object.freeze([
  TABLE.CREATION_HARDPOINT_TYPES,
  TABLE.CREATION_MODULES,
  TABLE.CREATION_PARTS,
  TABLE.CREATION_TEMPLATES,
]);

let indexes = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function indexRows(tableName) {
  return new Map(
    readStaticRows(tableName)
      .map((row) => [toInt(row && (row.typeID ?? row._key), 0), row])
      .filter(([typeID]) => typeID > 0),
  );
}

function indexNamedRows(tableName) {
  return new Map(
    readStaticRows(tableName)
      .map((row) => [String(row && (row.hardpointType ?? row._key) || ""), row])
      .filter(([key]) => key.length > 0),
  );
}

function getIndexes() {
  if (!indexes) {
    indexes = {
      hardpointTypes: indexNamedRows(TABLE.CREATION_HARDPOINT_TYPES),
      modules: indexRows(TABLE.CREATION_MODULES),
      parts: indexRows(TABLE.CREATION_PARTS),
      templates: indexRows(TABLE.CREATION_TEMPLATES),
    };
  }
  return indexes;
}

function getCreationHardpointType(typeID) {
  return cloneValue(getIndexes().hardpointTypes.get(String(typeID || "")) || null);
}

function getCreationModule(typeID) {
  return cloneValue(getIndexes().modules.get(toInt(typeID, 0)) || null);
}

function getCreationPart(typeID) {
  return cloneValue(getIndexes().parts.get(toInt(typeID, 0)) || null);
}

function getCreationTemplate(typeID) {
  return cloneValue(getIndexes().templates.get(toInt(typeID, 0)) || null);
}

function isCreationModuleType(typeID) {
  return getIndexes().modules.has(toInt(typeID, 0));
}

function resetCreationStaticDataForTests() {
  indexes = null;
  clearReferenceCache(CREATION_TABLES);
}

module.exports = {
  CREATION_TABLES,
  getCreationHardpointType,
  getCreationModule,
  getCreationPart,
  getCreationTemplate,
  isCreationModuleType,
  resetCreationStaticDataForTests,
};
