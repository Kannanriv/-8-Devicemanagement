"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { NAV, isActive } from "./nav";
import { useShell } from "./shell-context";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("focus-ring group flex items-center gap-2.5 rounded-control", className)} aria-label="#8 Device Management home">
      <span className="relative flex size-8 items-center justify-center overflow-hidden rounded-[10px] bg-inverse text-[13px] font-bold tracking-[-0.04em] text-inverse-fg">
        #8
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-signature" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[14px] font-semibold tracking-[-0.02em]">Device</span>
        <span className="text-[14px] font-semibold tracking-[-0.02em] text-muted">Management</span>
      </span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-6">
      {NAV.map((group) => (
        <div key={group.label} className="flex flex-col gap-px">
          <p className="px-3 pb-1.5 text-[12px] font-medium text-subtle">{group.label}</p>
          {group.items.map((item) => {
            const active = isActive(pathname, item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-ring group relative flex h-[34px] items-center gap-3 rounded-[11px] px-3 text-[13.5px] font-medium transition-colors duration-200",
                  active ? "bg-raised text-fg ring-1 ring-line ring-inset" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-fg" : "text-subtle group-hover:text-muted")} strokeWidth={1.75} />
                <span className="truncate">{item.label}</span>
                {item.module ? (
                  <span className={cn("ml-auto text-[10.5px] tabular", active ? "text-muted" : "text-subtle/70")}>{item.module}</span>
                ) : null}
                {active ? <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-signature" /> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function NavRail() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[256px] shrink-0 flex-col border-r border-line bg-bg lg:flex">
      <div className="flex h-16 items-center px-5">
        <BrandMark />
      </div>
      <div className="scrollbar-quiet flex-1 overflow-y-auto px-3 pt-2 pb-6">
        <NavLinks />
      </div>
    </aside>
  );
}

/** Mobile navigation drawer. */
export function MobileNav() {
  const { state, actions } = useShell();
  return (
    <DialogPrimitive.Root open={state.navOpen} onOpenChange={actions.setNavOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm lg:hidden" />
        <DialogPrimitive.Content className="fixed inset-y-2 left-2 z-50 flex w-[280px] flex-col overflow-hidden rounded-panel border border-line-strong bg-panel shadow-float outline-none data-[state=open]:animate-enter lg:hidden">
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Console modules</DialogPrimitive.Description>
          <div className="flex h-16 items-center px-5">
            <BrandMark />
          </div>
          <div className="scrollbar-quiet flex-1 overflow-y-auto px-3 pb-6">
            <NavLinks onNavigate={() => actions.setNavOpen(false)} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
