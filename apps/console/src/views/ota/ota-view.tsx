"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HardDriveUpload, Plus, Rocket } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { CampaignStatusBadge } from "@/components/status";
import { CampaignDialog } from "@/components/dialogs";
import { Button } from "@/components/ui/button";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useCampaigns, useFirmware } from "@/lib/api";
import { fmt } from "@/lib/utils";
import { campaignTotals, WaveStrip } from "./waves";

export function OtaView() {
  const campaigns = useCampaigns();
  const firmware = useFirmware();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") setOpen(true);
  }, []);
  const fwById = new Map((firmware.data ?? []).map((f) => [f.id, f]));
  const list = (campaigns.data ?? []).toSorted((a, b) => {
    const rank = (s: string) => (s === "running" ? 0 : s === "paused" ? 1 : s === "draft" ? 2 : 3);
    return rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <>
      <PageHeader
        title="Firmware & OTA"
        description="Staged rollouts that pause themselves when devices get sick."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/firmware">
                <HardDriveUpload />
                Firmware library
              </Link>
            </Button>
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus />
              New campaign
            </Button>
          </>
        }
      />
      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Campaigns</PanelTitle>
            <PanelDescription>Running first</PanelDescription>
          </div>
        </PanelHeader>
        {campaigns.isPending ? (
          <div className="flex flex-col gap-2 px-7 pb-7">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : campaigns.error ? (
          <ApiError error={campaigns.error} onRetry={() => void campaigns.refetch()} />
        ) : list.length === 0 ? (
          <Empty
            icon={Rocket}
            title="No campaigns yet"
            action={
              <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                New campaign
              </Button>
            }
          >
            Upload firmware, pick a cohort, and roll out in waves gated on device health.
          </Empty>
        ) : (
          <ul className="flex flex-col border-t border-line">
            {list.map((c) => {
              const t = campaignTotals(c);
              const fw = fwById.get(c.firmwareId);
              return (
                <li key={c.id} className="border-b border-line last:border-0">
                  <Link
                    href={`/ota/${c.id}`}
                    className="focus-ring grid gap-x-6 gap-y-3 px-6 py-4 transition-colors hover:bg-hover sm:px-7 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <CampaignStatusBadge status={c.status} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-subtle">
                        {fw ? <span className="font-mono">{fw.version}</span> : "Firmware"}
                        {c.fromVersions.length ? ` from ${c.fromVersions.join(", ")}` : ""}, updated {fmt.ago(c.updatedAt)}
                      </p>
                    </div>
                    <WaveStrip waves={c.waves} className="self-center" />
                    <div className="flex items-center gap-5 text-right text-xs">
                      <div>
                        <p className="text-sm font-semibold tabular">{fmt.number(t.succeeded)}</p>
                        <p className="text-subtle">updated</p>
                      </div>
                      <div>
                        <p className={t.failed ? "text-sm font-semibold text-danger tabular" : "text-sm font-semibold tabular"}>{fmt.number(t.failed)}</p>
                        <p className="text-subtle">failed</p>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <CampaignDialog open={open} onOpenChange={setOpen} onCreated={(id) => router.push(`/ota/${id}`)} />
    </>
  );
}
