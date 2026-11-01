"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Send } from "lucide-react";
import { toast } from "sonner";
import { HexInspector } from "@/components/hex-inspector";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Callout } from "@/components/ui/empty";
import { API_URL, client, errorMessage, useCodecSpec } from "@/lib/api";
import { useTenant } from "@/lib/tenant";
import { cn } from "@/lib/utils";

export const MQTT_URL = process.env.NEXT_PUBLIC_MQTT_URL ?? "mqtt://localhost:1883";

interface IngestResult {
  messageId?: string;
  deviceId?: string;
  status: "decoded" | "unknown" | "error";
  message?: string;
  data?: Record<string, unknown>;
  warnings?: string[];
  errors?: string[];
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-subtle">{label}</span>
      <div className="flex items-center gap-1 rounded-control bg-sunken/60 py-1 pr-1 pl-3 ring-1 ring-line ring-inset">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={value}>
          {value}
        </code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="text-ion" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

/** Connection details + "Send test payload" for a newly onboarded device. */
export function ConnectPanel({ serial, codecId, codecVersion }: { serial: string; codecId?: string; codecVersion?: string }) {
  const t = useTenant();
  const spec = useCodecSpec(codecId, codecVersion);
  const vector = spec.data?.vectors.find((v) => v.direction !== "downlink");
  const send = useMutation({
    mutationFn: () => client(t).post<IngestResult>(`/ingest/http/${encodeURIComponent(serial)}`, { hex: vector!.hex, port: vector!.port }),
    onError: (e) => toast.error("Test payload failed", { description: errorMessage(e) }),
  });
  const r = send.data;
  const ingestUrl = `${API_URL}/ingest/http/${encodeURIComponent(serial)}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <CopyField label="MQTT topic" value={`dev/${serial}/up`} />
        <CopyField label="MQTT broker" value={MQTT_URL} />
        <CopyField label="HTTP ingest (POST {hex, port})" value={ingestUrl} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" disabled={!vector || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? <Spinner /> : <Send />}
          Send test payload
        </Button>
        <span className="text-xs text-subtle">
          {spec.isPending && codecId
            ? "Loading codec vectors…"
            : vector
              ? <>Uses vector <span className="font-mono">{vector.name}</span> from {codecId}</>
              : codecId
                ? "This codec has no uplink test vector."
                : "No codec on this model, so there is nothing to decode."}
        </span>
      </div>
      {r ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={r.status === "decoded" ? "ion" : r.status === "unknown" ? "ember" : "danger"}>{r.status === "decoded" ? "Decoded" : r.status === "unknown" ? "Unknown payload" : "Decode error"}</Badge>
            {r.message ? <span className={cn("font-mono text-sm")}>{r.message}</span> : null}
            <span className="text-xs text-subtle">The device is now online and its shadow is updated.</span>
          </div>
          {vector ? <HexInspector hex={vector.hex} data={r.data} /> : null}
          {r.errors?.length ? <Callout tone="danger">{r.errors.join(". ")}</Callout> : null}
        </div>
      ) : null}
    </div>
  );
}
