"use client";

import * as React from "react";
import { Inbox, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import type { Device, DeviceMessage } from "@hash8/sdk-ts";
import { HexInspector, JsonView } from "@/components/hex-inspector";
import { ApiError } from "@/components/query-state";
import { Badge, Dot } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout, Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { errorMessage, useCodecSpec, useDeviceMessages, useRedecode } from "@/lib/api";
import { findMessage, messageLayout } from "@/lib/dcs";
import { cn, fmt, hexBytes } from "@/lib/utils";

export function MessagesTab({ d }: { d: Device }) {
  const msgs = useDeviceMessages(d.id, 100);
  const [selectedId, setSelectedId] = React.useState<string>();
  const list = msgs.data ?? [];
  const selected = list.find((m) => m.id === selectedId) ?? list[0];
  const redecode = useRedecode();

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Panel className="flex min-h-0 flex-col xl:max-h-[calc(100dvh-220px)]">
        <PanelHeader className="pb-2">
          <div>
            <PanelTitle>Uplinks</PanelTitle>
            <PanelDescription>{list.length ? `Latest ${list.length}` : "Most recent first"}</PanelDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={redecode.isPending}
            onClick={() =>
              redecode.mutate(
                { deviceId: d.id },
                {
                  onSuccess: () => {
                    toast.success("Re-decoding this device’s history");
                    void msgs.refetch();
                  },
                  onError: (e) => toast.error("Re-decode failed", { description: errorMessage(e) }),
                },
              )
            }
          >
            {redecode.isPending ? <Spinner /> : <RefreshCcw />}
            Re-decode
          </Button>
        </PanelHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {msgs.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : msgs.error ? (
            <ApiError error={msgs.error} onRetry={() => void msgs.refetch()} />
          ) : list.length === 0 ? (
            <Empty icon={Inbox} title="No messages yet">
              Uplinks show here as soon as the device reports.
            </Empty>
          ) : (
            <ul role="listbox" aria-label="Messages" className="flex flex-col gap-0.5">
              {list.map((m) => (
                <li key={m.id} role="option" aria-selected={selected?.id === m.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(m.id)}
                    className={cn(
                      "focus-ring flex w-full cursor-pointer flex-col gap-1 rounded-[14px] px-3 py-2.5 text-left transition-colors",
                      selected?.id === m.id ? "bg-raised ring-1 ring-line ring-inset" : "hover:bg-hover",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Dot tone={m.status === "decoded" ? "ion" : m.status === "error" ? "danger" : "ember"} />
                      <span className="truncate text-sm font-medium">{m.message ?? (m.status === "unknown" ? "Unknown payload" : "Decode error")}</span>
                      <span className="ml-auto shrink-0 text-xs text-subtle tabular">{fmt.time(m.receivedAt)}</span>
                    </span>
                    <span className="truncate pl-4 font-mono text-xs text-subtle">{m.payloadHex}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      {selected ? <MessageDetail m={selected} d={d} /> : <div className="hidden xl:block" />}
    </div>
  );
}

function MessageDetail({ m, d }: { m: DeviceMessage; d: Device }) {
  const [mode, setMode] = React.useState<"inspector" | "json">("inspector");
  const spec = useCodecSpec(d.codecId, m.codecVersion ?? d.codecVersion);
  const def = findMessage(spec.data, m.message);
  const layout = React.useMemo(() => (def ? messageLayout(def, hexBytes(m.payloadHex).length) : null), [def, m.payloadHex]);

  return (
    <Panel className="min-w-0">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle className="flex flex-wrap items-center gap-2">
            {m.message ?? "Undecoded payload"}
            <Badge tone={m.status === "decoded" ? "ion" : m.status === "error" ? "danger" : "ember"}>{fmt.label(m.status)}</Badge>
          </PanelTitle>
          <PanelDescription>
            {fmt.dateTime(m.receivedAt)} over {m.transport.toUpperCase()}
            {m.port != null ? `, port ${m.port}` : ""}
            {m.topic ? `, ${m.topic}` : ""}
            {m.codecVersion ? `, codec ${m.codecVersion}` : ""}
          </PanelDescription>
        </div>
        <Segmented
          label="Display"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "inspector", label: "Inspector" },
            { value: "json", label: "JSON" },
          ]}
        />
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        {mode === "inspector" ? (
          <HexInspector hex={m.payloadHex} data={m.data} ranges={layout?.ranges} />
        ) : (
          <JsonView value={m} className="max-h-[560px]" />
        )}
        {layout && !layout.complete ? (
          <p className="text-xs text-subtle">Byte highlighting covers fixed-width fields; repeated or switched sections aren’t mapped.</p>
        ) : null}
        {m.warnings.length ? (
          <Callout tone="ember" title="Warnings">
            <ul className="list-disc pl-4">
              {m.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {m.errors?.length ? (
          <Callout tone="danger" title="Errors">
            <ul className="list-disc pl-4">
              {m.errors.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
