const BaseService = require("../baseService");

class StargateService extends BaseService {
  constructor() {
    super("stargate");
  }

  Handle_get_fuel_energy() {
    return 0;
  }
}

module.exports = StargateService;
