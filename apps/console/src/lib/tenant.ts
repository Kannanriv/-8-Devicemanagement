"use client";

import { useSyncExternalStore } from "react";

/**
 * Active tenant (sent as `x-tenant-id`). `undefined` lets the API use its
 * seeded default tenant. Persisted per browser.
 */
const KEY = "h8.tenant.v1";
const listeners = new Set<() => void>();
let current: string | undefined;
let loaded = false;

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    current = window.localStorage.getItem(KEY) ?? undefined;
  } catch {
    current = undefined;
  }
}

export function getTenant(): string | undefined {
  load();
  return current;
}

export function setTenant(id: string | undefined) {
  current = id || undefined;
  try {
    if (current) window.localStorage.setItem(KEY, current);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTenant() {
  return useSyncExternalStore(subscribe, getTenant, () => undefined);
}
