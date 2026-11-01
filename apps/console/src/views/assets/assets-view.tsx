"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { useAssets, useCreateAsset } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";

export function AssetsView() {
  const [q, setQ] = React.useState("");
  const [dq, setDq] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const assets = useAssets(dq ? { q: dq } : {});
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const list = (assets.data ?? []).filter((a) => !dq || `${a.name} ${a.type} ${a.serial ?? ""} ${a.organization ?? ""}`.toLowerCase().includes(dq.toLowerCase()));
  const unequipped = list.filter((a) => a.deviceIds.length === 0).length;

  return (
    <>
      <PageHeader
        title="Assets"
        description="The machines, vehicles and sites your devices monitor. Associations are versioned, so swaps never lose history."
        meta={assets.data ? <Badge tone={unequipped ? "ember" : "neutral"}>{unequipped} without a device</Badge> : null}
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus />
            New asset
          </Button>
        }
      />
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, type, serial or organization" className="pl-10" aria-label="Search assets" />
      </div>
      <Panel className="overflow-hidden pt-2">
        {assets.isPending ? (
          <div className="flex flex-col gap-2 p-7">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : assets.error ? (
          <ApiError error={assets.error} onRetry={() => void assets.refetch()} />
        ) : list.length === 0 ? (
          <Empty
            icon={Link2}
            title={dq ? "No assets match" : "No assets yet"}
            action={
              !dq ? (
                <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                  New asset
                </Button>
              ) : undefined
            }
          >
            {dq ? "Try another search." : "Create an asset, then assign devices to it from Inventory."}
          </Empty>
        ) : (
          <Table className={cn(assets.isFetching && "opacity-75")}>
            <THead>
              <TR>
                <TH>Asset</TH>
                <TH>Type</TH>
                <TH className="hidden md:table-cell">Organization</TH>
                <TH className="hidden lg:table-cell">Site</TH>
                <TH className="text-right">Devices</TH>
              </TR>
            </THead>
            <TBody>
              {list.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <Link href={`/assets/${a.id}`} className="focus-ring group flex flex-col rounded">
                      <span className="font-medium group-hover:underline group-hover:underline-offset-4">{a.name}</span>
                      <span className="text-xs text-subtle">{[a.make, a.model, a.serial].filter(Boolean).join(" ") || "—"}</span>
                    </Link>
                  </TD>
                  <TD>
                    <Badge>{fmt.label(a.type)}</Badge>
                  </TD>
                  <TD className="hidden text-[13px] text-muted md:table-cell">{[a.organization, a.branch].filter(Boolean).join(", ") || "—"}</TD>
                  <TD className="hidden text-[13px] text-muted lg:table-cell">{a.site?.name ?? "—"}</TD>
                  <TD className={cn("text-right tabular", a.deviceIds.length === 0 && "text-ember")}>{a.deviceIds.length}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
      <CreateAssetDialog open={open} onOpenChange={setOpen} onCreated={(id) => router.push(`/assets/${id}`)} />
    </>
  );
}

function CreateAssetDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const create = useCreateAsset();
  const [f, setF] = React.useState({ name: "", type: "", make: "", model: "", serial: "", organization: "", branch: "", site: "" });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  React.useEffect(() => {
    if (open) setF({ name: "", type: "", make: "", model: "", serial: "", organization: "", branch: "", site: "" });
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New asset</DialogTitle>
          <DialogDescription>Anything a device can be installed on.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              {
                name: f.name,
                type: f.type,
                make: f.make || undefined,
                model: f.model || undefined,
                serial: f.serial || undefined,
                organization: f.organization || undefined,
                branch: f.branch || undefined,
                site: f.site ? { name: f.site } : undefined,
              },
              {
                onSuccess: (a) => {
                  toast.success(`${a.name} created`);
                  onOpenChange(false);
                  onCreated(a.id);
                },
                onError: (err) => toast.error("Couldn’t create asset", { description: errorMessage(err) }),
              },
            );
          }}
        >
          <DialogBody>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label htmlFor="a-name">Name</Label>
                <Input id="a-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Excavator 14" required />
              </Field>
              <Field>
                <Label htmlFor="a-type">Type</Label>
                <Input id="a-type" value={f.type} onChange={(e) => set("type", e.target.value)} placeholder="excavator" list="asset-types" required />
                <datalist id="asset-types">
                  {["excavator", "generator", "truck", "trailer", "cold-room", "meter-point", "pump", "container"].map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <Field>
                <Label htmlFor="a-make">Make</Label>
                <Input id="a-make" value={f.make} onChange={(e) => set("make", e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="a-model">Model</Label>
                <Input id="a-model" value={f.model} onChange={(e) => set("model", e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="a-org">Organization</Label>
                <Input id="a-org" value={f.organization} onChange={(e) => set("organization", e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="a-branch">Branch</Label>
                <Input id="a-branch" value={f.branch} onChange={(e) => set("branch", e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="a-serial">Serial</Label>
                <Input id="a-serial" value={f.serial} onChange={(e) => set("serial", e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="a-site">Site</Label>
                <Input id="a-site" value={f.site} onChange={(e) => set("site", e.target.value)} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!f.name || !f.type || create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Create asset
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
