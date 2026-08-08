const path = require("path");

const {
  buildDbRowset,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const INVENTORY_ROW_DESCRIPTOR_COLUMNS = [
  ["itemID", 20],
  ["typeID", 3],
  ["ownerID", 3],
  ["locationID", 20],
  ["flagID", 2],
  ["quantity", 3],
  ["groupID", 3],
  ["categoryID", 3],
  ["customInfo", 129],
  ["singleton", 2],
  ["stacksize", 3],
];

function buildItemsInSystemsRowset(items = []) {
  return buildDbRowset(
    INVENTORY_ROW_DESCRIPTOR_COLUMNS,
    Array.isArray(items) ? items : [],
    "carbon.common.script.sys.crowset.CRowset",
  );
}

module.exports = {
  INVENTORY_ROW_DESCRIPTOR_COLUMNS,
  buildItemsInSystemsRowset,
};
