const BaseService = require("../baseService");

function getSessionCharacterID(session) {
  return Number(
    session && (session.characterID || session.charID || session.charid),
  ) || 0;
}

class KisnService extends BaseService {
  constructor() {
    super("kisnService");
  }

  Handle_get_serial_number(_args, session) {
    const characterID = getSessionCharacterID(session);
    return characterID > 0 ? String(characterID) : null;
  }
}

module.exports = KisnService;
module.exports._testing = {
  getSessionCharacterID,
};
