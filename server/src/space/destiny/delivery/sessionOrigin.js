const coordinateFrame = require("./coordinateFrame");

function resolveSessionDestinyPositionOrigin(session) {
  return coordinateFrame.getSessionDestinyPositionOrigin(session);
}

function setSessionDestinyPositionOrigin(session, position) {
  return coordinateFrame.setSessionDestinyPositionOrigin(session, position);
}

function translateClientPositionToWorldPosition(session, position) {
  return coordinateFrame.clientToWorldPosition(position, session);
}

module.exports = {
  resolveSessionDestinyPositionOrigin,
  setSessionDestinyPositionOrigin,
  translateClientPositionToWorldPosition,
};
