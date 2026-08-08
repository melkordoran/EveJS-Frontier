import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isInventoryMember,
  isPublicProtoMember,
  parseArgs,
} from "../../frontier-contracts/export-frontier-contracts.mjs";

test("contract exporter parses build and destination options", () => {
  const options = parseArgs([
    "--build",
    "3450341",
    "--out",
    "./tmp/contracts",
    "--force",
  ]);

  assert.equal(options.build, 3450341);
  assert.equal(options.outDir, path.resolve("./tmp/contracts"));
  assert.equal(options.force, true);
});

test("contract exporter recognizes public protobuf bytecode", () => {
  assert.equal(
    isPublicProtoMember(
      "eveProto/generated/eve_public/chat/local_pb2.pyc",
    ),
    true,
  );
  assert.equal(
    isPublicProtoMember("eveProto/generated/eve/wallet/wallet_pb2.pyc"),
    false,
  );
});

test("contract exporter inventories selected Frontier client modules", () => {
  assert.equal(
    isInventoryMember("frontier/landscape/common/resource_config.pyc"),
    true,
  );
  assert.equal(
    isInventoryMember("frontier/smart_assemblies/client/proto_messenger.pyc"),
    true,
  );
  assert.equal(isInventoryMember("eve/client/script/ui/shared/mapView.pyc"), false);
});
