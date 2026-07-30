const path = require("path");
const crypto = require("crypto");

const {
  buildDailyGoalsProtoRoot,
} = require(path.join(__dirname, "../../../services/dailyGoals/dailyGoalsProto"));
const dailyGoalsState = require(path.join(
  __dirname,
  "../../../services/dailyGoals/dailyGoalsState",
));
const {
  CATEGORY,
  rewardsForDailyTemplate,
  rewardsForBonusTemplate,
  paymentsForMilestone,
} = require(path.join(__dirname, "../../../services/dailyGoals/dailyGoalsCatalog"));
const {
  encodePayload,
  getActiveCharacterID,
  sliceWithPage,
  timestampFromMs,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");

const REQUEST_PREFIX = "eve_public.dailygoal.api.";

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.dailygoal.api.GetAllCurrentRequest",
  "eve_public.dailygoal.api.GetAllWithRewardsRequest",
  "eve_public.dailygoal.api.GetAllCompletedWithEntitlementsRequest",
  "eve_public.dailygoal.api.GetRequest",
  "eve_public.dailygoal.api.RedeemRequest",
  "eve_public.dailygoal.api.RedeemAllRequest",
  "eve_public.dailygoal.api.PayForCompletionRequest",
]);

function normalizeRequestTypeName(requestTypeName) {
  return String(requestTypeName || "")
    .replace(".api.requests_pb2.", ".api.")
    .replace(".api.notices_pb2.", ".api.");
}

function buildIdentifier(uuidString) {
  return { uuid: uuidStringToBuffer(uuidString) };
}

// The client parses every reward's asset id with `uuid.UUID(bytes=payment.asset.uuid)`,
// which raises on empty bytes and drops the whole goal. Give each payment a
// stable, non-empty 16-byte asset uuid derived from the goal uuid + index.
function withRewardAssets(payments, seedUuid) {
  return (payments || []).map((payment, index) => ({
    ...payment,
    asset: {
      uuid: crypto
        .createHash("sha256")
        .update(`${seedUuid}:${index}`)
        .digest()
        .subarray(0, 16),
    },
  }));
}

// Reward preview spec (Payment[]) the client renders under "Rewards".
function paymentsForTemplate(template) {
  if (!template) {
    return [];
  }
  return template.isBonus ? rewardsForBonusTemplate() : rewardsForDailyTemplate();
}

function buildAttributes(descriptor) {
  const template = descriptor.template;
  const attributes = {
    name_message: { sequential: template.nameMessageID },
    description_message: { sequential: template.descriptionMessageID },
    help_text_message: { sequential: template.helpTextMessageID },
    category: descriptor.category,
    contribution_configuration: { [template.contribution]: {} },
    payment: withRewardAssets(paymentsForTemplate(template), descriptor.uuid),
    target: template.target,
    active_after: timestampFromMs(descriptor.activeAfterMs),
    active_until: timestampFromMs(descriptor.activeUntilMs),
    omega: Boolean(template.omega),
  };
  // Tag the goal with its career path (Explorer/Industrialist/Enforcer/Soldier
  // of Fortune) so the client groups/labels it; omitted for the static jumps
  // goal and the bonus, which belong to no career path.
  if (Number(template.careerPath) > 0) {
    attributes.career = { sequential: Number(template.careerPath) };
  }
  return attributes;
}

// Rewards a completed-but-unredeemed goal has earned and can claim. Empty until
// completed and cleared once redeemed, so the client shows the Claim button only
// while there's actually something to claim.
function buildDailyEarnings(descriptor) {
  if (!descriptor.completed || descriptor.redeemed) {
    return [];
  }
  return paymentsForTemplate(descriptor.template).map((payment) => ({
    unit: payment.unit,
    omega_required: false,
  }));
}

// GetAllCurrentResponse.Goal. `payment` (in attributes) is the reward preview;
// `earnings` is the claimable amount once completed.
function buildCurrentGoal(descriptor) {
  return {
    id: buildIdentifier(descriptor.uuid),
    goal: buildAttributes(descriptor),
    current_progress: descriptor.progress,
    entitlements: [],
    earnings: buildDailyEarnings(descriptor),
    paid_completion: Boolean(descriptor.paidCompletion),
  };
}

// Attributes for a Monthly Reward Track milestone (category MONTHLY_BONUS). Its
// contribution is "complete daily bonus goals"; the reward is carried on
// `payment`, and its window spans the calendar month.
function buildMilestoneAttributes(descriptor) {
  const milestone = descriptor.milestone;
  return {
    name_message: { sequential: milestone.nameMessageID },
    description_message: { sequential: milestone.descriptionMessageID },
    help_text_message: { sequential: milestone.helpTextMessageID },
    category: CATEGORY.MONTHLY_BONUS,
    contribution_configuration: { complete_daily_goal: {} },
    payment: withRewardAssets(paymentsForMilestone(milestone), descriptor.uuid),
    target: milestone.target,
    active_after: timestampFromMs(descriptor.monthStartMs),
    active_until: timestampFromMs(descriptor.monthEndMs),
    omega: Boolean(milestone.omega),
  };
}

