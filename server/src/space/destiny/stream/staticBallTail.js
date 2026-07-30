"use strict";

const { BALL_FLAG, BALL_MODE } = require("../constants");
const {
  resolveConfiguredBallFlags,
  resolveConfiguredBallMode,
} = require("./ballConfig");
const {
  buildVector,
  pushBigInt64,
  pushDouble,
  pushFloat,
  pushInt32,
  pushUInt8,
  toFiniteNumber,
  toInt32,
} = require("./primitives");

const MINI_GEOMETRY_FLAG_MASK = (
  BALL_FLAG.HAS_MINIBOXES |
  BALL_FLAG.HAS_MINIBALLS |
  BALL_FLAG.HAS_MINICAPSULES
);

function normalizeStaticTailBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const bytes = [];
    for (const valueByte of value) {
      const byte = Math.trunc(Number(valueByte));
      if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
        return null;
      }
      bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
  if (typeof value === "string") {
    const hex = value.replace(/\s+/g, "");
    if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)) {
      return Buffer.from(hex, "hex");
    }
  }
  return null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.slice(0, 0xffff) : [];
}

function getEntityMiniBalls(entity) {
  return normalizeArray(entity && (entity.miniBalls || entity.miniballs));
}

function getEntityMiniCapsules(entity) {
  return normalizeArray(entity && (entity.miniCapsules || entity.minicapsules));
}

function getEntityMiniBoxes(entity) {
  return normalizeArray(entity && (entity.miniBoxes || entity.miniboxes));
}

function getEntityMiniGeometryFlags(entity) {
  return (
    (getEntityMiniBoxes(entity).length > 0 ? BALL_FLAG.HAS_MINIBOXES : 0) |
    (getEntityMiniBalls(entity).length > 0 ? BALL_FLAG.HAS_MINIBALLS : 0) |
    (getEntityMiniCapsules(entity).length > 0 ? BALL_FLAG.HAS_MINICAPSULES : 0)
  );
}

function getStaticBallMode(entity) {
  return resolveConfiguredBallMode(entity, BALL_MODE.RIGID);
}

function getStaticBallFallbackFlags(entity) {
  if (entity && (entity.kind === "station" || entity.kind === "stargate")) {
    return BALL_FLAG.IS_GLOBAL | BALL_FLAG.IS_MASSIVE;
  }
  if (entity && entity.kind === "orbital") {
    return BALL_FLAG.IS_GLOBAL | BALL_FLAG.IS_INTERACTIVE;
  }
  if (entity && (entity.kind === "container" || entity.kind === "wreck")) {
    return BALL_FLAG.IS_INTERACTIVE;
  }
  return BALL_FLAG.IS_GLOBAL;
}

function getConfiguredStaticBallFlags(entity) {
  return (
    resolveConfiguredBallFlags(entity, getStaticBallFallbackFlags(entity)) &
    ~BALL_FLAG.IS_FREE
  ) & 0xff;
}

function hasExplicitStaticTail(entity) {
  const tail = normalizeStaticTailBuffer(entity && entity.destinyCollisionTail);
  return Boolean(tail && tail.length > 0);
}

function getStaticBallFlags(entity) {
  const configured = getConfiguredStaticBallFlags(entity);
  const generatedMiniFlags = getEntityMiniGeometryFlags(entity);
  if (hasExplicitStaticTail(entity)) {
    return configured;
  }
  return (
    (configured & ~MINI_GEOMETRY_FLAG_MASK) |
    generatedMiniFlags
  ) & 0xff;
}

function pushCount(chunks, count) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(count, 0);
  chunks.push(buffer);
}

function getMiniCapsulePoint(miniCapsule, primaryKey, fallbackKey) {
  const numericPrefix = primaryKey === "hemisphereA" ? "a" : "b";
  const numericPoint = miniCapsule && {
    x: miniCapsule[`${numericPrefix}x`],
    y: miniCapsule[`${numericPrefix}y`],
    z: miniCapsule[`${numericPrefix}z`],
  };
  return buildVector(
    miniCapsule && (
      miniCapsule[primaryKey] ||
      miniCapsule[fallbackKey] ||
      miniCapsule[primaryKey.toLowerCase()] ||
      miniCapsule[fallbackKey.toLowerCase()] ||
      numericPoint
    ),
  );
}

function getMiniBoxVector(miniBox, vectorName) {
  const numericPrefixByName = {
    corner: "c",
    localX: "x",
    localY: "y",
    localZ: "z",
  };
  const numericPrefix = numericPrefixByName[vectorName];
  return buildVector(
    miniBox && (
      miniBox[vectorName] ||
      {
        x: miniBox[`${numericPrefix}0`],
        y: miniBox[`${numericPrefix}1`],
        z: miniBox[`${numericPrefix}2`],
      }
    ),
  );
}

