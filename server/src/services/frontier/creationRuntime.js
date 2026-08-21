const path = require("path");

const {
  ITEM_FLAGS,
  findItemById,
  grantItemsToCharacterLocation,
  moveItemToLocation,
  removeInventoryItem,
  updateInventoryItem,
  updateShipItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCreationModule,
  getCreationTemplate,
} = require(path.join(__dirname, "./creationStaticData"));
const {
  applyModifierGroups,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  getAttributeIDByNames,
  getPassiveModifierEffectRecords,
  getModuleChargeGroupIDs,
  getTypeDogmaEffects,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  buildGodmaShipEffectEvent,
  buildModuleAttributeChangeEvent,
  sendOnMultiEvent,
} = require(path.join(__dirname, "../_shared/godmaMultiEvent"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ABILITY_RELOAD,
  ABILITY_UNLOAD,
  getModuleBehaviorName,
  getRegisteredBehaviorAbilities,
  resolveCreationAbilityHandler,
} = require(path.join(__dirname, "./creationAbilityRuntime"));

const CREATION_STATE_KEY = "evejsFrontierCreation";
const CREATION_STATE_VERSION = 1;
const CREATION_FITTING_FLAG_ID = 183;
const HIDDEN_CREATION_MODULE_FLAG_ID = CREATION_FITTING_FLAG_ID;
const CREATION_ONLINE_EFFECT_ID = 16;
const CREATION_FRICTION_CONSTANT = 1.0e-6;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_AGILITY = getAttributeIDByNames("agility") || 70;
// Attribute 567 also has the display name "Thrust" but is the legacy
// speedBoostFactor. Frontier CreationDogmaItem explicitly uses attribute 6250.
const ATTRIBUTE_THRUST = 6250;
const DOGMA_OP_MOD_ADD = 2;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseCustomInfo(customInfo) {
  const text = String(customInfo || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return { legacyCustomInfo: text };
  }
}

function normalizeRotation(value, dimensions) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {
    x: toFiniteNumber(source.x, 0),
    y: toFiniteNumber(source.y, 0),
    z: toFiniteNumber(source.z, 0),
  };
  if (dimensions === 4) {
    normalized.w = toFiniteNumber(source.w, 1);
  }
  return normalized;
}

function getCreationModuleAbilities(typeID, options = {}) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return [];
  }
  const resolveEffects = typeof options.getTypeDogmaEffects === "function"
    ? options.getTypeDogmaEffects
    : getTypeDogmaEffects;
  const abilities = [];
  if (resolveEffects(numericTypeID).has(CREATION_ONLINE_EFFECT_ID)) {
    abilities.push("online", "offline");
  }
  // Behavior abilities are advertised only when a server handler is
  // registered for them (see creationAbilityRuntime): the client hard-gates
  // activate_ability on this list, so advertising an unimplemented ability
  // would surface broken buttons instead of a clean rejection.
  const resolveBehaviorAbilities =
    typeof options.getRegisteredBehaviorAbilities === "function"
      ? options.getRegisteredBehaviorAbilities
      : getRegisteredBehaviorAbilities;
  const resolveBehaviorName = typeof options.getModuleBehaviorName === "function"
    ? options.getModuleBehaviorName
    : getModuleBehaviorName;
  for (const ability of resolveBehaviorAbilities(resolveBehaviorName(numericTypeID))) {
    if (!abilities.includes(ability)) {
      abilities.push(ability);
    }
  }
  const resolveChargeGroups =
    typeof options.getModuleChargeGroupIDs === "function"
      ? options.getModuleChargeGroupIDs
      : getModuleChargeGroupIDs;
  const resolveAbilityHandler =
    typeof options.resolveCreationAbilityHandler === "function"
      ? options.resolveCreationAbilityHandler
      : resolveCreationAbilityHandler;
  const chargeGroups = resolveChargeGroups(numericTypeID);
  if (chargeGroups && Number(chargeGroups.size) > 0) {
    const behaviorName = resolveBehaviorName(numericTypeID);
    for (const ability of [ABILITY_RELOAD, ABILITY_UNLOAD]) {
      if (
        !abilities.includes(ability) &&
        resolveAbilityHandler(behaviorName, ability)
      ) {
        abilities.push(ability);
      }
    }
  }
  return abilities;
}