// Earnings surface the milestone reward as claimable while earned-but-unclaimed.
function buildMilestoneEarnings(descriptor) {
  if (!descriptor.earned || descriptor.claimed) {
    return [];
  }
  return paymentsForMilestone(descriptor.milestone).map((payment) => ({
    unit: payment.unit,
    omega_required: Boolean(descriptor.omega),
  }));
}

// A monthly milestone as a GetAllCurrentResponse.Goal (category MONTHLY_BONUS).
// The client's controller reads the reward track from the current-goals list by
// category, so the milestones must ride along here.
function buildMilestoneCurrentGoal(descriptor) {
  return {
    id: buildIdentifier(descriptor.uuid),
    goal: buildMilestoneAttributes(descriptor),
    current_progress: descriptor.progress,
    entitlements: [],
    earnings: buildMilestoneEarnings(descriptor),
    paid_completion: false,
  };
}

function createDailyGoalsGatewayService(context) {
  const protoRoot = buildDailyGoalsProtoRoot();
  const publishGatewayNotice =
    context && typeof context.publishGatewayNotice === "function"
      ? context.publishGatewayNotice
      : null;
  const lookup = (name) => protoRoot.lookupType(`eve_public.dailygoal.api.${name}`);
  const types = {
    getAllCurrentResponse: lookup("GetAllCurrentResponse"),
    getAllWithRewardsRequest: lookup("GetAllWithRewardsRequest"),
    getAllWithRewardsResponse: lookup("GetAllWithRewardsResponse"),
    getAllCompletedResponse: lookup("GetAllCompletedWithEntitlementsResponse"),
    getRequest: lookup("GetRequest"),
    getResponse: lookup("GetResponse"),
    redeemRequest: lookup("RedeemRequest"),
    payForCompletionRequest: lookup("PayForCompletionRequest"),
    progressedNotice: lookup("ProgressedNotice"),
    completedNotice: lookup("CompletedNotice"),
    redeemedNotice: lookup("RedeemedNotice"),
  };

  // Bridge state-side goal events onto targeted client gateway notices.
  function publishGoalNotice(characterID, event) {
    if (!publishGatewayNotice || !characterID || !event || !event.uuid) {
      return;
    }
    const target = { character: Number(characterID) };
    const id = buildIdentifier(event.uuid);
    if (event.kind === "progressed") {
      publishGatewayNotice(
        "eve_public.dailygoal.api.ProgressedNotice",
        encodePayload(types.progressedNotice, {
          goal: id,
          current_progress: Number(event.currentProgress || 0),
        }),
        target,
      );
    } else if (event.kind === "completed") {
      publishGatewayNotice(
        "eve_public.dailygoal.api.CompletedNotice",
        encodePayload(types.completedNotice, { goal: id }),
        target,
      );
    } else if (event.kind === "redeemed") {
      publishGatewayNotice(
        "eve_public.dailygoal.api.RedeemedNotice",
        encodePayload(types.redeemedNotice, { goal: id }),
        target,
      );
    }
  }

  if (publishGatewayNotice) {
    dailyGoalsState.registerNoticePublisher(publishGoalNotice);
  }

  function ok(responseTypeName, payloadBuffer) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: payloadBuffer || Buffer.alloc(0),
    };
  }

  function decodeRequest(messageType, requestEnvelope) {
    return messageType.decode(
      Buffer.from(
        requestEnvelope &&
          requestEnvelope.payload &&
          requestEnvelope.payload.value
          ? requestEnvelope.payload.value
          : Buffer.alloc(0),
      ),
    );
  }

  function extractGoalUuid(identifier) {
    if (!identifier || !identifier.uuid) {
      return null;
    }
    const buffer = Buffer.from(identifier.uuid);
    if (buffer.length !== 16) {
      return null;
    }
    const hex = buffer.toString("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  return {
    name: "daily-goals",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType(requestTypeName) {
      const normalized = normalizeRequestTypeName(requestTypeName);
      return HANDLED_REQUEST_TYPES.includes(normalized)
        ? normalized.replace(/Request$/, "Response")
        : null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      const normalized = normalizeRequestTypeName(requestTypeName);
      if (!HANDLED_REQUEST_TYPES.includes(normalized)) {
        return null;
      }
      const activeCharacterID = getActiveCharacterID(requestEnvelope);

      if (normalized === `${REQUEST_PREFIX}GetAllCurrentRequest`) {
        // Current goals AND the monthly reward-track milestones — the client
        // categorizes this single list into daily / daily-bonus / monthly-bonus.
        const goals = dailyGoalsState.getCurrentGoals(activeCharacterID);
        const milestones = dailyGoalsState.getMonthlyMilestones(activeCharacterID);
        return ok(
          `${REQUEST_PREFIX}GetAllCurrentResponse`,
          encodePayload(types.getAllCurrentResponse, {
            goals: [
              ...goals.map(buildCurrentGoal),
              ...milestones.map(buildMilestoneCurrentGoal),
            ],
          }),
        );
      }

      if (normalized === `${REQUEST_PREFIX}GetAllWithRewardsRequest`) {
        // Paginated list of goals with UNCLAIMED rewards (the client's claim
        // history). Scoped to earned-but-unclaimed MONTHLY milestones: daily
        // goals (including the completion bonus) carry their claim affordance on
        // their own card, from the rewards GetAllCurrent reports per goal.
        const decoded = decodeRequest(types.getAllWithRewardsRequest, requestEnvelope);
        const unclaimed = dailyGoalsState
          .getMonthlyMilestones(activeCharacterID)
          .filter((descriptor) => descriptor.earned && !descriptor.claimed);
        const paged = sliceWithPage(unclaimed, decoded && decoded.page);
        return ok(
          `${REQUEST_PREFIX}GetAllWithRewardsResponse`,
          encodePayload(types.getAllWithRewardsResponse, {
            ids: paged.items.map((descriptor) => buildIdentifier(descriptor.uuid)),
            next_page: paged.nextPage || undefined,
          }),
        );
      }

      if (
        normalized === `${REQUEST_PREFIX}GetAllCompletedWithEntitlementsRequest`
      ) {
        return ok(
          `${REQUEST_PREFIX}GetAllCompletedWithEntitlementsResponse`,
          encodePayload(types.getAllCompletedResponse, { goals: [] }),
        );
      }

      if (normalized === `${REQUEST_PREFIX}GetRequest`) {
        const decoded = decodeRequest(types.getRequest, requestEnvelope);
        const uuid = extractGoalUuid(decoded && decoded.goal);
        // A GetRequest may target either a daily goal or a monthly milestone.
        const dailyDescriptor = uuid
          ? dailyGoalsState.getGoal(activeCharacterID, uuid)
          : null;
        if (dailyDescriptor) {
          return ok(
            `${REQUEST_PREFIX}GetResponse`,
            encodePayload(types.getResponse, {
              goal: buildAttributes(dailyDescriptor),
              progress: dailyDescriptor.progress,
              entitlements: [],
              earnings: buildDailyEarnings(dailyDescriptor),
            }),
          );
        }
        const milestoneDescriptor = uuid
          ? dailyGoalsState.getMonthlyMilestone(activeCharacterID, uuid)
          : null;
        if (milestoneDescriptor) {
          return ok(
            `${REQUEST_PREFIX}GetResponse`,
            encodePayload(types.getResponse, {
              goal: buildMilestoneAttributes(milestoneDescriptor),
              progress: milestoneDescriptor.progress,
              entitlements: [],
              earnings: buildMilestoneEarnings(milestoneDescriptor),
            }),
          );
        }
        return {
          statusCode: 404,
          statusMessage: "",
          responseTypeName: `${REQUEST_PREFIX}GetResponse`,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      if (normalized === `${REQUEST_PREFIX}RedeemRequest`) {
        const decoded = decodeRequest(types.redeemRequest, requestEnvelope);
        const uuid = extractGoalUuid(decoded && decoded.goal);
        // Try a daily goal first, then a monthly milestone claim.
        let result = uuid
          ? dailyGoalsState.redeemGoal(activeCharacterID, uuid)
          : { success: false };
        if (!result.success && uuid) {
          result = dailyGoalsState.claimMonthlyMilestone(activeCharacterID, uuid);
        }
        return {
          statusCode: result.success ? 200 : 404,
          statusMessage: "",
          responseTypeName: `${REQUEST_PREFIX}RedeemResponse`,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      if (normalized === `${REQUEST_PREFIX}RedeemAllRequest`) {
        dailyGoalsState.redeemAll(activeCharacterID);
        dailyGoalsState.claimAllMonthlyMilestones(activeCharacterID);
        return ok(`${REQUEST_PREFIX}RedeemAllResponse`, Buffer.alloc(0));
      }

      if (normalized === `${REQUEST_PREFIX}PayForCompletionRequest`) {
        // Complete a daily goal by paying Evermarks (2,500 / 4,500).
        const decoded = decodeRequest(types.payForCompletionRequest, requestEnvelope);
        const uuid = extractGoalUuid(decoded && decoded.goal);
        const result = uuid
          ? dailyGoalsState.payForCompletion(activeCharacterID, uuid)
          : { success: false };
        return {
          statusCode: result.success ? 200 : 403,
          statusMessage: result.success ? "" : String(result.errorMsg || ""),
          responseTypeName: `${REQUEST_PREFIX}PayForCompletionResponse`,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      return null;
    },
  };
}

module.exports = {
  createDailyGoalsGatewayService,
};
module.exports._testing = {
  buildAttributes,
  buildCurrentGoal,
  HANDLED_REQUEST_TYPES,
};
