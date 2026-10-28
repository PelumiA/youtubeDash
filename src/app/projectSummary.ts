/**
 * One-page Markdown summary of a project: what it is, where it lives, the idea it came from,
 * and the thumbnail test with its explained scores. Pure, so it is tested without the app.
 */
import type { Idea, Project, ThumbnailRow } from "../db/api";
import { PLATFORMS } from "../thumbnails/platforms";
import { DIMENSIONS, explainWinner, score, type Breakdown, type Candidate, type Weights } from "../thumbnails/score";

export interface SummaryInput {
  project: Project;
  thumbnails: ThumbnailRow[];
  idea: Idea | null;
  weights: Weights;
  /** The tester's video title for this project, if any. */
  videoTitle?: string | null;
  /** YYYY-MM-DD the summary was generated. */
  date: string;
}

const day = (iso: string) => iso.slice(0, 10);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function buildProjectSummary({ project, thumbnails, idea, weights, videoTitle, date }: SummaryInput): string {
  const lines: string[] = [`# ${project.title}`, ""];
  lines.push(`- **Status:** ${project.status}`);
  if (project.category) lines.push(`- **Category:** ${project.category}`);
  if (idea?.tags.length) lines.push(`- **Tags:** ${idea.tags.join(", ")}`);
  lines.push(`- **Created:** ${day(project.createdAt)}`);
  if (project.folderPath) lines.push(`- **Folder:** \`${project.folderPath}\``);
  if (videoTitle?.trim()) lines.push(`- **Video title:** ${videoTitle.trim()}`);
  lines.push(`- **Summary generated:** ${date}`);

  if (idea) {
    lines.push("", "## Idea", "", `Captured ${day(idea.createdAt)}${idea.hasImage ? " from a screenshot" : ""}.`);
    const text = [idea.rawText, idea.ocrText].map((t) => t?.trim()).filter(Boolean).join("\n\n");
    if (text) lines.push("", ...text.split("\n").map((l) => (l ? `> ${l}` : ">")));
  }

  lines.push("", "## Thumbnail test", "");
  const scored = thumbnails
    .filter((t) => t.breakdownJson)
    .map((t) => ({ t, b: JSON.parse(t.breakdownJson!) as Breakdown }))
    .map(({ t, b }) => ({ t, b, s: score(b, weights) }));
  if (!thumbnails.length) {
    lines.push("No thumbnails tested yet.");
    return lines.join("\n") + "\n";
  }
  if (!scored.length) {
    lines.push(`${thumbnails.length} candidate${thumbnails.length === 1 ? "" : "s"} added but not scored yet. Open the thumbnail tester to score them.`);
    return lines.join("\n") + "\n";
  }

  const winner = thumbnails.find((t) => t.id === project.winnerThumbnailId) ?? null;
  const platforms = [...new Set(scored.map((x) => PLATFORMS[x.b.platform].label))];
  lines.push(`Platform: ${platforms.join(", ")}. Weights: ${DIMENSIONS.map((d) => `${d.label.toLowerCase()} ${weights[d.id]}`).join(", ")}.`, "");
  lines.push(`| Candidate | Score | ${DIMENSIONS.map((d) => d.label).join(" | ")} |`);
  lines.push(`|---|---|${DIMENSIONS.map(() => "---").join("|")}|`);
  for (const { t, s } of [...scored].sort((a, b) => b.s.total - a.s.total)) {
    const name = `${cell(t.label || t.path)}${t.id === winner?.id ? " ★" : ""}`;
    const dims = s.dims.map((d) => (d.points == null ? "n/a" : `${d.points.toFixed(1)}/${d.weight}${d.overridden ? "*" : ""}`));
    lines.push(`| ${name} | ${s.total.toFixed(0)}${s.outOf < 100 ? ` (of ${s.outOf} pts)` : ""} | ${dims.join(" | ")} |`);
  }
  if (scored.some((x) => x.s.dims.some((d) => d.overridden))) lines.push("", "\\* set by hand; the measured value is in the app.");
  const unscored = thumbnails.length - scored.length;
  if (unscored > 0) lines.push("", `${unscored} more candidate${unscored === 1 ? " isn't" : "s aren't"} scored yet.`);

  const candidates: Candidate[] = scored.map(({ t, s }) => ({ id: t.id, name: t.label || "candidate", score: s }));
  const why = explainWinner(candidates);
  lines.push("");
  if (winner) lines.push(`**Winner:** ${winner.label || winner.path} (picked by you).`);
  else lines.push("**Winner:** not picked yet.");
  if (why) lines.push("", `Why the top score leads: ${why.text}`);

  const pick = winner ? scored.find((x) => x.t.id === winner.id) : [...scored].sort((a, b) => b.s.total - a.s.total)[0];
  if (pick) {
    const notes = pick.s.dims.flatMap((d) => d.notes.map((n) => `- ${d.label}: ${n}`));
    if (notes.length) lines.push("", `### Notes on ${pick.t.label || "the top candidate"}`, "", ...notes);
    const ai = pick.b.ai;
    if (ai) lines.push("", `### AI critique (${ai.model}, advisory)`, "", `Hook ${ai.hookScore}/10 · reads as ${ai.emotion}. ${ai.story}`, "", ...ai.critique.map((c) => `- ${c}`));
  }
  return lines.join("\n") + "\n";
}