function buildCreationShipAttributeModifierEntries(moduleItems, options = {}) {
  const resolveAttributes =
    typeof options.buildEffectiveItemAttributeMap === "function"
      ? options.buildEffectiveItemAttributeMap
      : buildEffectiveItemAttributeMap;
  const resolvePassiveEffects =
    typeof options.getPassiveModifierEffectRecords === "function"
      ? options.getPassiveModifierEffectRecords
      : getPassiveModifierEffectRecords;
  const appendModifiers =
    typeof options.appendDirectModifierEntries === "function"
      ? options.appendDirectModifierEntries
      : appendDirectModifierEntries;
  const modifierEntries = [];
  const seenItemIDs = new Set();

  for (const item of Array.isArray(moduleItems) ? moduleItems : []) {
    const itemID = toInt(item && item.itemID, 0);
    const typeID = toInt(item && item.typeID, 0);
    if (itemID <= 0 || typeID <= 0 || seenItemIDs.has(itemID)) {
      continue;
    }
    seenItemIDs.add(itemID);
    appendModifiers(
      modifierEntries,
      resolveAttributes(item),
      resolvePassiveEffects(typeID),
      "frontierCreationModule",
    );
  }

  return modifierEntries;
}

function buildCreationIntrinsicShipAttributeModifierEntries(
  shipItem,
  moduleItems,
  options = {},
) {
  const resolveAttributes =
    typeof options.buildEffectiveItemAttributeMap === "function"
      ? options.buildEffectiveItemAttributeMap
      : buildEffectiveItemAttributeMap;
  const applyModifiers =
    typeof options.applyModifierGroups === "function"
      ? options.applyModifierGroups
      : applyModifierGroups;
  const moduleModifierEntries = Array.isArray(options.moduleModifierEntries)
    ? options.moduleModifierEntries
    : buildCreationShipAttributeModifierEntries(moduleItems, options);
  const attributes = resolveAttributes(shipItem);
  const baseMaxVelocity = toFiniteNumber(
    attributes && attributes[ATTRIBUTE_MAX_VELOCITY],
    0,
  );

  applyModifiers(attributes, moduleModifierEntries);

  const thrust = Math.max(
    0,
    toFiniteNumber(attributes && attributes[ATTRIBUTE_THRUST], 0),
  );
  const agility = Math.max(
    0,
    toFiniteNumber(attributes && attributes[ATTRIBUTE_AGILITY], 0),
  );
  const maxVelocity =
    (baseMaxVelocity + thrust) * CREATION_FRICTION_CONSTANT * agility;
  const additiveVelocity = maxVelocity - baseMaxVelocity;
  if (!Number.isFinite(additiveVelocity) || Math.abs(additiveVelocity) < 1.0e-9) {
    return [];
  }

  // CreationDogmaItem derives subwarp velocity from thrust rather than using
  // the hull's attribute 37 directly: (base + thrust) * 1e-6 * agility.
  // Collapse that client-authored dependency into one additive Dogma entry so
  // normal skill/environment modifiers still run afterward in global order.
  return [{
    modifiedAttributeID: ATTRIBUTE_MAX_VELOCITY,
    operation: DOGMA_OP_MOD_ADD,
    value: Math.round(additiveVelocity * 1.0e6) / 1.0e6,
    stackingPenalized: false,
  }];
}

function isCreationModuleOnline(item) {
  if (getCreationModuleAbilities(item && item.typeID).length === 0) {
    return false;
  }
  const moduleState = item && item.moduleState;
  if (
    moduleState &&
    typeof moduleState === "object" &&
    Object.prototype.hasOwnProperty.call(moduleState, "online")
  ) {
    return moduleState.online === true;
  }
  return true;
}

function normalizeCreationState(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const templateTypeID = toInt(value.templateTypeID, 0);
  if (templateTypeID <= 0) {
    return null;
  }

  const modules = (Array.isArray(value.modules) ? value.modules : [])
    .map((module) => {
      const typeID = toInt(module && module.typeID, 0);
      return {
        itemID: toInt(module && module.itemID, 0),
        typeID,
        abilities: getCreationModuleAbilities(typeID, options),
      };
    })
    .filter((module) => module.itemID > 0 && module.typeID > 0);

  const interiorPlacements = (
    Array.isArray(value.interiorPlacements) ? value.interiorPlacements : []
  )
    .map((placement) => ({
      itemID: toInt(placement && placement.itemID, 0),
      partID: toInt(placement && placement.partID, 0),
      x: toFiniteNumber(placement && placement.x, 0),
      y: toFiniteNumber(placement && placement.y, 0),
      z: toFiniteNumber(placement && placement.z, 0),
      rotation: normalizeRotation(placement && placement.rotation, 3),
    }))
    .filter((placement) => placement.itemID > 0 && placement.partID > 0);

  const hardpoints = (Array.isArray(value.hardpoints) ? value.hardpoints : [])
    .map((hardpoint) => ({
      interiorItemID: toInt(hardpoint && hardpoint.interiorItemID, 0),
      hardpointIndex: Math.max(0, toInt(hardpoint && hardpoint.hardpointIndex, 0)),
      creationID: toInt(hardpoint && hardpoint.creationID, 0),
      partID: toInt(hardpoint && hardpoint.partID, 0),
      x: toFiniteNumber(hardpoint && hardpoint.x, 0),
      y: toFiniteNumber(hardpoint && hardpoint.y, 0),
      z: toFiniteNumber(hardpoint && hardpoint.z, 0),
      rotation: normalizeRotation(hardpoint && hardpoint.rotation, 4),
      attachedItemID: hardpoint && hardpoint.attachedItemID != null
        ? toInt(hardpoint.attachedItemID, 0) || null
        : null,
    }))
    .filter((hardpoint) => hardpoint.interiorItemID > 0 && hardpoint.partID > 0);

  return {
    version: CREATION_STATE_VERSION,
    templateTypeID,
    poweredOff: value.poweredOff === true,
    modules,
    interiorPlacements,
    hardpoints,
  };
}

