const rawPolicy = require("./productionMissionPolicy.json");

function positiveInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return normalized;
}

function nonEmptyText(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new TypeError(`${fieldName} must be non-empty text`);
  }
  return normalized;
}

function assertUnique(value, seen, fieldName) {
  const key = String(value).toLowerCase();
  if (seen.has(key)) {
    throw new TypeError(`${fieldName} must be unique: ${value}`);
  }
  seen.add(key);
}

function normalizedTemplateAliases(value) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const separatorIndex = normalized.indexOf(":");
  return separatorIndex >= 0
    ? [normalized, normalized.slice(separatorIndex + 1)]
    : [normalized];
}

function isValidMissionPresentation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (typeof value.bookmarkDeadspace !== "boolean") {
    return false;
  }
  const hint = String(value.bookmarkHint || "").trim();
  const match = hint.match(/^UI\/Agents\/Bookmarks\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return false;
  }
  const [, category, variant] = match;
  return variant === (value.bookmarkDeadspace ? "Deadspace" : category);
}

function isValidMissionRewardPresentation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const validReward = (reward, timed = false) => (
    reward &&
    typeof reward === "object" &&
    !Array.isArray(reward) &&
    Number.isInteger(reward.typeID) &&
    reward.typeID > 0 &&
    Number.isInteger(reward.quantity) &&
    reward.quantity > 0 &&
    (!timed || (
      Number.isInteger(reward.timeIntervalMinutes) &&
      reward.timeIntervalMinutes > 0
    ))
  );
  const hasNormal = Object.prototype.hasOwnProperty.call(value, "normalReward");
  const hasBonus = Object.prototype.hasOwnProperty.call(value, "bonusReward");
  const hasLoyaltyPoints = Object.prototype.hasOwnProperty.call(value, "loyaltyPoints");
  return (hasNormal || hasBonus || hasLoyaltyPoints) &&
    (!hasNormal || validReward(value.normalReward, false)) &&
    (!hasBonus || validReward(value.bonusReward, true)) &&
    (!hasLoyaltyPoints || (
      Number.isInteger(value.loyaltyPoints) && value.loyaltyPoints >= 0
    ));
}

function isValidMissionSetup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const validRoute = [
    value.sourceAgentID,
    value.sourceSolarSystemID,
    value.missionSolarSystemID,
  ].every((field) => Number.isInteger(field) && field > 0);
  const position = value.missionPosition;
  const validPosition = Boolean(position) &&
    typeof position === "object" &&
    !Array.isArray(position) &&
    [position.x, position.y, position.z].every(Number.isFinite);
  return validRoute && validPosition && (
    !Object.prototype.hasOwnProperty.call(value, "reward") ||
    isValidMissionRewardPresentation(value.reward)
  );
}

function validateProductionMissionPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("production mission policy must be an object");
  }

  const version = positiveInteger(value.version, "version");
  if (!Array.isArray(value.goldenSecurityMissions)) {
    throw new TypeError("goldenSecurityMissions must be an array");
  }
  const goldenMissionIDs = new Set();
  const templateIDByDungeonID = new Map();
  const dungeonIDByTemplateID = new Map();
  const goldenSecurityMissions = value.goldenSecurityMissions.map((entry, index) => {
    const prefix = `goldenSecurityMissions[${index}]`;
    const missionID = positiveInteger(entry && entry.missionID, `${prefix}.missionID`);
    const dungeonID = positiveInteger(entry && entry.dungeonID, `${prefix}.dungeonID`);
    const agentLevel = positiveInteger(entry && entry.agentLevel, `${prefix}.agentLevel`);
    if (typeof (entry && entry.requiresMissionSetup) !== "boolean") {
      throw new TypeError(`${prefix}.requiresMissionSetup must be a boolean`);
    }
    const requiresMissionSetup = entry.requiresMissionSetup;
    const templateID = nonEmptyText(entry && entry.templateID, `${prefix}.templateID`);
    if (templateID !== templateID.toLowerCase()) {
      throw new TypeError(`${prefix}.templateID must use canonical lowercase casing`);
    }
    assertUnique(missionID, goldenMissionIDs, "goldenSecurityMissions missionID");
    const dungeonKey = String(dungeonID);
    const templateKey = templateID.toLowerCase();
    const mappedTemplateID = templateIDByDungeonID.get(dungeonKey);
    if (mappedTemplateID && mappedTemplateID !== templateKey) {
      throw new TypeError(
        `golden dungeonID ${dungeonID} must map consistently to templateID ${mappedTemplateID}`,
      );
    }
    const mappedDungeonID = dungeonIDByTemplateID.get(templateKey);
    if (mappedDungeonID && mappedDungeonID !== dungeonID) {
      throw new TypeError(
        `golden templateID ${templateID} must map consistently to dungeonID ${mappedDungeonID}`,
      );
    }
    templateIDByDungeonID.set(dungeonKey, templateKey);
    dungeonIDByTemplateID.set(templateKey, dungeonID);
    return { missionID, dungeonID, agentLevel, templateID, requiresMissionSetup };
  });

  if (!Array.isArray(value.disabledMissions)) {
    throw new TypeError("disabledMissions must be an array");
  }
  const disabledMissionIDs = new Set();
  const disabledTemplateIDs = new Set();
  const disabledTemplateAliases = new Set();
  const disabledMissions = value.disabledMissions.map((entry, index) => {
    const prefix = `disabledMissions[${index}]`;
    const missionID = positiveInteger(entry && entry.missionID, `${prefix}.missionID`);
    assertUnique(missionID, disabledMissionIDs, "disabledMissions missionID");
    if (goldenMissionIDs.has(String(missionID).toLowerCase())) {
      throw new TypeError(`missionID ${missionID} cannot be both golden and disabled`);
    }
    if (!Array.isArray(entry && entry.templateIDs) || entry.templateIDs.length <= 0) {
      throw new TypeError(`${prefix}.templateIDs must be a non-empty array`);
    }
    const templateIDs = entry.templateIDs.map((templateID, templateIndex) => {
      const normalized = nonEmptyText(
        templateID,
        `${prefix}.templateIDs[${templateIndex}]`,
      );
      assertUnique(normalized, disabledTemplateIDs, "disabledMissions templateID");
      for (const alias of normalizedTemplateAliases(normalized)) {
        disabledTemplateAliases.add(alias);
      }
      return normalized;
    });
    return { missionID, templateIDs };
  });

  const generatedMissionIDRange = value.generatedMissionIDRange;
  if (!generatedMissionIDRange || typeof generatedMissionIDRange !== "object") {
    throw new TypeError("generatedMissionIDRange must be an object");
  }
  const minInclusive = positiveInteger(
    generatedMissionIDRange.minInclusive,
    "generatedMissionIDRange.minInclusive",
  );
  const maxExclusive = positiveInteger(
    generatedMissionIDRange.maxExclusive,
    "generatedMissionIDRange.maxExclusive",
  );
  if (maxExclusive <= minInclusive) {
    throw new TypeError("generatedMissionIDRange.maxExclusive must exceed minInclusive");
  }

  if (!Array.isArray(value.retiredTemplatePrefixes) || value.retiredTemplatePrefixes.length <= 0) {
    throw new TypeError("retiredTemplatePrefixes must be a non-empty array");
  }
  const retiredPrefixKeys = new Set();
  const retiredTemplatePrefixes = value.retiredTemplatePrefixes.map((prefix, index) => {
    const normalized = nonEmptyText(prefix, `retiredTemplatePrefixes[${index}]`)
      .toLowerCase();
    assertUnique(normalized, retiredPrefixKeys, "retiredTemplatePrefixes");
    return normalized;
  });

  for (const { missionID, templateID } of goldenSecurityMissions) {
    if (missionID >= minInclusive && missionID < maxExclusive) {
      throw new TypeError(
        `golden missionID ${missionID} cannot be inside generatedMissionIDRange`,
      );
    }
    const goldenTemplateAliases = normalizedTemplateAliases(templateID);
    if (goldenTemplateAliases.some((alias) => disabledTemplateAliases.has(alias))) {
      throw new TypeError(
        `templateID ${templateID} cannot be both golden and disabled`,
      );
    }
    const normalizedTemplateID = templateID.toLowerCase();
    if (retiredTemplatePrefixes.some((prefix) => normalizedTemplateID.startsWith(prefix))) {
      throw new TypeError(
        `golden templateID ${templateID} cannot use a retired template prefix`,
      );
    }
  }

  return {
    version,
    goldenSecurityMissions,
    disabledMissions,
    generatedMissionIDRange: { minInclusive, maxExclusive },
    retiredTemplatePrefixes,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

const productionMissionPolicy = deepFreeze(
  validateProductionMissionPolicy(rawPolicy),
);

const disabledMissionTemplateIdentifiers = new Set(
  productionMissionPolicy.disabledMissions.flatMap(({ templateIDs }) =>
    templateIDs.flatMap(normalizedTemplateAliases)),
);

function normalizeStableMissionIdentity(value) {
  let normalized = String(value == null ? "" : value).trim().toLowerCase();
  let match = normalized.match(/^(?:mission|client-mission|retail-mission):(.+)$/);
  while (match) {
    normalized = String(match[1] || "").trim().toLowerCase();
    match = normalized.match(/^(?:mission|client-mission|retail-mission):(.+)$/);
  }
  return normalized;
}

function isDisabledMissionIdentifier(value) {
  const normalized = normalizeStableMissionIdentity(value);
  if (!/^-?\d+$/.test(normalized)) {
    return false;
  }
  const missionID = Number.parseInt(normalized, 10);
  return productionMissionPolicy.disabledMissions.some(
    ({ missionID: disabledMissionID }) => missionID === disabledMissionID,
  );
}

function isGeneratedMissionIdentifier(value) {
  const normalized = normalizeStableMissionIdentity(value);
  if (!/^-?\d+$/.test(normalized)) {
    return false;
  }
  const missionID = Number.parseInt(normalized, 10);
  return missionID >= productionMissionPolicy.generatedMissionIDRange.minInclusive &&
    missionID < productionMissionPolicy.generatedMissionIDRange.maxExclusive;
}

function isDisabledMissionTemplateIdentifier(value) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return Boolean(normalized) && disabledMissionTemplateIdentifiers.has(normalized);
}

