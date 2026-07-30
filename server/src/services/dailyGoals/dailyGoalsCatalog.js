const crypto = require("crypto");

// Authored daily-goal catalog, structured to match CCP's official AIR Daily
// Goals spec (support.eveonline.com "AIR Daily Goals and the Monthly Reward
// Track"). Names/descriptions/help texts are the retail client's own
// localization message IDs (recovered from `localization_fsd_en-us.pickle` /
// `_main.pickle`, build 3396210, label path `UI/DailyGoals/*`), so the client
// renders authentic text.
//
// Per the article, each day offers FIVE daily goals: four goals — one from each
// career path (Explorer, Industrialist, Enforcer, Soldier of Fortune), universal
// for all players that day — plus a static fifth goal, "Complete 3 Jumps",
// available every day. Completing any two of the five awards the daily bonus
// (10,000 Skill Points) and counts one day toward the Monthly Reward Track.
// Individual daily goals carry no separate payout (the bonus is the reward).

const CATEGORY = Object.freeze({
  UNSPECIFIED: 0,
  DAILY: 1,
  DAILY_BONUS: 2,
  MONTHLY_BONUS: 3,
});

// Career path identifiers (recovered from the client's
// `characterdata.careerpathconst`). The daily-goal `career` field carries one of
// these so the client groups/labels each goal by career path.
const CAREER_PATH = Object.freeze({
  NONE: 0,
  EXPLORER: 1,
  ENFORCER: 2,
  INDUSTRIALIST: 3,
  SOLDIER_OF_FORTUNE: 4,
});

const PAYMENT_PERIOD_COMPLETION = 1;

// Evermarks are stored as loyalty points issued by this corp (Heraldry / Evermark
// issuer). A per-goal or milestone EM reward is expressed as `Unit.lp` with this
// associated corporation; grants/spends go through the LP wallet under this issuer.
const EVERMARK_ISSUER_CORP_ID = 1000419;

// The daily completion bonus: complete 2 of the 5 daily goals -> 10,000 SP.
// Matches CCP's documented value (no ISK). Tunable for a local instance.
const BONUS_SKILL_POINTS = 10000;
const BONUS_TARGET_DAILY_COMPLETIONS = 2;

// Each individual daily goal also grants an ISK + Evermark reward on completion.
// (The client carries no reward figures; these are set to match live TQ.)
const DAILY_GOAL_ISK_REWARD = 500000;
const DAILY_GOAL_EVERMARK_REWARD = 500;

// Evermarks-paid completion: any two daily goals per day may be completed in
// exchange for Evermarks instead of doing the activity (CCP: 2,500 EM for the
// first, 4,500 EM for the second).
const EM_PAID_COMPLETION_COST_FIRST = 2500;
const EM_PAID_COMPLETION_COST_SECOND = 4500;
const MAX_PAID_COMPLETIONS_PER_DAY = 2;

// Five daily goals per day: one per career path + the static jumps goal.
const DAILY_ROTATION_SIZE = 5;

function spUnit(amount) {
  return { sp: { amount: Math.max(0, Math.trunc(amount)) } };
}

function evermarkUnit(amount) {
  return {
    lp: {
      amount: {
        amount: Math.max(0, Math.trunc(amount)),
        associated_corporation: { sequential: EVERMARK_ISSUER_CORP_ID },
      },
    },
  };
}

// Career-path goal pools. The daily rotation picks one template from each pool
// per day. Only event-tracked templates are listed so every offered goal is
// completable; authentic-but-unhooked variants (faction-specific kills, PvP,
// factional warfare, scan-site types, specific ores) can be added here once they
// have a `recordActivity` hook. `activityKind` is the key `recordActivity()`
// advances; `amount` on an event adds to progress.
const CAREER_TEMPLATE_POOLS = Object.freeze({
  explorer: [
    {
      key: "scan_signatures",
      nameMessageID: 697658, // "Scan 5 Signatures"
      descriptionMessageID: 697689,
      helpTextMessageID: 697934,
      careerPath: CAREER_PATH.EXPLORER,
      contribution: "scan_signature",
      activityKind: "scan_signature",
      target: 5,
      tracked: true,
    },
  ],
  industrialist: [
    {
      key: "mine_ore",
      nameMessageID: 697670, // "Mine 2000 units of Ore"
      descriptionMessageID: 697683,
      helpTextMessageID: 697940,
      careerPath: CAREER_PATH.INDUSTRIALIST,
      contribution: "mine_ore",
      activityKind: "mine_ore",
      target: 2000,
      tracked: true,
    },
    {
      key: "manufacture_item",
      nameMessageID: 697671, // "Manufacture an Item"
      descriptionMessageID: 697684,
      helpTextMessageID: 697939,
      careerPath: CAREER_PATH.INDUSTRIALIST,
      contribution: "install_manufacturing_job",
      activityKind: "install_manufacturing_job",
      target: 1,
      tracked: true,
    },
    {
      key: "salvage_wrecks",
      nameMessageID: 712791, // "Salvage 5 Wrecks"
      descriptionMessageID: 712835,
      helpTextMessageID: 712844,
      careerPath: CAREER_PATH.INDUSTRIALIST,
      contribution: "salvage_wreck",
      activityKind: "salvage_wreck",
      target: 5,
      tracked: true,
    },
  ],
  enforcer: [
    {
      key: "destroy_noncapsuleers",
      nameMessageID: 697667, // "Destroy 25 non-capsuleers"
      descriptionMessageID: 697720,
      helpTextMessageID: 697943,
      careerPath: CAREER_PATH.ENFORCER,
      contribution: "kill_npc",
      activityKind: "kill_npc",
      target: 25,
      tracked: true,
    },
  ],
  soldierOfFortune: [
    {
      key: "earn_lp",
      nameMessageID: 712805, // "Earn 50 LP for any corporation"
      descriptionMessageID: 712842, // EarnLP_SoF_description
      helpTextMessageID: 712850, // EarnLP_SoF_help
      careerPath: CAREER_PATH.SOLDIER_OF_FORTUNE,
      contribution: "earn_loyalty_points",
      activityKind: "earn_loyalty_points",
      target: 50,
      tracked: true,
    },
  ],
});

