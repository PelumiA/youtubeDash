import { useEffect, useState } from "react";
import { Button } from "../app/ui";
import { DEFAULT_WEIGHTS, DIMENSIONS, type Weights } from "./score";

/** Point weights per scoring dimension. Changes apply only when the user clicks Apply. */
export default function WeightsEditor({ weights, onWeights }: { weights: Weights; onWeights: (w: Weights) => void }) {
  const [draft, setDraft] = useState(weights);
  useEffect(() => setDraft(weights), [weights]);
  const total = Object.values(draft).reduce((a, b) => a + b, 0);

  return (
    <div>
      {DIMENSIONS.map((d) => (
        <label key={d.id} className="flex items-center gap-3 py-1 text-sm">
          <span className="w-36">{d.label}</span>
          <input type="range" min={0} max={50} value={draft[d.id]} onChange={(e) => setDraft({ ...draft, [d.id]: Number(e.target.value) })} className="flex-1" aria-label={`${d.label} weight`} />
          <span className="w-8 text-right tabular-nums">{draft[d.id]}</span>
        </label>
      ))}
      <p className="mt-1 text-xs text-muted">Total {total} points. Scores are shown out of 100 over the dimensions that are available.</p>
      <div className="mt-2 flex gap-2">
        <Button variant="primary" onClick={() => onWeights(draft)} disabled={JSON.stringify(draft) === JSON.stringify(weights) || total === 0}>Apply weights</Button>
        <Button variant="ghost" onClick={() => setDraft(DEFAULT_WEIGHTS)}>Defaults (30/25/20/15/10)</Button>
      </div>
    </div>
  );
}