function isDisabledMissionSourceURL(value) {
  const normalized = String(value == null ? "" : value).trim();
  if (!normalized) {
    return false;
  }
  try {
    const parsed = new URL(normalized, "https://eve-survival.org/");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname !== "eve-survival.org" && hostname !== "www.eve-survival.org") {
      return false;
    }
    for (const [key, queryValue] of parsed.searchParams.entries()) {
      if (
        key.toLowerCase() === "wakka" &&
        isDisabledMissionTemplateIdentifier(queryValue)
      ) {
        return true;
      }
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function isRetiredMissionTemplateIdentifier(value) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return isDisabledMissionTemplateIdentifier(normalized) ||
    isDisabledMissionSourceURL(normalized) ||
    productionMissionPolicy.retiredTemplatePrefixes.some((prefix) =>
      normalized.startsWith(prefix)) ||
    isDisabledMissionIdentifier(normalized) ||
    isGeneratedMissionIdentifier(normalized);
}

module.exports = {
  isDisabledMissionIdentifier,
  isDisabledMissionSourceURL,
  isDisabledMissionTemplateIdentifier,
  isGeneratedMissionIdentifier,
  isRetiredMissionTemplateIdentifier,
  normalizeStableMissionIdentity,
  isValidMissionPresentation,
  isValidMissionRewardPresentation,
  isValidMissionSetup,
  productionMissionPolicy,
  validateProductionMissionPolicy,
};
