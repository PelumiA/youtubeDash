import { useEffect, useState } from "react";
import { Button } from "../app/ui";
import { TAXONOMY_PRESETS, parseCategories, type Taxonomy } from "./taxonomy";

/** Idea categories and the brief footer, from a preset or edited by hand. */
export default function TaxonomyEditor({ taxonomy, onTaxonomy }: { taxonomy: Taxonomy; onTaxonomy: (t: Taxonomy) => Promise<void> | void }) {
  const [categories, setCategories] = useState(taxonomy.categories.join(", "));
  const [footer, setFooter] = useState(taxonomy.footer);
  const [presetId, setPresetId] = useState(taxonomy.presetId);
  useEffect(() => {
    setCategories(taxonomy.categories.join(", "));
    setFooter(taxonomy.footer);
    setPresetId(taxonomy.presetId);
  }, [taxonomy]);
  const parsed = parseCategories(categories);
  const dirty = parsed.join() !== taxonomy.categories.join() || footer !== taxonomy.footer || presetId !== taxonomy.presetId;

  function loadPreset(id: string) {
    const p = TAXONOMY_PRESETS.find((x) => x.presetId === id);
    setPresetId(id);
    if (p) {
      setCategories(p.categories.join(", "));
      setFooter(p.footer);
    }
  }

  return (
    <div>
      <select className="mb-2 rounded-md border border-line bg-panel px-2 py-1 text-sm" value={presetId} onChange={(e) => loadPreset(e.target.value)} aria-label="Category preset">
        {TAXONOMY_PRESETS.map((p) => <option key={p.presetId} value={p.presetId}>{p.label}</option>)}
        {!TAXONOMY_PRESETS.some((p) => p.presetId === presetId) && <option value={presetId}>Custom</option>}
      </select>
      <textarea
        className="h-16 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm"
        value={categories}
        onChange={(e) => {
          setCategories(e.target.value);
          setPresetId("custom");
        }}
        aria-label="Categories"
      />
      <label className="mt-2 block text-xs font-medium text-muted">
        Brief footer (added to every brief.md)
        <input className="mt-1 w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm" value={footer} onChange={(e) => setFooter(e.target.value)} />
      </label>
      <Button variant="primary" className="mt-2" disabled={!dirty || parsed.length === 0} onClick={() => onTaxonomy({ presetId, categories: parsed, footer })}>Save categories</Button>
    </div>
  );
}
