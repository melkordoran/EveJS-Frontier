const BaseService = require("../baseService");
const { buildDict } = require("../_shared/serviceHelpers");
const { throwWrappedUserError } = require("../../common/machoErrors");
const log = require("../../utils/logger");

const defaultRuntime = require("./berthingRuntime");

const ERROR_MESSAGES = Object.freeze({
  BERTHING_CONTRACT_NOT_FOUND: "This ship is not berthed at that assembly.",
  BERTHING_HOST_NOT_FOUND: "The SmartHangar is no longer available.",
  BERTHING_HOST_NOT_OPERATIONAL: "The SmartHangar is not operational.",
  BERTHING_HOST_NOT_OWNED: "You do not own this SmartHangar.",
  BERTHING_HOST_NOT_SMART_HANGAR: "This assembly does not provide a SmartHangar.",
  BERTHING_NOT_IN_SPACE: "You must be in space to berth a ship.",
  BERTHING_OUT_OF_RANGE: "Move within SmartHangar access range before docking.",
  BERTHING_SHIP_GROUP_NOT_ACCEPTED: "This SmartHangar does not accept your ship class.",
  BERTHING_SHIP_NOT_FOUND: "Your active ship could not be found.",
  BERTHING_RELOCATION_FAILED: "Your ship could not be moved into or out of the SmartHangar.",
  BERTHING_STATE_WRITE_FAILED: "The SmartHangar could not save your berthing state.",
});

function buildContractResponse(contract) {
  if (!contract) {
    return null;
  }
  return buildDict([
    ["host_assembly_id", contract.hostAssemblyID],
    ["occupied_ship_id", contract.occupiedShipID],
    ["char_id", contract.characterID],
    ["solar_system_id", contract.solarSystemID],
    ["phase", contract.phase],
    ["signed_at", contract.signedAt],
  ]);
}

function throwBerthingError(result) {
  const reason = String(result && result.errorMsg || "BERTHING_FAILED");
  throwWrappedUserError("CustomNotify", {
    notify: ERROR_MESSAGES[reason] || `SmartHangar docking failed: ${reason}`,
  });
}

class BerthingSvcService extends BaseService {
  constructor(options = {}) {
    super("berthingSvc");
    this.runtime = options.runtime || defaultRuntime;
  }

  _runContractAction(action, args, session) {
    const hostAssemblyID = Number(args && args[0]) || 0;
    const result = action.call(this.runtime, session, hostAssemblyID);
    if (!result || result.success !== true) {
      log.info(
        `[BerthingSvc] ${action.name || "contract action"} rejected ` +
          `char=${session && session.characterID} host=${hostAssemblyID} ` +
          `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwBerthingError(result);
    }
    return buildContractResponse(result.data && result.data.contract);
  }

  Handle_get_my_contract(_args, session) {
    return buildContractResponse(this.runtime.getContractForSession(session));
  }

  Handle_begin_berth(args, session) {
    return this._runContractAction(this.runtime.beginBerth, args, session);
  }

  Handle_berth(args, session) {
    return this._runContractAction(this.runtime.berth, args, session);
  }

  Handle_complete_berth(args, session) {
    return this._runContractAction(this.runtime.completeBerth, args, session);
  }

  Handle_undock_berth(args, session) {
    this._runContractAction(this.runtime.undockBerth, args, session);
    return null;
  }

  Handle_eject_occupied_ship(args, session) {
    this._runContractAction(this.runtime.ejectOccupiedShip, args, session);
    return null;
  }
}

BerthingSvcService.buildContractResponse = buildContractResponse;

module.exports = BerthingSvcService;
