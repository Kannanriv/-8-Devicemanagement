"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CornerDownLeft, Cpu, FileSpreadsheet, Moon, RefreshCcw, Rocket, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useDevices, useRedecode, useRunAgent, errorMessage } from "@/lib/api";
import { AGENT_META, AGENT_NAMES } from "@/lib/agents";
import { setTheme, useTheme } from "@/lib/theme";
import { ALL_NAV } from "./nav";
import { useShell } from "./shell-context";
import { ConnectivityDot, HealthBadge, LifecycleBadge } from "@/components/status";
import { Kbd } from "@/components/ui/input";

const groupCls =
  "px-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";
const itemCls =
  "flex h-11 cursor-pointer items-center gap-3 rounded-[12px] px-2.5 text-sm text-fg data-[selected=true]:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette() {
  const { state, actions } = useShell();
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search.trim(), 180);
  const devices = useDevices({ q, limit: 6 }, { enabled: state.paletteOpen && q.length >= 2 });
  const runAgent = useRunAgent();
  const redecode = useRedecode();

  const go = (href: string) => {
    actions.setPaletteOpen(false);
    router.push(href);
  };

  React.useEffect(() => {
    if (!state.paletteOpen) setSearch("");
  }, [state.paletteOpen]);

  return (
    <DialogPrimitive.Root open={state.paletteOpen} onOpenChange={actions.setPaletteOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[6px]" />
        <DialogPrimitive.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-panel border border-line-strong bg-panel shadow-float outline-none data-[state=open]:animate-enter">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Navigate, find a device by serial, run an agent or an action.</DialogPrimitive.Description>
          <Command label="Command palette" shouldFilter loop className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-line px-5">
              <Search className="size-4 shrink-0 text-subtle" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search pages, serials, agents, actions…"
                className="h-14 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="scrollbar-quiet max-h-[min(60vh,460px)] overflow-y-auto pb-2">
              <Command.Empty className="px-5 py-10 text-center text-sm text-muted">
                Nothing matches “{search}”.
              </Command.Empty>

              {q.length >= 2 && devices.data?.items.length ? (
                <Command.Group heading="Devices" className={groupCls} forceMount>
                  {devices.data.items.map((d) => (
                    <Command.Item
                      key={d.id}
                      value={`device ${d.udi ?? ""} ${d.serial} ${d.name ?? ""} ${d.imei ?? ""} ${d.sim?.iccid ?? ""} ${search}`}
                      onSelect={() => go(`/devices/${d.id}`)}
                      className={itemCls}
                    >
                      <Cpu />
                      <span className="font-mono text-[13px]">{d.udi ?? d.serial}</span>
                      {d.name ? <span className="truncate text-muted">{d.name}</span> : null}
                      <span className="ml-auto flex items-center gap-2">
                        <LifecycleBadge state={d.lifecycle} />
                        <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} withLabel={false} />
                        <HealthBadge level={d.health?.level} />
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              <Command.Group heading="Go to" className={groupCls}>
                {ALL_NAV.map((n) => {
                  const Icon = n.icon;
                  return (
                    <Command.Item key={n.href} value={`go ${n.label} ${n.keywords ?? ""}`} onSelect={() => go(n.href)} className={itemCls}>
                      <Icon />
                      {n.label}
                    </Command.Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading="Agents" className={groupCls}>
                {AGENT_NAMES.map((name) => {
                  const m = AGENT_META[name];
                  const Icon = m.icon;
                  return (
                    <Command.Item
                      key={name}
                      value={`agent run ${m.title} ${name}`}
                      onSelect={() => {
                        if (name === "fleet-copilot") {
                          actions.askCopilot();
                          return;
                        }
                        actions.setPaletteOpen(false);
                        runAgent.mutate(
                          { agent: name, input: { trigger: "command-palette" } },
                          {
                            onSuccess: () => {
                              toast.success(`${m.title} started`, { action: { label: "View", onClick: () => router.push("/agents") } });
                            },
                            onError: (e) => toast.error(`${m.title} didn’t start`, { description: errorMessage(e) }),
                          },
                        );
                      }}
                      className={itemCls}
                    >
                      <Icon />
                      <span>Run {m.title}</span>
                      <span className="ml-auto hidden truncate pl-4 text-xs text-subtle sm:block">{m.description.split(".")[0]}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading="Actions" className={groupCls}>
                <Command.Item value="ask copilot question" onSelect={() => actions.askCopilot(search || undefined)} className={itemCls}>
                  <Sparkles />
                  {search ? <>Ask Copilot “{search}”</> : "Ask Fleet Copilot"}
                  <span className="ml-auto flex gap-1">
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Command.Item>
                <Command.Item value="upload excel spec import" onSelect={() => go("/spec-imports")} className={itemCls}>
                  <FileSpreadsheet />
                  Import an OEM Excel spec
                </Command.Item>
                <Command.Item value="new ota campaign rollout" onSelect={() => go("/ota?new=1")} className={itemCls}>
                  <Rocket />
                  Start an OTA campaign
                </Command.Item>
                <Command.Item
                  value="redecode unknown payloads"
                  onSelect={() => {
                    actions.setPaletteOpen(false);
                    redecode.mutate(
                      {},
                      {
                        onSuccess: () => toast.success("Re-decode queued for unknown payloads"),
                        onError: (e) => toast.error("Re-decode failed", { description: errorMessage(e) }),
                      },
                    );
                  }}
                  className={itemCls}
                >
                  <RefreshCcw />
                  Re-decode unknown payloads
                </Command.Item>
                <Command.Item
                  value="toggle theme dark light"
                  onSelect={() => {
                    setTheme(theme === "dark" ? "light" : "dark");
                    actions.setPaletteOpen(false);
                  }}
                  className={itemCls}
                >
                  <Moon />
                  Switch to {theme === "dark" ? "light" : "dark"} theme
                </Command.Item>
              </Command.Group>
            </Command.List>
            <div className="flex items-center gap-4 border-t border-line px-5 py-2.5 text-xs text-subtle">
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>
                  <CornerDownLeft className="size-3" />
                </Kbd>{" "}
                open
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
