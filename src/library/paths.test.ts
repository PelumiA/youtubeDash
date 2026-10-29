import { describe, expect, it } from "vitest";
import { isUnder, joinPath, pathKey } from "./paths";

describe("path helpers", () => {
  it("normalizes both separators and case", () => {
    expect(pathKey("C:\\Media\\Reels\\")).toBe("c:/media/reels");
    expect(pathKey("C:\\Media/Reels")).toBe(pathKey("c:/media\\reels"));
  });

  it("joins without doubling separators", () => {
    expect(joinPath("C:\\Media\\", "\\Reels\\", "a.mp4")).toBe("C:\\Media\\Reels\\a.mp4");
    expect(joinPath("/media/", "a.mp4")).toBe("/media/a.mp4");
  });

  it("knows what is inside a folder", () => {
    expect(isUnder("C:\\Media\\Reels\\a.mp4", "c:\\media")).toBe(true);
    expect(isUnder("C:\\Media", "C:\\Media\\")).toBe(true);
    expect(isUnder("C:\\Media2\\a.mp4", "C:\\Media")).toBe(false);
  });
});
