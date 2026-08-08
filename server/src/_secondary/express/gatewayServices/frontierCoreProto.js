"use strict";

const protobuf = require("protobufjs");

let cachedTypes = null;

function buildFrontierCoreProtoRoot() {
  const root = new protobuf.Root();

  root.define("eve_public.character").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint32"),
    ),
  );
  root.define("eve_public.solarsystem").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  );
  root.define("eve_public.isk").add(
    new protobuf.Type("Currency")
      .add(new protobuf.Field("units", 1, "sint64"))
      .add(new protobuf.Field("nanos", 2, "sint32")),
  );
  root.define("eve_public.token").add(
    new protobuf.Type("Amount")
      .add(new protobuf.Field("denom", 1, "string"))
      .add(new protobuf.Field("value", 2, "string")),
  );
  root.define("eve_public.wallet").add(
    new protobuf.Type("Address").add(
      new protobuf.Field("hex", 1, "string"),
    ),
  );

  const localChat = root.define("eve_public.chat.local");
  localChat
    .add(
      new protobuf.Type("Message").add(
        new protobuf.Field("content", 1, "string"),
      ),
    )
    .add(
      new protobuf.Type("BroadcastMessageRequest").add(
        new protobuf.Field("message", 1, "eve_public.chat.local.Message"),
      ),
    )
    .add(new protobuf.Type("BroadcastMessageResponse"))
    .add(new protobuf.Type("GetMembershipRequest"))
    .add(
      new protobuf.Type("GetMembershipResponse")
        .add(
          new protobuf.Field(
            "characters",
            1,
            "eve_public.character.Identifier",
            "repeated",
          ),
        )
        .add(
          new protobuf.Field(
            "solar_system",
            2,
            "eve_public.solarsystem.Identifier",
          ),
        ),
    )
    .add(
      new protobuf.Type("EnterNotice")
        .add(
          new protobuf.Field(
            "character",
            1,
            "eve_public.character.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "solar_system",
            2,
            "eve_public.solarsystem.Identifier",
          ),
        ),
    )
    .add(
      new protobuf.Type("ExitNotice")
        .add(
          new protobuf.Field(
            "character",
            1,
            "eve_public.character.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "solar_system",
            2,
            "eve_public.solarsystem.Identifier",
          ),
        ),
    )
    .add(
      new protobuf.Type("MembershipNotice")
        .add(
          new protobuf.Field(
            "characters",
            1,
            "eve_public.character.Identifier",
            "repeated",
          ),
        )
        .add(
          new protobuf.Field(
            "solar_system",
            2,
            "eve_public.solarsystem.Identifier",
          ),
        ),
    )
    .add(
      new protobuf.Type("MessageBroadcastNotice")
        .add(
          new protobuf.Field(
            "author",
            1,
            "eve_public.character.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "solar_system",
            2,
            "eve_public.solarsystem.Identifier",
          ),
        )
        .add(
          new protobuf.Field("message", 3, "eve_public.chat.local.Message"),
        ),
    );

  root.define("eve_public.wallet.api")
    .add(
      new protobuf.Type("GetBalanceRequest").add(
        new protobuf.Field("wallet", 1, "eve_public.wallet.Address"),
      ),
    )
    .add(
      new protobuf.Type("GetBalanceResponse").add(
        new protobuf.Field("balance", 1, "eve_public.token.Amount"),
      ),
    );

  root.define("eve_public.token.exchange.api")
    .add(new protobuf.Type("GetExchangeRateRequest"))
    .add(
      new protobuf.Type("GetExchangeRateResponse")
        .add(
          new protobuf.Field("lux_per_token", 1, "eve_public.isk.Currency"),
        )
        .add(
          new protobuf.Field("token_per_lux", 2, "eve_public.token.Amount"),
        ),
    );

  root.resolveAll();
  return root;
}

function getFrontierCoreProtoTypes() {
  if (cachedTypes) {
    return cachedTypes;
  }
  const root = buildFrontierCoreProtoRoot();
  cachedTypes = {
    chatBroadcastMessageRequest: root.lookupType(
      "eve_public.chat.local.BroadcastMessageRequest",
    ),
    chatBroadcastMessageResponse: root.lookupType(
      "eve_public.chat.local.BroadcastMessageResponse",
    ),
    chatEnterNotice: root.lookupType("eve_public.chat.local.EnterNotice"),
    chatExitNotice: root.lookupType("eve_public.chat.local.ExitNotice"),
    chatGetMembershipRequest: root.lookupType(
      "eve_public.chat.local.GetMembershipRequest",
    ),
    chatGetMembershipResponse: root.lookupType(
      "eve_public.chat.local.GetMembershipResponse",
    ),
    chatMembershipNotice: root.lookupType(
      "eve_public.chat.local.MembershipNotice",
    ),
    chatMessageBroadcastNotice: root.lookupType(
      "eve_public.chat.local.MessageBroadcastNotice",
    ),
    walletGetBalanceRequest: root.lookupType(
      "eve_public.wallet.api.GetBalanceRequest",
    ),
    walletGetBalanceResponse: root.lookupType(
      "eve_public.wallet.api.GetBalanceResponse",
    ),
    tokenGetExchangeRateRequest: root.lookupType(
      "eve_public.token.exchange.api.GetExchangeRateRequest",
    ),
    tokenGetExchangeRateResponse: root.lookupType(
      "eve_public.token.exchange.api.GetExchangeRateResponse",
    ),
  };
  return cachedTypes;
}

module.exports = {
  buildFrontierCoreProtoRoot,
  getFrontierCoreProtoTypes,
};
