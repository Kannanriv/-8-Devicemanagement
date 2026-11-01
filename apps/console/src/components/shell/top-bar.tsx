"use client";

import * as React from "react";
import { Building2, Check, Menu, Moon, Search, Sparkles, Sun } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Kbd, Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTenants } from "@/lib/api";
import { useLiveRate, useLiveStatus } from "@/lib/live";
import { setTenant, useTenant } from "@/lib/tenant";
import { setTheme, useTheme } from "@/lib/theme";
import { cn, fmt } from "@/lib/utils";
import { useShell } from "./shell-context";

export function TopBar() {
  const { actions } = useShell();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl backdrop-saturate-150">
      <div className="flex h-16 items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => actions.setNavOpen(true)} aria-label="Open navigation">
          <Menu />
        </Button>
        <button
          type="button"
          onClick={() => actions.setPaletteOpen(true)}
          className="focus-ring group flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-full bg-hover px-4 text-left text-sm text-subtle ring-1 ring-line ring-inset transition-colors hover:text-muted hover:ring-line-strong sm:max-w-md"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">Search devices, codecs, actions</span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <LivePulse />
          <Tooltip content={<span>Ask Fleet Copilot · ⌘J</span>}>
            <Button variant="secondary" size="md" onClick={() => actions.askCopilot()} className="hidden gap-2 sm:inline-flex">
              <Sparkles className="text-signal" />
              Copilot
            </Button>
          </Tooltip>
          <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => actions.askCopilot()} aria-label="Open Copilot">
            <Sparkles />
          </Button>
          <ThemeToggle />
          <TenantSwitcher />
        </div>
      </div>
    </header>
  );
}

/** Live traffic indicator: decoded messages per minute from the WebSocket. */
function LivePulse() {
  const status = useLiveStatus();
  const rate = useLiveRate();
  const live = status === "open";
  const label = live ? `${fmt.compact(rate)} msg/min` : status === "connecting" ? "Connecting" : "Offline";
  return (
    <Tooltip content={live ? "Live decoded traffic, rolling 60s" : "Live stream unavailable. It reconnects automatically."}>
      <span
        role="status"
        aria-live="polite"
        className="hidden h-10 items-center gap-2.5 rounded-full px-3.5 text-[13px] font-medium text-muted ring-1 ring-line ring-inset md:inline-flex"
      >
        <span className="relative flex size-2.5" aria-hidden>
          {live && rate > 0 ? <span className="absolute inset-0 animate-pulse-ring rounded-full bg-signature" /> : null}
          <span className={cn("relative size-2.5 rounded-full", live ? "bg-signature" : status === "connecting" ? "bg-subtle" : "bg-ember/80")} />
        </span>
        <span className="tabular">{label}</span>
      </span>
    </Tooltip>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Tooltip content={`Switch to ${next} theme`}>
      <Button variant="ghost" size="icon" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>
    </Tooltip>
  );
}

function TenantSwitcher() {
  const tenant = useTenant();
  const tenants = useTenants();
  const qc = useQueryClient();
  const [custom, setCustom] = React.useState("");
  const list = tenants.data ?? [];
  const current = list.find((t) => t.id === tenant);
  const name = current?.name ?? (tenant ? tenant : "Default workspace");

  const choose = (id: string | undefined) => {
    setTenant(id);
    void qc.invalidateQueries();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="max-w-[200px] gap-2 pl-2" aria-label={`Tenant: ${name}`}>
          <span className="flex size-6 items-center justify-center rounded-full bg-inverse text-[11px] font-semibold text-inverse-fg">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden truncate sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Switch tenant</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => choose(undefined)}>
            <Building2 />
            <span className="flex-1">Default workspace</span>
            {!tenant ? <Check className="text-signal!" /> : null}
          </DropdownMenuItem>
          {list.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => choose(t.id)}>
              <Building2 />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{t.name}</span>
                <span className="text-xs text-subtle">{fmt.label(t.kind)}</span>
              </span>
              {tenant === t.id ? <Check className="text-signal!" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <form
          className="flex gap-1.5 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) choose(custom.trim());
            setCustom("");
          }}
        >
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Tenant id"
            aria-label="Tenant id"
            className="h-8 text-[13px]"
          />
          <Button type="submit" size="sm" variant="primary">
            Use
          </Button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
