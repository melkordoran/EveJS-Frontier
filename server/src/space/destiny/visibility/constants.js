"use strict";

// Retail client-facing bubble/grid constants. Keep public-grid streaming and
// internal bubble ownership importing these from one place so static props,
// dynamic ships, and warp-handoff visibility cannot drift independently.
const BUBBLE_RADIUS_METERS = 250_000;
const BUBBLE_HYSTERESIS_METERS = 5_000;
const BUBBLE_RADIUS_SQUARED = BUBBLE_RADIUS_METERS * BUBBLE_RADIUS_METERS;
const BUBBLE_CENTER_MIN_DISTANCE_METERS = BUBBLE_RADIUS_METERS * 2;
const BUBBLE_CENTER_MIN_DISTANCE_SQUARED =
  BUBBLE_CENTER_MIN_DISTANCE_METERS * BUBBLE_CENTER_MIN_DISTANCE_METERS;
const BUBBLE_RETENTION_RADIUS_METERS =
  BUBBLE_RADIUS_METERS + BUBBLE_HYSTERESIS_METERS;
const BUBBLE_RETENTION_RADIUS_SQUARED =
  BUBBLE_RETENTION_RADIUS_METERS * BUBBLE_RETENTION_RADIUS_METERS;

// CCP Nullarbor documented the post-Brain-in-a-Box public grid as 7,864,320m.
// Elysian keeps 250km bubbles as the internal ownership unit while streaming
// player-facing dynamic/static visibility through these larger boxes.
const PUBLIC_GRID_BOX_METERS = 7_864_320;
const PUBLIC_GRID_HALF_BOX_METERS = PUBLIC_GRID_BOX_METERS / 2;
// Current-client Jita captures acquire the diagonal 50001250 gate group (11.2
// Mm centre-to-centre / 8.6 Mm from the landing point), while excluding the
// next gate 20.3 Mm away. Keep this local neighbourhood non-transitive; it
// augments, rather than merges, face-connected giant-grid clusters.
const PUBLIC_GRID_NEARBY_VISIBILITY_RADIUS_METERS = 12_500_000;

module.exports = {
  BUBBLE_CENTER_MIN_DISTANCE_METERS,
  BUBBLE_CENTER_MIN_DISTANCE_SQUARED,
  BUBBLE_HYSTERESIS_METERS,
  BUBBLE_RADIUS_METERS,
  BUBBLE_RADIUS_SQUARED,
  BUBBLE_RETENTION_RADIUS_METERS,
  BUBBLE_RETENTION_RADIUS_SQUARED,
  PUBLIC_GRID_BOX_METERS,
  PUBLIC_GRID_HALF_BOX_METERS,
  PUBLIC_GRID_NEARBY_VISIBILITY_RADIUS_METERS,
};
