"use client";

import * as React from "react";
import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Device, DeviceCredential } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { CredentialBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { useDeviceCredentials, useIssueCredential, useRevokeCredential } from "@/lib/api-v11";
import { fmt } from "@/lib/utils";

export function CredentialsTab({ d }: { d: Device }) {
  const creds = useDeviceCredentials(d.id);
  const issue = useIssueCredential(d.id);
  const [revoking, setRevoking] = React.useState<DeviceCredential | null>(null);
  const list = (creds.data ?? []).toSorted((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Credentials</PanelTitle>
          <PanelDescription>Certificates and keys this device authenticates with</PanelDescription>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={issue.isPending}
          onClick={() =>
            issue.mutate(undefined, {
              onSuccess: () => toast.success("Certificate issued", { description: "Signed by the tenant’s device CA." }),
              onError: (e) => toast.error("Couldn’t issue", { description: errorMessage(e) }),
            })
          }
        >
          {issue.isPending ? <Spinner /> : <Plus />}
          Issue X.509 certificate
        </Button>
      </PanelHeader>
      {creds.isPending ? (
        <div className="flex flex-col gap-2 px-7 pb-7">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : creds.error ? (
        <ApiError error={creds.error} onRetry={() => void creds.refetch()} />
      ) : list.length === 0 ? (
        <Empty icon={KeyRound} title="No credentials">
          Issue a certificate so this device can connect with mutual TLS.
        </Empty>
      ) : (
        <CredentialTable list={list} onRevoke={setRevoking} />
      )}
      <RevokeDialog cred={revoking} onClose={() => setRevoking(null)} />
    </Panel>
  );
}

export function CredentialTable({
  list,
  onRevoke,
  deviceColumn,
}: {
  list: (DeviceCredential & { deviceUdi?: string })[];
  onRevoke: (c: DeviceCredential) => void;
  deviceColumn?: boolean;
}) {
  return (
    <Table>
      <THead>
        <TR>
          {deviceColumn ? <TH>Device</TH> : null}
          <TH>Kind</TH>
          <TH>Fingerprint</TH>
          <TH>Status</TH>
          <TH className="hidden md:table-cell">Issued</TH>
          <TH>Expires</TH>
          <TH className="w-24" />
        </TR>
      </THead>
      <TBody>
        {list.map((c) => (
          <TR key={c.id}>
            {deviceColumn ? (
              <TD>
                <a href={`/devices/${c.deviceId}#credentials`} className="focus-ring rounded font-mono text-[12.5px] hover:underline">
                  {c.deviceUdi ?? c.deviceId}
                </a>
              </TD>
            ) : null}
            <TD className="text-[13px] uppercase">{c.kind}</TD>
            <TD>
              <p className="max-w-56 truncate font-mono text-xs">{c.fingerprint}</p>
              {c.subject ? <p className="max-w-56 truncate text-xs text-subtle">{c.subject}</p> : null}
            </TD>
            <TD>
              <CredentialBadge status={c.status} />
              {c.revokedReason ? <p className="mt-1 max-w-48 truncate text-xs text-subtle">{c.revokedReason}</p> : null}
            </TD>
            <TD className="hidden text-[13px] text-muted md:table-cell">{fmt.dateTime(c.issuedAt)}</TD>
            <TD className="text-[13px] whitespace-nowrap text-muted">{c.expiresAt ? fmt.ago(c.expiresAt) : "Never"}</TD>
            <TD className="text-right">
              {c.status !== "revoked" ? (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => onRevoke(c)}>
                  Revoke
                </Button>
              ) : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function RevokeDialog({ cred, onClose }: { cred: DeviceCredential | null; onClose: () => void }) {
  const [reason, setReason] = React.useState("");
  const revoke = useRevokeCredential();
  React.useEffect(() => setReason(""), [cred]);
  return (
    <Dialog open={!!cred} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke credential</DialogTitle>
          <DialogDescription>The device can no longer authenticate with it. This can’t be undone.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="truncate font-mono text-xs text-muted">{cred?.fingerprint}</p>
          <Field>
            <Label htmlFor="rv-reason">Reason (recorded in audit)</Label>
            <Textarea id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Device reported stolen" className="min-h-20" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason.trim() || revoke.isPending || !cred}
            onClick={() =>
              cred &&
              revoke.mutate(
                { id: cred.id, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.success("Credential revoked");
                    onClose();
                  },
                  onError: (e) => toast.error("Couldn’t revoke", { description: errorMessage(e) }),
                },
              )
            }
          >
            {revoke.isPending ? <Spinner /> : null}
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
