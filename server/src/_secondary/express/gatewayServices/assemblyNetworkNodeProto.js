"use strict";

/**
 * Protobuf types for the local Network Node fuel service.
 *
 * Mirrors the exported Frontier descriptors (build 3450341):
 *   eve_public/assembly/networknode/api/requests.proto
 *   eve_public/assembly/networknode/api/notices.proto
 *   eve_public/assembly/networknode/fuel.proto
 *   eve_public/assembly/networknode/fueltype/fueltype.proto
 *   eve_public/assembly/container.proto (ItemAttributes)
 *   eve_public/inventory/generic_item.proto (genericitem Location/Identifier)
 *   eve_public/inventory/inventory.proto (LocationFlag)
 *
 * Client field usage (frontier/smart_assemblies bytecode evidence):
 * - GetFuelConfigResponse: only `fuels[].fuel_type.sequential` (a fuel
 *   typeID) and `fuels[].efficiency` are read; the deprecated `fuel` and
 *   `attributes` entry fields are never touched.
 * - GetFuelResponse.fuel / FuelChangedNotice.fuel are assembly.ItemAttributes
 *   where `identifier.sequential` is read as the fuel typeID and `quantity`
 *   as stored units.
 * - PrepareDepositFuelRequest.items[].id.sequential carries the source fuel
 *   stack's inventory itemID; PrepareWithdrawFuelRequest.fuel_type.sequential
 *   carries the fuel typeID. The two Identifier namespaces are not
 *   interchangeable.
 */

const protobuf = require("protobufjs");

let cachedTypes = null;

function buildNetworkNodeProtoRoot() {
  const root = new protobuf.Root();

  root.define("eve_public.assembly").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  ).add(
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

  root.define("eve_public.assembly.networknode.fuel")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint64"),
      ),
    )
    .add(
      new protobuf.Type("Attributes").add(
        new protobuf.Field("efficiency", 1, "uint64"),
      ),
    );

  root.define("eve_public.assembly.networknode.fueltype").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  );

  const fuelEntry = new protobuf.Type("FuelEntry")
    .add(
      new protobuf.Field(
        "fuel",
        1,
        "eve_public.assembly.networknode.fuel.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "attributes",
        2,
        "eve_public.assembly.networknode.fuel.Attributes",
      ),
    )
    .add(
      new protobuf.Field(
        "fuel_type",
        3,
        "eve_public.assembly.networknode.fueltype.Identifier",
      ),
    )
    .add(new protobuf.Field("efficiency", 4, "uint64"));

  const depositFuelItem = new protobuf.Type("FuelItem")
    .add(
      new protobuf.Field(
        "id",
        1,
        "eve_public.assembly.networknode.fuel.Identifier",
      ),
    )
    .add(new protobuf.Field("quantity", 2, "uint32"));

  root.define("eve_public.assembly.networknode.api")
    .add(new protobuf.Type("GetFuelRequest").add(
      new protobuf.Field("network_node", 1, "eve_public.assembly.Identifier"),
    ))
    .add(new protobuf.Type("GetFuelResponse").add(
      new protobuf.Field("fuel", 1, "eve_public.assembly.ItemAttributes"),
    ))
    .add(new protobuf.Type("GetFuelConfigRequest"))
    .add(
      new protobuf.Type("GetFuelConfigResponse")
        .add(fuelEntry)
        .add(
          new protobuf.Field(
            "fuels",
            1,
            "eve_public.assembly.networknode.api.GetFuelConfigResponse.FuelEntry",
            "repeated",
          ),
        ),
    )
    .add(
      new protobuf.Type("PrepareDepositFuelRequest")
        .add(depositFuelItem)
        .add(
          new protobuf.Field(
            "network_node",
            1,
            "eve_public.assembly.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "source",
            5,
            "eve_public.inventory.genericitem.Location",
          ),
        )
        .add(
          new protobuf.Field(
            "items",
            6,
            "eve_public.assembly.networknode.api.PrepareDepositFuelRequest.FuelItem",
            "repeated",
          ),
        ),
    )
    .add(
      new protobuf.Type("PrepareDepositFuelResponse")
        .add(new protobuf.Field("prepared_transaction_uuid", 1, "bytes"))
        .add(new protobuf.Field("prepared_transaction_bcs_data", 2, "bytes")),
    )
    .add(
      new protobuf.Type("ExecuteDepositFuelRequest")
        .add(new protobuf.Field("prepared_transaction_uuid", 1, "bytes"))
        .add(new protobuf.Field("signature", 2, "string")),
    )
    .add(new protobuf.Type("ExecuteDepositFuelResponse"))
    .add(
      new protobuf.Type("PrepareWithdrawFuelRequest")
        .add(
          new protobuf.Field(
            "network_node",
            1,
            "eve_public.assembly.Identifier",
          ),
        )
        .add(
          new protobuf.Field(
            "fuel_type",
            2,
            "eve_public.assembly.networknode.fueltype.Identifier",
          ),
        )
        .add(new protobuf.Field("quantity", 3, "uint32"))
        .add(
          new protobuf.Field(
            "destination",
            4,
            "eve_public.inventory.genericitem.Location",
          ),
        ),
    )
    .add(
      new protobuf.Type("PrepareWithdrawFuelResponse")
        .add(new protobuf.Field("prepared_transaction_uuid", 1, "bytes"))
        .add(new protobuf.Field("prepared_transaction_bcs_data", 2, "bytes")),
    )
    .add(
      new protobuf.Type("ExecuteWithdrawFuelRequest")
        .add(new protobuf.Field("prepared_transaction_uuid", 1, "bytes"))
        .add(new protobuf.Field("signature", 2, "string")),
    )
    .add(new protobuf.Type("ExecuteWithdrawFuelResponse"))
    .add(
      new protobuf.Type("FuelChangedNotice")
        .add(
          new protobuf.Field(
            "network_node",
            1,
            "eve_public.assembly.Identifier",
          ),
        )
        .add(new protobuf.Field("fuel", 2, "eve_public.assembly.ItemAttributes")),
    );

  return root;
}

