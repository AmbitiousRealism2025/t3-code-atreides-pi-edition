import { useState } from "react";

interface ThinkingBlockProps {
  thinkingText: string;
  defaultExpanded?: boolean;
}

export default function ThinkingBlock({
  thinkingText,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previewLength = Math.max(1, Math.round(thinkingText.length / 100) * 100);

  return (
    <div className="mb-3 rounded-xl border border-border/70 bg-card/35">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/35"
      >
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground/80">{expanded ? "▾" : "▸"}</span>
          <span className="text-xs font-medium text-foreground/85">Model reasoning</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          ~{previewLength} chars
        </span>
      </button>
      {expanded && (
        <div className="border-border/70 border-t px-3 py-3">
          <pre className="wrap-break-word whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground/85">
            {thinkingText}
          </pre>
        </div>
      )}
    </div>
  );
}
