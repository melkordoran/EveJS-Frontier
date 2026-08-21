const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require("../_shared/serviceHelpers");

function normalizePositiveInteger(value) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolveSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charID || session.charid),
  );
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildRotation(value, includeW = false) {
  const source = value && typeof value === "object" ? value : {};
  const entries = [
    ["x", toFiniteNumber(source.x, 0)],
    ["y", toFiniteNumber(source.y, 0)],
    ["z", toFiniteNumber(source.z, 0)],
  ];
  if (includeW) {
    entries.push(["w", toFiniteNumber(source.w, 1)]);
  }
  return buildDict(entries);
}

function buildCreationLayout(template) {
  const parts = template && template.parts && typeof template.parts === "object"
    ? template.parts
    : null;
  if (!parts) {
    return buildDict([]);
  }

  const entries = Object.entries(parts)
    .map(([rawPartID, part]) => {
      const partID = normalizePositiveInteger(rawPartID);
      const position = Array.isArray(part && part.position) ? part.position : [];
      const rotation = Array.isArray(part && part.rotation) ? part.rotation : [];
      if (!partID) {
        return null;
      }
      return [
        partID,
        buildDict([
          ["graphic_id", normalizePositiveInteger(part && part.graphic_id)],
          ["x", toFiniteNumber(position[0], 0)],
          ["y", toFiniteNumber(position[1], 0)],
          ["z", toFiniteNumber(position[2], 0)],
          ["rotation", buildRotation({
            x: rotation[0],
            y: rotation[1],
            z: rotation[2],
            w: rotation[3],
          }, true)],
        ]),
      ];
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);

  return buildDict([["parts", buildDict(entries)]]);
}

function buildCreationModules(state, options = {}) {
  const resolveLoadedCharge =
    options && typeof options.getLoadedCharge === "function"
      ? options.getLoadedCharge
      : () => null;
  return buildDict(
    (Array.isArray(state && state.modules) ? state.modules : [])
      .map((module) => {
        const moduleItemID = normalizePositiveInteger(module && module.itemID);
        const loaded = resolveLoadedCharge(moduleItemID) || null;
        const loadedTypeID = normalizePositiveInteger(
          loaded && (loaded.typeID ?? loaded.type_id),
        ) || null;
        const loadedCount = normalizePositiveInteger(
          loaded && (loaded.quantity ?? loaded.count ?? loaded.loaded_count),
        );
        return [
          moduleItemID,
          buildDict([
            ["item_id", normalizePositiveInteger(module && module.itemID)],
            ["type_id", normalizePositiveInteger(module && module.typeID)],
            ["abilities", buildList(
              (Array.isArray(module && module.abilities) ? module.abilities : [])
                .map((ability) => String(ability)),
            )],
            ["loaded_type_id", loadedTypeID],
            ["loaded_count", loadedCount],
          ]),
        ];
      })
      .filter(([itemID]) => itemID > 0)
      .sort((left, right) => left[0] - right[0]),
  );
}

function buildInteriorPlacements(state) {
  return buildDict(
    (Array.isArray(state && state.interiorPlacements)
      ? state.interiorPlacements
      : [])
      .map((placement) => [
        normalizePositiveInteger(placement && placement.itemID),
        buildDict([
          ["part_id", normalizePositiveInteger(placement && placement.partID)],
          ["x", toFiniteNumber(placement && placement.x, 0)],
          ["y", toFiniteNumber(placement && placement.y, 0)],
          ["z", toFiniteNumber(placement && placement.z, 0)],
          ["rotation", buildRotation(placement && placement.rotation)],
        ]),
      ])
      .filter(([itemID]) => itemID > 0)
      .sort((left, right) => left[0] - right[0]),
  );
}

function buildHardpoints(state) {
  return buildList(
    (Array.isArray(state && state.hardpoints) ? state.hardpoints : [])
      .map((hardpoint) => buildDict([
        ["interior_item_id", normalizePositiveInteger(
          hardpoint && hardpoint.interiorItemID,
        )],
        ["hardpoint_index", Math.max(0, Number(hardpoint && hardpoint.hardpointIndex) || 0)],
        ["creation_id", normalizePositiveInteger(hardpoint && hardpoint.creationID)],
        ["part_id", normalizePositiveInteger(hardpoint && hardpoint.partID)],
        ["x", toFiniteNumber(hardpoint && hardpoint.x, 0)],
        ["y", toFiniteNumber(hardpoint && hardpoint.y, 0)],
        ["z", toFiniteNumber(hardpoint && hardpoint.z, 0)],
        ["rotation", buildRotation(hardpoint && hardpoint.rotation, true)],
        ["attached_item_id", normalizePositiveInteger(
          hardpoint && hardpoint.attachedItemID,
        ) || null],
      ])),
  );
}

function buildCreationSnapshot(
  item,
  characterID,
  state = null,
  template = null,
  options = {},
) {
  return buildDict([
    ["item_id", item.itemID],
    ["type_id", item.typeID],
    ["owner_id", item.ownerID || characterID],
    ["access_control", buildDict([["default", "owner"]])],
    ["layout", state && template ? buildCreationLayout(template) : buildDict([])],
    ["modules", state ? buildCreationModules(state, options) : buildDict([])],
    ["interior_placements", state ? buildInteriorPlacements(state) : buildDict([])],
    ["hardpoints", state ? buildHardpoints(state) : buildList([])],
  ]);
}

function buildCreationDiagnostic(diagnostic = {}) {
  return buildDict([
    ["code", String(diagnostic.code || "invalid_post_commit_state")],
    ["severity", String(diagnostic.severity || "blocker")],
    ["moduleItemID", normalizePositiveInteger(diagnostic.moduleItemID) || null],
    ["changeOp", diagnostic.changeOp == null ? null : String(diagnostic.changeOp)],
    ["retryAt", diagnostic.retryAt == null ? null : diagnostic.retryAt],
    ["params", buildDict(Object.entries(
      diagnostic.params && typeof diagnostic.params === "object"
        ? diagnostic.params
        : {},
    ))],
  ]);
}

module.exports = {
  buildCreationDiagnostic,
  buildCreationLayout,
  buildCreationModules,
  buildCreationSnapshot,
  buildHardpoints,
  buildInteriorPlacements,
  normalizePositiveInteger,
  resolveSessionCharacterID,
};
