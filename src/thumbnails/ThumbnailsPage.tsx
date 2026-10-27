import { Panel } from "../app/ui";

/** Placeholder: the build plan gates each module on the previous phase's definition of done. */
export default function ThumbnailsPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Panel title="Thumbnail tester">
        <div className="space-y-2 px-4 py-6 text-sm">
          <p>Score 2–4 candidates with an explained breakdown (readability, subject, safe zones, color, hook) and compare them side by side.</p>
          <p className="text-muted">Scheduled for Phase 2. It starts once the media library meets its definition of done.</p>
        </div>
      </Panel>
    </div>
  );
}
