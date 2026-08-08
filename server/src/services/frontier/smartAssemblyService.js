const BaseService = require("../baseService");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
const { throwWrappedUserError } = require("../../common/machoErrors");
const log = require("../../utils/logger");

const ASSEMBLY_STATUS_OFFLINE = 1;
const ASSEMBLY_STATUS_ONLINE = 2;

const ERROR_MESSAGES = Object.freeze({
  ASSEMBLY_ACCESS_DENIED: "You do not own this assembly.",
  ASSEMBLY_NOT_CHAIN_ANCHORED: "This assembly does not require a chain state transition.",
  ASSEMBLY_NOT_FOUND: "The assembly is no longer available.",
  ASSEMBLY_NOT_IN_CURRENT_SYSTEM: "You must be in the assembly's solar system.",
  ASSEMBLY_NOT_SMART_GATE: "That assembly is not a smart gate.",
  ASSEMBLY_TRANSACTION_MISMATCH: "The assembly transaction no longer matches this action.",
  ASSEMBLY_TRANSACTION_NOT_FOUND: "The assembly transaction expired. Try the action again.",
  ASSEMBLY_UNDER_CONSTRUCTION: "Construction must finish before this assembly can be onlined.",
  INVALID_ASSEMBLY_SIGNATURE: "The signed assembly transaction could not be verified.",
  INVALID_ASSEMBLY_STATE: "The requested assembly state is invalid.",
  SMART_GATE_ALREADY_LINKED: "One of those Heavy Gates is already linked.",
  SMART_GATE_DESTINATION_OFFLINE: "The destination Heavy Gate must be online before jumping.",
  SMART_GATE_DESTINATION_REQUIRED: "Link this Heavy Gate to a destination before bringing it online.",
  SMART_GATE_DESTINATION_UNAVAILABLE: "The destination Heavy Gate has no usable arrival point.",
  SMART_GATE_JUMP_FAILED: "The Heavy Gate jump could not be completed.",
  SMART_GATE_LINK_MISMATCH: "The Heavy Gate link is no longer reciprocal.",
  SMART_GATE_MUST_BE_OFFLINE: "Both Heavy Gates must be offline before changing their link.",
  SMART_GATE_NOT_LINKED: "This Heavy Gate is not linked.",
  SMART_GATE_OFFLINE: "This Heavy Gate must be online before jumping.",
  SMART_GATE_OUT_OF_RANGE: "The selected Heavy Gate is outside this gate's jump range.",
  SMART_GATE_SAME_SYSTEM: "Heavy Gates must link across different solar systems.",
  SMART_GATE_SELF_LINK: "A Heavy Gate cannot link to itself.",
  SMART_GATE_TYPE_MISMATCH: "Heavy Gates can only link to another gate of the same type.",
  SHIP_NOT_IN_SPACE: "You need an active ship in space to use this Heavy Gate.",
});

function throwAssemblyError(result) {
  const reason = String(result && result.errorMsg || "ASSEMBLY_STATE_CHANGE_FAILED");
  throwWrappedUserError("CustomNotify", {
    notify: ERROR_MESSAGES[reason] || `Assembly state change failed: ${reason}`,
  });
}

function getDeploymentRuntime() {
  return require("./deploymentRuntime");
}

class SmartAssemblyService extends BaseService {
  constructor() {
    super("smartAssemblyService");
  }

  Handle_get_my_assemblies(_args, session) {
    return buildList(
      getDeploymentRuntime().listMyAssemblies(session).map((record) => (
        buildDict(Object.entries(record))
      )),
    );
  }

