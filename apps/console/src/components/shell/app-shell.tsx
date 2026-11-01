import * as React from "react";
import { NavRail, MobileNav } from "./nav-rail";
import { TopBar } from "./top-bar";
import { CommandPalette } from "./command-palette";
import { CopilotDrawer } from "./copilot";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="focus-ring sr-only z-50 rounded-full bg-inverse px-4 py-2 text-sm text-inverse-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" className="mx-auto w-full max-w-[1480px] flex-1 px-4 pt-8 pb-16 sm:px-6 lg:px-10 lg:pt-10">
          {children}
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <CopilotDrawer />
    </div>
  );
}
