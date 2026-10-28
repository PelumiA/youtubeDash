import { useEffect, useState } from "react";
import { api, pickFolder, type AiStatus, type StarterFolder } from "../db/api";
import { TAXONOMY_PRESETS, localDate } from "../ideas/taxonomy";
import { PRESETS } from "../library/renameEngine";
import { joinPath } from "../library/paths";
import { PLATFORMS, type PlatformId } from "../thumbnails/platforms";
import AiSettingsField from "./AiSettingsField";
import { SETTINGS, setJson } from "./settings";
import { Badge, Button } from "./ui";

type Pack = "default" | "groovy-gains";

const PACKS: Array<{ id: Pack; label: string; blurb: string; starter: string[] }> = [
  {
    id: "default",
    label: "Default",
    blurb: "General YouTube naming; idea categories tutorial, talking-head, short, vlog, series, carousel, other.",
    starter: [...new Set(Object.values(PRESETS[0].folders))],
  },
  {
    id: "groovy-gains",
    label: "Groovy Gains",
    blurb: "Reels / carousels naming; categories talking-head, outlier-recreation, carousel, testimonial, promo; every brief ends with the GROOVY CTA.",
    starter: ["Reels", "Carousels", "Thumbnails", "Ideas"],
  },
];

const STEPS = ["Preset pack", "Media folder", "Projects folder", "Thumbnails", "AI"];

/** First run: a few choices with sensible defaults. Every step can be skipped and redone in Settings. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [pack, setPack] = useState<Pack>("default");
  const [mediaRoot, setMediaRoot] = useState<string | null>(null);
  const [starter, setStarter] = useState<StarterFolder[] | null>(null);
  const [projectsDir, setProjectsDir] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformId>("youtube");
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const packInfo = PACKS.find((p) => p.id === pack)!;

  useEffect(() => {
    api.aiStatus().then(setAi, () => {});
  }, []);

  // What the starter folders would do in the chosen media folder (nothing is created yet).
  useEffect(() => {
    setStarter(null);
    if (mediaRoot) api.planStarterFolders(mediaRoot, packInfo.starter).then(setStarter, (e) => setError(String(e)));
  }, [mediaRoot, packInfo]);

  async function chooseMedia() {
    const dir = await pickFolder("Choose your main media folder");
    if (dir) setMediaRoot(dir);
  }

  async function createStarter() {
    try {
      setStarter(await api.createStarterFolders(mediaRoot!, packInfo.starter));
    } catch (e) {
      setError(String(e));
    }
  }

  async function finish() {
    try {
      const taxonomy = TAXONOMY_PRESETS.find((t) => t.presetId === pack)!;
      await api.setSetting(SETTINGS.libraryPreset, pack);
      await setJson(SETTINGS.taxonomy, { presetId: taxonomy.presetId, categories: taxonomy.categories, footer: taxonomy.footer });
      if (mediaRoot) await api.setSetting(SETTINGS.libraryRoot, mediaRoot);
      if (projectsDir) await api.setSetting(SETTINGS.projectsDir, projectsDir);
      await api.setSetting(SETTINGS.defaultPlatform, platform);
      await api.setSetting(SETTINGS.onboardingDone, localDate());
      onDone();
    } catch (e) {
      setError(String(e));
    }
  }

  async function skip() {
    await api.setSetting(SETTINGS.onboardingDone, localDate()).catch(() => {});
    onDone();
  }

  const card = (selected: boolean) => `w-full rounded-lg border p-3 text-left ${selected ? "border-accent ring-2 ring-accent/30" : "border-line hover:bg-sunken"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Set up Creator Dashboard">
      <div className="flex w-full max-w-xl flex-col rounded-lg border border-line bg-panel shadow-xl">
        <div className="border-b border-line px-5 py-3">
          <div className="font-semibold">Set up Creator Dashboard</div>
          <ol className="mt-2 flex gap-1 text-[11px]">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex-1 border-t-2 pt-1 ${i <= step ? "border-accent text-ink" : "border-line text-muted"}`}>{s}</li>
            ))}
          </ol>
        </div>

        <div className="min-h-64 space-y-3 px-5 py-4 text-sm">
          {step === 0 && (
            <>
              <p>Pick a starting point for file naming and idea categories. You can change either later in Settings.</p>
              {PACKS.map((p) => (
                <button key={p.id} className={card(pack === p.id)} onClick={() => setPack(p.id)} aria-pressed={pack === p.id}>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-muted">{p.blurb}</div>
                </button>
              ))}
            </>
          )}

          {step === 1 && (
            <>
              <p>The folder you shoot into. The Media library opens it automatically. Scanning only reads; nothing is renamed without a preview.</p>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{mediaRoot ?? "No folder chosen"}</span>
                <Button onClick={chooseMedia}>{mediaRoot ? "Change…" : "Choose folder…"}</Button>
              </div>
              {mediaRoot && starter && (
                <div className="rounded-md border border-line p-3">
                  <p className="mb-2 text-xs text-muted">Starter folders for the {packInfo.label} pack (only missing ones are created; existing folders are left as they are):</p>
                  <ul className="mb-2 flex flex-wrap gap-1.5">
                    {starter.map((f) => (
                      <li key={f.name}><Badge tone={f.status === "missing" ? "muted" : "ok"}>{f.name}/ · {f.status === "missing" ? "will be created" : f.status}</Badge></li>
                    ))}
                  </ul>
                  <Button onClick={createStarter} disabled={!starter.some((f) => f.status === "missing")}>Create missing folders</Button>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <p>Where the Idea organizer creates project folders (each one gets brief.md, script.md, assets/ and thumbnails/).</p>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{projectsDir ?? "No folder chosen"}</span>
                <Button onClick={async () => setProjectsDir((await pickFolder("Choose (or create) your Projects folder", "C:\\Demo\\Projects")) ?? projectsDir)}>Choose folder…</Button>
              </div>
              {mediaRoot && (
                <Button variant="ghost" onClick={() => setProjectsDir(joinPath(mediaRoot, "Projects"))}>Use {joinPath(mediaRoot, "Projects")}</Button>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p>Which platform should new thumbnail tests start on? Each project can still switch.</p>
              {(Object.keys(PLATFORMS) as PlatformId[]).map((id) => (
                <button key={id} className={card(platform === id)} onClick={() => setPlatform(id)} aria-pressed={platform === id}>
                  <div className="font-medium">{PLATFORMS[id].label}</div>
                  <div className="text-xs text-muted">{id === "youtube" ? "16:9, checked against the duration badge, hover buttons and progress bar." : "9:16 cover, checked against the action rail, caption and the 3:4 profile-grid crop."}</div>
                </button>
              ))}
            </>
          )}

          {step === 4 && (
            <>
              <p>Optional. With an Anthropic or OpenRouter API key, the AI can critique thumbnail hooks and suggest idea categories. It only runs when you ask, and you confirm what is sent. Everything else works offline.</p>
              <AiSettingsField ai={ai} onAi={setAi} offlineNote="You can add or remove it later in Settings." />
            </>
          )}

          {error && <p className="text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={skip}>Skip setup</Button>
          <span className="flex gap-2">
            {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)}>{(step === 1 && !mediaRoot) || (step === 2 && !projectsDir) ? "Skip this step" : "Next"}</Button>
            ) : (
              <Button variant="primary" onClick={finish}>Finish</Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
