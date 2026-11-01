"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeviceMessage } from "@hash8/sdk-ts";
import { WS_URL } from "./api";
import { getTenant, useTenant } from "./tenant";

/**
 * Live socket store. One connection per tab; components subscribe to narrow
 * slices (status / rate / messages) so a busy stream only re-renders what shows it.
 */
export type LiveStatus = "connecting" | "open" | "closed";
export type LiveMessage = Partial<DeviceMessage> & { id: string; receivedAt: string; deviceSerial?: string };

interface LiveState {
  status: LiveStatus;
  rate: number; // msgs / min, rolling
  messages: LiveMessage[];
  series: { t: number; n: number; ok: number }[]; // per-10s buckets, last 5 min
}

const MAX_MESSAGES = 60;
const listeners = new Set<() => void>();
let state: LiveState = { status: "closed", rate: 0, messages: [], series: [] };
const arrivals: number[] = [];

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const SERVER: LiveState = { status: "closed", rate: 0, messages: [], series: [] };

export function useLiveStatus() {
  return useSyncExternalStore(subscribe, () => state.status, () => SERVER.status);
}
export function useLiveRate() {
  return useSyncExternalStore(subscribe, () => state.rate, () => 0);
}
export function useLiveMessages() {
  return useSyncExternalStore(subscribe, () => state.messages, () => SERVER.messages);
}
export function useLiveSeries() {
  return useSyncExternalStore(subscribe, () => state.series, () => SERVER.series);
}

function tick() {
  const now = Date.now();
  while (arrivals.length && arrivals[0]! < now - 60_000) arrivals.shift();
  const bucket = Math.floor(now / 10_000) * 10_000;
  const series = state.series.filter((p) => p.t > now - 5 * 60_000);
  if (!series.length || series[series.length - 1]!.t !== bucket) series.push({ t: bucket, n: 0, ok: 0 });
  if (arrivals.length !== state.rate || series !== state.series) set({ rate: arrivals.length, series });
}

function onMessage(raw: unknown) {
  const now = Date.now();
  arrivals.push(now);
  const p = (raw ?? {}) as Partial<LiveMessage>;
  const msg: LiveMessage = {
    ...p,
    id: p.id ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: p.receivedAt ?? new Date(now).toISOString(),
  };
  const bucket = Math.floor(now / 10_000) * 10_000;
  const series = state.series.slice();
  const last = series[series.length - 1];
  const ok = msg.status === "decoded" || (msg.status === undefined && !!msg.message) ? 1 : 0;
  if (last && last.t === bucket) series[series.length - 1] = { t: bucket, n: last.n + 1, ok: last.ok + ok };
  else series.push({ t: bucket, n: 1, ok });
  set({ messages: [msg, ...state.messages].slice(0, MAX_MESSAGES), series, rate: arrivals.length });
}

/** Mount once (in Providers). Maintains the socket with backoff and invalidates queries on server events. */
export function useLiveConnection() {
  const qc = useQueryClient();
  const tenant = useTenant();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const pending = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | undefined;
    const t = getTenant() ?? "default";

    const invalidate = (area: string) => {
      pending.add(area);
      if (flush) return;
      flush = setTimeout(() => {
        flush = undefined;
        for (const a of pending) void qc.invalidateQueries({ queryKey: [t, a] });
        pending.clear();
      }, 1_500);
    };

    const connect = () => {
      if (disposed) return;
      set({ status: "connecting" });
      try {
        const url = new URL(WS_URL);
        const tid = getTenant();
        if (tid) url.searchParams.set("tenantId", tid);
        ws = new WebSocket(url.toString());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        set({ status: "open" });
      };
      ws.onmessage = (ev) => {
        let data: { type?: string; payload?: unknown };
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (data.type) {
          case "message":
            onMessage(data.payload);
            invalidate("stats");
            break;
          case "alert":
            invalidate("alerts");
            invalidate("inbox");
            break;
          case "device":
            invalidate("devices");
            invalidate("device");
            break;
          case "ota":
            invalidate("campaigns");
            invalidate("inbox");
            break;
          case "command":
            invalidate("device");
            break;
          case "audit":
            invalidate("audit");
            break;
        }
      };
      ws.onclose = () => {
        set({ status: "closed" });
        schedule();
      };
      ws.onerror = () => ws?.close();
    };

    const schedule = () => {
      if (disposed) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };

    connect();
    const interval = setInterval(tick, 2_000);
    return () => {
      disposed = true;
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      if (flush) clearTimeout(flush);
      ws?.close();
    };
  }, [qc, tenant]);
}
