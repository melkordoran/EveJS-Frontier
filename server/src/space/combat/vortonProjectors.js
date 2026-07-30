const path = require("path");

const {
  normalizeDamageVector,
  sumDamageVector,
} = require(path.join(__dirname, "./damage"));
const {
  resolveMissileAppliedDamage,
} = require(path.join(__dirname, "./missiles/missileSolver"));

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round6(value) {
  return Number(toFiniteNumber(value, 0).toFixed(6));
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function dot(left, right) {
  return (
    (toFiniteNumber(left && left.x, 0) * toFiniteNumber(right && right.x, 0)) +
    (toFiniteNumber(left && left.y, 0) * toFiniteNumber(right && right.y, 0)) +
    (toFiniteNumber(left && left.z, 0) * toFiniteNumber(right && right.z, 0))
  );
}

function magnitude(vector) {
  return Math.sqrt(dot(vector, vector));
}

function getSurfaceDistance(sourceEntity, targetEntity) {
  const delta = subtractVectors(
    targetEntity && targetEntity.position,
    sourceEntity && sourceEntity.position,
  );
  return Math.max(
    0,
    magnitude(delta) -
      Math.max(0, toFiniteNumber(sourceEntity && sourceEntity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function toEntityID(entity) {
  return Math.trunc(toFiniteNumber(entity && entity.itemID, 0));
}

/**
 * A vorton projector never rolls to hit.  It has no trackingSpeed, so there is no
 * angular error term at all: inside optimal it always connects, and damage is
 * scaled by the same signature/velocity application curve missiles use.  Outside
 * optimal it does nothing — the module declares no falloff.
 */
function resolveVortonShot({
  attackerEntity,
  targetEntity,
  weaponSnapshot,
} = {}) {
  const rawShotDamage = normalizeDamageVector(
    weaponSnapshot && weaponSnapshot.rawShotDamage,
  );
  const surfaceDistance = getSurfaceDistance(attackerEntity, targetEntity);
  const optimalRange = Math.max(
    0,
    toFiniteNumber(weaponSnapshot && weaponSnapshot.optimalRange, 0),
  );
  const outOfRange = surfaceDistance > optimalRange + 1e-6;

  if (outOfRange || sumDamageVector(rawShotDamage) <= 0) {
    return {
      hit: false,
      wrecking: false,
      quality: 0,
      chanceToHit: outOfRange ? 0 : 1,
      surfaceDistance: round6(surfaceDistance),
      optimalRange: round6(optimalRange),
      outOfRange,
      applicationFactor: 0,
      shotDamage: {
        em: 0, thermal: 0, kinetic: 0, explosive: 0,
      },
    };
  }

  const applied = resolveMissileAppliedDamage(weaponSnapshot, targetEntity);

  return {
    hit: true,
    wrecking: false,
    quality: 1,
    chanceToHit: 1,
    surfaceDistance: round6(surfaceDistance),
    optimalRange: round6(optimalRange),
    outOfRange: false,
    applicationFactor: round6(
      applied.application && applied.application.applicationFactor,
    ),
    targetSignatureRadius: round6(
      applied.impactState && applied.impactState.signatureRadius,
    ),
    shotDamage: applied.appliedDamage,
  };
}

// Chain lightning arcs only to combat entities and large collidable structures -
// the same things a vorton can meaningfully engage.  It must NOT arc to wrecks,
// jetcans or other inert loot, which carry structure HP (so pilots can shoot
// them) and would otherwise read as valid via hasDamageableHealth alone.
const VORTON_ARC_TARGET_KINDS = new Set([
  "ship", // enemy ships
  "drone", // enemy drones
  "fighter", // enemy fighters: launched combat craft, same intent as drones
  "structure", // large collidable Upwell structures
  "orbital", // customs offices and other planetary orbitals
]);

function isVortonArcTargetKind(kind) {
  return VORTON_ARC_TARGET_KINDS.has(String(kind || ""));
}

/**
 * Chain lightning walks outward from the primary target: each link finds the
 * nearest not-yet-struck candidate within VortonArcRange of the PREVIOUS link,
 * not of the firing ship, so an arc can reach well past the projector's optimal.
 * Candidate supply is the caller's business - it decides what is a legal target.
 */
function selectVortonArcTargets({
  attackerEntity,
  primaryTargetEntity,
  candidateEntities = [],
  weaponSnapshot,
} = {}) {
  const arcRange = Math.max(
    0,
    toFiniteNumber(weaponSnapshot && weaponSnapshot.arcRange, 0),
  );
  const arcTargets = Math.max(
    0,
    Math.trunc(toFiniteNumber(weaponSnapshot && weaponSnapshot.arcTargets, 0)),
  );
  if (arcRange <= 0 || arcTargets <= 0 || !primaryTargetEntity) {
    return [];
  }

  const struck = new Set([
    toEntityID(attackerEntity),
    toEntityID(primaryTargetEntity),
  ]);
  const remaining = (Array.isArray(candidateEntities) ? candidateEntities : [])
    .filter((entity) => entity && !struck.has(toEntityID(entity)));

  const chain = [];
  let linkOrigin = primaryTargetEntity;

  while (chain.length < arcTargets && remaining.length > 0) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = getSurfaceDistance(linkOrigin, remaining[index]);
      if (distance <= arcRange && distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }

    if (nearestIndex < 0) {
      break;
    }

    const [nextEntity] = remaining.splice(nearestIndex, 1);
    struck.add(toEntityID(nextEntity));
    chain.push({
      entity: nextEntity,
      linkIndex: chain.length + 1,
      distanceFromPreviousLink: round6(nearestDistance),
    });
    linkOrigin = nextEntity;
  }

  return chain;
}

/**
 * Arc damage is resolved per link against that entity's own signature and
 * velocity, so a fast frigate shrugs off an arc that guts the battleship next to
 * it.  Range to the firing ship is deliberately not rechecked - the arc travels
 * from link to link, and selectVortonArcTargets already bounded each hop.
 */
function resolveVortonArcShot({ targetEntity, weaponSnapshot } = {}) {
  const rawShotDamage = normalizeDamageVector(
    weaponSnapshot && weaponSnapshot.rawShotDamage,
  );
  if (sumDamageVector(rawShotDamage) <= 0) {
    return {
      hit: false,
      wrecking: false,
      quality: 0,
      applicationFactor: 0,
      shotDamage: {
        em: 0, thermal: 0, kinetic: 0, explosive: 0,
      },
    };
  }

  const applied = resolveMissileAppliedDamage(weaponSnapshot, targetEntity);
  return {
    hit: true,
    wrecking: false,
    quality: 1,
    chanceToHit: 1,
    applicationFactor: round6(
      applied.application && applied.application.applicationFactor,
    ),
    shotDamage: applied.appliedDamage,
  };
}

module.exports = {
  resolveVortonShot,
  resolveVortonArcShot,
  selectVortonArcTargets,
  isVortonArcTargetKind,
  getSurfaceDistance,
};
