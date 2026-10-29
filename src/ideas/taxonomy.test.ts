import { describe, expect, it } from "vitest";
import { categorize, cleanOcrText, localDate, parseCategories, parseTags, suggestLocally, tagsFromText, titleFromText, TAXONOMY_PRESETS } from "./taxonomy";

const DEFAULT = TAXONOMY_PRESETS[0].categories;
const GROOVY = TAXONOMY_PRESETS[1].categories;

describe("offline idea suggestion", () => {
  it("ships the Default and Groovy Gains taxonomies", () => {
    expect(DEFAULT).toEqual(["tutorial", "talking-head", "short", "vlog", "series", "carousel", "other"]);
    expect(GROOVY).toEqual(["talking-head", "outlier-recreation", "carousel", "testimonial", "promo"]);
    expect(TAXONOMY_PRESETS[1].footer).toBe("CTA: Comment GROOVY and I'll DM you my free 4-week starter plan.");
  });

  it("picks the category with the most keyword matches, in taxonomy order on ties", () => {
    expect(categorize("How to fix your deadlift: 3 mistakes", DEFAULT)).toEqual({ category: "tutorial", matched: ["how to", "fix", "mistakes"] });
    expect(categorize("Recreate the reel that went viral", GROOVY).category).toBe("outlier-recreation");
    expect(categorize("Client transformation: lost 12kg", GROOVY).category).toBe("testimonial");
    expect(categorize("Black Friday coaching offer", GROOVY).category).toBe("promo");
    expect(categorize("Swipe through the 5 slides", DEFAULT).category).toBe("carousel");
    // Custom categories match on their own name.
    expect(categorize("a recipe for overnight oats", ["recipe", "other"]).category).toBe("recipe");
  });

  it("falls back to other, or the first category", () => {
    expect(categorize("pineapple", DEFAULT)).toEqual({ category: "other", matched: [] });
    expect(categorize("pineapple", GROOVY).category).toBe("talking-head");
    expect(suggestLocally("pineapple pizza debate", GROOVY).reason).toMatch(/no keywords/);
  });

  it("does not match keywords inside other words", () => {
    expect(categorize("a shortcut for prefixes", DEFAULT).category).toBe("other");
  });

  it("titles from the first real sentence, skipping app chrome", () => {
    const shot = "9:41 100%\n@coach.mira · 2h\n\nStop skipping warm-ups. Your knees will thank you\n\n♡ 2.4K likes  318 replies";
    expect(titleFromText(shot)).toBe("Stop skipping warm-ups");
    expect(titleFromText("idea: film the gym tour #vlog https://x.com/a")).toBe("Idea: film the gym tour");
    expect(titleFromText("")).toBe("Untitled idea");
  });

  it("joins wrapped OCR lines split into paragraphs", () => {
    expect(titleFromText("3 squat mistakes that are killing\n\nyour leg day (and how to fix each\n\none).")).toBe("3 squat mistakes that are killing your leg day");
    // A capitalised line after a gap starts a new paragraph.
    expect(titleFromText("Hip thrust tips for beginners\n\nShow the setup first")).toBe("Hip thrust tips for beginners");
  });

  it("shortens long titles at a natural break or a word boundary", () => {
    const t = titleFromText("The complete beginner's guide to building a home gym on a budget without wasting money on gear");
    expect(t.length).toBeLessThanOrEqual(71);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });

  it("tags with hashtags first, then frequent topic words", () => {
    expect(tagsFromText("#Glutes day: hip thrust form, hip thrust tempo and hip mobility")).toEqual(["glutes", "hip", "thrust", "day"]);
    expect(tagsFromText("the and of")).toEqual([]);
  });

  it("cleans OCR noise lines", () => {
    expect(cleanOcrText("  9:41   100% \n\n\n\nHello   world.\n|\nNext ")).toBe("Hello world.\n\nNext");
    expect(cleanOcrText("squat mistakes that are killing\n\nyour leg day.\n\nFilm it")).toBe("squat mistakes that are killing\nyour leg day.\n\nFilm it");
  });
});

describe("settings parsing", () => {
  it("normalizes categories and tags", () => {
    expect(parseCategories("Tutorial, Talking Head\nvlog,,tutorial")).toEqual(["tutorial", "talking-head", "vlog"]);
    expect(parseTags(" #Squat, legs, squat ,")).toEqual(["squat", "legs"]);
  });

  it("dates by local calendar day", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
