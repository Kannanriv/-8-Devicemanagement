"use client";

import * as React from "react";
import { toast } from "sonner";
import type { DeviceQuery } from "@hash8/sdk-ts";
import { Button, Spinner } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, Input, Label, NativeSelect } from "@/components/ui/input";
import { Callout } from "@/components/ui/empty";
import { errorMessage, useCreateCampaign, useFirmware } from "@/lib/api";

type Open = { open: boolean; onOpenChange: (v: boolean) => void };

export function CampaignDialog({ cohort, open, onOpenChange, onCreated }: Open & { cohort?: DeviceQuery; onCreated?: (id: string) => void }) {
  const firmware = useFirmware();
  const create = useCreateCampaign();
  const [name, setName] = React.useState("");
  const [firmwareId, setFirmwareId] = React.useState("");
  const [maxFailure, setMaxFailure] = React.useState("5");
  const [minHealth, setMinHealth] = React.useState("60");
  const fw = firmware.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New OTA campaign</DialogTitle>
          <DialogDescription>Rolls out in waves: canary, 10%, 50%, then everyone, gated on health.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              {
                name,
                firmwareId,
                cohort: cohort ?? {},
                healthGate: { maxFailureRate: Number(maxFailure) / 100, minHealthScore: Number(minHealth) },
              },
              {
                onSuccess: (c) => {
                  toast.success("Campaign created");
                  onOpenChange(false);
                  onCreated?.(c.id);
                },
                onError: (err) => toast.error("Couldn’t create campaign", { description: errorMessage(err) }),
              },
            );
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor="c-name">Name</Label>
              <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tracker fw 2.4.1 rollout" required />
            </Field>
            <Field>
              <Label htmlFor="c-fw">Firmware</Label>
              <NativeSelect id="c-fw" value={firmwareId} onChange={(e) => setFirmwareId(e.target.value)} required>
                <option value="">{firmware.isPending ? "Loading…" : fw.length ? "Choose firmware…" : "No firmware uploaded yet"}</option>
                {fw.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.version} · {f.modelId}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label htmlFor="c-fail">Pause above failure %</Label>
                <Input id="c-fail" type="number" min={0} max={100} value={maxFailure} onChange={(e) => setMaxFailure(e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="c-health">Minimum health</Label>
                <Input id="c-health" type="number" min={0} max={100} value={minHealth} onChange={(e) => setMinHealth(e.target.value)} />
              </Field>
            </div>
            {cohort && Object.keys(cohort).length ? (
              <Callout tone="signal" title="Cohort from your fleet filters">
                {Object.entries(cohort)
                  .filter(([k]) => k !== "limit" && k !== "cursor")
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(", ") || "All devices"}
              </Callout>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name || !firmwareId || create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Create campaign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