// Fixed career-path order the four rotating goals are drawn in.
const CAREER_PATH_ORDER = Object.freeze([
  "explorer",
  "industrialist",
  "enforcer",
  "soldierOfFortune",
]);

// The static fifth goal, offered every day regardless of career-path rotation.
const STATIC_JUMPS_TEMPLATE = Object.freeze({
  key: "complete_jumps",
  nameMessageID: 1004953, // "Complete 3 Jumps"
  descriptionMessageID: 1004954,
  helpTextMessageID: 1004955,
  careerPath: CAREER_PATH.NONE,
  contribution: "space_jump",
  activityKind: "space_jump",
  target: 3,
  tracked: true,
  isStatic: true,
});

// Flat lookup of every daily template (career pools + static jumps).
const DAILY_TEMPLATE_POOL = Object.freeze([
  ...CAREER_PATH_ORDER.flatMap((path) => CAREER_TEMPLATE_POOLS[path]),
  STATIC_JUMPS_TEMPLATE,
]);

const DAILY_TEMPLATE_BY_KEY = Object.freeze(
  Object.fromEntries(DAILY_TEMPLATE_POOL.map((t) => [t.key, t])),
);

// The "complete 2 daily goals -> reward" bonus (category DAILY_BONUS). Progress
// is driven internally as daily goals complete; completing it grants the SP
// bonus and advances the Monthly Reward Track by one day.
const BONUS_TEMPLATE = Object.freeze({
  key: "daily_completion_bonus",
  nameMessageID: 699211, // "Daily Completion Bonus"
  descriptionMessageID: 699209,
  helpTextMessageID: 699210,
  careerPath: CAREER_PATH.NONE,
  contribution: "complete_daily_goal",
  activityKind: "complete_daily_goal",
  target: BONUS_TARGET_DAILY_COMPLETIONS,
  isBonus: true,
});

// Each daily goal grants a small ISK + Evermark reward on completion. Shown as
// the goal's reward preview and granted on (activity-based) completion.
function rewardsForDailyTemplate() {
  return [
    { period: PAYMENT_PERIOD_COMPLETION, unit: iskUnit(DAILY_GOAL_ISK_REWARD) },
    { period: PAYMENT_PERIOD_COMPLETION, unit: evermarkUnit(DAILY_GOAL_EVERMARK_REWARD) },
  ];
}

function rewardsForBonusTemplate() {
  return [{ period: PAYMENT_PERIOD_COMPLETION, unit: spUnit(BONUS_SKILL_POINTS) }];
}

// Concrete reward amounts actually granted on redemption, derived from the same
// reward specs the client previews. Evermarks are the LP unit issued by the
// Evermark corp. Keeps grant + preview in sync.
function grantableRewardsForTemplate(template) {
  const specs = template.isBonus
    ? rewardsForBonusTemplate()
    : rewardsForDailyTemplate();
  const grant = { isk: 0, skillPoints: 0, evermarks: 0 };
  for (const spec of specs) {
    if (spec.unit && spec.unit.isk) {
      grant.isk += Number(spec.unit.isk.amount.units || 0);
    }
    if (spec.unit && spec.unit.sp) {
      grant.skillPoints += Number(spec.unit.sp.amount || 0);
    }
    if (spec.unit && spec.unit.lp) {
      grant.evermarks += Number(spec.unit.lp.amount.amount || 0);
    }
  }
  return grant;
}

function iskUnit(amount) {
  return { isk: { amount: { units: Math.max(0, Math.trunc(amount)) } } };
}

