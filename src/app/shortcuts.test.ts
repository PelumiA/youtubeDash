import { describe, expect, it } from "vitest";
import { actionFor, type KeyInput } from "./shortcuts";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, typing: false, ...mods });

describe("keyboard shortcuts", () => {
  it("maps Ctrl and Cmd combos", () => {
    expect(actionFor(key("k", { ctrlKey: true }))).toEqual({ kind: "palette" });
    expect(actionFor(key("K", { metaKey: true }))).toEqual({ kind: "palette" });
    expect(actionFor(key("3", { ctrlKey: true }))).toEqual({ kind: "go", route: "thumbnails" });
    expect(actionFor(key(",", { ctrlKey: true }))).toEqual({ kind: "go", route: "settings" });
    expect(actionFor(key("N", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "newIdea" });
  });

  it("works while typing for modifier combos, but ? only outside text fields", () => {
    expect(actionFor(key("k", { ctrlKey: true, typing: true }))).toEqual({ kind: "palette" });
    expect(actionFor(key("?", { shiftKey: true }))).toEqual({ kind: "help" });
    expect(actionFor(key("?", { shiftKey: true, typing: true }))).toBeNull();
  });

  it("ignores everything else", () => {
    expect(actionFor(key("k"))).toBeNull();
    expect(actionFor(key("5", { ctrlKey: true }))).toBeNull();
    expect(actionFor(key("k", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(actionFor(key("v", { ctrlKey: true }))).toBeNull();
  });
});
