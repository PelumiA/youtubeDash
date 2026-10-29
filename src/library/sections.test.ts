import { describe, expect, it } from "vitest";
import { buildChapters, formatPrecise, formatTimestamp, isOnKeyframe, parseTimestamp, sectionsFromMarkers, snapToKeyframe } from "./sections";

describe("timestamps", () => {
  it("formats and parses", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(134.9)).toBe("2:14");
    expect(formatTimestamp(3723)).toBe("1:02:03");
    expect(formatTimestamp(65, true)).toBe("0:01:05");
    expect(formatPrecise(123.44)).toBe("2:03.4");
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("1:30.5")).toBe(90.5);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("1:xx")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
});

describe("sectionsFromMarkers", () => {
  it("covers the whole clip, sorted, ignoring duplicates and edge markers", () => {
    const s = sectionsFromMarkers([600, 300, 300, 0.2, 1799.9], 1800, 7);
    expect(s.map((x) => [x.startS, x.endS])).toEqual([[0, 300], [300, 600], [600, 1800]]);
    expect(s.every((x) => x.mediaFileId === 7 && x.id === null)).toBe(true);
    expect(s[2].label).toBe("Section 3");
  });
  it("yields one section without markers", () => {
    expect(sectionsFromMarkers([], 42, 1)).toHaveLength(1);
  });
});

describe("keyframes", () => {
  const keys = [0, 10, 20, 30];
  it("snaps to the nearest keyframe within range", () => {
    expect(snapToKeyframe(11.2, keys)).toBe(10);
    expect(snapToKeyframe(18.5, keys)).toBe(20);
    expect(snapToKeyframe(15, keys, 2)).toBe(15);
    expect(snapToKeyframe(5, [])).toBe(5);
  });
  it("detects alignment", () => {
    expect(isOnKeyframe(10.03, keys)).toBe(true);
    expect(isOnKeyframe(10.2, keys)).toBe(false);
  });
});

describe("buildChapters", () => {
  it("produces a paste-ready list starting at 0:00", () => {
    const chapters = buildChapters(
      [
        { startS: 134.2, endS: 400, label: "Squat form" },
        { startS: 0, endS: 134.2, label: "Hook" },
        { startS: 400, endS: 900, label: "Common mistakes" },
      ],
      900,
    );
    expect(chapters.text).toBe("0:00 Hook\n2:14 Squat form\n6:40 Common mistakes");
    expect(chapters.warnings).toEqual([]);
  });

  it("adds an Intro when the first section starts late, and uses hours for long videos", () => {
    const chapters = buildChapters(
      [
        { startS: 60, endS: 1800, label: "Part one" },
        { startS: 1800, endS: 4000, label: "Part two" },
      ],
      4000,
    );
    expect(chapters.text).toBe("0:00:00 Intro\n0:01:00 Part one\n0:30:00 Part two");
  });

  it("warns about YouTube's rules", () => {
    const few = buildChapters([{ startS: 0, endS: 100, label: "Only" }], 100);
    expect(few.warnings.join(" ")).toMatch(/at least 3/);
    const short = buildChapters(
      [
        { startS: 0, endS: 5, label: "Blink" },
        { startS: 5, endS: 50, label: "B" },
        { startS: 50, endS: 100, label: "C" },
      ],
      100,
    );
    expect(short.warnings.join(" ")).toMatch(/10 seconds: Blink/);
  });
});