// ---- Monthly Reward Track ---------------------------------------------------
// Milestones unlock by completing 2 daily goals on 3/6/9/12 separate days in a
// month. One track for all capsuleers (Alpha) plus an additional track for Omega
// clones. Names/descriptions/help are authentic client message IDs; the milestone
// REWARD AMOUNTS are TQ-authored server data not present in the client, so they
// are chosen locally here and are tunable.

const MONTHLY_MILESTONE_TARGETS = Object.freeze([3, 6, 9, 12]);
const MONTHLY_DESCRIPTION_MESSAGE_ID = 712843; // "Complete Daily bonus Goals to earn an extra reward."
const MONTHLY_HELP_BY_TARGET = Object.freeze({
  3: 712846,
  6: 712847,
  9: 712848,
  12: 712849,
});
const MONTHLY_NAME_BY_TIER_TARGET = Object.freeze({
  alpha: { 3: 712806, 6: 712831, 9: 712833, 12: 712834 },
  omega: { 3: 722337, 6: 722338, 9: 722339, 12: 722340 },
});
// Synthetic reward amounts (local, tunable). Omega milestones are richer.
const MONTHLY_REWARD_BY_TIER_TARGET = Object.freeze({
  alpha: {
    3: { isk: 1000000 },
    6: { sp: 5000 },
    9: { isk: 2000000 },
    12: { sp: 10000 },
  },
  omega: {
    3: { isk: 2000000 },
    6: { sp: 10000 },
    9: { isk: 5000000 },
    12: { sp: 25000 },
  },
});

const MONTHLY_MILESTONES = Object.freeze(
  ["alpha", "omega"].flatMap((tier) =>
    MONTHLY_MILESTONE_TARGETS.map((target) => ({
      key: `${tier}_${target}`,
      tier,
      omega: tier === "omega",
      target,
      nameMessageID: MONTHLY_NAME_BY_TIER_TARGET[tier][target],
      descriptionMessageID: MONTHLY_DESCRIPTION_MESSAGE_ID,
      helpTextMessageID: MONTHLY_HELP_BY_TARGET[target],
      reward: MONTHLY_REWARD_BY_TIER_TARGET[tier][target],
    })),
  ),
);

const MONTHLY_MILESTONE_BY_KEY = Object.freeze(
  Object.fromEntries(MONTHLY_MILESTONES.map((m) => [m.key, m])),
);

function paymentsForMilestone(milestone) {
  const reward = milestone && milestone.reward;
  if (!reward) {
    return [];
  }
  const unit = reward.isk ? iskUnit(reward.isk) : spUnit(reward.sp || 0);
  return [{ period: PAYMENT_PERIOD_COMPLETION, unit }];
}

function grantableRewardForMilestone(milestone) {
  const reward = (milestone && milestone.reward) || {};
  return {
    isk: Number(reward.isk || 0),
    skillPoints: Number(reward.sp || 0),
  };
}

function hashToInt(value) {
  const digest = crypto.createHash("sha256").update(String(value)).digest();
  return digest.readUInt32BE(0);
}

// Deterministic daily selection: one goal from each career path (date-seeded so
// the picks change day to day but are stable within a day), plus the static
// jumps goal as the fifth. Universal for all players on a given day.
function pickDailyTemplateKeys(dateKey) {
  const keys = [];
  for (const path of CAREER_PATH_ORDER) {
    const pool = CAREER_TEMPLATE_POOLS[path];
    if (!pool || pool.length === 0) {
      continue;
    }
    const index = hashToInt(`${dateKey}:${path}`) % pool.length;
    keys.push(pool[index].key);
  }
  keys.push(STATIC_JUMPS_TEMPLATE.key);
  return keys;
}

module.exports = {
  CATEGORY,
  CAREER_PATH,
  CAREER_PATH_ORDER,
  CAREER_TEMPLATE_POOLS,
  PAYMENT_PERIOD_COMPLETION,
  EVERMARK_ISSUER_CORP_ID,
  BONUS_SKILL_POINTS,
  BONUS_TARGET_DAILY_COMPLETIONS,
  DAILY_GOAL_ISK_REWARD,
  DAILY_GOAL_EVERMARK_REWARD,
  EM_PAID_COMPLETION_COST_FIRST,
  EM_PAID_COMPLETION_COST_SECOND,
  MAX_PAID_COMPLETIONS_PER_DAY,
  DAILY_ROTATION_SIZE,
  DAILY_TEMPLATE_POOL,
  DAILY_TEMPLATE_BY_KEY,
  STATIC_JUMPS_TEMPLATE,
  BONUS_TEMPLATE,
  rewardsForDailyTemplate,
  rewardsForBonusTemplate,
  grantableRewardsForTemplate,
  pickDailyTemplateKeys,
  MONTHLY_MILESTONE_TARGETS,
  MONTHLY_MILESTONES,
  MONTHLY_MILESTONE_BY_KEY,
  paymentsForMilestone,
  grantableRewardForMilestone,
};
