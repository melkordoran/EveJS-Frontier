const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const config = require(path.join(__dirname, "../../config"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const crimewatchState = require(path.join(__dirname, "./crimewatchState"));
const {
  buildList,
  buildBoundObjectResponse,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

class CrimewatchService extends BaseService {
  constructor() {
    super("crimewatch");
    // TQ keeps one crimewatch remote object alive for the client session and
    // returns that same OID on subsequent binds until the client releases it.
    this.reuseBoundObjectForSession = true;
  }

  _resolveReferenceMs(session, fallback = Date.now()) {
    return (
      session &&
      session._space &&
      Number.isFinite(Number(session._space.simTimeMs))
    )
      ? Number(session._space.simTimeMs)
      : fallback;
  }

  _resolveSessionCharacterID(session) {
    return (
      session &&
      (session.characterID || session.charID || session.charid || session.userid)
    ) || 0;
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const bindParameter = args && args[0];
    void bindParameter;
    log.debug("[CrimewatchService] MachoResolveObject called");
    // The EVE client requests a bound object from this service.
    // In EVEmu, this returns the Node ID (e.g. 888444).
    // We return our configured proxy node ID.
    return config.proxyNodeId;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug(
      `[CrimewatchService] MachoBindObject args=${args ? args.length : 0}`,
    );
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetClientStates(args, session, kwargs) {
    log.debug("[CrimewatchService] GetClientStates called");
    const now = this._resolveReferenceMs(session, Date.now());
    return crimewatchState.buildClientStatesForSession(session, now);
  }

  Handle_GetSafetyLevel(args, session) {
    const characterID = this._resolveSessionCharacterID(session);
    return crimewatchState.getSafetyLevel(characterID);
  }

  Handle_SetSafetyLevel(args, session) {
    const characterID = this._resolveSessionCharacterID(session);
    const rawSafetyLevel = Array.isArray(args) && args.length > 0
      ? Number(args[0])
      : crimewatchState.SAFETY_LEVEL_FULL;
    const requestedSafetyLevel = Number.isFinite(rawSafetyLevel)
      ? rawSafetyLevel
      : crimewatchState.SAFETY_LEVEL_FULL;
    const result = crimewatchState.setSafetyLevel(
      characterID,
      requestedSafetyLevel,
    );
    return result.success ? result.data.safetyLevel : crimewatchState.SAFETY_LEVEL_FULL;
  }

  Handle_GetMySecurityStatus(args, session) {
    const charID =
      (session && (session.characterID || session.charid || session.userid)) || 0;
    const charData = charID ? getCharacterRecord(charID) || {} : {};
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? 0,
    );
    const normalizedStatus = Number.isFinite(securityStatus) ? securityStatus : 0;

    log.debug(
      `[CrimewatchService] GetMySecurityStatus(charID=${charID}) -> ${normalizedStatus}`,
    );

    return normalizedStatus;
  }

  Handle_GetCharacterSecurityStatus(args, session) {
    const charID =
      (args && args.length > 0 ? Number(args[0]) || 0 : 0) ||
      (session && (session.characterID || session.charid || session.userid)) ||
      0;
    const charData = charID ? getCharacterRecord(charID) || {} : {};
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? 0,
    );
    const normalizedStatus = Number.isFinite(securityStatus) ? securityStatus : 0;

    log.debug(
      `[CrimewatchService] GetCharacterSecurityStatus(charID=${charID}) -> ${normalizedStatus}`,
    );

    return normalizedStatus;
  }

  Handle_GetSecurityStatusTransactions() {
    log.debug("[CrimewatchService] GetSecurityStatusTransactions -> []");
    return buildList([]);
  }
}

module.exports = CrimewatchService;
