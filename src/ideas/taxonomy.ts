/**
 * Idea taxonomy presets and the offline suggestion: a keyword match for the category, the
 * idea's first real sentence as a working title, and frequent topic words as tags. Claude's
 * suggestion replaces it when an API key is set, but this path always works.
 */

export interface Taxonomy {
  presetId: string;
  categories: string[];
  /** Closing line added to every project brief. */
  footer: string;
}

export interface Suggestion {
  category: string;
  title: string;
  tags: string[];
  source: "ai" | "local";
  model?: string | null;
  cached?: boolean;
  /** Why the offline suggestion picked this category. */
  reason?: string | null;
}

export const TAXONOMY_PRESETS: Array<Taxonomy & { label: string }> = [
  {
    presetId: "default",
    label: "Default",
    categories: ["tutorial", "talking-head", "short", "vlog", "series", "carousel", "other"],
    footer: "",
  },
  {
    presetId: "groovy-gains",
    label: "Groovy Gains",
    categories: ["talking-head", "outlier-recreation", "carousel", "testimonial", "promo"],
    footer: "CTA: Comment GROOVY and I'll DM you my free 4-week starter plan.",
  },
];

export const DEFAULT_TAXONOMY: Taxonomy = TAXONOMY_PRESETS[0];

/** Phrases that point at a category. Custom categories match on their own name. */
const KEYWORDS: Record<string, string[]> = {
  tutorial: ["how to", "tutorial", "step by step", "guide", "learn", "tips", "fix", "mistakes", "technique", "explained", "beginner"],
  "talking-head": ["talking head", "to camera", "my take", "opinion", "story time", "rant", "why i", "thoughts on", "hot take", "unpopular"],
  short: ["short", "reel", "tiktok", "15 sec", "30 sec", "quick clip", "one-liner"],
  vlog: ["vlog", "day in", "behind the scenes", "come with me", "week in", "my routine"],
  series: ["series", "part 1", "part 2", "episode", "day 1", "week 1", "30 day", "challenge"],
  carousel: ["carousel", "slides", "swipe", "infographic", "cheat sheet"],
  "outlier-recreation": ["outlier", "went viral", "viral", "recreate", "remake", "million views", "blew up", "trending"],
  testimonial: ["testimonial", "client", "transformation", "before and after", "success story", "results", "lost"],
  promo: ["promo", "launch", "discount", "sale", "offer", "sign up", "coaching", "program", "dm me", "link in bio", "spots left"],
};

/** Words that make a line social-app chrome rather than idea text. */
const UI_WORDS = new Set(
  "likes like replies reply retweets retweet reposts repost views view comments comment shares share follow following followers followed send sent edited ago am pm sponsored translate more see show".split(" "),
);

const STOPWORDS = new Set(
  (
    "the a an and or but if then so of to in on at by for with from up down out over into about as is are was were be been being it its this that these those " +
    "i me my we our you your he she they them their his her what which who whom how why when where there here all any each one two three some most more less " +
    "very just really also too not no yes can could should would will shall may might must do does did doing done have has had make makes made get gets got " +
    "film shoot video post idea ideas quick behind thing things way stop killing need want like every best good bad new"
  ).split(" "),
);

const hasWord = (line: string, min = 2) => new RegExp(`[A-Za-z]{${min},}`).test(line);

/**
 * Tidies OCR output: drops lines with no real words, collapses spaces and blank runs, and
 * removes the blank line OCR puts inside a wrapped sentence (unfinished line, lowercase next).
 */
