/**
 * ToolApprovalCard - Inline tool approval with 60-second countdown.
 *
 * Design spec: Leto Prime (CDO), 2026-03-22
 * Calm authority, not reactive scramble. Progressive visual warmth
 * communicates urgency without anxiety.
 *
 * Phases:
 *   Calm (60-20s)    - accent color
 *   Warm (20-10s)    - warning color
 *   Urgent (10-5s)   - danger color
 *   Critical (5-0s)  - danger + pulse
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

// ── Types ──────────────────────────────────────────────────────────

export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "auto-approved";

export interface ToolApprovalCardProps {
  /** Unique request ID */
  requestId: string;
  /** Tool name (e.g. "Edit", "Bash", "Write") */
  toolName: string;
  /** One-line description of the action */
  detail: string;
  /** Whether to render in compact (single-line) mode */
  compact?: boolean;
  /** Called when user approves */
  onApprove: (requestId: string) => void;
  /** Called when user rejects */
  onReject: (requestId: string) => void;
  /** Called when auto-approval fires */
  onAutoApprove: (requestId: string) => void;
  /** Total countdown duration in seconds */
  duration?: number;
  /** Whether keyboard shortcuts are active (disabled when composer has focus) */
  keyboardActive?: boolean;
}

// ── Phase logic ────────────────────────────────────────────────────

type Phase = "calm" | "warm" | "urgent" | "critical";

function getPhase(remaining: number): Phase {
  if (remaining > 20) return "calm";
  if (remaining > 10) return "warm";
  if (remaining > 5) return "urgent";
  return "critical";
}

const PHASE_BAR_CLASSES: Record<Phase, string> = {
  calm: "bg-accent",
  warm: "bg-warning",
  urgent: "bg-destructive",
  critical: "bg-destructive",
};

const PHASE_BORDER_CLASSES: Record<Phase, string> = {
  calm: "border-l-border",
  warm: "border-l-warning",
  urgent: "border-l-destructive",
  critical: "border-l-destructive",
};

// ── Tool icon helper ───────────────────────────────────────────────

function toolIcon(toolName: string): string {
  switch (toolName) {
    case "Read": case "Glob": case "Grep": case "LS": case "View":
      return "📄";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      return "✏️";
    case "Bash": case "Execute":
      return "⚡";
    case "WebSearch": case "WebFetch":
      return "🔍";
    default:
      return "🔧";
  }
}

// ── Component ──────────────────────────────────────────────────────

export const ToolApprovalCard = memo(function ToolApprovalCard(props: ToolApprovalCardProps) {
  const {
    requestId,
    toolName,
    detail,
    compact = false,
    onApprove,
    onReject,
    onAutoApprove,
    duration = 60,
    keyboardActive = true,
  } = props;

  const [status, setStatus] = useState<ToolApprovalStatus>("pending");
  const [remaining, setRemaining] = useState(duration);
  const startTimeRef = useRef(Date.now());
  const rafRef = useRef<number>(undefined as unknown as number);

  const phase = useMemo(() => getPhase(remaining), [remaining]);
  const progressPercent = useMemo(() => Math.max(0, (remaining / duration) * 100), [remaining, duration]);

  // ── Countdown timer ──────────────────────────────────────────────

  useEffect(() => {
    if (status !== "pending") return;

    startTimeRef.current = Date.now();

    const tick = () => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      const next = Math.max(0, duration - elapsed);
      setRemaining(next);

      if (next <= 0) {
        setStatus("auto-approved");
        onAutoApprove(requestId);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [status, duration, requestId, onAutoApprove]);

  // ── Keyboard shortcuts ───────────────────────────────────────────

  useEffect(() => {
    if (status !== "pending" || !keyboardActive) return;

    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        handleApprove();
      } else if (e.key === "Escape" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        handleReject();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [status, keyboardActive]);

  // ── Actions ──────────────────────────────────────────────────────

  const handleApprove = useCallback(() => {
    if (status !== "pending") return;
    setStatus("approved");
    onApprove(requestId);
  }, [status, requestId, onApprove]);

  const handleReject = useCallback(() => {
    if (status !== "pending") return;
    setStatus("rejected");
    onReject(requestId);
  }, [status, requestId, onReject]);

  // ── Resolved state ──────────────────────────────────────────────

  if (status !== "pending") {
    const label =
      status === "approved" ? "Approved"
      : status === "rejected" ? "Rejected"
      : "Auto-approved";
    const icon = status === "rejected" ? "✗" : "✓";

    if (compact) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground/70">
          <span>{toolIcon(toolName)}</span>
          <span className="font-medium">{toolName}</span>
          <span>—</span>
          <span>{icon} {label}</span>
        </div>
      );
    }

    return (
      <div
        className="rounded-xl border border-border/50 bg-muted/30 px-4 py-3 transition-colors duration-200"
        role="status"
        aria-label={`Tool ${toolName}: ${label}`}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground/70">
          <span>{icon}</span>
          <span className="font-medium">{toolName}</span>
          <span>—</span>
          <span>{label}</span>
          {status === "auto-approved" && <span className="ml-auto text-xs">🕐</span>}
        </div>
      </div>
    );
  }

  // ── Compact pending ─────────────────────────────────────────────

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-l-2 px-3 py-1.5 transition-colors duration-500",
          "bg-card",
          PHASE_BORDER_CLASSES[phase],
        )}
        role="alert"
        aria-live="polite"
        aria-label={`Tool approval: ${toolName}. ${Math.ceil(remaining)} seconds remaining.`}
      >
        <span className="text-sm">{toolIcon(toolName)}</span>
        <span className="text-xs font-medium text-foreground">{toolName}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>

        {/* Compact progress bar */}
        <div className="ml-auto flex h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted/50">
          <div
            className={cn("h-full transition-colors duration-500", PHASE_BAR_CLASSES[phase])}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={handleApprove}>✓</Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={handleReject}>✗</Button>
        </div>
      </div>
    );
  }

  // ── Full pending card ───────────────────────────────────────────

  return (
    <div
      className={cn(
        "rounded-xl border border-l-4 bg-card px-4 py-3 transition-colors duration-500",
        PHASE_BORDER_CLASSES[phase],
        phase === "critical" && "animate-pulse-subtle",
      )}
      role="alert"
      aria-live="polite"
      aria-label={`Tool approval: ${toolName} ${detail}. ${Math.ceil(remaining)} seconds remaining.`}
    >
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">{toolIcon(toolName)}</span>
        <span className="text-sm font-semibold text-foreground">{toolName}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </div>

      {/* Progress bar */}
      <div className="mb-3 h-[3px] w-full overflow-hidden rounded-full bg-muted/50">
        <div
          className={cn(
            "h-full rounded-full transition-colors duration-500",
            PHASE_BAR_CLASSES[phase],
          )}
          style={{
            width: `${progressPercent}%`,
            transition: "width 100ms linear, background-color 500ms",
          }}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleApprove}
          className={cn(
            "px-4",
            phase === "critical" && "shadow-sm shadow-destructive/30",
          )}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleReject}
          className="px-4"
        >
          Reject
        </Button>
        <span className={cn(
          "ml-auto text-xs transition-colors duration-500",
          phase === "urgent" || phase === "critical"
            ? "text-destructive"
            : "text-muted-foreground/60",
        )}>
          auto in {Math.ceil(remaining)}s
        </span>
      </div>
    </div>
  );
});

export default ToolApprovalCard;