function readCreationState(item) {
  return normalizeCreationState(
    parseCustomInfo(item && item.customInfo)[CREATION_STATE_KEY],
  );
}

function filterCreationModuleInventoryItems(item, inventoryItems = []) {
  const items = Array.isArray(inventoryItems) ? inventoryItems : [];
  const state = readCreationState(item);
  if (!state || !Array.isArray(state.modules)) {
    return items;
  }
  const activeModuleItemIDs = new Set(
    state.modules
      .map((module) => toInt(module && module.itemID, 0))
      .filter((itemID) => itemID > 0),
  );
  if (activeModuleItemIDs.size === 0) {
    return items;
  }
  return items.filter((inventoryItem) => (
    toInt(inventoryItem && inventoryItem.flagID, 0) !== CREATION_FITTING_FLAG_ID ||
    activeModuleItemIDs.has(toInt(inventoryItem && inventoryItem.itemID, 0))
  ));
}

function customInfoWithCreationState(item, state) {
  const info = parseCustomInfo(item && item.customInfo);
  info[CREATION_STATE_KEY] = normalizeCreationState(state);
  return JSON.stringify(info);
}

function vector(values, dimensions, fallbackLast = 0) {
  const source = Array.isArray(values) ? values : [];
  return Array.from({ length: dimensions }, (_, index) =>
    toFiniteNumber(source[index], index === dimensions - 1 ? fallbackLast : 0));
}

function buildCreationSeedPlan(template) {
  const plan = [];
  const interiors = Array.isArray(template && template.interior_modules)
    ? template.interior_modules
    : [];

  interiors.forEach((interior, interiorIndex) => {
    plan.push({
      kind: "interior",
      interiorIndex,
      typeID: toInt(interior && interior.type_id, 0),
    });
    (Array.isArray(interior && interior.hardpoints) ? interior.hardpoints : [])
      .forEach((hardpoint, hardpointIndex) => {
        const exteriorTypeID = toInt(hardpoint && hardpoint.exterior_type_id, 0);
        if (exteriorTypeID > 0) {
          plan.push({
            kind: "exterior",
            interiorIndex,
            hardpointIndex,
            typeID: exteriorTypeID,
          });
        }
      });
  });

  return plan.filter((entry) => entry.typeID > 0);
}

function buildSeededCreationState(template, creationID, plan, createdItems) {
  const interiors = Array.isArray(template && template.interior_modules)
    ? template.interior_modules
    : [];
  const itemForPlan = new Map();
  plan.forEach((entry, index) => itemForPlan.set(entry, createdItems[index] || null));

  const interiorItems = new Map();
  const exteriorItems = new Map();
  plan.forEach((entry) => {
    const item = itemForPlan.get(entry);
    if (!item) {
      return;
    }
    if (entry.kind === "interior") {
      interiorItems.set(entry.interiorIndex, item);
    } else {
      exteriorItems.set(`${entry.interiorIndex}:${entry.hardpointIndex}`, item);
    }
  });

  const modules = createdItems.map((item) => ({
    itemID: toInt(item && item.itemID, 0),
    typeID: toInt(item && item.typeID, 0),
    abilities: getCreationModuleAbilities(item && item.typeID),
  })).filter((module) => module.itemID > 0 && module.typeID > 0);

  const interiorPlacements = [];
  const hardpoints = [];
  interiors.forEach((interior, interiorIndex) => {
    const interiorItem = interiorItems.get(interiorIndex);
    if (!interiorItem) {
      return;
    }
    const position = vector(interior.position, 3);
    const rotation = vector(interior.rotation, 3);
    interiorPlacements.push({
      itemID: interiorItem.itemID,
      partID: toInt(interior.part_id, 0),
      x: position[0],
      y: position[1],
      z: position[2],
      rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    });

    (Array.isArray(interior.hardpoints) ? interior.hardpoints : [])
      .forEach((hardpoint, hardpointIndex) => {
        const hardpointPosition = vector(hardpoint.position, 3);
        const hardpointRotation = vector(hardpoint.rotation, 4, 1);
        const attached = exteriorItems.get(`${interiorIndex}:${hardpointIndex}`);
        hardpoints.push({
          interiorItemID: interiorItem.itemID,
          hardpointIndex,
          creationID,
          partID: toInt(hardpoint.part_id, 0),
          x: hardpointPosition[0],
          y: hardpointPosition[1],
          z: hardpointPosition[2],
          rotation: {
            x: hardpointRotation[0],
            y: hardpointRotation[1],
            z: hardpointRotation[2],
            w: hardpointRotation[3],
          },
          attachedItemID: attached ? attached.itemID : null,
        });
      });
  });

  return normalizeCreationState({
    version: CREATION_STATE_VERSION,
    templateTypeID: toInt(template && (template.typeID ?? template._key), 0),
    poweredOff: false,
    modules,
    interiorPlacements,
    hardpoints,
  });
}

