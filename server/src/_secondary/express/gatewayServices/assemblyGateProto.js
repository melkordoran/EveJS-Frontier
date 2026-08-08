"use strict";

const protobuf = require("protobufjs");

let cachedTypes = null;

function buildAssemblyGateProtoRoot() {
  const root = new protobuf.Root();

  root.define("eve_public")
    .add(
      new protobuf.Type("Page")
        .add(new protobuf.Field("size", 1, "uint32"))
        .add(new protobuf.Field("token", 2, "string")),
    )
    .add(
      new protobuf.Type("NextPage")
        .add(new protobuf.Field("token", 1, "string")),
    );

  root.define("eve_public.math").add(
    new protobuf.Type("Vector3")
      .add(new protobuf.Field("x", 1, "double"))
      .add(new protobuf.Field("y", 2, "double"))
      .add(new protobuf.Field("z", 3, "double")),
  );

  root.define("eve_public.solarsystem").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  );

  root.define("eve_public.assembly")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint64"),
      ),
    )
    .add(
      new protobuf.Type("Location")
        .add(
          new protobuf.Field(
            "solar_system",
            1,
            "eve_public.solarsystem.Identifier",
          ),
        )
        .add(new protobuf.Field("position", 2, "eve_public.math.Vector3")),
    )
    .add(
      new protobuf.Type("Metadata")
        .add(new protobuf.Field("name", 1, "string"))
        .add(new protobuf.Field("description", 2, "string"))
        .add(new protobuf.Field("dapp_url", 3, "string")),
    );

  const getEnergyConfigResponse = new protobuf.Type("GetEnergyConfigResponse")
    .add(
      new protobuf.Type("EnergyEntry")
        .add(new protobuf.Field("assembly_type", 1, "uint64"))
        .add(new protobuf.Field("energy_required", 2, "uint64")),
    )
    .add(
      new protobuf.Field(
        "energy_requirements",
        1,
        "eve_public.assembly.api.GetEnergyConfigResponse.EnergyEntry",
        "repeated",
      ),
    );

  root.define("eve_public.assembly.api")
    .add(
      new protobuf.Type("GetMetadataRequest").add(
        new protobuf.Field(
          "assembly",
          1,
          "eve_public.assembly.Identifier",
        ),
      ),
    )
    .add(
      new protobuf.Type("GetMetadataResponse").add(
        new protobuf.Field(
          "metadata",
          1,
          "eve_public.assembly.Metadata",
        ),
      ),
    )
    .add(new protobuf.Type("GetEnergyConfigRequest"))
    .add(getEnergyConfigResponse);

  root.define("eve_public.assembly.gate")
    .add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint64"),
      ),
    )
    .add(
      new protobuf.Type("Attributes")
        .add(new protobuf.Field("type_id", 1, "uint64"))
        .add(
          new protobuf.Field("location", 2, "eve_public.assembly.Location"),
        )
        .add(
          new protobuf.Field("metadata", 3, "eve_public.assembly.Metadata"),
        )
        .add(
          new protobuf.Field(
            "destination",
            4,
            "eve_public.assembly.Identifier",
          ),
        ),
    );

  const getAllOwnedResponse = new protobuf.Type("GetAllOwnedResponse");
  getAllOwnedResponse.add(
    new protobuf.Type("Entry")
      .add(
        new protobuf.Field(
          "id",
          1,
          "eve_public.assembly.gate.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "attributes",
          2,
          "eve_public.assembly.gate.Attributes",
        ),
      ),
  );
  getAllOwnedResponse
    .add(
      new protobuf.Field(
        "gates",
        1,
        "eve_public.assembly.gate.api.GetAllOwnedResponse.Entry",
        "repeated",
      ),
    )
    .add(new protobuf.Field("next_page", 2, "eve_public.NextPage"));

  root.define("eve_public.assembly.gate.api")
    .add(
      new protobuf.Type("GetAllOwnedRequest").add(
        new protobuf.Field("page", 1, "eve_public.Page"),
      ),
    )
    .add(getAllOwnedResponse);

  root.resolveAll();
  return root;
}

function getAssemblyGateProtoTypes() {
  if (cachedTypes) {
    return cachedTypes;
  }
  const root = buildAssemblyGateProtoRoot();
  cachedTypes = {
    getMetadataRequest: root.lookupType(
      "eve_public.assembly.api.GetMetadataRequest",
    ),
    getMetadataResponse: root.lookupType(
      "eve_public.assembly.api.GetMetadataResponse",
    ),
    getEnergyConfigRequest: root.lookupType(
      "eve_public.assembly.api.GetEnergyConfigRequest",
    ),
    getEnergyConfigResponse: root.lookupType(
      "eve_public.assembly.api.GetEnergyConfigResponse",
    ),
    getAllOwnedRequest: root.lookupType(
      "eve_public.assembly.gate.api.GetAllOwnedRequest",
    ),
    getAllOwnedResponse: root.lookupType(
      "eve_public.assembly.gate.api.GetAllOwnedResponse",
    ),
  };
  return cachedTypes;
}

module.exports = {
  buildAssemblyGateProtoRoot,
  getAssemblyGateProtoTypes,
};
