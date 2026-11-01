"use client";

import Link from "next/link";
import { HardDriveDownload, Rocket } from "lucide-react";
import type { Device } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { CampaignStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useCampaigns, useFirmware } from "@/lib/api";
import { fmt } from "@/lib/utils";

export function FirmwareTab({ d }: { d: Device }) {
  const fw = useFirmware();
  const campaigns = useCampaigns();
  const available = (fw.data ?? []).filter((f) => f.modelId === d.modelId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const relevant = (campaigns.data ?? []).filter(
    (c) =>
      (c.cohort?.modelId ? c.cohort.modelId === d.modelId : true) &&
      (c.fromVersions?.length ? !!d.firmwareVersion && c.fromVersions.includes(d.firmwareVersion) : true) &&
      available.some((f) => f.id === c.firmwareId),
  );
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Firmware</PanelTitle>
            <PanelDescription>
              Running <span className="font-mono text-fg">{d.firmwareVersion ?? "unknown"}</span>
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          {fw.isPending ? (
            <Skeleton className="h-40" />
          ) : fw.error ? (
            <ApiError error={fw.error} onRetry={() => void fw.refetch()} />
          ) : available.length === 0 ? (
            <Empty icon={HardDriveDownload} title="No firmware for this model" action={<Link className="text-sm text-signal hover:underline" href="/firmware">Upload firmware</Link>} />
          ) : (
            <ul className="flex flex-col">
              {available.map((f) => (
                <li key={f.id} className="flex items-center gap-3 border-b border-line py-3 last:border-0">
                  <span className="font-mono text-sm">{f.version}</span>
                  {f.version === d.firmwareVersion ? <Badge tone="ion">Installed</Badge> : null}
                  <span className="ml-auto text-[13px] text-muted">{fmt.bytes(f.sizeBytes)}</span>
                  <span className="text-[13px] text-subtle">{fmt.ago(f.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>OTA campaigns</PanelTitle>
            <PanelDescription>Rollouts that can reach this device</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          {campaigns.isPending ? (
            <Skeleton className="h-40" />
          ) : campaigns.error ? (
            <ApiError error={campaigns.error} onRetry={() => void campaigns.refetch()} />
          ) : relevant.length === 0 ? (
            <Empty icon={Rocket} title="Not in any rollout" />
          ) : (
            <ul className="flex flex-col">
              {relevant.map((c) => (
                <li key={c.id} className="border-b border-line last:border-0">
                  <Link href={`/ota/${c.id}`} className="focus-ring -mx-2 flex items-center gap-3 rounded-[12px] px-2 py-3 hover:bg-hover">
                    <span className="text-sm font-medium">{c.name}</span>
                    <CampaignStatusBadge status={c.status} />
                    <span className="ml-auto text-[13px] text-subtle">{fmt.ago(c.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