  _beginStateTransition(args, session, targetStatus) {
    const itemID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().beginAssemblyStateTransition(
      session,
      itemID,
      targetStatus,
    );
    if (!result || result.success !== true || !result.data) {
      log.info(
        `[smartAssemblyService] State transition rejected char=${session && session.characterID} ` +
          `item=${itemID} target=${targetStatus} reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwAssemblyError(result);
    }
    return buildDict([
      ["transaction_data", result.data.transactionData],
      ["transaction_uuid", result.data.transactionUUID],
    ]);
  }

  _commitStateTransition(args, session, targetStatus) {
    const itemID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().commitAssemblyStateTransition(
      session,
      itemID,
      args && args[1],
      args && args[2],
      targetStatus,
    );
    if (!result || result.success !== true) {
      log.info(
        `[smartAssemblyService] Signed state transition rejected ` +
          `char=${session && session.characterID} item=${itemID} ` +
          `target=${targetStatus} reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      return false;
    }
    return true;
  }

  Handle_set_online(args, session) {
    return this._beginStateTransition(args, session, ASSEMBLY_STATUS_ONLINE);
  }

  Handle_set_online_signature(args, session) {
    return this._commitStateTransition(args, session, ASSEMBLY_STATUS_ONLINE);
  }

  Handle_set_offline(args, session) {
    return this._beginStateTransition(args, session, ASSEMBLY_STATUS_OFFLINE);
  }

  Handle_set_offline_signature(args, session) {
    return this._commitStateTransition(args, session, ASSEMBLY_STATUS_OFFLINE);
  }

  Handle_on_interaction(args, session) {
    const itemID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().recordAssemblyInteraction(
      session,
      itemID,
    );
    if (!result || result.success !== true) {
      throwAssemblyError(result);
    }
    return null;
  }

  Handle_link_gates(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const destinationGateID = Number(args && args[1]) || 0;
    const result = getDeploymentRuntime().beginGateLinkTransition(
      session,
      gateID,
      destinationGateID,
    );
    if (!result || result.success !== true || !result.data) {
      log.info(
        `[smartAssemblyService] Gate link rejected char=${session && session.characterID} ` +
          `source=${gateID} destination=${destinationGateID} ` +
          `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwAssemblyError(result);
    }
    return buildDict([
      ["transaction_data", result.data.transactionData],
      ["transaction_uuid", result.data.transactionUUID],
    ]);
  }

  Handle_link_gates_signature(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().commitGateLinkTransition(
      session,
      gateID,
      args && args[1],
      args && args[2],
    );
    if (!result || result.success !== true) {
      log.info(
        `[smartAssemblyService] Signed gate link rejected ` +
          `char=${session && session.characterID} source=${gateID} ` +
          `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      return false;
    }
    return true;
  }

  Handle_gate_jump(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().beginGateJumpTransition(
      session,
      gateID,
    );
    if (!result || result.success !== true || !result.data) {
      log.info(
        `[smartAssemblyService] Gate jump rejected char=${session && session.characterID} ` +
          `source=${gateID} reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwAssemblyError(result);
    }
    return buildDict([
      ["transaction_data", result.data.transactionData],
      ["transaction_uuid", result.data.transactionUUID],
    ]);
  }

  Handle_gate_jump_signature(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().commitGateJumpTransition(
      session,
      gateID,
      args && args[1],
      args && args[2],
    );
    if (!result || result.success !== true) {
      log.info(
        `[smartAssemblyService] Signed gate jump rejected ` +
          `char=${session && session.characterID} source=${gateID} ` +
          `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwAssemblyError(result);
    }
    return true;
  }

  Handle_unlink_gate(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().beginGateUnlinkTransition(
      session,
      gateID,
    );
    if (!result || result.success !== true || !result.data) {
      log.info(
        `[smartAssemblyService] Gate unlink rejected char=${session && session.characterID} ` +
          `source=${gateID} reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      throwAssemblyError(result);
    }
    return buildDict([
      ["transaction_data", result.data.transactionData],
      ["transaction_uuid", result.data.transactionUUID],
    ]);
  }

  Handle_unlink_gate_signature(args, session) {
    const gateID = Number(args && args[0]) || 0;
    const result = getDeploymentRuntime().commitGateUnlinkTransition(
      session,
      gateID,
      args && args[1],
      args && args[2],
    );
    if (!result || result.success !== true) {
      log.info(
        `[smartAssemblyService] Signed gate unlink rejected ` +
          `char=${session && session.characterID} source=${gateID} ` +
          `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      return false;
    }
    return true;
  }
}

module.exports = SmartAssemblyService;
