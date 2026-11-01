import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAspectToRect,
  calculateFillScale,
  calculateFitScale,
  clampCropRect,
} from "./reference-image-utils";

test("clampCropRect keeps crop rectangle strictly within [0, 1] bounds", () => {
  const inside = clampCropRect({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
  assert.deepEqual(inside, { x: 0.2, y: 0.2, width: 0.5, height: 0.5 });

  const overflow = clampCropRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 });
  assert.equal(overflow.x + overflow.width <= 1.0001, true);
  assert.equal(overflow.y + overflow.height <= 1.0001, true);

  const negative = clampCropRect({ x: -0.2, y: -0.1, width: 0.4, height: 0.3 });
  assert.equal(negative.x, 0);
  assert.equal(negative.y, 0);
});

test("applyAspectToRect preserves aspect ratio for presets", () => {
  const natural = { width: 1000, height: 500 }; // 2:1 ratio image
  const initial = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

  // Square (1:1)
  const square = applyAspectToRect("1:1", initial, natural);
  // (width * 1000) / (height * 500) = 1 => width / height = 0.5
  const pixelW = square.width * natural.width;
  const pixelH = square.height * natural.height;
  assert.ok(Math.abs(pixelW / pixelH - 1) < 0.01, `Expected 1:1, got ${pixelW / pixelH}`);

  // 16:9
  const wide = applyAspectToRect("16:9", initial, natural);
  const widePixelW = wide.width * natural.width;
  const widePixelH = wide.height * natural.height;
  assert.ok(Math.abs(widePixelW / widePixelH - 16 / 9) < 0.02, `Expected 16:9, got ${widePixelW / widePixelH}`);

  // Free (unconstrained)
  const free = applyAspectToRect("free", initial, natural);
  assert.deepEqual(free, initial);
});

test("calculateFitScale and calculateFillScale handle normal and 90-degree rotated orientations", () => {
  // Container: 500x500, Image: 1000x500
  const fit0 = calculateFitScale(500, 500, 1000, 500, 0);
  assert.equal(fit0, 0.5); // 500 / 1000 = 0.5

  const fill0 = calculateFillScale(500, 500, 1000, 500, 0);
  assert.equal(fill0, 1.0); // 500 / 500 = 1.0

  // Rotated 90 degrees: effective width is 500, effective height is 1000
  const fit90 = calculateFitScale(500, 500, 1000, 500, 90);
  assert.equal(fit90, 0.5); // 500 / 1000 = 0.5

  const fill90 = calculateFillScale(500, 500, 1000, 500, 90);
  assert.equal(fill90, 1.0); // 500 / 500 = 1.0
});
