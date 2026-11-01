"use client";

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
const KEY = "h8.theme";
const listeners = new Set<() => void>();

function read(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function setTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "dark",
  );
}

/** Inline script (runs before paint) to apply the stored theme without a flash. */
export const themeScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"){var r=document.documentElement;r.classList.remove("dark");r.classList.add("light")}}catch(e){}`;

export interface ChartPalette {
  fg: string;
  muted: string;
  subtle: string;
  line: string;
  panel: string;
  raised: string;
  signal: string;
  ion: string;
  ember: string;
  danger: string;
}

export function chartPalette(theme: Theme): ChartPalette {
  return theme === "light"
    ? {
        fg: "#0B0C10",
        muted: "#5B606C",
        subtle: "#8A8F9C",
        line: "rgba(11,12,16,0.08)",
        panel: "#FBFAF7",
        raised: "#FFFFFF",
        signal: "#3F5EF0",
        ion: "#12A387",
        ember: "#E2621F",
        danger: "#D83A52",
      }
    : {
        fg: "#F4F2EE",
        muted: "#8A8F9C",
        subtle: "#5B606C",
        line: "rgba(255,255,255,0.07)",
        panel: "#0C0E15",
        raised: "#141722",
        signal: "#5B7CFF",
        ion: "#5EE6C8",
        ember: "#FF8A4C",
        danger: "#FF5D73",
      };
}