function getNetworkNodeProtoTypes() {
  if (cachedTypes) {
    return cachedTypes;
  }
  const root = buildNetworkNodeProtoRoot();
  root.resolveAll();
  const api = "eve_public.assembly.networknode.api";
  cachedTypes = {
    root,
    GetFuelRequest: root.lookupType(`${api}.GetFuelRequest`),
    GetFuelResponse: root.lookupType(`${api}.GetFuelResponse`),
    GetFuelConfigRequest: root.lookupType(`${api}.GetFuelConfigRequest`),
    GetFuelConfigResponse: root.lookupType(`${api}.GetFuelConfigResponse`),
    PrepareDepositFuelRequest: root.lookupType(`${api}.PrepareDepositFuelRequest`),
    PrepareDepositFuelResponse: root.lookupType(`${api}.PrepareDepositFuelResponse`),
    ExecuteDepositFuelRequest: root.lookupType(`${api}.ExecuteDepositFuelRequest`),
    ExecuteDepositFuelResponse: root.lookupType(`${api}.ExecuteDepositFuelResponse`),
    PrepareWithdrawFuelRequest: root.lookupType(`${api}.PrepareWithdrawFuelRequest`),
    PrepareWithdrawFuelResponse: root.lookupType(`${api}.PrepareWithdrawFuelResponse`),
    ExecuteWithdrawFuelRequest: root.lookupType(`${api}.ExecuteWithdrawFuelRequest`),
    ExecuteWithdrawFuelResponse: root.lookupType(`${api}.ExecuteWithdrawFuelResponse`),
    FuelChangedNotice: root.lookupType(`${api}.FuelChangedNotice`),
  };
  return cachedTypes;
}

module.exports = {
  getNetworkNodeProtoTypes,
};