function reconcileCreationModuleFittingFlags(item, characterID, state) {
  const shipID = toInt(item && item.itemID, 0);
  const ownerID = toInt(characterID, 0);
  const reversals = [];
  const changes = [];

  for (const module of state.modules) {
    const source = findItemById(module.itemID);
    if (
      !source ||
      toInt(source.ownerID, 0) !== ownerID ||
      toInt(source.locationID, 0) !== shipID ||
      toInt(source.typeID, 0) !== module.typeID
    ) {
      continue;
    }

    if (
      toInt(source.flagID, 0) === CREATION_FITTING_FLAG_ID &&
      toInt(source.singleton, 0) === 1 &&
      toInt(source.stacksize, 1) === 1
    ) {
      continue;
    }

    const result = moveCreationModuleToFitting(source, shipID);
    if (!result.success) {
      rollbackInventoryActions(reversals);
      return result;
    }
    reversals.push(buildInventoryMoveReversal(source, result));
    changes.push(...(result.data.changes || []));
  }

  return { success: true, data: { changes } };
}

function ensureCreationState(item, characterID) {
  const canonicalItem =
    findItemById(toInt(item && item.itemID, 0)) || item;
  const ownerID = toInt(characterID, 0);
  if (
    !canonicalItem ||
    ownerID <= 0 ||
    toInt(canonicalItem.ownerID, 0) !== ownerID
  ) {
    return { success: false, errorMsg: "CREATION_ITEM_NOT_OWNED" };
  }
  const template = getCreationTemplate(canonicalItem && canonicalItem.typeID);
  if (!template) {
    return { success: false, errorMsg: "CREATION_TEMPLATE_NOT_FOUND" };
  }

  const existing = readCreationState(canonicalItem);
  if (
    existing &&
    existing.templateTypeID === toInt(canonicalItem.typeID, 0)
  ) {
    const reconciliation = reconcileCreationModuleFittingFlags(
      canonicalItem,
      characterID,
      existing,
    );
    if (!reconciliation.success) {
      return reconciliation;
    }
    return {
      success: true,
      data: {
        item: canonicalItem,
        state: existing,
        template,
        seeded: false,
        moduleFittingChanges: reconciliation.data.changes,
      },
    };
  }

  const plan = buildCreationSeedPlan(template);
  const grantResult = grantItemsToCharacterLocation(
    characterID,
    canonicalItem.itemID,
    HIDDEN_CREATION_MODULE_FLAG_ID,
    plan.map((entry) => ({
      itemType: entry.typeID,
      quantity: 1,
      options: { individualItems: true, singleton: 1 },
    })),
  );
  if (!grantResult.success) {
    return grantResult;
  }

  const createdItems = grantResult.data.items || [];
  if (createdItems.length !== plan.length) {
    for (const createdItem of createdItems) {
      removeInventoryItem(createdItem.itemID, { removeContents: true });
    }
    return { success: false, errorMsg: "CREATION_MODULE_SEED_INCOMPLETE" };
  }

  const state = buildSeededCreationState(
    template,
    canonicalItem.itemID,
    plan,
    createdItems,
  );
  const updateResult = updateShipItem(canonicalItem.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: customInfoWithCreationState(currentItem, state),
  }));
  if (!updateResult.success) {
    for (const createdItem of createdItems) {
      removeInventoryItem(createdItem.itemID, { removeContents: true });
    }
    return updateResult;
  }

  return {
    success: true,
    data: {
      item: updateResult.data,
      state,
      template,
      seeded: true,
      createdItems,
    },
  };
}

