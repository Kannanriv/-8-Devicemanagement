"use client";

import * as React from "react";
import { CheckCircle2, KeyRound, ShieldCheck, XCircle } from "lucide-react";
import type { CredentialStatus, DeviceCredential } from "@hash8/sdk-ts";
import { PageHeader, Stat } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { useSecurityOverview } from "@/lib/api-v11";
import { fmt } from "@/lib/utils";
import { CredentialTable, RevokeDialog } from "@/views/device/credentials-tab";

export function SecurityView() {
  const q = useSecurityOverview();
  const [filter, setFilter] = React.useState<CredentialStatus | "attention">("attention");
  const [revoking, setRevoking] = React.useState<DeviceCredential | null>(null);
  const o = q.data;
  const creds = (o?.credentials ?? []).filter((c) => (filter === "attention" ? c.status === "expiring" || c.status === "expired" : c.status === filter));
  const passing = o ? o.isolation.filter((c) => c.ok).length : 0;

  return (
    <>
      <PageHeader title="Security & access" description="Device credentials, certificate expiry and the checks that keep each tenant’s devices and data isolated." />
      {q.error && !o ? (
        <Panel>
          <ApiError error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            <dl className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
              {[
                { label: "Active credentials", value: o?.active ?? o?.total, tone: "ion" as const },
                { label: "Expiring within 30 days", value: o?.expiring, tone: "ember" as const },
                { label: "Expired", value: o?.expired, tone: "danger" as const },
                { label: "Revoked", value: o?.revoked },
              ].map((c) => (
                <div key={c.label} className="bg-panel px-6 py-5">
                  {q.isPending ? (
                    <Skeleton className="h-12 w-24" />
                  ) : (
                    <Stat label={c.label} value={c.value == null ? "—" : fmt.number(c.value)} tone={c.value ? c.tone : undefined} />
                  )}
                </div>
              ))}
            </dl>
          </Panel>
          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
            <Panel className="min-w-0 overflow-hidden">
              <PanelHeader>
                <div>
                  <PanelTitle>Credentials</PanelTitle>
                  <PanelDescription>Revoke a credential to cut a device off immediately</PanelDescription>
                </div>
                <Segmented
                  label="Filter"
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: "attention", label: "Needs action" },
                    { value: "active", label: "Active" },
                    { value: "revoked", label: "Revoked" },
                  ]}
                />
              </PanelHeader>
              {q.isPending ? (
                <div className="flex flex-col gap-2 px-7 pb-7">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : creds.length === 0 ? (
                <Empty icon={KeyRound} title={filter === "attention" ? "Nothing expiring" : "None"}>
                  {filter === "attention" ? "No credentials expire in the next 30 days." : "Open a device’s Credentials tab to issue or rotate certificates."}
                </Empty>
              ) : (
                <CredentialTable list={creds} onRevoke={setRevoking} deviceColumn />
              )}
            </Panel>
            <Panel className="h-fit">
              <PanelHeader>
                <div>
                  <PanelTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-ion" />
                    Tenant isolation
                  </PanelTitle>
                  <PanelDescription>{o ? `${passing} of ${o.isolation.length} checks passing` : "Verifying"}</PanelDescription>
                </div>
              </PanelHeader>
              <PanelBody>
                {q.isPending ? (
                  <Skeleton className="h-40" />
                ) : !o?.isolation.length ? (
                  <p className="text-sm text-muted">No isolation checks reported.</p>
                ) : (
                  <ul className="flex flex-col">
                    {o.isolation.map((c) => (
                      <li key={c.name} className="flex gap-3 border-b border-line py-3 last:border-0">
                        {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ion" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
                        <div className="min-w-0">
                          <p className="text-sm">{fmt.label(c.name)}</p>
                          {c.detail ? <p className="text-xs text-subtle">{c.detail}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelBody>
            </Panel>
          </div>
        </>
      )}
      <RevokeDialog cred={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}
