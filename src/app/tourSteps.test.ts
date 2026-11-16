import { describe, expect, it } from "vitest";
import { TOUR, cardPosition } from "./tourSteps";

const card = { w: 360, h: 200 };
const vp = { w: 1400, h: 900 };

describe("tour", () => {
  it("places the card beside, then left of, then below the target, inside the viewport", () => {
    expect(cardPosition({ x: 10, y: 100, w: 200, h: 30 }, card, vp)).toEqual({ x: 224, y: 15 });
    expect(cardPosition({ x: 1100, y: 400, w: 280, h: 30 }, card, vp)).toEqual({ x: 726, y: 315 });
    const wide = cardPosition({ x: 20, y: 300, w: 1360, h: 40 }, card, vp);
    expect(wide).toEqual({ x: 520, y: 354 });
    const low = cardPosition({ x: 10, y: 880, w: 200, h: 20 }, card, vp);
    expect(low.y).toBe(vp.h - card.h - 12);
  });

  it("centres when there is no target", () => {
    expect(cardPosition(null, card, vp)).toEqual({ x: 520, y: 350 });
  });

  it("has a highlight or a page for every step, and says the library doesn't read clip content", () => {
    for (const s of TOUR) expect(s.target || s.route).toBeTruthy();
    expect(TOUR.find((s) => s.target === "nav-library")!.body.join(" ")).toMatch(/doesn't look at what's in the clip/);
  });
});
