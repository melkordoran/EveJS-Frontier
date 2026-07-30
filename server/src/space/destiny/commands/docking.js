function applyPendingDockStateCommand(entity, pendingDock) {
  entity.pendingDock = pendingDock;
}

module.exports = {
  applyPendingDockStateCommand,
};
