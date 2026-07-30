/**
 * Login Campaign Services (loginCampaignManager, seasonalLoginCampaignManager)
 *
 * V23.02 client queries these during the character selection phase.
 * The seasonalLoginCampaignService.prime_campaign_data() iterates the result,
 * so we must return empty lists/dicts (not null).
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const config = require(path.join(__dirname, "../../config"));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  readRuntimeAccount,
  writeRuntimeAccount,
} = require(path.join(__dirname, "../newEdenStore/storeState"));

const MAX_AUDIT_EVENTS = 100;
const auditEvents = [];
const DAILY_TRACK_LENGTH = 15;
const RESET_HOUR_UTC = 11;
const LOCAL_REDEEM_TOKEN_BASE = 700000000;
const CAMPAIGN_ID = 2187;
const CAMPAIGN_TITLE_MESSAGE_ID = 598040;
const CAMPAIGN_SUBTITLE_MESSAGE_ID = 598039;
const REWARD_LABEL_MESSAGE_ID = 598041;
const CAMPAIGN_BUCKET_ID = 4;
const CAMPAIGN_BACKGROUND = "res:/UI/Texture/classes/LoginCampaign/backgrounds/dliBackground.png";
const DEFAULT_REWARD = Object.freeze({ typeID: 49810, quantity: 1 });
let nowForTests = null;

function now() {
  return nowForTests ? new Date(nowForTests) : new Date();
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function getCampaignConfig() {
  const configuredRewards = Array.isArray(config.dailyLoginRewards)
    ? config.dailyLoginRewards
      .map((reward) => ({
        typeID: positiveInteger(reward && reward.typeID, 0),
        quantity: positiveInteger(reward && reward.quantity, 0),
      }))
      .filter((reward) => reward.typeID > 0 && reward.quantity > 0)
    : [];
  return {
    enabled: config.dailyLoginRewardsEnabled !== false,
    rewards: configuredRewards.length > 0 ? configuredRewards : [DEFAULT_REWARD],
  };
}

function rewardForDay(campaignConfig, day) {
  return campaignConfig.rewards[(day - 1) % campaignConfig.rewards.length];
}

// A campaign day starts at 11:00 UTC.  Subtracting eleven hours makes the
// remaining UTC date a stable, readable reset identifier.
function resetID(date = now()) {
  const shifted = new Date(date.getTime() - RESET_HOUR_UTC * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function resetStart(date = now()) {
  const reset = new Date(date);
  reset.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
  if (date.getTime() < reset.getTime()) {
    reset.setUTCDate(reset.getUTCDate() - 1);
  }
  return reset;
}

function nextReset(date = now()) {
  const reset = resetStart(date);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

function fileTime(date) {
  return BigInt(date.getTime()) * 10000n + 116444736000000000n;
}

function accountIDFromSession(session) {
  return positiveInteger(session && (session.userid || session.userID || session.accountID), 0);
}

function normalizeProgress(value) {
  const source = value && typeof value === "object" ? value : {};
  const day = Math.trunc(Number(source.day) || 0);
  return {
    day: day >= 0 && day <= DAILY_TRACK_LENGTH ? day : 0,
    lastClaimReset: typeof source.lastClaimReset === "string" ? source.lastClaimReset : "",
  };
}

function rewardPayload(typeID, quantity, day) {
  return buildKeyVal([
    ["typeID", typeID],
    ["blueprintProductivityLevel", null],
    ["blueprintMaterialLevel", null],
    ["labelMessageID", REWARD_LABEL_MESSAGE_ID + day - 1],
    ["tier", day === DAILY_TRACK_LENGTH ? 4 : 1],
    ["quantity", quantity],
    ["icon", null],
  ]);
}

function staticData(campaignConfig) {
  const rewards = Array.from({ length: DAILY_TRACK_LENGTH }, (_, index) => {
    const day = index + 1;
    const reward = rewardForDay(campaignConfig, day);
    return [day, rewardPayload(reward.typeID, reward.quantity, day)];
  });
  return buildKeyVal([
    ["campaign_duration", DAILY_TRACK_LENGTH],
    ["subtitleMessageID", CAMPAIGN_SUBTITLE_MESSAGE_ID],
    ["campaign_id", CAMPAIGN_ID],
    ["titleMessageID", CAMPAIGN_TITLE_MESSAGE_ID],
    ["is_rookie_campaign", true],
    ["windowHeaderBackgroundNarrow", CAMPAIGN_BACKGROUND],
    ["windowHeaderBackgroundWide", CAMPAIGN_BACKGROUND],
    ["item_rewards_by_day", buildDict(rewards)],
  ]);
}

function bucketProgressPayload(progress) {
  const claimedRewards = progress.day;
  return buildKeyVal([
    ["bucketID", CAMPAIGN_BUCKET_ID],
    ["fill_level", claimedRewards / DAILY_TRACK_LENGTH],
    ["next_fill_level", Math.min(claimedRewards + 1, DAILY_TRACK_LENGTH) / DAILY_TRACK_LENGTH],
  ]);
}

function itemProgressPayload(progress, currentReset, date = now()) {
  const claimedToday = progress.lastClaimReset === currentReset;
  const nextRewardIndex = progress.day >= DAILY_TRACK_LENGTH ? 1 : progress.day + 1;
  const nextRewardTime = claimedToday ? nextReset(date) : resetStart(date);
  return buildKeyVal([
    ["next_reward_index", nextRewardIndex],
    ["num_claimed_rewards", progress.day],
    ["next_reward_timestamp", buildFiletimeLong(fileTime(nextRewardTime))],
  ]);
}

function generateTokenID(tokens) {
  const maximum = Math.max(0, ...(tokens || []).flatMap((token) => [token && token.tokenID, token && token.massTokenID]).map((value) => Number(value) || 0));
  return maximum >= LOCAL_REDEEM_TOKEN_BASE
    ? maximum + 1
    : LOCAL_REDEEM_TOKEN_BASE + (Date.now() % 100000000);
}

function buildCampaignToken(tokens, reward) {
  const tokenID = generateTokenID(tokens);
  return {
    tokenID,
    massTokenID: null,
    typeID: reward.typeID,
    quantity: reward.quantity,
    stationID: 0,
    dateTime: currentFileTime().toString(),
    expireDateTime: "0",
    label: "Daily Login Reward",
    description: "Daily login campaign reward",
    available: true,
    addedByContext: 0,
    addedByExtra: null,
  };
}

function safeClone(value) {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch (error) {
    return null;
  }
}

function recordCampaignAuditEvent(kind, args, session) {
  auditEvents.push({
    kind,
    args: safeClone(args),
    characterID: Number(session && (session.characterID || session.charid)) || 0,
    accountID: Number(session && (session.userid || session.userID)) || 0,
    recordedAt: new Date().toISOString(),
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  }
}

const testing = {
  getAuditEvents() {
    return auditEvents.map((entry) => ({ ...entry }));
  },
  resetForTests() {
    auditEvents.length = 0;
    nowForTests = null;
  },
  setNowForTests(value) {
    nowForTests = value ? new Date(value) : null;
  },
};

class LoginCampaignMgrService extends BaseService {
  constructor() {
    super("loginCampaignManager");
  }

  Handle_GetActiveCampaigns(args, session) {
    log.debug("[LoginCampaignMgr] GetActiveCampaigns");
    return { type: "list", items: [] };
  }

  Handle_GetCampaignData(args, session) {
    log.debug("[LoginCampaignMgr] GetCampaignData");
    return { type: "dict", entries: [] };
  }

  Handle_GetPlayerProgress(args, session) {
    log.debug("[LoginCampaignMgr] GetPlayerProgress");
    return { type: "dict", entries: [] };
  }

  Handle_get_client_campaign_state(args, session) {
    const campaignConfig = getCampaignConfig();
    if (!campaignConfig.enabled) {
      return null;
    }
    const progress = normalizeProgress(
      readRuntimeAccount(accountIDFromSession(session)).dailyLoginCampaign,
    );
    const currentReset = resetID();
    return buildKeyVal([
      ["static_data", staticData(campaignConfig)],
      ["bucket_progress", bucketProgressPayload(progress)],
      ["item_progress", itemProgressPayload(progress, currentReset)],
    ]);
  }

  Handle_claim_reward(args, session) {
    const campaignConfig = getCampaignConfig();
    const accountID = accountIDFromSession(session);
    if (!campaignConfig.enabled || !accountID) {
      return null;
    }
    const runtimeAccount = readRuntimeAccount(accountID);
    const previous = normalizeProgress(runtimeAccount.dailyLoginCampaign);
    const currentReset = resetID();
    if (previous.lastClaimReset === currentReset) {
      recordCampaignAuditEvent("login_campaign_claim_reward_rejected", args, session);
      log.info(`[LoginCampaignMgr] claim_reward rejected user=${accountID} reset=${currentReset}`);
      return null;
    }
    const day = previous.day >= DAILY_TRACK_LENGTH ? 1 : previous.day + 1;
    const progress = { day, lastClaimReset: currentReset };
    const tokens = Array.isArray(runtimeAccount.redeemTokens) ? runtimeAccount.redeemTokens : [];
    const configuredReward = rewardForDay(campaignConfig, day);
    const token = buildCampaignToken(tokens, configuredReward);
    writeRuntimeAccount(accountID, {
      ...runtimeAccount,
      redeemTokens: [...tokens, token],
      dailyLoginCampaign: progress,
    });
    const reward = rewardPayload(configuredReward.typeID, configuredReward.quantity, day);
    const updatedProgress = itemProgressPayload(progress, currentReset);
    const updatedBucketProgress = bucketProgressPayload(progress);
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification("OnRedeemingQueueUpdated", "clientID", []);
    }
    recordCampaignAuditEvent("login_campaign_claim_reward", args, session);
    log.info(`[LoginCampaignMgr] claim_reward user=${accountID} day=${day} token=${token.tokenID}`);
    return [reward, updatedProgress, null, updatedBucketProgress];
  }
}

class SeasonalLoginCampaignMgrService extends BaseService {
  constructor() {
    super("seasonalLoginCampaignManager");
  }

  Handle_GetActiveCampaigns(args, session) {
    log.debug("[SeasonalLoginCampaignMgr] GetActiveCampaigns");
    return { type: "list", items: [] };
  }

  Handle_GetCampaignData(args, session) {
    log.debug("[SeasonalLoginCampaignMgr] GetCampaignData");
    return { type: "list", items: [] };
  }

  Handle_GetPlayerProgress(args, session) {
    log.debug("[SeasonalLoginCampaignMgr] GetPlayerProgress");
    return { type: "dict", entries: [] };
  }

  Handle_get_active_campaign(args, session) {
    log.debug("[SeasonalLoginCampaignMgr] get_active_campaign");

    return [null, null, null, null];
  }

  Handle_claim_reward(args, session) {
    recordCampaignAuditEvent("seasonal_login_claim_reward_no_active_campaign", args, session);
    log.info("[SeasonalLoginCampaignMgr] claim_reward -> false");
    return false;
  }

  Handle_get_claim_history(args, session) {
    recordCampaignAuditEvent("seasonal_login_get_claim_history_empty", args, session);
    log.debug("[SeasonalLoginCampaignMgr] get_claim_history -> empty dict");
    return buildDict([]);
  }
}

LoginCampaignMgrService._testing = testing;
SeasonalLoginCampaignMgrService._testing = testing;

module.exports = { LoginCampaignMgrService, SeasonalLoginCampaignMgrService };