export function cleanOcrText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .map((l) => (l && !hasWord(l) ? "" : l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([^.!?:\n])\n\n(?=[a-z(])/g, "$1\n")
    .trim();
}

/** Lines of real idea text: no handles, links, timestamps or app chrome. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/https?:\/\/\S+|www\.\S+/gi, "")
        .replace(/(^|\s)[@#][\w.]+/g, "$1")
        .replace(/[^\p{L}\p{N}\s.,!?'’"“”:;()&%$£€+-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .map((l) => {
      const words = (l.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1);
      return words.length && words.some((w) => !UI_WORDS.has(w)) && hasWord(l, 3) ? l : "";
    });
}

/** The idea's first real sentence (joined across wrapped lines), trimmed to fit a title. */
export function titleFromText(text: string, max = 70): string {
  const paragraphs: string[] = [];
  let current = "";
  let gap = false;
  for (const line of contentLines(text)) {
    if (!line) {
      gap = true;
      continue;
    }
    // OCR often splits one wrapped sentence into "paragraphs"; a gap only ends the paragraph
    // when the sentence looks finished or the next line starts a new one.
    const continues = current && (!gap || (!/[.!?:]$/.test(current) && /^[a-z(]/.test(line)));
    if (continues) current = `${current} ${line}`;
    else {
      if (current) paragraphs.push(current);
      current = line;
    }
    gap = false;
  }
  if (current) paragraphs.push(current);

  const sentences = paragraphs.flatMap((p) => p.split(/(?<=[.!?])\s+/));
  const pick = sentences.find((s) => (s.match(/[A-Za-z]{2,}/g) ?? []).length >= 3) ?? sentences[0] ?? "";
  let title = pick.replace(/[.!?]+$/, "").trim();
  if (title.length > max) {
    // Prefer a natural break (parenthesis, dash, colon) over cutting mid-phrase.
    const brk = title.slice(0, max).search(/\s[(\-–—:]|:\s/);
    title = brk >= 20 ? title.slice(0, brk) : `${title.slice(0, max).replace(/\s+\S*$/, "")}…`;
  }
  title = title.replace(/[\s,;:(–—-]+$/, "").trim();
  return title ? title[0].toUpperCase() + title.slice(1) : "Untitled idea";
}

/** Hashtags first, then the most frequent topic words. */
export function tagsFromText(text: string, max = 4): string[] {
  const tags: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)#([A-Za-z][\w-]{1,30})/g)) tags.push(m[1].toLowerCase());
  const counts = new Map<string, { n: number; first: number }>();
  const words = contentLines(text).join(" ").toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  words.forEach((w, i) => {
    w = w.replace(/'s$/, "");
    if (w.length < 3 || STOPWORDS.has(w) || UI_WORDS.has(w)) return;
    const c = counts.get(w);
    counts.set(w, c ? { ...c, n: c.n + 1 } : { n: 1, first: i });
  });
  const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).map(([w]) => w);
  for (const w of ranked) if (!tags.includes(w)) tags.push(w);
  return tags.slice(0, max);
}

export function categorize(text: string, categories: string[]): { category: string; matched: string[] } {
  const hay = ` ${contentLines(text).join(" ").toLowerCase().replace(/[^a-z0-9%]+/g, " ")} `;
  let best = { category: "", matched: [] as string[] };
  for (const cat of categories) {
    const phrases = [...(KEYWORDS[cat] ?? []), cat.replace(/-/g, " ")];
    const matched = phrases.filter((p) => hay.includes(` ${p.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim()} `));
    if (matched.length > best.matched.length) best = { category: cat, matched };
  }
  if (best.category) return best;
  return { category: categories.includes("other") ? "other" : categories[0] ?? "", matched: [] };
}

export function suggestLocally(text: string, categories: string[]): Suggestion {
  const { category, matched } = categorize(text, categories);
  return {
    category,
    title: titleFromText(text),
    tags: tagsFromText(text),
    source: "local",
    model: null,
    cached: false,
    reason: matched.length ? `matched ${matched.map((m) => `"${m}"`).join(", ")}` : "no keywords matched, so the default category",
  };
}

/** Parses a free-form category list (commas or new lines) into unique slugs. */
export function parseCategories(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const c = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Local calendar date, YYYY-MM-DD (not UTC: a late-night idea belongs to today). */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
