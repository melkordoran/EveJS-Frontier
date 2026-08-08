const BaseService = require("../baseService");
const { buildDict } = require("../_shared/serviceHelpers");

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

  Handle_get_memories_from_character() {
    return buildEmptyMemories();
  }

  Handle_get_memories_from_shell() {
    return buildEmptyMemories();
  }
}

module.exports = ExperienceService;
module.exports.buildEmptyMemories = buildEmptyMemories;
