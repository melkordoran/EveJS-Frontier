const BaseService = require("../baseService");
const log = require("../../utils/logger");
const { throwWrappedUserError } = require("../../common/machoErrors");
const {
  buildDict,
  buildKeyVal,
  buildList,
} = require("../_shared/serviceHelpers");

const PATHWAY_CATEGORY_IDS = Object.freeze([1, 2, 3, 4]);
const UNSUPPORTED_PROGRESSION_MUTATION_NOTIFY =
  "Memory cards and ascension mutations are not available yet.";

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

function buildEmptyMemoryPointTotals() {
  // ExperienceService.calculate_memory_point_totals() in client 3467658
  // creates this same int-keyed map from PathwayCategory enum values.
  return buildDict(PATHWAY_CATEGORY_IDS.map((categoryID) => [categoryID, 0]));
}

function throwUnsupportedProgressionMutation(methodName) {
  log.debug(
    `[experience] ${methodName} rejected: progression mutation unavailable`,
  );
  throwWrappedUserError("CustomNotify", {
    notify: UNSUPPORTED_PROGRESSION_MUTATION_NOTIFY,
  });
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

  Handle_get_memories_from_crown() {
    return buildEmptyMemories();
  }

  Handle_get_memory_point_totals() {
    return buildEmptyMemoryPointTotals();
  }

  Handle_get_ascension_choices() {
    // PointSelectionIntegration treats a falsey/empty result as no choices.
    return buildList([]);
  }

  Handle_delete_memory() {
    return throwUnsupportedProgressionMutation("delete_memory");
  }

  Handle_ascend() {
    return throwUnsupportedProgressionMutation("ascend");
  }

  Handle_implant_crown() {
    return throwUnsupportedProgressionMutation("implant_crown");
  }

  Handle_implant_reignment() {
    return throwUnsupportedProgressionMutation("implant_reignment");
  }

  Handle_delete_active_reignment() {
    return throwUnsupportedProgressionMutation("delete_active_reignment");
  }

  Handle_delete_active_crown() {
    return throwUnsupportedProgressionMutation("delete_active_crown");
  }
}

module.exports = ExperienceService;
module.exports.buildEmptyMemories = buildEmptyMemories;
module.exports._testing = {
  PATHWAY_CATEGORY_IDS,
  UNSUPPORTED_PROGRESSION_MUTATION_NOTIFY,
  buildEmptyCharacterExperience,
  buildEmptyCharacterProgression,
  buildEmptyMemories,
  buildEmptyMemoryPointTotals,
};
