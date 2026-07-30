const PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS = 4;
// The current client contract authors WarpTo four ticks ahead. Keep the
// history-safe trust window on that same preserved contract until the atomic
// ring cutover; John's one-tick authoring policy is deliberately not active.
const PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD =
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS;
// Handoff planning starts as soon as the active warp has left its source
// public grid; no second wall-clock grace belongs beside the live-grid test.
const PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS = 0;
// Retain the exact handoff surface value for parity. Runtime presentation still
// uses the preserved four-tick history-safe lane above until golden evidence
// authorizes a separate current-lane cutover.
const PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS = 0;
// Destination controllers may prewarm throughout deceleration, while their
// static visibility snapshot becomes eligible inside the observed 10 Mm gate.
const PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS = 10_000_000;

module.exports = {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
};
