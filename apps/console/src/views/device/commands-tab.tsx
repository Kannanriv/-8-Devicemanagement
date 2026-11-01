"use client";

import * as React from "react";
import { Send, TerminalSquare, X } from "lucide-react";
import { toast } from "sonner";
import type { Device } from "@hash8/sdk-ts";
import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { CodecMessageForm, defaultValues } from "@/components/codec-form";
import { ApiError } from "@/components/query-state";
import { CommandStatusBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout, Empty } from "@/components/ui/empty";
import { Field, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { errorMessage, useCancelCommand, useDeviceCommands, useSendCommand } from "@/lib/api";
import { fmt } from "@/lib/utils";

export function CommandsTab({ d, spec, specLoading }: { d: Device; spec?: DeviceCodecSpec; specLoading: boolean }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
      <ComposePanel d={d} spec={spec} specLoading={specLoading} />
      <QueuePanel d={d} />
    </div>
  );
}

function ComposePanel({ d, spec, specLoading }: { d: Device; spec?: DeviceCodecSpec; specLoading: boolean }) {
  const downlinks = spec?.downlink ?? [];
  const [name, setName] = React.useState("");
  const msg = downlinks.find((m) => m.name === name);
  const [data, setData] = React.useState<Record<string, unknown>>({});
  const [raw, setRaw] = React.useState("{}");
  const send = useSendCommand(d.id);

  React.useEffect(() => {
    if (!name && downlinks[0]) setName(downlinks[0].name);
  }, [downlinks, name]);
  React.useEffect(() => {
    if (msg) setData(defaultValues(msg));
  }, [msg]);

  const freeform = !specLoading && downlinks.length === 0;
  let rawParsed: Record<string, unknown> | null = null;
  if (freeform) {
    try {
      const v = JSON.parse(raw) as unknown;
      rawParsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      rawParsed = null;
    }
  }

  const submit = () => {
    const body = freeform ? { message: name, data: rawParsed ?? {} } : { message: name, data };
    send.mutate(body, {
      onSuccess: () => toast.success(`${name} queued`, { description: "Delivered on the device’s next downlink window." }),
      onError: (e) => toast.error("Command rejected", { description: errorMessage(e) }),
    });
  };

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Compose</PanelTitle>
          <PanelDescription>{spec ? `Generated from ${spec.id}@${spec.version}` : "Downlink command"}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-5">
        {specLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-24" />
          </div>
        ) : freeform ? (
          <>
            <Callout tone="neutral" title="No downlinks in this codec">
              {d.codecId ? "The codec defines no downlink messages. You can still send a raw command." : "This device has no codec assigned."}
            </Callout>
            <Field>
              <Label htmlFor="cmd-name">Message name</Label>
              <input
                id="cmd-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="focus-ring h-10 rounded-control border border-line bg-sunken/60 px-3.5 text-sm"
              />
            </Field>
            <Field>
              <Label htmlFor="cmd-raw">Data (JSON)</Label>
              <Textarea id="cmd-raw" value={raw} onChange={(e) => setRaw(e.target.value)} className="font-mono text-[13px]" aria-invalid={!rawParsed} />
            </Field>
          </>
        ) : (
          <>
            <Field>
              <Label htmlFor="cmd-msg">Message</Label>
              <NativeSelect id="cmd-msg" value={name} onChange={(e) => setName(e.target.value)}>
                {downlinks.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
              {msg?.description ? <p className="text-xs text-subtle">{msg.description}</p> : null}
            </Field>
            {msg ? <CodecMessageForm msg={msg} value={data} onChange={setData} idPrefix="cmd" /> : null}
          </>
        )}
        <Button variant="primary" disabled={!name || send.isPending || (freeform && !rawParsed)} onClick={submit}>
          {send.isPending ? <Spinner /> : <Send />}
          Queue command
        </Button>
      </PanelBody>
    </Panel>
  );
}

function QueuePanel({ d }: { d: Device }) {
  const cmds = useDeviceCommands(d.id);
  const cancel = useCancelCommand(d.id);
  const list = (cmds.data ?? []).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Panel className="min-w-0 overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Queue</PanelTitle>
          <PanelDescription>Commands and their delivery status</PanelDescription>
        </div>
      </PanelHeader>
      {cmds.isPending ? (
        <PanelBody className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </PanelBody>
      ) : cmds.error ? (
        <ApiError error={cmds.error} onRetry={() => void cmds.refetch()} />
      ) : list.length === 0 ? (
        <Empty icon={TerminalSquare} title="No commands yet">
          Queue a command to change device behaviour remotely.
        </Empty>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Command</TH>
              <TH>Status</TH>
              <TH className="hidden md:table-cell">Payload</TH>
              <TH className="hidden lg:table-cell">By</TH>
              <TH className="text-right">When</TH>
              <TH className="w-12" />
            </TR>
          </THead>
          <TBody>
            {list.map((c) => (
              <TR key={c.id}>
                <TD>
                  <p className="font-medium">{c.message}</p>
                  <p className="max-w-64 truncate font-mono text-xs text-subtle">{JSON.stringify(c.data)}</p>
                  {c.error ? <p className="text-xs text-danger">{c.error}</p> : null}
                </TD>
                <TD>
                  <CommandStatusBadge status={c.status} />
                </TD>
                <TD className="hidden font-mono text-xs text-muted md:table-cell">
                  {c.payloadHex ?? "—"}
                  {c.port != null ? <span className="text-subtle"> :{c.port}</span> : null}
                </TD>
                <TD className="hidden text-[13px] text-muted lg:table-cell">{c.requestedBy}</TD>
                <TD className="text-right text-[13px] whitespace-nowrap text-muted">{fmt.ago(c.createdAt)}</TD>
                <TD>
                  {c.status === "queued" ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Cancel ${c.message}`}
                      disabled={cancel.isPending}
                      onClick={() =>
                        cancel.mutate(c.id, { onError: (e) => toast.error("Couldn’t cancel", { description: errorMessage(e) }) })
                      }
                    >
                      <X />
                    </Button>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  );
}
