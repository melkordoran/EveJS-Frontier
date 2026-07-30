# Destiny visibility

This lane will own once-per-tick acquisition and removal planning for dynamic,
bubble-scoped static, and public-grid Destiny state.

Scene code may discover topology deltas, but package planners must order their
presentation and stage visibility mutations with the same accepted delivery
transaction. The migration consolidates the current session visibility sets;
it must not create a parallel visibility database or commit visibility before
delivery succeeds.

The final scene-tick coordinator adapts Carbon's once-per-`currentTime`
BubbleUpdater law to the existing 100 ms scene tick. It snapshots only local
arrays and uses ephemeral local Sets to deduplicate entity and session aliases
inside the current plan. Existing topology and generation ledgers remain the
only inputs and truth stores supplied by the scene orchestrator. The coordinator
creates no retained BubbleUpdater dictionaries, timer, tick cache, membership
store, or delivery history.

`membershipState.js` and `controlState.js` are stateless ownership adapters over
those same runtime-supplied objects. They centralize committed membership,
generation-local reservations, fresh/release bookkeeping, warp handoff and quiet
state, deferred presentation, suppression, and post-attach mutation without
retaining a second copy. Runtime still chooses scene policy and delivery order;
the adapters enforce exact-generation and accepted-delivery mutation boundaries.

## Carbon license notice

The final scene-tick coordination behavior is adapted from
`carbonengine/destiny` v3.1.1.

MIT License

Copyright (c) 2026 CCP Games

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
