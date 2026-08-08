const BaseService = require("../baseService");

class StatusEffectMgrService extends BaseService {
  constructor() {
    super("statusEffectMgr");
  }

  Handle_get_grace_state() {
    return [0.0, false];
  }
}

module.exports = StatusEffectMgrService;
