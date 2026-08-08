const BaseService = require("../baseService");
const log = require("../../utils/logger");
const {
  buildDict,
  buildKeyVal,
  buildList,
} = require("../_shared/serviceHelpers");

const PATHWAY_CATEGORY_IDS = Object.freeze([1, 2, 3, 4]);

function getSessionCharacterID(session) {
  const characterID = Number(
    session && (session.characterID || session.charid || session.charID),
  );
  return Number.isInteger(characterID) && characterID > 0 ? characterID : 0;
}

function buildEmptyCharacterExperience() {
  return buildDict([
    ["total_xp", 0],
    ["cap", 0],
    [
      "category_xp",
      buildDict(PATHWAY_CATEGORY_IDS.map((categoryID) => [String(categoryID), 0])),
    ],
  ]);
}

function buildEmptyCharacterProgression() {
  return buildList(
    PATHWAY_CATEGORY_IDS.map((categoryID) =>
      buildKeyVal([
        ["categoryID", categoryID],
        ["points", 0],
      ]),
    ),
  );
}

function buildEmptyMemories() {
  return buildDict([
    ["shell_memories", buildDict([])],
    ["crown_memories", buildDict([])],
  ]);
}

class ExperienceService extends BaseService {
  constructor() {
    super("experience");
  }

  Handle_get_character(_args, session) {
    const characterID = getSessionCharacterID(session);
    log.debug(`[experience] get_character char=${characterID || "none"} state=bootstrap`);
    return buildEmptyCharacterExperience();
  }

  Handle_get_character_progression(_args, session) {
    const characterID = getSessionCharacterID(session);
    log.debug(
      `[experience] get_character_progression char=${characterID || "none"} state=bootstrap`,
    );
    return buildEmptyCharacterProgression();
  }

  Handle_get_memories_from_character() {
    return buildEmptyMemories();
  }

  Handle_get_memories_from_shell() {
    return buildEmptyMemories();
  }
}

module.exports = ExperienceService;
module.exports.buildEmptyMemories = buildEmptyMemories;
