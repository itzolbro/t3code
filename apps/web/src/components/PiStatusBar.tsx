import { EnvironmentId } from "@t3tools/contracts";
import { memo, useCallback, useState } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { usePiExtensions } from "../state/piExtensions";

/**
 * Pi Status Bar — surfaces pi's installed usage trackers (subscription
 * meter, quotas, LSP status, goal, statusline, pwsh notifications) as Pi Tie
 * features. The statuses/widgets come from pi extensions' `setStatus` /
 * `setWidget` UI requests bridged over the TUI publish stream.
 */
export const PiStatusBar = memo(function PiStatusBar() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;

  if (environmentId === null) {
    return null;
  }
  return <PiStatusBarContent environmentId={environmentId} />;
});

function PiStatusBarContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { statuses, widgets, notices } = usePiExtensions(environmentId);
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<number>>(new Set());

  const dismiss = useCallback((id: number) => {
    setDismissedNotices((previous) => new Set(previous).add(id));
  }, []);

  const visibleNotices = notices.filter((notice) => !dismissedNotices.has(notice.id));

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-border bg-muted/30">
      {visibleNotices.length > 0 ? (
        <div className="flex flex-col gap-1 px-3 py-1.5">
          {visibleNotices.map((notice) => (
            <div
              key={notice.id}
              className={
                notice.level === "error"
                  ? "flex items-start justify-between gap-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
                  : notice.level === "warning"
                    ? "flex items-start justify-between gap-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
                    : "flex items-start justify-between gap-2 rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
              }
            >
              <span className="min-w-0 truncate">{notice.text}</span>
              <button
                type="button"
                onClick={() => dismiss(notice.id)}
                className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {widgets.length > 0 ? (
        <div className="flex flex-col gap-1 overflow-x-auto px-3 py-1.5">
          {widgets.map((widget) => (
            <div key={widget.key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0 font-medium text-foreground/70">{widget.key}</span>
              <span className="whitespace-pre font-mono">
                {widget.lines.map((line, index) => (
                  <span key={index} className={index > 0 ? "ml-5" : undefined}>
                    {line}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {statuses.length > 0 ? (
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-1">
          {statuses.map((status) => (
            <span
              key={status.key}
              className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted"
              title={status.key}
            >
              {status.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
