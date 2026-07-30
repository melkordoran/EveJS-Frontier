const BaseService = require("../baseService");
const log = require("../../utils/logger");
const {
  buildFiletimeLong,
} = require("../_shared/serviceHelpers");
const {
  adjustCharacterBalance,
} = require("../account/walletState");
const {
  readRuntimeAccount,
  writeRuntimeAccount,
} = require("../newEdenStore/storeState");

const MILESTONE_ID = 1;
const MILESTONE_DURATION_MS = 2 * 60 * 60 * 1000;
const MILESTONE_REWARD_ISK = 500000;
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const activeMilestones = new Map();
let nowForTests = null;

function nowMilliseconds() {
  return nowForTests === null ? Date.now() : nowForTests;
}

function accountIDFromSession(session) {
  return Number(session && (session.userid || session.userID || session.accountID)) || 0;
}

function characterIDFromSession(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function normalizeProgress(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    onlineMilliseconds: Math.min(
      MILESTONE_DURATION_MS,
      Math.max(0, Math.trunc(Number(source.onlineMilliseconds) || 0)),
    ),
    achieved: Boolean(source.achieved),
    claimed: Boolean(source.claimed),
  };
}

function readProgress(accountID) {
  return normalizeProgress(readRuntimeAccount(accountID).loginMilestone);
}

function writeProgress(accountID, progress) {
  const runtimeAccount = readRuntimeAccount(accountID);
  writeRuntimeAccount(accountID, {
    ...runtimeAccount,
    loginMilestone: normalizeProgress(progress),
  });
  return normalizeProgress(progress);
}

function filetimeForMilliseconds(milliseconds) {
  return BigInt(Math.trunc(milliseconds)) * 10000n + FILETIME_UNIX_EPOCH_OFFSET;
}

function notifyTimerStarted(session, deadlineMilliseconds) {
  if (session && typeof session.sendNotification === "function") {
    session.sendNotification("OnMilestoneTimerStarted", "clientID", [
      buildFiletimeLong(filetimeForMilliseconds(deadlineMilliseconds)),
    ]);
  }
}

function notifyMilestoneAchieved(session) {
  if (session && typeof session.sendNotification === "function") {
    session.sendNotification("OnLoginMilestoneAchieved", "clientID", [
      MILESTONE_ID,
      MILESTONE_REWARD_ISK,
    ]);
  }
}

function clearActiveMilestone(accountID) {
  const active = activeMilestones.get(accountID);
  if (active && active.timer) {
    clearTimeout(active.timer);
  }
  activeMilestones.delete(accountID);
  return active || null;
}

function currentProgress(accountID) {
  const progress = readProgress(accountID);
  const active = activeMilestones.get(accountID);
  if (!active || progress.claimed || progress.achieved) {
    return progress;
  }
  return {
    ...progress,
    onlineMilliseconds: Math.min(
      MILESTONE_DURATION_MS,
      progress.onlineMilliseconds + Math.max(0, nowMilliseconds() - active.startedAt),
    ),
  };
}

function achieveMilestone(accountID, session = null) {
  const progress = currentProgress(accountID);
  if (progress.claimed || progress.achieved) {
    clearActiveMilestone(accountID);
    return progress;
  }
  if (progress.onlineMilliseconds < MILESTONE_DURATION_MS) {
    return progress;
  }
  const active = clearActiveMilestone(accountID);
  const achieved = writeProgress(accountID, {
    ...progress,
    onlineMilliseconds: MILESTONE_DURATION_MS,
    achieved: true,
  });
  notifyMilestoneAchieved(session || (active && active.session));
  return achieved;
}

function startMilestoneTimer(accountID, session) {
  const priorActive = clearActiveMilestone(accountID);
  let progress = currentProgress(accountID);
  if (priorActive && !progress.achieved && !progress.claimed) {
    progress = writeProgress(accountID, {
      ...progress,
      onlineMilliseconds: Math.min(
        MILESTONE_DURATION_MS,
        progress.onlineMilliseconds + Math.max(0, nowMilliseconds() - priorActive.startedAt),
      ),
    });
  }
  if (progress.claimed) {
    return;
  }
  if (progress.achieved) {
    notifyMilestoneAchieved(session);
    return;
  }
  if (progress.onlineMilliseconds >= MILESTONE_DURATION_MS) {
    achieveMilestone(accountID, session);
    return;
  }

  const remaining = MILESTONE_DURATION_MS - progress.onlineMilliseconds;
  const startedAt = nowMilliseconds();
  const timer = setTimeout(() => achieveMilestone(accountID, session), remaining);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  activeMilestones.set(accountID, { session, startedAt, timer });
  notifyTimerStarted(session, startedAt + remaining);
}

function handleSessionDisconnected(session) {
  const accountID = accountIDFromSession(session);
  const active = activeMilestones.get(accountID);
  if (!active || active.session !== session) {
    return;
  }
  const progress = currentProgress(accountID);
  clearActiveMilestone(accountID);
  if (progress.onlineMilliseconds >= MILESTONE_DURATION_MS) {
    writeProgress(accountID, {
      ...progress,
      onlineMilliseconds: MILESTONE_DURATION_MS,
      achieved: true,
    });
  } else {
    writeProgress(accountID, progress);
  }
}

class MilestoneMgrService extends BaseService {
  constructor() {
    super("milestoneMgr");
  }

  Handle_ProcessCharacterLogon(args, session) {
    const accountID = accountIDFromSession(session);
    if (accountID) {
      startMilestoneTimer(accountID, session);
    }
    log.debug(`[MilestoneMgr] ProcessCharacterLogon account=${accountID}`);
    return null;
  }

  Handle_ClaimRewards(args, session) {
    const milestoneID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    const accountID = accountIDFromSession(session);
    const characterID = characterIDFromSession(session);
    log.debug(
      `[MilestoneMgr] ClaimRewards milestone=${milestoneID} char=${characterID}`,
    );
    if (milestoneID !== MILESTONE_ID || !accountID || !characterID) {
      return null;
    }
    const progress = achieveMilestone(accountID, session);
    if (!progress.achieved || progress.claimed) {
      return null;
    }
    writeProgress(accountID, { ...progress, claimed: true });
    const rewardResult = adjustCharacterBalance(characterID, MILESTONE_REWARD_ISK, {
      referenceID: MILESTONE_ID,
      reason: "Two-hour login milestone",
      description: "Two-hour login milestone",
    });
    if (!rewardResult.success) {
      writeProgress(accountID, { ...progress, claimed: false });
      log.warn(
        `[MilestoneMgr] ClaimRewards failed char=${characterID}: ${rewardResult.errorMsg}`,
      );
      return null;
    }
    clearActiveMilestone(accountID);
    log.info(
      `[MilestoneMgr] ClaimRewards milestone=${MILESTONE_ID} char=${characterID} isk=${MILESTONE_REWARD_ISK}`,
    );
    return null;
  }
}

MilestoneMgrService._testing = {
  setNowForTests(value) {
    nowForTests = value === null || value === undefined ? null : Number(value);
  },
  processTimersForTests() {
    for (const [accountID, active] of activeMilestones.entries()) {
      achieveMilestone(accountID, active.session);
    }
  },
  resetForTests() {
    for (const accountID of activeMilestones.keys()) {
      clearActiveMilestone(accountID);
    }
    nowForTests = null;
  },
};

MilestoneMgrService.handleSessionDisconnected = handleSessionDisconnected;

module.exports = MilestoneMgrService;
