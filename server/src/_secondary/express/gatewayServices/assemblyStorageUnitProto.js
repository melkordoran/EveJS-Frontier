"use strict";

/**
 * Build-3455996 Smart Storage Unit public contract.
 *
 * These message shapes mirror the exported client descriptors exactly. The
 * client routes by the fully-qualified request message name (there is no
 * protobuf service declaration in this build).
 */

const protobuf = require("protobufjs");

let cachedTypes = null;

function buildStorageUnitProtoRoot() {
  const root = new protobuf.Root();

  root.define("eve_public.assembly")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint64"),
      ),
    )
    .add(
      new protobuf.Type("ItemAttributes")
        .add(
          new protobuf.Field(
            "identifier",
            1,
            "eve_public.inventory.genericitemtype.Identifier",
          ),
        )
        .add(new protobuf.Field("quantity", 2, "uint32"))
        .add(new protobuf.Field("volume", 3, "float")),
    )
    .add(
      new protobuf.Type("InventoryItem")
        .add(
          new protobuf.Field(
            "identifier",
            1,
            "eve_public.inventory.genericitem.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "attributes",
            2,
            "eve_public.assembly.ItemAttributes",
          ),
        ),
    );

  root.define("eve_public.character").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint32"),
    ),
  );

  root.define("eve_public.inventory").add(
    new protobuf.Type("LocationFlag").add(
      new protobuf.Field("value", 1, "uint64"),
    ),
  );

  root.define("eve_public.inventory.genericitem")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint64"),
      ),
    )
    .add(
      new protobuf.Type("Location")
        .add(
          new protobuf.Field(
            "item",
            1,
            "eve_public.inventory.genericitem.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "flag",
            2,
            "eve_public.inventory.LocationFlag",
          ),
        ),
    );

  root.define("eve_public.inventory.genericitemtype").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  );

  root.define("eve_public.sponsoredtransaction.preparedtransaction")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("uuid", 1, "bytes"),
      ),
    )
    .add(
      new protobuf.Type("Attributes").add(
        new protobuf.Field("bcs_data_b64_bytes", 1, "string"),
      ),
    );

  const depositStack = new protobuf.Type("Stack")
    .add(
      new protobuf.Field(
        "item",
        1,
        "eve_public.inventory.genericitem.Identifier",
      ),
    )
    .add(new protobuf.Field("quantity", 2, "uint64"));

  const withdrawStack = new protobuf.Type("Stack")
    .add(
      new protobuf.Field(
        "item_type",
        1,
        "eve_public.inventory.genericitemtype.Identifier",
      ),
    )
    .add(new protobuf.Field("quantity", 2, "uint32"));

  const prepareDeposit = new protobuf.Type("PrepareDepositItemsRequest")
    .add(depositStack)
    .add(
      new protobuf.Field(
        "source_container",
        1,
        "eve_public.inventory.genericitem.Location",
      ),
    )
    .add(
      new protobuf.Field(
        "destination_container",
        2,
        "eve_public.assembly.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "stacks",
        3,
        "eve_public.assembly.storageunit.api.PrepareDepositItemsRequest.Stack",
        "repeated",
      ),
    );

  const prepareWithdraw = new protobuf.Type("PrepareWithdrawItemsRequest")
    .add(withdrawStack)
    .add(
      new protobuf.Field(
        "source_container",
        1,
        "eve_public.assembly.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "another_assembly",
        2,
        "eve_public.assembly.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "generic_location",
        3,
        "eve_public.inventory.genericitem.Location",
      ),
    )
    .add(
      new protobuf.Field(
        "stacks",
        4,
        "eve_public.assembly.storageunit.api.PrepareWithdrawItemsRequest.Stack",
        "repeated",
      ),
    )
    .add(
      new protobuf.OneOf("destination_container", [
        "another_assembly",
        "generic_location",
      ]),
    );

  const api = root.define("eve_public.assembly.storageunit.api");
  api
    .add(
      new protobuf.Type("GetInventoryRequest")
        .add(
          new protobuf.Field(
            "storage_unit",
            1,
            "eve_public.assembly.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "inventory_owner",
            2,
            "eve_public.character.Identifier",
          ),
        ),
    )
    .add(
      new protobuf.Type("GetInventoryResponse").add(
        new protobuf.Field(
          "items",
          1,
          "eve_public.assembly.InventoryItem",
          "repeated",
        ),
      ),
    )
    .add(prepareDeposit)
    .add(buildPreparedResponseType("PrepareDepositItemsResponse"))
    .add(buildExecuteRequestType("ExecuteDepositItemsRequest"))
    .add(new protobuf.Type("ExecuteDepositItemsResponse"))
    .add(prepareWithdraw)
    .add(buildPreparedResponseType("PrepareWithdrawItemsResponse"))
    .add(buildExecuteRequestType("ExecuteWithdrawItemsRequest"))
    .add(new protobuf.Type("ExecuteWithdrawItemsResponse"))
    .add(buildInventoryNoticeType("InventoryItemDepositedNotice"))
    .add(buildInventoryNoticeType("InventoryItemWithdrawnNotice"));

  root.resolveAll();
  return root;
}

function buildPreparedResponseType(name) {
  return new protobuf.Type(name)
    .add(
      new protobuf.Field(
        "prepared_transaction",
        1,
        "eve_public.sponsoredtransaction.preparedtransaction.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "prepared_transaction_attributes",
        2,
        "eve_public.sponsoredtransaction.preparedtransaction.Attributes",
      ),
    );
}

function buildExecuteRequestType(name) {
  return new protobuf.Type(name)
    .add(
      new protobuf.Field(
        "prepared_transaction",
        1,
        "eve_public.sponsoredtransaction.preparedtransaction.Identifier",
      ),
    )
    .add(new protobuf.Field("signature", 2, "string"));
}

function buildInventoryNoticeType(name) {
  return new protobuf.Type(name)
    .add(
      new protobuf.Field(
        "storage_unit",
        1,
        "eve_public.assembly.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "character",
        2,
        "eve_public.character.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "item",
        3,
        "eve_public.assembly.InventoryItem",
      ),
    );
}

function getStorageUnitProtoTypes() {
  if (cachedTypes) {
    return cachedTypes;
  }
  const root = buildStorageUnitProtoRoot();
  const lookup = (name) => root.lookupType(
    `eve_public.assembly.storageunit.api.${name}`,
  );
  cachedTypes = {
    root,
    GetInventoryRequest: lookup("GetInventoryRequest"),
    GetInventoryResponse: lookup("GetInventoryResponse"),
    PrepareDepositItemsRequest: lookup("PrepareDepositItemsRequest"),
    PrepareDepositItemsResponse: lookup("PrepareDepositItemsResponse"),
    ExecuteDepositItemsRequest: lookup("ExecuteDepositItemsRequest"),
    ExecuteDepositItemsResponse: lookup("ExecuteDepositItemsResponse"),
    PrepareWithdrawItemsRequest: lookup("PrepareWithdrawItemsRequest"),
    PrepareWithdrawItemsResponse: lookup("PrepareWithdrawItemsResponse"),
    ExecuteWithdrawItemsRequest: lookup("ExecuteWithdrawItemsRequest"),
    ExecuteWithdrawItemsResponse: lookup("ExecuteWithdrawItemsResponse"),
    InventoryItemDepositedNotice: lookup("InventoryItemDepositedNotice"),
    InventoryItemWithdrawnNotice: lookup("InventoryItemWithdrawnNotice"),
  };
  return cachedTypes;
}

module.exports = {
  buildStorageUnitProtoRoot,
  getStorageUnitProtoTypes,
};
