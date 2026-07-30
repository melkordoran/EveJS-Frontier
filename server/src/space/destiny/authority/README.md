# Destiny authority

This lane will expose the package-level contracts used by the space scene,
movement commands, and services. During the migration, `destiny/index.js`
forwards to the legacy root implementation so there is still one authority.

New package consumers must use the explicit directory facade. Authority work
must consolidate the existing session, tick, and delivery state rather than
introduce another truth store. The scene runtime remains the orchestrator.

No general ship/static contact or collision-enabling massive-state policy is
part of this lane. The targeted live-missile presentation exception remains a
separate required Destiny contract.