function buildDiagnostic(code, change = null, params = {}) {
  return {
    code,
    severity: "blocker",
    moduleItemID: toInt(
      change && (change.itemID ?? change.interiorItemID ?? change.attachedItemID),
      0,
    ) || null,
    changeOp: change && change.op ? String(change.op) : null,
    retryAt: null,
    params,
  };
}

function findHardpoint(state, interiorItemID, hardpointIndex) {
  return state.hardpoints.find((hardpoint) =>
    hardpoint.interiorItemID === interiorItemID &&
    hardpoint.hardpointIndex === hardpointIndex);
}

function validateOwnedSourceItem(itemID, typeID, characterID, change) {
  const item = findItemById(itemID);
  if (
    !item ||
    toInt(item.ownerID, 0) !== characterID ||
    toInt(item.typeID, 0) !== typeID
  ) {
    return { diagnostic: buildDiagnostic("item_unavailable", change), item: null };
  }
  const sourceLocationID = toInt(change && change.sourceLocationID, 0);
  const sourceFlagID = toInt(change && change.sourceFlagID, -1);
  if (
    (sourceLocationID > 0 && toInt(item.locationID, 0) !== sourceLocationID) ||
    (sourceFlagID >= 0 && toInt(item.flagID, 0) !== sourceFlagID)
  ) {
    return { diagnostic: buildDiagnostic("item_unavailable", change), item: null };
  }
  return { diagnostic: null, item };
}

function validatePart(template, partID) {
  return Boolean(template && template.parts && template.parts[String(partID)]);
}

function buildPlacement(change) {
  return {
    itemID: toInt(change.itemID, 0),
    partID: toInt(change.partID, 0),
    x: toFiniteNumber(change.x, 0),
    y: toFiniteNumber(change.y, 0),
    z: toFiniteNumber(change.z, 0),
    rotation: {
      x: toFiniteNumber(change.rotationX, 0),
      y: toFiniteNumber(change.rotationY, 0),
      z: toFiniteNumber(change.rotationZ, 0),
    },
  };
}

function buildHardpoint(change, creationID, attachedItemID = null) {
  return {
    interiorItemID: toInt(change.interiorItemID, 0),
    hardpointIndex: Math.max(0, toInt(change.hardpointIndex, 0)),
    creationID,
    partID: toInt(change.partID, 0),
    x: toFiniteNumber(change.x, 0),
    y: toFiniteNumber(change.y, 0),
    z: toFiniteNumber(change.z, 0),
    rotation: {
      x: toFiniteNumber(change.rotationX, 0),
      y: toFiniteNumber(change.rotationY, 0),
      z: toFiniteNumber(change.rotationZ, 0),
      w: toFiniteNumber(change.rotationW, 1),
    },
    attachedItemID,
  };
}

