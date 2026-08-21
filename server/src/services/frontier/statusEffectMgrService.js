const BaseService = require("../baseService");
const { buildDict } = require("../_shared/serviceHelpers");

// Build 3474408 accepted-shape evidence:
//
// * frontier/status_effect/client/service.pyc forwards get_effect_config as a
//   keyword call and returns the result unchanged.
// * frontier/hud/heat/integration.pyc treats the result as a mapping and reads
//   raiment_type_id / raiment_nominal_max_bonus with `or 0` / `or 0.0`.
// * frontier/hud/status_effects/insider.pyc seeds its per-effect mapping with
//   exact `.get` fallbacks: three 0.0 grace values, two 1.0 trait intervals,
//   false for has_medical_traits, and an empty severity_curve mapping.
//
// Those observations prove fields and client-accepted fallback values; they do
// not reveal CCP's production server payload.  EveJS locally chooses to return
// their union as a complete neutral policy because status-effect progression
// and raiment bonuses are not implemented.  An empty mapping would satisfy the
// normal heat consumer, but would needlessly omit fields other client tooling
// directly indexes.
const LOCAL_NEUTRAL_STATUS_EFFECT_CONFIG_ENTRIES = Object.freeze([
  Object.freeze(["grace_increment", 0.0]),
  Object.freeze(["grace_decrement", 0.0]),
  Object.freeze(["grace_severity_bonus", 0.0]),
  Object.freeze(["trait_interval_low", 1.0]),
  Object.freeze(["trait_interval_high", 1.0]),
  Object.freeze(["has_medical_traits", false]),
  Object.freeze(["severity_curve", null]),
  Object.freeze(["raiment_type_id", 0]),
  Object.freeze(["raiment_nominal_max_bonus", 0.0]),
]);

function buildNeutralStatusEffectConfig() {
  return buildDict(
    LOCAL_NEUTRAL_STATUS_EFFECT_CONFIG_ENTRIES.map(([key, value]) => [
      key,
      key === "severity_curve" ? buildDict([]) : value,
    ]),
  );
}

class StatusEffectMgrService extends BaseService {
  constructor() {
    super("statusEffectMgr");
  }

  Handle_get_grace_state() {
    return [0.0, false];
  }

  Handle_get_effect_config() {
    return buildNeutralStatusEffectConfig();
  }
}

module.exports = StatusEffectMgrService;
module.exports._testing = {
  LOCAL_NEUTRAL_STATUS_EFFECT_CONFIG_ENTRIES,
  buildNeutralStatusEffectConfig,
};
