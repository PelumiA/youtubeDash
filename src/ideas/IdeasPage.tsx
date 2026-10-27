import { Panel } from "../app/ui";

/** Placeholder: the build plan gates each module on the previous phase's definition of done. */
export default function IdeasPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Panel title="Idea organizer">
        <div className="space-y-2 px-4 py-6 text-sm">
          <p>Capture ideas as text or screenshots, categorize them, and scaffold a project folder for each.</p>
          <p className="text-muted">Scheduled for Phase 3. It starts once the media library meets its definition of done.</p>
        </div>
      </Panel>
    </div>
  );
}