function stageCreationChanges(state, template, creationID, characterID, changes) {
  const next = cloneValue(state);
  const inventoryActions = [];

  for (const rawChange of changes) {
    const change = rawChange && typeof rawChange === "object" ? rawChange : {};
    const op = String(change.op || "").trim().toLowerCase();
    const itemID = toInt(change.itemID, 0);
    const interiorItemID = toInt(change.interiorItemID, 0);
    const attachedItemID = toInt(change.attachedItemID, 0);

    if (op === "add") {
      const typeID = toInt(change.typeID, 0);
      const definition = getCreationModule(typeID);
      const source = validateOwnedSourceItem(itemID, typeID, characterID, change);
      if (
        !definition ||
        !definition.placement ||
        !definition.placement.occupancy ||
        !validatePart(template, toInt(change.partID, 0)) ||
        source.diagnostic
      ) {
        return {
          diagnostic: source.diagnostic || buildDiagnostic("invalid_placement", change),
        };
      }
      next.modules = next.modules.filter((module) => module.itemID !== itemID);
      next.modules.push({
        itemID,
        typeID,
        abilities: getCreationModuleAbilities(typeID),
      });
      next.interiorPlacements = next.interiorPlacements
        .filter((placement) => placement.itemID !== itemID);
      next.interiorPlacements.push(buildPlacement(change));
      inventoryActions.push({
        item: source.item,
        locationID: creationID,
        flagID: CREATION_FITTING_FLAG_ID,
        fitToCreation: true,
      });
      continue;
    }

    if (op === "move") {
      const placement = next.interiorPlacements
        .find((entry) => entry.itemID === itemID);
      if (!placement || !validatePart(template, toInt(change.partID, 0))) {
        return { diagnostic: buildDiagnostic("invalid_placement", change) };
      }
      Object.assign(placement, buildPlacement(change));
      continue;
    }

    if (op === "remove") {
      if (!next.modules.some((module) => module.itemID === itemID)) {
        return { diagnostic: buildDiagnostic("item_unavailable", change) };
      }
      const item = findItemById(itemID);
      if (!item || toInt(item.ownerID, 0) !== characterID) {
        return { diagnostic: buildDiagnostic("item_unavailable", change) };
      }
      next.modules = next.modules.filter((module) => module.itemID !== itemID);
      next.interiorPlacements = next.interiorPlacements
        .filter((placement) => placement.itemID !== itemID);
      next.hardpoints = next.hardpoints
        .filter((hardpoint) => hardpoint.interiorItemID !== itemID);
      inventoryActions.push({
        item,
        locationID: toInt(change.destLocationID, creationID),
        flagID: toInt(change.destFlagID, 5),
      });
      continue;
    }

    if (op === "place") {
      const interiorModule = next.modules
        .find((module) => module.itemID === interiorItemID);
      const definition = interiorModule && getCreationModule(interiorModule.typeID);
      const hardpointTypes = definition && definition.placement &&
        Array.isArray(definition.placement.hardpoints)
        ? definition.placement.hardpoints
        : [];
      const hardpointIndex = Math.max(0, toInt(change.hardpointIndex, 0));
      if (
        !interiorModule ||
        !hardpointTypes[hardpointIndex] ||
        !validatePart(template, toInt(change.partID, 0))
      ) {
        return { diagnostic: buildDiagnostic("invalid_placement", change) };
      }
      const existing = findHardpoint(next, interiorItemID, hardpointIndex);
      const replacement = buildHardpoint(
        change,
        creationID,
        existing ? existing.attachedItemID : null,
      );
      if (existing) {
        Object.assign(existing, replacement);
      } else {
        next.hardpoints.push(replacement);
      }
      continue;
    }

    if (op === "attach") {
      const typeID = toInt(change.typeID, 0);
      const target = findHardpoint(next, interiorItemID, toInt(change.hardpointIndex, 0));
      const exteriorDefinition = getCreationModule(typeID);
      const interiorModule = next.modules
        .find((module) => module.itemID === interiorItemID);
      const interiorDefinition = interiorModule && getCreationModule(interiorModule.typeID);
      const hardpointType = interiorDefinition && interiorDefinition.placement &&
        Array.isArray(interiorDefinition.placement.hardpoints)
        ? interiorDefinition.placement.hardpoints[toInt(change.hardpointIndex, 0)]
        : null;
      const compatible = exteriorDefinition && exteriorDefinition.placement &&
        Array.isArray(exteriorDefinition.placement.compatible_hardpoints)
        ? exteriorDefinition.placement.compatible_hardpoints
        : [];
      const source = validateOwnedSourceItem(
        attachedItemID,
        typeID,
        characterID,
        change,
      );
      if (!target || !hardpointType || !compatible.includes(hardpointType) || source.diagnostic) {
        return {
          diagnostic: source.diagnostic || buildDiagnostic("invalid_placement", change),
        };
      }
      target.attachedItemID = attachedItemID;
      next.modules = next.modules.filter((module) => module.itemID !== attachedItemID);
      next.modules.push({
        itemID: attachedItemID,
        typeID,
        abilities: getCreationModuleAbilities(typeID),
      });
      inventoryActions.push({
        item: source.item,
        locationID: creationID,
        flagID: CREATION_FITTING_FLAG_ID,
        fitToCreation: true,
      });
      continue;
    }

    if (op === "detach") {
      const target = next.hardpoints
        .find((hardpoint) => hardpoint.attachedItemID === attachedItemID);
      const item = findItemById(attachedItemID);
      if (!target || !item || toInt(item.ownerID, 0) !== characterID) {
        return { diagnostic: buildDiagnostic("item_unavailable", change) };
      }
      target.attachedItemID = null;
      next.modules = next.modules.filter((module) => module.itemID !== attachedItemID);
      inventoryActions.push({
        item,
        locationID: toInt(change.destLocationID, creationID),
        flagID: toInt(change.destFlagID, 5),
      });
      continue;
    }

    if (op === "move_attach") {
      const source = next.hardpoints
        .find((hardpoint) => hardpoint.attachedItemID === attachedItemID);
      const target = findHardpoint(next, interiorItemID, toInt(change.hardpointIndex, 0));
      if (!source || !target) {
        return { diagnostic: buildDiagnostic("invalid_placement", change) };
      }
      source.attachedItemID = null;
      target.attachedItemID = attachedItemID;
      continue;
    }

    return { diagnostic: buildDiagnostic("invalid_post_commit_state", change) };
  }

  return {
    state: normalizeCreationState(next),
    inventoryActions,
    diagnostic: null,
  };
}

