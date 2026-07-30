const protobuf = require("protobufjs");

// Minimal-but-faithful protobuf schema for the client's daily-goals gateway
// surface (`eve_public.dailygoal.*`). Field numbers/types were recovered from
// the retail client's compiled descriptors (build 3396210,
// `eveProto/generated/eve_public/dailygoal/...`). Only the messages the local
// gateway encodes (responses + notices) or decodes (requests) are defined, plus
// the leaf identifier/currency types they reference. The
// `dailyGoalsSchemaParity` test cross-checks every field number here against the
// recovered client descriptors so drift is caught automatically.
//
// The ContributionConfiguration variants are intentionally empty message shells:
// the client only calls `HasField(<variant>)` on them to pick an icon/label, and
// we never populate their contribution-method matchers, so an empty present
// sub-message is all the client needs to classify the goal.

let cachedRoot = null;

const CONTRIBUTION_VARIANTS = {
  kill_npc: 1,
  damage_ship: 2,
  mine_ore: 3,
  fw_capture: 4,
  fw_defend: 5,
  remote_armor_repair: 6,
  remote_shield_repair: 7,
  scan_signature: 8,
  install_manufacturing_job: 9,
  complete_daily_goal: 10,
  salvage_wreck: 11,
  earn_loyalty_points: 12,
  space_jump: 13,
};

function buildContributionConfigurationType() {
  const nested = {};
  const fields = {};
  for (const [name, id] of Object.entries(CONTRIBUTION_VARIANTS)) {
    const typeName = name
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    nested[typeName] = { fields: {} };
    fields[name] = {
      type: `eve_public.dailygoal.ContributionConfiguration.${typeName}`,
      id,
    };
  }
  return { fields, nested };
}

