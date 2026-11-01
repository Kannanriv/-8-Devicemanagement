"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { Device } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Field, Label, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useAsset, useAssetMutations, useAssets } from "@/lib/api-v11";
import { AssociationHistory } from "@/views/assets/association-history";
import { cn } from "@/lib/utils";

export function AssetTab({ d }: { d: Device }) {
  if (!d.assetId) return <AssignPanel d={d} />;
  return <AssetPanels d={d} assetId={d.assetId} />;
}

function AssetPanels({ d, assetId }: { d: Device; assetId: string }) {
  const asset = useAsset(assetId);
  const m = useAssetMutations(assetId);
  if (asset.isPending) return <Skeleton className="h-64 rounded-panel" />;
  if (asset.error || !asset.data)
    return (
      <Panel>
        <ApiError error={asset.error} onRetry={() => void asset.refetch()} />
      </Panel>
    );
  const a = asset.data;
  const rows: [string, React.ReactNode][] = [
    ["Type", a.type],
    ["Make and model", [a.make, a.model].filter(Boolean).join(" ") || "—"],
    ["Serial", a.serial ?? "—"],
    ["Organization", [a.organization, a.branch].filter(Boolean).join(", ") || "—"],
    ["Site", a.site?.name ?? "—"],
    ["Devices on asset", String(a.deviceIds.length)],
  ];
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>{a.name}</PanelTitle>
            <PanelDescription>This device is installed on this asset</PanelDescription>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={m.detach.isPending}
              onClick={() =>
                m.detach.mutate(d.id, {
                  onSuccess: () => toast.success("Device removed from asset"),
                  onError: (e) => toast.error("Couldn’t remove", { description: errorMessage(e) }),
                })
              }
            >
              {m.detach.isPending ? <Spinner /> : null}
              Remove
            </Button>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`/assets/${a.id}`}>
                Open asset
                <ArrowUpRight />
              </Link>
            </Button>
          </div>
        </PanelHeader>
        <PanelBody>
          <dl className="flex flex-col">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
                <dt className="text-[13px] text-muted">{k}</dt>
                <dd className="truncate text-right text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Association history</PanelTitle>
            <PanelDescription>Installs, swaps and reassignments on this asset</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <AssociationHistory assetId={a.id} highlightDevice={d.id} />
        </PanelBody>
      </Panel>
    </div>
  );
}

function AssignPanel({ d }: { d: Device }) {
  const assets = useAssets();
  const [assetId, setAssetId] = React.useState("");
  const [role, setRole] = React.useState<"primary" | "secondary">("primary");
  const m = useAssetMutations(assetId || "_");
  return (
    <Panel>
      <Empty icon={Link2} title="Not assigned to an asset" className="pb-6">
        Link this device to the vehicle, machine or site it monitors.
      </Empty>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-6 pb-10">
        <Field>
          <Label htmlFor="as-asset">Asset</Label>
          <NativeSelect id="as-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">{assets.isPending ? "Loading…" : (assets.data ?? []).length ? "Choose an asset…" : "No assets yet"}</option>
            {(assets.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.type})
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <Label htmlFor="as-role">Role</Label>
          <NativeSelect id="as-role" value={role} onChange={(e) => setRole(e.target.value as "primary" | "secondary")}>
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
          </NativeSelect>
        </Field>
        <Button
          variant="primary"
          className={cn(!assetId && "opacity-60")}
          disabled={!assetId || m.attach.isPending}
          onClick={() =>
            m.attach.mutate(
              { deviceId: d.id, role },
              {
                onSuccess: () => toast.success("Assigned to asset"),
                onError: (e) => toast.error("Couldn’t assign", { description: errorMessage(e) }),
              },
            )
          }
        >
          {m.attach.isPending ? <Spinner /> : <Link2 />}
          Assign to asset
        </Button>
      </div>
    </Panel>
  );
}
