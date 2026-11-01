"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftRight, Cpu, Plus, Unlink } from "lucide-react";
import { toast } from "sonner";
import type { Asset, Device } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { ConnectivityDot, HealthBadge, LifecycleBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Callout, Empty } from "@/components/ui/empty";
import { Field, FieldHint, Input, Label, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useDevices } from "@/lib/api";
import { useAsset, useAssetMutations } from "@/lib/api-v11";
import { fmt } from "@/lib/utils";
import { AssociationHistory } from "./association-history";

export function AssetView({ id }: { id: string }) {
  const asset = useAsset(id);
  if (asset.isPending)
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-80" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-80 rounded-panel" />
          <Skeleton className="h-80 rounded-panel" />
        </div>
      </div>
    );
  if (asset.error || !asset.data)
    return (
      <>
        <PageHeader title="Asset" back={{ href: "/assets", label: "Assets" }} />
        <Panel>
          <ApiError error={asset.error} onRetry={() => void asset.refetch()} />
        </Panel>
      </>
    );
  return <Loaded a={asset.data} />;
}

function Loaded({ a }: { a: Asset }) {
  const devices = useDevices({ assetId: a.id, limit: 50 });
  const m = useAssetMutations(a.id);
  const [dialog, setDialog] = React.useState<null | "attach" | "swap">(null);
  const [swapFrom, setSwapFrom] = React.useState<string>();
  const onAsset = (devices.data?.items ?? []).filter((d) => a.deviceIds.includes(d.id) || d.assetId === a.id);

  return (
    <>
      <PageHeader
        back={{ href: "/assets", label: "Assets" }}
        title={a.name}
        description={[fmt.label(a.type), [a.make, a.model].filter(Boolean).join(" "), a.serial].filter(Boolean).join(", ")}
        meta={
          <>
            {a.organization ? <Badge>{[a.organization, a.branch].filter(Boolean).join(", ")}</Badge> : null}
            {a.site?.name ? <Badge>{a.site.name}</Badge> : null}
            <Badge tone={a.deviceIds.length ? "ion" : "ember"}>
              {a.deviceIds.length} {a.deviceIds.length === 1 ? "device" : "devices"}
            </Badge>
          </>
        }
        actions={
          <>
            <Button variant="secondary" disabled={!onAsset.length} onClick={() => setDialog("swap")}>
              <ArrowLeftRight />
              Swap device
            </Button>
            <Button variant="primary" onClick={() => setDialog("attach")}>
              <Plus />
              Add device
            </Button>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle>Devices on this asset</PanelTitle>
              <PanelDescription>Lifecycle, connectivity and health for each</PanelDescription>
            </div>
          </PanelHeader>
          {devices.isPending ? (
            <div className="flex flex-col gap-2 px-7 pb-7">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : devices.error ? (
            <ApiError error={devices.error} onRetry={() => void devices.refetch()} />
          ) : onAsset.length === 0 ? (
            <Empty
              icon={Cpu}
              title="No devices installed"
              action={
                <Button size="sm" variant="primary" onClick={() => setDialog("attach")}>
                  Add device
                </Button>
              }
            >
              Install a device to start monitoring this asset.
            </Empty>
          ) : (
            <ul className="flex flex-col border-t border-line">
              {onAsset.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-6 py-4 last:border-0 sm:px-7">
                  <Link href={`/devices/${d.id}`} className="focus-ring min-w-40 flex-1 rounded">
                    <p className="font-mono text-[13px] font-medium hover:underline">{d.udi ?? d.serial}</p>
                    <p className="text-xs text-subtle">{d.model ?? d.modelId}</p>
                  </Link>
                  <LifecycleBadge state={d.lifecycle} />
                  <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} />
                  <HealthBadge level={d.health?.level} />
                  <div className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSwapFrom(d.id);
                        setDialog("swap");
                      }}
                    >
                      <ArrowLeftRight />
                      Swap
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${d.udi ?? d.serial} from asset`}
                      disabled={m.detach.isPending}
                      onClick={() =>
                        m.detach.mutate(d.id, {
                          onSuccess: () => toast.success("Device removed"),
                          onError: (e) => toast.error("Couldn’t remove", { description: errorMessage(e) }),
                        })
                      }
                    >
                      <Unlink />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Association history</PanelTitle>
              <PanelDescription>Every install, swap and removal</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody>
            <AssociationHistory assetId={a.id} />
          </PanelBody>
        </Panel>
      </div>
      <AttachDialog assetId={a.id} open={dialog === "attach"} onOpenChange={(v) => setDialog(v ? "attach" : null)} />
      <SwapDialog
        assetId={a.id}
        current={onAsset}
        initialFrom={swapFrom}
        open={dialog === "swap"}
        onOpenChange={(v) => {
          setDialog(v ? "swap" : null);
          if (!v) setSwapFrom(undefined);
        }}
      />
    </>
  );
}

function DevicePicker({ value, onChange, label, id }: { value: string; onChange: (id: string) => void; label: string; id: string }) {
  const [q, setQ] = React.useState("");
  const results = useDevices({ q: q || undefined, limit: 10, lifecycle: q ? undefined : "registered" });
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search UDI, serial or IMEI" aria-label={`Search for ${label.toLowerCase()}`} />
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{results.isFetching ? "Searching…" : q ? "Choose a device…" : "Choose a registered device…"}</option>
        {(results.data?.items ?? []).map((d: Device) => (
          <option key={d.id} value={d.id}>
            {d.udi ?? d.serial}
            {d.assetName ? ` (on ${d.assetName})` : ""}
          </option>
        ))}
      </NativeSelect>
      <FieldHint>Spare devices in Registered state are listed first.</FieldHint>
    </Field>
  );
}

function AttachDialog({ assetId, open, onOpenChange }: { assetId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const m = useAssetMutations(assetId);
  const [deviceId, setDeviceId] = React.useState("");
  const [role, setRole] = React.useState<"primary" | "secondary">("primary");
  React.useEffect(() => {
    if (open) setDeviceId("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add device to asset</DialogTitle>
          <DialogDescription>The association starts now and is kept in the history.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <DevicePicker id="at-dev" label="Device" value={deviceId} onChange={setDeviceId} />
          <Field>
            <Label htmlFor="at-role">Role</Label>
            <NativeSelect id="at-role" value={role} onChange={(e) => setRole(e.target.value as "primary" | "secondary")}>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </NativeSelect>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!deviceId || m.attach.isPending}
            onClick={() =>
              m.attach.mutate(
                { deviceId, role },
                {
                  onSuccess: () => {
                    toast.success("Device added");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error("Couldn’t add device", { description: errorMessage(e) }),
                },
              )
            }
          >
            {m.attach.isPending ? <Spinner /> : null}
            Add device
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwapDialog({
  assetId,
  current,
  initialFrom,
  open,
  onOpenChange,
}: {
  assetId: string;
  current: Device[];
  initialFrom?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const m = useAssetMutations(assetId);
  const [oldId, setOldId] = React.useState("");
  const [newId, setNewId] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setOldId(initialFrom ?? current[0]?.id ?? "");
      setNewId("");
    }
  }, [open, initialFrom, current]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Swap device</DialogTitle>
          <DialogDescription>The old device moves to Swap, the new one takes its place, and both keep their history.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <Label htmlFor="sw-old">Replace</Label>
            <NativeSelect id="sw-old" value={oldId} onChange={(e) => setOldId(e.target.value)}>
              {current.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.udi ?? d.serial}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DevicePicker id="sw-new" label="With" value={newId} onChange={setNewId} />
          {newId && newId === oldId ? <Callout tone="ember">Choose a different device.</Callout> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!oldId || !newId || oldId === newId || m.swap.isPending}
            onClick={() =>
              m.swap.mutate(
                { oldDeviceId: oldId, newDeviceId: newId },
                {
                  onSuccess: () => {
                    toast.success("Device swapped");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error("Swap failed", { description: errorMessage(e) }),
                },
              )
            }
          >
            {m.swap.isPending ? <Spinner /> : <ArrowLeftRight />}
            Swap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