function moveCreationModuleToFitting(sourceItem, creationID) {
  const sourceFlagID = toInt(sourceItem && sourceItem.flagID, 0);
  const repairingLegacyFittedStack = sourceFlagID === CREATION_FITTING_FLAG_ID;
  return moveItemToLocation(
    sourceItem && sourceItem.itemID,
    creationID,
    CREATION_FITTING_FLAG_ID,
    1,
    {
      affectsFitting: true,
      preserveMovedItemID: true,
      treatDestinationAsFitting: true,
      ...(repairingLegacyFittedStack
        ? {
            remainderLocationID: creationID,
            remainderFlagID: ITEM_FLAGS.CARGO_HOLD,
          }
        : {}),
    },
  );
}

function buildInventoryMoveReversal(sourceItem, moveResult) {
  const sourceItemID = toInt(sourceItem && sourceItem.itemID, 0);
  const explicitCreatedItemIDs =
    moveResult && moveResult.data && Array.isArray(moveResult.data.createdItemIDs)
      ? moveResult.data.createdItemIDs
      : [];
  const inferredCreatedItemIDs = (
    moveResult && moveResult.data && Array.isArray(moveResult.data.changes)
      ? moveResult.data.changes
      : []
  )
    .map((change) => toInt(change && change.item && change.item.itemID, 0))
    .filter((itemID) => itemID > 0 && itemID !== sourceItemID);
  return {
    sourceItem: cloneValue(sourceItem),
    createdItemIDs: [...new Set([
      ...explicitCreatedItemIDs.map((itemID) => toInt(itemID, 0)),
      ...inferredCreatedItemIDs,
    ].filter((itemID) => itemID > 0 && itemID !== sourceItemID))],
  };
}

function rollbackInventoryActions(reversals) {
  for (const reversal of [...reversals].reverse()) {
    for (const itemID of reversal.createdItemIDs || []) {
      removeInventoryItem(itemID, { removeContents: true });
    }
    if (reversal.sourceItem && reversal.sourceItem.itemID) {
      updateInventoryItem(
        reversal.sourceItem.itemID,
        () => cloneValue(reversal.sourceItem),
      );
    }
  }
}

function syncInventoryChangesForSession(session, changes) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      { emitCfgLocation: true },
    );
  }
}

function commitCreationDraft(item, characterID, rawChanges, session) {
  const ensured = ensureCreationState(item, characterID);
  if (!ensured.success) {
    return {
      success: false,
      diagnostics: [buildDiagnostic("invalid_post_commit_state", null, {
        reason: ensured.errorMsg || "CREATION_STATE_UNAVAILABLE",
      })],
    };
  }

  const changes = Array.isArray(rawChanges) ? rawChanges : [];
  const staged = stageCreationChanges(
    ensured.data.state,
    ensured.data.template,
    item.itemID,
    characterID,
    changes,
  );
  if (staged.diagnostic) {
    return { success: false, diagnostics: [staged.diagnostic] };
  }

  const reversals = [];
  const notificationChanges = [];
  for (const action of staged.inventoryActions) {
    const currentSource = findItemById(action.item.itemID) || action.item;
    if (
      toInt(currentSource.locationID, 0) === action.locationID &&
      toInt(currentSource.flagID, 0) === action.flagID &&
      (
        action.fitToCreation !== true ||
        (
          toInt(currentSource.singleton, 0) === 1 &&
          toInt(currentSource.stacksize, 1) === 1
        )
      )
    ) {
      continue;
    }
    const result = action.fitToCreation === true
      ? moveCreationModuleToFitting(currentSource, action.locationID)
      : moveItemToLocation(
          currentSource.itemID,
          action.locationID,
          action.flagID,
          null,
          { affectsFitting: true },
        );
    if (!result.success) {
      rollbackInventoryActions(reversals);
      return {
        success: false,
        diagnostics: [buildDiagnostic("item_unavailable", null, {
          reason: result.errorMsg || "ITEM_MOVE_FAILED",
        })],
      };
    }
    reversals.push(buildInventoryMoveReversal(currentSource, result));
    notificationChanges.push(...(result.data.changes || []));
  }

  const updateResult = updateShipItem(item.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: customInfoWithCreationState(currentItem, staged.state),
  }));
  if (!updateResult.success) {
    rollbackInventoryActions(reversals);
    return {
      success: false,
      diagnostics: [buildDiagnostic("invalid_post_commit_state", null, {
        reason: updateResult.errorMsg || "CREATION_STATE_WRITE_FAILED",
      })],
    };
  }

  syncInventoryChangesForSession(session, notificationChanges);

  return {
    success: true,
    diagnostics: [],
    data: { item: updateResult.data, state: staged.state },
  };
}

function setCreationPowerState(item, characterID, poweredOff) {
  const ensured = ensureCreationState(item, characterID);
  if (!ensured.success) {
    return ensured;
  }
  const state = { ...ensured.data.state, poweredOff: poweredOff === true };
  const updateResult = updateShipItem(item.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: customInfoWithCreationState(currentItem, state),
  }));
  return updateResult.success
    ? { success: true, data: { item: updateResult.data, state } }
    : updateResult;
}

