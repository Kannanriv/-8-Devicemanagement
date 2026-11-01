import type {
  CampaignStatus,
  CodecStatus,
  CommandStatus,
  Connectivity,
  HealthLevel,
  LifecycleState,
  Severity,
  SimStatus,
  CredentialStatus,
} from "@hash8/sdk-ts";
import { LIFECYCLE_LABELS } from "@hash8/sdk-ts";
import { Badge, Dot, type BadgeTone } from "@/components/ui/badge";
import { cn, fmt } from "@/lib/utils";

/*
 * Three independent axes, three distinct visual grammars — never one pill for everything:
 *   Lifecycle    → square-cornered tag with a stage pip (where the device is in its life)
 *   Connectivity → pulsing dot + plain text (is it talking right now)
 *   Health       → shield glyph tinted by level (is it working well)
 */

export const severityTone: Record<Severity, BadgeTone> = { info: "signal", warning: "ember", critical: "danger" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge tone={severityTone[severity]}>
      <Dot tone={severityTone[severity]} live={severity === "critical"} className="size-1.5 [&>span]:size-1.5" />
      {fmt.label(severity)}
    </Badge>
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
export const LIFECYCLE_ORDER: LifecycleState[] = [
  "registered",
  "assigned",
  "installing",
  "pending_activation",
  "activated",
  "maintenance",
  "suspended",
  "swap",
  "retired",
];
export const LIFECYCLE_MAIN: LifecycleState[] = ["registered", "assigned", "installing", "pending_activation", "activated"];
export const LIFECYCLE_SIDE: LifecycleState[] = ["maintenance", "suspended", "swap", "retired"];

export function lifecycleLabel(s: string) {
  return LIFECYCLE_LABELS[s as LifecycleState] ?? fmt.label(s);
}

export const lifecycleColor: Record<LifecycleState, string> = {
  registered: "var(--subtle)",
  assigned: "var(--muted)",
  installing: "var(--signal)",
  pending_activation: "var(--signal)",
  activated: "var(--ion)",
  maintenance: "var(--ember)",
  suspended: "var(--danger)",
  swap: "var(--ember)",
  retired: "var(--subtle)",
};

export function LifecycleBadge({ state, className }: { state: LifecycleState; className?: string }) {
  const main = LIFECYCLE_MAIN.indexOf(state);
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-2 rounded-[7px] border border-line-strong px-2 text-xs font-medium whitespace-nowrap text-fg",
        state === "retired" && "text-subtle",
        className,
      )}
      title={`Lifecycle: ${lifecycleLabel(state)}`}
    >
      {main >= 0 ? (
        <span className="flex gap-[2px]" aria-hidden>
          {LIFECYCLE_MAIN.map((s, i) => (
            <span key={s} className="h-2.5 w-[3px] rounded-[1px]" style={{ background: i <= main ? lifecycleColor[state] : "var(--line-strong)" }} />
          ))}
        </span>
      ) : (
        <span aria-hidden className="size-2 rotate-45 rounded-[1px]" style={{ background: lifecycleColor[state] }} />
      )}
      {lifecycleLabel(state)}
    </span>
  );
}

// ── Connectivity ─────────────────────────────────────────────────────────────
const connTone: Record<Connectivity, BadgeTone> = { online: "ion", stale: "ember", offline: "danger", never_seen: "neutral" };
export const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  online: "Online",
  stale: "Stale telemetry",
  offline: "Offline",
  never_seen: "Not commissioned",
};

export function ConnectivityDot({ value, withLabel = true, className }: { value: Connectivity; withLabel?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[13px] whitespace-nowrap", className)} title={`Connectivity: ${CONNECTIVITY_LABEL[value] ?? value}`}>
      <Dot tone={connTone[value] ?? "neutral"} live={value === "online"} />
      {withLabel ? <span className="text-muted">{CONNECTIVITY_LABEL[value] ?? fmt.label(value)}</span> : null}
    </span>
  );
}

