const BaseService = require("../baseService");
const { buildList } = require("../_shared/serviceHelpers");
const { throwWrappedUserError } = require("../../common/machoErrors");
const log = require("../../utils/logger");

const ERROR_MESSAGES = Object.freeze({
  ASSEMBLY_CREATE_FAILED: "The assembly could not be created in the current ballpark.",
  ASSEMBLY_TYPE_NOT_FOUND: "This client build does not contain the requested assembly type.",
  ASSEMBLY_TYPE_NOT_SUPPORTED: "This assembly cannot be deployed by the local Frontier server yet.",
  CONSTRUCTION_SITE_TYPE_NOT_FOUND: "The construction-depot type is absent from this client build.",
  DEPLOYMENT_TOO_FAR: "The construction site must be placed within range of your ship.",
  INSUFFICIENT_PLACEMENT_MATERIALS: "The required placement materials are no longer in your ship cargo.",
  INVALID_DEPLOYMENT_PLACEMENT: "The client supplied an invalid construction-site position.",
  NOT_IN_SPACE: "You must be in space to place a construction site.",
  SHIP_NOT_IN_SPACE: "Your active ship is not available in the current ballpark.",
  TOO_MANY_CONSTRUCTION_SITES: "You already have the maximum number of active construction sites.",
});

function throwDeploymentError(result) {
  const reason = String(result && result.errorMsg || "DEPLOYMENT_FAILED");
  throwWrappedUserError("CustomNotify", {
    notify: ERROR_MESSAGES[reason] || `Construction request failed: ${reason}`,
  });
}

function getDeploymentRuntime() {
  return require("./deploymentRuntime");
}

class DeploymentMgrService extends BaseService {
  constructor() {
    super("deploymentMgr");
  }

  Handle_get_claimed_packs() {
    return buildList([]);
  }

  Handle_build_deployable(args, session) {
    const typeID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().buildDeployable(
      session,
      typeID,
      args && args[1],
      args && args[2],
    );
    if (!result || result.success !== true) {
      const details = result && result.data && typeof result.data === "object"
        ? result.data
        : {};
      const placementDetails = Number.isFinite(Number(details.deploymentDistance))
        ? ` distance=${Number(details.deploymentDistance).toFixed(1)}` +
          ` limit=${Number(details.maxDeploymentDistance || 0).toFixed(1)}` +
          ` frame=${details.positionFrame || "unknown"}` +
          ` anchor=${details.buildAnchor || "unknown"}`
        : "";
      log.info(
        `[deploymentMgr] build_deployable rejected char=${session && session.characterID} ` +
          `type=${typeID} reason=${result && result.errorMsg || "UNKNOWN"}` +
          placementDetails,
      );
      throwDeploymentError(result);
    }
    return null;
  }

  Handle_cancel_construction(args, session) {
    const itemID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().cancelConstruction(session, itemID);
    if (!result || result.success !== true) {
      throwDeploymentError(result);
    }
    return null;
  }
}

module.exports = DeploymentMgrService;