function getCreationDogmaContext(item, characterID) {
  const ensured = ensureCreationState(item, characterID);
  if (!ensured.success) {
    return ensured;
  }

  const shipID = toInt(ensured.data.item && ensured.data.item.itemID, 0);
  const ownerID = toInt(characterID, 0);
  const poweredOff = ensured.data.state.poweredOff === true;
  const moduleItems = ensured.data.state.modules
    .map((module) => {
      const source = findItemById(module.itemID);
      if (
        !source ||
        toInt(source.ownerID, 0) !== ownerID ||
        toInt(source.locationID, 0) !== shipID ||
        toInt(source.typeID, 0) !== module.typeID
      ) {
        return null;
      }
      return {
        ...source,
        moduleState: {
          ...(source.moduleState || {}),
          online: !poweredOff && isCreationModuleOnline(source),
        },
      };
    })
    .filter(Boolean);
  const moduleModifierEntries =
    buildCreationShipAttributeModifierEntries(moduleItems);

  return {
    success: true,
    data: {
      ...ensured.data,
      moduleItems,
      shipAttributeModifierEntries: [
        ...moduleModifierEntries,
        ...buildCreationIntrinsicShipAttributeModifierEntries(
          ensured.data.item,
          moduleItems,
          { moduleModifierEntries },
        ),
      ],
    },
  };
}

function setCreationModuleOnlineState(
  item,
  characterID,
  moduleItemID,
  online,
  session = null,
) {
  const ensured = ensureCreationState(item, characterID);
  if (!ensured.success) {
    return ensured;
  }
  syncInventoryChangesForSession(
    session,
    ensured.data && ensured.data.moduleFittingChanges,
  );

  const numericModuleItemID = toInt(moduleItemID, 0);
  const module = ensured.data.state.modules
    .find((entry) => entry.itemID === numericModuleItemID);
  const moduleItem = module ? findItemById(numericModuleItemID) : null;
  if (
    !module ||
    !moduleItem ||
    toInt(moduleItem.ownerID, 0) !== toInt(characterID, 0) ||
    toInt(moduleItem.locationID, 0) !== toInt(item && item.itemID, 0) ||
    getCreationModuleAbilities(module.typeID).length === 0
  ) {
    return { success: false, errorMsg: "CREATION_MODULE_ABILITY_NOT_FOUND" };
  }

  const previousOnline = isCreationModuleOnline(moduleItem);
  const nextOnline = online === true;
  const updateResult = updateInventoryItem(numericModuleItemID, (currentItem) => ({
    ...currentItem,
    moduleState: {
      ...(currentItem.moduleState || {}),
      online: nextOnline,
    },
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const serverTime = (
    session &&
    session._space &&
    typeof session._space.simFileTime === "bigint"
  ) ? session._space.simFileTime : currentFileTime();
  if (previousOnline !== nextOnline) {
    const subEvents = [];
    const isOnlineAttributeID = getAttributeIDByNames("isOnline") || 1153;
    subEvents.push(buildModuleAttributeChangeEvent(
      characterID,
      numericModuleItemID,
      isOnlineAttributeID,
      nextOnline ? 1 : 0,
      previousOnline ? 1 : 0,
      serverTime,
    ));
    subEvents.push(buildGodmaShipEffectEvent(
      numericModuleItemID,
      characterID,
      item.itemID,
      CREATION_ONLINE_EFFECT_ID,
      serverTime,
      {
        isStart: nextOnline ? 1 : 0,
        shouldStart: nextOnline ? 1 : 0,
      },
    ));
    sendOnMultiEvent(session, subEvents, serverTime);
  }

  return {
    success: true,
    data: {
      item: updateResult.data,
      previousOnline,
      nextOnline,
      serverTime,
    },
  };
}

module.exports = {
  CREATION_FITTING_FLAG_ID,
  CREATION_ONLINE_EFFECT_ID,
  CREATION_STATE_KEY,
  CREATION_STATE_VERSION,
  HIDDEN_CREATION_MODULE_FLAG_ID,
  buildCreationSeedPlan,
  buildSeededCreationState,
  buildCreationIntrinsicShipAttributeModifierEntries,
  buildCreationShipAttributeModifierEntries,
  commitCreationDraft,
  ensureCreationState,
  filterCreationModuleInventoryItems,
  getCreationDogmaContext,
  getCreationModuleAbilities,
  isCreationModuleOnline,
  normalizeCreationState,
  readCreationState,
  setCreationModuleOnlineState,
  setCreationPowerState,
  stageCreationChanges,
};
