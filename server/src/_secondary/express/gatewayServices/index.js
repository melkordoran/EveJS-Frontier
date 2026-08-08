const { createCompatibilityGatewayService } = require("./compatibilityGatewayService");
const {
  createAssemblyGateGatewayService,
} = require("./assemblyGateGatewayService");
const {
  createAssemblyNetworkNodeGatewayService,
} = require("./assemblyNetworkNodeGatewayService");
const {
  createAssemblyStorageUnitGatewayService,
} = require("./assemblyStorageUnitGatewayService");
const {
  createFrontierWalletGatewayService,
} = require("./frontierWalletGatewayService");
const {
  createFrontierTokenExchangeGatewayService,
} = require("./frontierTokenExchangeGatewayService");
const { createCorpGoalsGatewayService } = require("./corpGoalsGatewayService");
const { createCorpColorsGatewayService } = require("./corpColorsGatewayService");
const { createEvermarksGatewayService } = require("./evermarksGatewayService");
const { createFreelanceGatewayService } = require("./freelanceGatewayService");
const {
  createFwAdvantageGatewayService,
} = require("./fwAdvantageGatewayService");
const { createInsurgencyGatewayService } = require("./insurgencyGatewayService");
const {
  createMercenaryDenGatewayService,
} = require("./mercenaryDenGatewayService");
const {
  createLocalChatGatewayService,
} = require("./localChatGatewayService");
const {
  createNewEdenStoreGatewayService,
} = require("./newEdenStoreGatewayService");
const { createPlexVaultGatewayService } = require("./plexVaultGatewayService");
const {
  createSovereigntyGatewayService,
} = require("./sovereigntyGatewayService");
const {
  createStructurePaintworkGatewayService,
} = require("./structurePaintworkGatewayService");
const {
  createShipLogoGatewayService,
} = require("./shipLogoGatewayService");
const {
  createSkillPlanGatewayService,
} = require("./skillPlanGatewayService");
const {
  createCorpSkillPlanGatewayService,
} = require("./corpSkillPlanGatewayService");
const {
  createMapTagsGatewayService,
} = require("./mapTagsGatewayService");
const {
  createCampaignGatewayService,
} = require("./campaignGatewayService");
const {
  createDailyGoalsGatewayService,
} = require("./dailyGoalsGatewayService");

function createGatewayServiceRegistry(context) {
  const services = [
    createAssemblyGateGatewayService(context),
    createAssemblyNetworkNodeGatewayService(context),
    createAssemblyStorageUnitGatewayService(context),
    createFrontierWalletGatewayService(context),
    createFrontierTokenExchangeGatewayService(context),
    createCorpGoalsGatewayService(context),
    createCorpColorsGatewayService(context),
    createEvermarksGatewayService(context),
    createFreelanceGatewayService(context),
    createFwAdvantageGatewayService(context),
    createInsurgencyGatewayService(context),
    createNewEdenStoreGatewayService(context),
    createPlexVaultGatewayService(context),
    createStructurePaintworkGatewayService(context),
    createShipLogoGatewayService(context),
    createSovereigntyGatewayService(context),
    createMercenaryDenGatewayService(context),
    createLocalChatGatewayService(context),
    createSkillPlanGatewayService(context),
    createCorpSkillPlanGatewayService(context),
    createMapTagsGatewayService(context),
    createCampaignGatewayService(context),
    createDailyGoalsGatewayService(context),
    createCompatibilityGatewayService(context),
  ];

  return {
    services,
    getEmptySuccessResponseType(requestTypeName) {
      for (const service of services) {
        if (typeof service.getEmptySuccessResponseType !== "function") {
          continue;
        }

        const responseTypeName = service.getEmptySuccessResponseType(
          requestTypeName,
        );
        if (responseTypeName) {
          return responseTypeName;
        }
      }

      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      for (const service of services) {
        const result = service.handleRequest(requestTypeName, requestEnvelope);
        if (result) {
          return result;
        }
      }

      return null;
    },
  };
}

module.exports = {
  createGatewayServiceRegistry,
};
