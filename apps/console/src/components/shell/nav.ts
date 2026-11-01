import {
  BarChart3,
  BellRing,
  Binary,
  Bot,
  Boxes,
  Cable,
  FileSpreadsheet,
  GitBranch,
  HeartPulse,
  LayoutDashboard,
  Link2,
  Rocket,
  ScrollText,
  ShieldCheck,
  SignalHigh,
  SlidersHorizontal,
  Stethoscope,
  Unplug,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Module number from the product spec (01–14). */
  module?: string;
  keywords?: string;
  /** Extra path prefixes that should highlight this item. */
  also?: string[];
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: "Device management",
    items: [
      { module: "01", href: "/", label: "Overview", icon: LayoutDashboard, keywords: "home ops inbox actions" },
      { module: "02", href: "/inventory", label: "Inventory", icon: Boxes, keywords: "fleet devices table", also: ["/devices", "/fleet"] },
      { module: "03", href: "/lifecycle", label: "Lifecycle", icon: GitBranch, keywords: "pipeline activation transfer" },
      { module: "04", href: "/assets", label: "Assets", icon: Link2, keywords: "association swap vehicle machine" },
      { module: "05", href: "/configuration", label: "Configuration", icon: SlidersHorizontal, keywords: "templates drift profiles" },
      { module: "06", href: "/health", label: "Health & monitoring", icon: HeartPulse, keywords: "stale telemetry battery signal" },
      { module: "07", href: "/connectivity", label: "Connectivity & SIM", icon: SignalHigh, keywords: "sim carrier data usage" },
      { module: "08", href: "/ota", label: "Firmware & OTA", icon: Rocket, keywords: "rollout campaign update firmware", also: ["/firmware"] },
      { module: "09", href: "/diagnostics", label: "Diagnostics & commands", icon: Stethoscope, keywords: "decode downlink command" },
      { module: "10", href: "/alerts", label: "Incidents & alerts", icon: BellRing, keywords: "alarms rules" },
      { module: "11", href: "/audit", label: "Audit & history", icon: ScrollText, keywords: "log changes" },
      { module: "12", href: "/security", label: "Security & access", icon: ShieldCheck, keywords: "certificates credentials revoke" },
      { module: "13", href: "/reports", label: "Reports & analytics", icon: BarChart3, keywords: "uptime reliability charts" },
      { module: "14", href: "/integrations", label: "Integrations & automation", icon: Cable, keywords: "webhooks kafka crm rules", also: ["/automations"] },
    ],
  },
  {
    label: "Codec intelligence",
    items: [
      { href: "/codecs", label: "Codecs & plugins", icon: Binary, keywords: "decoder spec studio plugin" },
      { href: "/spec-imports", label: "Spec imports", icon: FileSpreadsheet, keywords: "excel upload" },
      { href: "/payloads/unknown", label: "Unknown payloads", icon: Unplug, keywords: "triage" },
      { href: "/agents", label: "AI agents", icon: Bot, keywords: "copilot" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

export function isActive(pathname: string, item: NavItem) {
  const match = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return match(item.href) || (item.also ?? []).some(match);
}
