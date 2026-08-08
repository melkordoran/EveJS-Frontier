const path = require("path");

const {
  marshalEncode,
} = require(path.join(__dirname, "../../../network/tcp/utils/marshal"));

function encodeCharacterBrainEffectLists(
  characterEffects = [],
  shipEffects = [],
  structureEffects = [],
  compatibilityProfile = "",
) {
  return marshalEncode(
    [
      { type: "list", items: characterEffects },
      { type: "list", items: shipEffects },
      { type: "list", items: structureEffects },
    ],
    { compatibilityProfile },
  );
}

module.exports = {
  encodeCharacterBrainEffectLists,
};
