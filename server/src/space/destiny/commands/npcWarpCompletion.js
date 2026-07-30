function applyNpcWarpCompletionWakeDeadlineCommand(entity, deadlineMs) {
  entity.deferNpcWarpCompletionWakeUntilMs = deadlineMs;
}

module.exports = {
  applyNpcWarpCompletionWakeDeadlineCommand,
};
