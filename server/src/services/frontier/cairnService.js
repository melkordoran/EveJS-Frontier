const BaseService = require("../baseService");
const { buildList } = require("../_shared/serviceHelpers");

class CairnService extends BaseService {
  constructor(serviceName = "cairnService") {
    super(serviceName);
  }

  Handle_get_visible_cairns() {
    // System view iterates the result before creating any cairn brackets.
    return buildList([]);
  }
}

module.exports = CairnService;
