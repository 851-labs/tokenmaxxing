import { describe, expect, it } from "vite-plus/test";

import { placeTooltip, tooltipBounds, type Rect, type Size } from "./tooltip-placement";

/** A 390 × 844 phone with a chart frame inset 20px on each side. */
const PHONE: Size = { height: 844, width: 390 };
const FRAME: Rect = { bottom: 600, left: 20, right: 370, top: 300 };
const CARD: Size = { height: 120, width: 220 };

function box(left: number, top: number, width: number, height: number): Rect {
  return { bottom: top + height, left, right: left + width, top };
}

function within(spot: { left: number; top: number }, card: Size, bounds: Rect) {
  expect(spot.left).toBeGreaterThanOrEqual(bounds.left);
  expect(spot.left + card.width).toBeLessThanOrEqual(bounds.right);
  expect(spot.top).toBeGreaterThanOrEqual(bounds.top);
  expect(spot.top + card.height).toBeLessThanOrEqual(bounds.bottom);
}

describe("tooltipBounds", () => {
  it("is the frame horizontally and the viewport vertically, kept off the screen edges", () => {
    expect(tooltipBounds(FRAME, PHONE)).toEqual({ bottom: 836, left: 20, right: 370, top: 8 });
  });

  it("clips a frame wider than a very narrow viewport to the viewport minus the gutter", () => {
    expect(tooltipBounds(box(-40, 100, 500, 200), { height: 640, width: 280 })).toEqual({
      bottom: 632,
      left: 8,
      right: 272,
      top: 8,
    });
  });

  it("collapses to an empty range rather than inverting when the frame is off screen", () => {
    const bounds = tooltipBounds(box(500, 0, 100, 100), PHONE);
    expect(bounds.right).toBe(bounds.left);
  });
});

describe("placeTooltip above", () => {
  const bounds = tooltipBounds(FRAME, PHONE);
  const place = (anchor: Rect, card: Size = CARD) =>
    placeTooltip({ anchor, bounds, card, offset: 12, placement: "above" });

  it("centres the card over the anchor when there is room", () => {
    const spot = place(box(180, 400, 30, 200));
    expect(spot).toEqual({ left: 85, side: "above", top: 268 });
  });

  it("clamps inside the frame for an anchor at the left edge", () => {
    const spot = place(box(24, 400, 20, 200));
    expect(spot.left).toBe(20);
    within(spot, CARD, bounds);
  });

  it("clamps inside the frame for an anchor at the right edge", () => {
    const spot = place(box(350, 400, 20, 200));
    expect(spot.left).toBe(370 - 220);
    within(spot, CARD, bounds);
  });

  it("flips below an anchor near the top of the viewport", () => {
    const spot = place(box(180, 40, 30, 60));
    expect(spot).toEqual({ left: 85, side: "below", top: 112 });
  });

  it("stays on screen when neither side has room, on the roomier side", () => {
    const tall: Size = { height: 500, width: 220 };
    const spot = place(box(180, 500, 30, 20), tall);
    expect(spot.side).toBe("above");
    within(spot, tall, bounds);
  });

  it("pins a card wider than the chart to the frame's left edge", () => {
    const narrow = tooltipBounds(box(20, 300, 150, 200), PHONE);
    const spot = placeTooltip({
      anchor: box(150, 400, 10, 100),
      bounds: narrow,
      card: CARD,
      offset: 12,
      placement: "above",
    });
    expect(spot.left).toBe(20);
  });

  it("keeps a card inside a very narrow viewport", () => {
    const tiny = tooltipBounds(box(16, 200, 288, 200), { height: 568, width: 320 });
    const card: Size = { height: 120, width: tiny.right - tiny.left };
    for (const x of [16, 150, 300]) {
      within(
        placeTooltip({
          anchor: box(x, 300, 4, 100),
          bounds: tiny,
          card,
          offset: 12,
          placement: "above",
        }),
        card,
        tiny,
      );
    }
  });
});

describe("placeTooltip beside", () => {
  const desktop = tooltipBounds(box(100, 200, 900, 280), { height: 900, width: 1280 });
  const place = (anchor: Rect, bounds: Rect = desktop) =>
    placeTooltip({ anchor, bounds, card: CARD, offset: 12, placement: "beside" });

  it("goes right of a bar in the first half and vertically centres on it", () => {
    expect(place(box(300, 200, 10, 280))).toEqual({ left: 322, side: "right", top: 280 });
  });

  it("goes left of a bar in the second half", () => {
    expect(place(box(800, 200, 10, 280))).toEqual({ left: 568, side: "left", top: 280 });
  });

  it("overlaps the bar but stays inside a frame too narrow for either side", () => {
    const bounds = tooltipBounds(FRAME, PHONE);
    for (const x of [24, 190, 360]) {
      within(place(box(x, 300, 6, 280), bounds), CARD, bounds);
    }
  });
});
