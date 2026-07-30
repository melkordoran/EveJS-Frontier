const DESTINY_COORDINATE_FRAME = Object.freeze({
  WORLD: "world",
});

const ACTIVE_DESTINY_COORDINATE_FRAME = DESTINY_COORDINATE_FRAME.WORLD;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clonePosition(position = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(position && position.x, fallback.x),
    y: toFiniteNumber(position && position.y, fallback.y),
    z: toFiniteNumber(position && position.z, fallback.z),
  };
}

function isFinitePosition(position) {
  return Boolean(
    position &&
    Number.isFinite(Number(position.x)) &&
    Number.isFinite(Number(position.y)) &&
    Number.isFinite(Number(position.z)),
  );
}

function shouldRebaseDestinyPackets() {
  return ACTIVE_DESTINY_COORDINATE_FRAME !== DESTINY_COORDINATE_FRAME.WORLD;
}

function getSessionDestinyPositionOrigin(session) {
  if (!shouldRebaseDestinyPackets()) {
    return null;
  }
  const origin = session && session._space && session._space.destinyPositionOrigin;
  return isFinitePosition(origin) ? clonePosition(origin) : null;
}

function setSessionDestinyPositionOrigin(session, position) {
  if (!session || !session._space) {
    return null;
  }
  if (!shouldRebaseDestinyPackets() || !isFinitePosition(position)) {
    session._space.destinyPositionOrigin = null;
    return null;
  }
  const origin = clonePosition(position);
  session._space.destinyPositionOrigin = origin;
  return origin;
}

function resolveOutboundDestinyPacketOrigin(origin) {
  if (!shouldRebaseDestinyPackets()) {
    return null;
  }
  return isFinitePosition(origin) ? clonePosition(origin) : null;
}

function worldToClientPosition(position) {
  return clonePosition(position);
}

function clientToWorldPosition(position) {
  return clonePosition(position);
}

module.exports = {
  ACTIVE_DESTINY_COORDINATE_FRAME,
  DESTINY_COORDINATE_FRAME,
  clientToWorldPosition,
  clonePosition,
  getSessionDestinyPositionOrigin,
  isFinitePosition,
  resolveOutboundDestinyPacketOrigin,
  setSessionDestinyPositionOrigin,
  shouldRebaseDestinyPackets,
  worldToClientPosition,
};