// ── Health ───────────────────────────────────────────────────────────────────
export function healthLevelOf(score: number | undefined, level?: HealthLevel): HealthLevel {
  if (level) return level;
  if (score == null) return "normal";
  return score >= 80 ? "normal" : score >= 55 ? "warning" : "critical";
}
export function healthTone(score: number): BadgeTone {
  const l = healthLevelOf(score);
  return l === "normal" ? "ion" : l === "warning" ? "ember" : "danger";
}
const levelColor: Record<HealthLevel, string> = { normal: "text-ion", warning: "text-ember", critical: "text-danger" };

export function HealthBadge({ level, score, className }: { level?: HealthLevel; score?: number; className?: string }) {
  const l = healthLevelOf(score, level);
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap", levelColor[l], className)}
      title={`Health: ${fmt.label(l)}${score != null ? ` (${Math.round(score)})` : ""}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
        <path
          d="M8 1.75 2.75 3.6v4.1c0 3.1 2.2 5.3 5.25 6.55 3.05-1.25 5.25-3.45 5.25-6.55V3.6L8 1.75Z"
          fill="currentColor"
          fillOpacity={l === "normal" ? 0.12 : 0.22}
        />
        {l === "normal" ? (
          <path d="m5.6 8.1 1.7 1.7 3.2-3.4" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M8 5.2v3.3M8 10.6v.2" strokeLinecap="round" />
        )}
      </svg>
      {fmt.label(l)}
      {score != null ? <span className="font-normal text-subtle tabular">{Math.round(score)}</span> : null}
    </span>
  );
}

/** Compact numeric health score with arc meter. */
export function HealthPill({ score, className }: { score: number | undefined; className?: string }) {
  if (score == null || Number.isNaN(score)) return <span className="text-subtle">—</span>;
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const tone = healthTone(s);
  const color = tone === "ion" ? "var(--ion)" : tone === "ember" ? "var(--ember)" : "var(--danger)";
  const c = 2 * Math.PI * 6;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium tabular", className)} aria-label={`Health ${s} of 100`}>
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(s / 100) * c} ${c}`} />
      </svg>
      {s}
    </span>
  );
}

// ── Other statuses ───────────────────────────────────────────────────────────
const simTone: Record<SimStatus, BadgeTone> = { active: "ion", inactive: "neutral", suspended: "ember", terminated: "danger", unknown: "neutral" };
export function SimBadge({ status }: { status: SimStatus | undefined }) {
  if (!status) return <span className="text-xs text-subtle">No SIM</span>;
  return <Badge tone={simTone[status] ?? "neutral"}>{fmt.label(status)}</Badge>;
}

const credTone: Record<CredentialStatus, BadgeTone> = { active: "ion", expiring: "ember", expired: "danger", revoked: "neutral" };
export function CredentialBadge({ status }: { status: CredentialStatus }) {
  return <Badge tone={credTone[status] ?? "neutral"}>{fmt.label(status)}</Badge>;
}

const codecTone: Record<CodecStatus, BadgeTone> = { draft: "neutral", in_review: "ember", published: "ion", deprecated: "neutral" };
export function CodecStatusBadge({ status }: { status: CodecStatus }) {
  return <Badge tone={codecTone[status]}>{fmt.label(status)}</Badge>;
}

const campaignTone: Record<CampaignStatus, BadgeTone> = {
  draft: "neutral",
  running: "signal",
  paused: "ember",
  completed: "ion",
  rolled_back: "danger",
  failed: "danger",
};
export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <Badge tone={campaignTone[status]}>
      {status === "running" ? <Dot tone="signal" live className="size-1.5 [&>span]:size-1.5" /> : null}
      {fmt.label(status)}
    </Badge>
  );
}

const commandTone: Record<CommandStatus, BadgeTone> = {
  queued: "neutral",
  sent: "signal",
  acked: "ion",
  failed: "danger",
  timeout: "ember",
  cancelled: "neutral",
};
export function CommandStatusBadge({ status }: { status: CommandStatus }) {
  return <Badge tone={commandTone[status]}>{fmt.label(status)}</Badge>;
}