function appendMiniGeometrySections(chunks, entity) {
  const miniBalls = getEntityMiniBalls(entity);
  if (miniBalls.length > 0) {
    pushCount(chunks, miniBalls.length);
    for (const miniBall of miniBalls) {
      const center = buildVector(miniBall && (miniBall.center || miniBall.position || miniBall));
      pushDouble(chunks, center.x);
      pushDouble(chunks, center.y);
      pushDouble(chunks, center.z);
      pushFloat(chunks, toFiniteNumber(miniBall && miniBall.radius, 0));
    }
  }

  const miniCapsules = getEntityMiniCapsules(entity);
  if (miniCapsules.length > 0) {
    pushCount(chunks, miniCapsules.length);
    for (const miniCapsule of miniCapsules) {
      const hemisphereA = getMiniCapsulePoint(miniCapsule, "hemisphereA", "pointA");
      const hemisphereB = getMiniCapsulePoint(miniCapsule, "hemisphereB", "pointB");
      pushDouble(chunks, hemisphereA.x);
      pushDouble(chunks, hemisphereA.y);
      pushDouble(chunks, hemisphereA.z);
      pushDouble(chunks, hemisphereB.x);
      pushDouble(chunks, hemisphereB.y);
      pushDouble(chunks, hemisphereB.z);
      pushFloat(chunks, toFiniteNumber(miniCapsule && miniCapsule.radius, 0));
    }
  }

  const miniBoxes = getEntityMiniBoxes(entity);
  if (miniBoxes.length > 0) {
    pushCount(chunks, miniBoxes.length);
    for (const miniBox of miniBoxes) {
      for (const vectorName of ["corner", "localX", "localY", "localZ"]) {
        const vector = getMiniBoxVector(miniBox, vectorName);
        pushDouble(chunks, vector.x);
        pushDouble(chunks, vector.y);
        pushDouble(chunks, vector.z);
      }
    }
  }
}

function resolveStaticBallHeaderCorporationID(entity) {
  const explicit = toInt32(entity && entity.staticBallCorporationID, 0);
  if (explicit > 0) {
    return explicit;
  }
  const corporationID = toInt32(entity && entity.corporationID, 0);
  if (corporationID > 0) {
    return corporationID;
  }
  const ownerID = toInt32(entity && entity.ownerID, 0);
  return ownerID >= 1_000_000 ? ownerID : -1;
}

function buildStaticBallHeader(entity) {
  const chunks = [];
  pushDouble(chunks, toFiniteNumber(entity && entity.staticBallMass, 10_000_000_000));
  pushUInt8(chunks, toInt32(entity && entity.staticBallUnknownByte, 0));
  pushBigInt64(
    chunks,
    toInt32(entity && entity.allianceID, 0) > 0 ? entity.allianceID : -1,
  );
  pushInt32(chunks, resolveStaticBallHeaderCorporationID(entity));
  pushInt32(chunks, toInt32(entity && entity.staticBallUnknownInt32, -1));
  pushUInt8(chunks, 0xff);
  return Buffer.concat(chunks);
}

function buildGeneratedStaticTail(entity, mode) {
  const chunks = [];
  if (mode === BALL_MODE.RIGID) {
    pushUInt8(chunks, 0xff);
  } else {
    chunks.push(buildStaticBallHeader(entity));
  }
  appendMiniGeometrySections(chunks, entity);
  return Buffer.concat(chunks);
}

function resolveStaticBallTail(entity) {
  const explicitTail = normalizeStaticTailBuffer(entity && entity.destinyCollisionTail);
  if (explicitTail && explicitTail.length > 0) {
    return {
      tail: explicitTail,
      source: entity.destinyCollisionTailSource || "explicit",
    };
  }
  const mode = getStaticBallMode(entity);
  return {
    tail: buildGeneratedStaticTail(entity, mode),
    source: getEntityMiniGeometryFlags(entity) !== 0
      ? "generated-mini-geometry"
      : mode === BALL_MODE.RIGID
        ? null
        : "generated-static-header",
  };
}

module.exports = {
  MINI_GEOMETRY_FLAG_MASK,
  appendMiniGeometrySections,
  buildGeneratedStaticTail,
  buildStaticBallHeader,
  getConfiguredStaticBallFlags,
  getEntityMiniGeometryFlags,
  getStaticBallFallbackFlags,
  getStaticBallFlags,
  getStaticBallMode,
  normalizeStaticTailBuffer,
  resolveStaticBallHeaderCorporationID,
  resolveStaticBallTail,
};
