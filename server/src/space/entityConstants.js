"use strict";

// Canonical entity-type values carried on entity.npcEntityType / profile
// entityType records and compared across the NPC, combat, security, bounty and
// destiny paths.
//
// Scope note: several unrelated namespaces spell one of these values the same
// way — the /concord chat command token, the insurance CONCORD loss reason, the
// gate-skin material race hint, and the CONCORD hardware family. Those are
// distinct concepts that merely share a spelling and deliberately do NOT use
// these constants, so renaming an entity type here cannot silently change them.
const ENTITY_TYPE = Object.freeze({
  NPC: "npc",
  CONCORD: "concord",
  PLAYER: "player",
  // Target-class lists (autoAggroTargetClasses, npcControlState's allowed set)
  // draw from this same namespace and include drones.
  DRONE: "drone",
});

module.exports = { ENTITY_TYPE };
