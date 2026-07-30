# Destiny batching

This lane is reserved for the collision-free Park update batching contract:
character history, bubble history, singlecasts, narrowcasts, paired bubble
updates, and packaged actions.

The migration must move the active behavior into this package without adding a
second tick queue or delivery history. Visibility and authority changes commit
only with the accepted delivery transaction and remain eligible for retry when
delivery is rejected.

The active implementation keeps the existing runtime histories and accepted
delivery transaction authoritative; this lane does not establish a second
batcher or truth store.

## Carbon license notice

The PackagedAction and Park lane-planning behavior is adapted from
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