function buildDailyGoalsProtoRoot() {
  if (cachedRoot) {
    return cachedRoot;
  }

  cachedRoot = protobuf.Root.fromJSON({
    nested: {
      google: {
        nested: {
          protobuf: {
            nested: {
              Timestamp: {
                fields: {
                  seconds: { type: "int64", id: 1 },
                  nanos: { type: "int32", id: 2 },
                },
              },
            },
          },
        },
      },
      eve_public: {
        nested: {
          Page: {
            fields: {
              size: { type: "uint32", id: 1 },
              token: { type: "string", id: 2 },
            },
          },
          NextPage: {
            fields: {
              token: { type: "string", id: 1 },
            },
          },
          character: {
            nested: {
              Identifier: {
                fields: { sequential: { type: "uint32", id: 1 } },
              },
            },
          },
          corporation: {
            nested: {
              Identifier: {
                fields: { sequential: { type: "uint32", id: 1 } },
              },
            },
          },
          career: {
            // Placeholder so Attributes.career resolves; never populated.
            nested: {
              Path: {
                fields: { sequential: { type: "uint32", id: 1 } },
              },
            },
          },
          isk: {
            nested: {
              Currency: {
                fields: {
                  // sint64/sint32 (zigzag) — must match the client exactly or the
                  // decoded ISK value is wrong (e.g. 500000 read as 250000).
                  units: { type: "sint64", id: 1 },
                  nanos: { type: "sint32", id: 2 },
                },
              },
            },
          },
          loyaltypoints: {
            nested: {
              Currency: {
                fields: {
                  amount: { type: "uint64", id: 1 },
                  associated_corporation: {
                    type: "eve_public.corporation.Identifier",
                    id: 2,
                  },
                },
              },
            },
          },
          plex: {
            nested: {
              Currency: {
                fields: { total_in_cents: { type: "sint64", id: 1 } },
              },
            },
          },
          inventory: {
            nested: {
              genericitemtype: {
                nested: {
                  Identifier: {
                    fields: { sequential: { type: "uint64", id: 1 } },
                  },
                },
              },
            },
          },
          localization: {
            nested: {
              message: {
                nested: {
                  Identifier: {
                    fields: { sequential: { type: "uint32", id: 1 } },
                  },
                },
              },
            },
          },
          assetholding: {
            nested: {
              asset: {
                nested: {
                  Identifier: {
                    fields: { uuid: { type: "bytes", id: 1 } },
                  },
                },
              },
              entitlement: {
                nested: {
                  Identifier: {
                    fields: {
                      holder: {
                        type: "eve_public.assetholding.entitlement.Holder",
                        id: 1,
                      },
                      asset: {
                        type: "eve_public.assetholding.asset.Identifier",
                        id: 2,
                      },
                    },
                  },
                  Holder: {
                    fields: {
                      character: {
                        type: "eve_public.character.Identifier",
                        id: 1,
                      },
                    },
                  },
                },
              },
            },
          },
          dailygoal: {
            nested: {
              Category: {
                values: {
                  CATEGORY_UNSPECIFIED: 0,
                  CATEGORY_DAILY: 1,
                  CATEGORY_DAILY_BONUS: 2,
                  CATEGORY_MONTHLY_BONUS: 3,
                },
              },
              PaymentPeriod: {
                values: {
                  PAYMENT_PERIOD_UNSPECIFIED: 0,
                  PAYMENT_PERIOD_COMPLETION: 1,
                },
              },
              Identifier: {
                fields: { uuid: { type: "bytes", id: 1 } },
              },
              InterStellarKredits: {
                fields: {
                  amount: { type: "eve_public.isk.Currency", id: 1 },
                },
              },
              LoyaltyPoints: {
                fields: {
                  amount: { type: "eve_public.loyaltypoints.Currency", id: 1 },
                },
              },
              SkillPoints: {
                fields: { amount: { type: "uint32", id: 1 } },
              },
              Item: {
                fields: {
                  amount: { type: "uint32", id: 1 },
                  type: {
                    type: "eve_public.inventory.genericitemtype.Identifier",
                    id: 2,
                  },
                },
              },
              Plex: {
                fields: {
                  amount: { type: "eve_public.plex.Currency", id: 1 },
                },
              },
              Unit: {
                fields: {
                  isk: { type: "eve_public.dailygoal.InterStellarKredits", id: 1 },
                  lp: { type: "eve_public.dailygoal.LoyaltyPoints", id: 2 },
                  sp: { type: "eve_public.dailygoal.SkillPoints", id: 3 },
                  item: { type: "eve_public.dailygoal.Item", id: 5 },
                  plex: { type: "eve_public.dailygoal.Plex", id: 6 },
                },
              },
              Payment: {
                fields: {
                  asset: {
                    type: "eve_public.assetholding.asset.Identifier",
                    id: 1,
                  },
                  period: { type: "eve_public.dailygoal.PaymentPeriod", id: 2 },
                  unit: { type: "eve_public.dailygoal.Unit", id: 3 },
                },
              },
              ContributionConfiguration: buildContributionConfigurationType(),
              Attributes: {
                fields: {
                  name_message: {
                    type: "eve_public.localization.message.Identifier",
                    id: 1,
                  },
                  description_message: {
                    type: "eve_public.localization.message.Identifier",
                    id: 2,
                  },
                  help_text_message: {
                    type: "eve_public.localization.message.Identifier",
                    id: 3,
                  },
                  assigner: {
                    type: "eve_public.corporation.Identifier",
                    id: 4,
                  },
                  category: { type: "eve_public.dailygoal.Category", id: 5 },
                  contribution_configuration: {
                    type: "eve_public.dailygoal.ContributionConfiguration",
                    id: 6,
                  },
                  career: { type: "eve_public.career.Path", id: 7 },
                  payment: {
                    rule: "repeated",
                    type: "eve_public.dailygoal.Payment",
                    id: 8,
                  },
                  target: { type: "uint64", id: 9 },
                  active_after: { type: "google.protobuf.Timestamp", id: 10 },
                  active_until: { type: "google.protobuf.Timestamp", id: 11 },
                  omega: { type: "bool", id: 12 },
                },
              },
              api: {
                nested: {
                  Earning: {
                    fields: {
                      unit: { type: "eve_public.dailygoal.Unit", id: 1 },
                      omega_required: { type: "bool", id: 2 },
                    },
                  },
                  GetAllCurrentRequest: { fields: {} },
                  GetAllCurrentResponse: {
                    fields: {
                      goals: {
                        rule: "repeated",
                        type:
                          "eve_public.dailygoal.api.GetAllCurrentResponse.Goal",
                        id: 1,
                      },
                    },
                    nested: {
                      Goal: {
                        fields: {
                          id: { type: "eve_public.dailygoal.Identifier", id: 1 },
                          goal: {
                            type: "eve_public.dailygoal.Attributes",
                            id: 2,
                          },
                          current_progress: { type: "uint64", id: 3 },
                          entitlements: {
                            rule: "repeated",
                            type:
                              "eve_public.assetholding.entitlement.Identifier",
                            id: 4,
                          },
                          earnings: {
                            rule: "repeated",
                            type: "eve_public.dailygoal.api.Earning",
                            id: 5,
                          },
                          paid_completion: { type: "bool", id: 6 },
                        },
                      },
                    },
                  },
                  GetAllCompletedWithEntitlementsRequest: { fields: {} },
                  GetAllCompletedWithEntitlementsResponse: {
                    fields: {
                      goals: {
                        rule: "repeated",
                        type:
                          "eve_public.dailygoal.api.GetAllCompletedWithEntitlementsResponse.Goal",
                        id: 1,
                      },
                    },
                    nested: {
                      Goal: {
                        fields: {
                          id: { type: "eve_public.dailygoal.Identifier", id: 1 },
                          entitlements: {
                            rule: "repeated",
                            type:
                              "eve_public.assetholding.entitlement.Identifier",
                            id: 2,
                          },
                        },
                      },
                    },
                  },
                  GetAllWithRewardsRequest: {
                    fields: { page: { type: "eve_public.Page", id: 1 } },
                  },
                  GetAllWithRewardsResponse: {
                    fields: {
                      ids: {
                        rule: "repeated",
                        type: "eve_public.dailygoal.Identifier",
                        id: 1,
                      },
                      next_page: { type: "eve_public.NextPage", id: 2 },
                    },
                  },
                  GetRequest: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    },
                  },
                  GetResponse: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Attributes", id: 1 },
                      progress: { type: "uint64", id: 2 },
                      entitlements: {
                        rule: "repeated",
                        type: "eve_public.assetholding.entitlement.Identifier",
                        id: 3,
                      },
                      earnings: {
                        rule: "repeated",
                        type: "eve_public.dailygoal.api.Earning",
                        id: 4,
                      },
                    },
                  },
                  RedeemRequest: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                      redeem_current_location: { type: "bool", id: 2 },
                    },
                  },
                  RedeemResponse: { fields: {} },
                  RedeemAllRequest: { fields: {} },
                  RedeemAllResponse: { fields: {} },
                  PayForCompletionRequest: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    },
                  },
                  PayForCompletionResponse: { fields: {} },
                  // notices.proto
                  CurrentGoalsNotice: {
                    fields: {
                      goals: {
                        rule: "repeated",
                        type: "eve_public.dailygoal.api.CurrentGoalsNotice.Goal",
                        id: 1,
                      },
                    },
                    nested: {
                      Earning: {
                        fields: {
                          unit: { type: "eve_public.dailygoal.Unit", id: 1 },
                        },
                      },
                      Goal: {
                        fields: {
                          id: { type: "eve_public.dailygoal.Identifier", id: 1 },
                          goal: {
                            type: "eve_public.dailygoal.Attributes",
                            id: 2,
                          },
                          current_progress: { type: "uint64", id: 3 },
                          entitlements: {
                            rule: "repeated",
                            type:
                              "eve_public.assetholding.entitlement.Identifier",
                            id: 4,
                          },
                          earnings: {
                            rule: "repeated",
                            type:
                              "eve_public.dailygoal.api.CurrentGoalsNotice.Earning",
                            id: 5,
                          },
                        },
                      },
                    },
                  },
                  CompletedNotice: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    },
                  },
                  ProgressedNotice: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                      current_progress: { type: "uint64", id: 2 },
                    },
                  },
                  RedeemedNotice: {
                    fields: {
                      goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  return cachedRoot;
}

module.exports = {
  buildDailyGoalsProtoRoot,
  CONTRIBUTION_VARIANTS,
};
