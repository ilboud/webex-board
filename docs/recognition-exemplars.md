# Recognition exemplars

Trace each outline as one continuous stroke in the stated direction, ending on the starting point. Keep the shape well inside the canvas. The fixture IDs below match the frozen automated oracle; the guidance translates their point order into a reproducible gesture rather than asking an operator to read coordinates.

## Clean automatic-replacement exemplars

### `clean-circle-64`

Start at the circle’s rightmost point. Trace a smooth, round loop clockwise at an even speed and return exactly to the start. Keep the width and height equal. A clean result maps circle to the router icon automatically.

### `clean-rectangle-64`

Start at the top-left corner. Trace the top edge left-to-right, then the right edge downward, the bottom edge right-to-left, and the left edge upward. Keep all edges straight, turn at square corners, and close exactly at the start. A clean result maps rectangle to the LAN icon automatically.

### `clean-cloud-64`

Start at the rightmost tip. Trace clockwise around five evenly spaced, rounded outward lobes, keeping the overall outline roughly circular, and close at the start. Do not draw internal lines. A clean result maps cloud to the cloud icon automatically.

## Medium suggestion exemplars

The medium fixtures use the same shape and stroke order as their clean partner with small seeded offsets. For a manual attempt, add slight, frequent hand wobble while preserving closure and the named outline. Stop when one visible source stroke and the Accept/Dismiss control appear; natural hardware input can require another attempt.

### `distorted-circle-seed-104729`

Use the `clean-circle-64` rightmost-start, clockwise order, but vary the radius slightly every few millimetres so the loop is visibly imperfect without becoming open or oval. The expected category remains circle and the intended UI outcome is a router suggestion.

### `distorted-rectangle-seed-104759`

Use the `clean-rectangle-64` top-left-start edge order. Let each edge wander slightly inward and outward while retaining four clear sides and square-ish corners. The expected category remains rectangle and the intended UI outcome is a LAN suggestion.

### `distorted-cloud-seed-104761`

Use the `clean-cloud-64` rightmost-start, clockwise order. Keep five lobes but vary their size and curvature slightly, then close the outline. The expected category remains cloud and the intended UI outcome is a cloud suggestion.

## Manual interaction checks

- Select **Accept** on a medium suggestion – only its source stroke should become the mapped icon.
- Select **Dismiss** – the control should disappear while the source stroke remains.
- Select **Undo** while a suggestion is visible – only the suggestion should disappear.
- Select **Undo** after replacement – the icon should become its original source stroke.
- Draw a medium exemplar near each canvas edge – the entire suggestion should remain inside the canvas and close to its stroke.
- Select **Clear** with ink and a suggestion present – both should disappear.
