"use client";

import * as React from "react";

interface ShellState {
  paletteOpen: boolean;
  copilotOpen: boolean;
  navOpen: boolean;
  copilotDraft: string | null;
}
interface ShellActions {
  setPaletteOpen: (v: boolean) => void;
  setCopilotOpen: (v: boolean) => void;
  setNavOpen: (v: boolean) => void;
  /** Open the Copilot drawer, optionally pre-filled with a prompt (sent immediately). */
  askCopilot: (prompt?: string) => void;
  consumeDraft: () => string | null;
}

const ShellContext = React.createContext<{ state: ShellState; actions: ShellActions } | null>(null);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [copilotOpen, setCopilotOpen] = React.useState(false);
  const [navOpen, setNavOpen] = React.useState(false);
  const [copilotDraft, setDraft] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);

  const actions = React.useMemo<ShellActions>(
    () => ({
      setPaletteOpen,
      setCopilotOpen,
      setNavOpen,
      askCopilot: (prompt) => {
        draftRef.current = prompt ?? null;
        setDraft(prompt ?? null);
        setPaletteOpen(false);
        setCopilotOpen(true);
      },
      consumeDraft: () => {
        const d = draftRef.current;
        draftRef.current = null;
        setDraft(null);
        return d;
      },
    }),
    [],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (k === "j") {
        e.preventDefault();
        setCopilotOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = React.useMemo(
    () => ({ state: { paletteOpen, copilotOpen, navOpen, copilotDraft }, actions }),
    [paletteOpen, copilotOpen, navOpen, copilotDraft, actions],
  );
  return <ShellContext value={value}>{children}</ShellContext>;
}

export function useShell() {
  const ctx = React.use(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <ShellProvider>");
  return ctx;
}
