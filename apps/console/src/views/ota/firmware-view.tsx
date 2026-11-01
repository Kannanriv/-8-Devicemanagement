"use client";

import * as React from "react";
import { HardDriveUpload, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Button, Spinner } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, useFirmware, useModels, useUploadFirmware } from "@/lib/api";
import { fmt } from "@/lib/utils";

export function FirmwareView() {
  const fw = useFirmware();
  const models = useModels();
  const [open, setOpen] = React.useState(false);
  const modelName = new Map((models.data ?? []).map((m) => [m.id, `${m.vendor} ${m.name}`]));
  const list = (fw.data ?? []).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <PageHeader
        back={{ href: "/ota", label: "Firmware & OTA" }}
        title="Firmware library"
        description="Signed images, ready to roll out. Every artifact is hashed and signed with the tenant’s ed25519 key."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Upload />
            Upload firmware
          </Button>
        }
      />
      <Panel className="overflow-hidden pt-2">
        {fw.isPending ? (
          <div className="flex flex-col gap-2 p-7">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : fw.error ? (
          <ApiError error={fw.error} onRetry={() => void fw.refetch()} />
        ) : list.length === 0 ? (
          <Empty
            icon={HardDriveUpload}
            title="No firmware yet"
            action={
              <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                Upload firmware
              </Button>
            }
          >
            Upload a binary to sign it and make it available for OTA campaigns.
          </Empty>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Version</TH>
                <TH>Model</TH>
                <TH className="hidden md:table-cell">Size</TH>
                <TH className="hidden lg:table-cell">SHA-256</TH>
                <TH className="hidden lg:table-cell">Needs codec</TH>
                <TH className="text-right">Uploaded</TH>
              </TR>
            </THead>
            <TBody>
              {list.map((f) => (
                <TR key={f.id}>
                  <TD>
                    <p className="font-mono text-[13px] font-medium">{f.version}</p>
                    {f.releaseNotes ? <p className="max-w-72 truncate text-xs text-subtle">{f.releaseNotes}</p> : null}
                  </TD>
                  <TD className="text-[13px]">{modelName.get(f.modelId) ?? f.modelId}</TD>
                  <TD className="hidden text-[13px] text-muted tabular md:table-cell">{fmt.bytes(f.sizeBytes)}</TD>
                  <TD className="hidden lg:table-cell">
                    <Tooltip content={<span className="font-mono break-all">{f.sha256}</span>}>
                      <span tabIndex={0} className="focus-ring inline-flex items-center gap-1.5 rounded font-mono text-xs text-muted">
                        <ShieldCheck className="size-3.5 text-ion" />
                        {f.sha256.slice(0, 12)}…
                      </span>
                    </Tooltip>
                  </TD>
                  <TD className="hidden font-mono text-xs text-muted lg:table-cell">{f.codecVersion ?? "—"}</TD>
                  <TD className="text-right text-[13px] whitespace-nowrap text-muted">{fmt.ago(f.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
      <UploadDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const models = useModels();
  const upload = useUploadFirmware();
  const [file, setFile] = React.useState<File | null>(null);
  const [version, setVersion] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [codecVersion, setCodecVersion] = React.useState("");
  const [notes, setNotes] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setFile(null);
      setVersion("");
      setNotes("");
      setCodecVersion("");
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload firmware</DialogTitle>
          <DialogDescription>The image is hashed and signed on upload.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!file) return;
            upload.mutate(
              { file, version, modelId, releaseNotes: notes || undefined, codecVersion: codecVersion || undefined },
              {
                onSuccess: () => {
                  toast.success(`Firmware ${version} uploaded and signed`);
                  onOpenChange(false);
                },
                onError: (err) => toast.error("Upload failed", { description: errorMessage(err) }),
              },
            );
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor="fw-file">Binary</Label>
              <Input id="fw-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="h-auto py-2 file:mr-3 file:rounded-full file:border-0 file:bg-hover file:px-3 file:py-1 file:text-[13px] file:text-fg" required />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label htmlFor="fw-ver">Version</Label>
                <Input id="fw-ver" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2.4.1" required />
              </Field>
              <Field>
                <Label htmlFor="fw-codec">Needs codec (optional)</Label>
                <Input id="fw-codec" value={codecVersion} onChange={(e) => setCodecVersion(e.target.value)} placeholder="1.2.0" />
              </Field>
            </div>
            <Field>
              <Label htmlFor="fw-model">Model</Label>
              <NativeSelect id="fw-model" value={modelId} onChange={(e) => setModelId(e.target.value)} required>
                <option value="">{models.isPending ? "Loading…" : "Choose a model…"}</option>
                {(models.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.vendor} {m.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <Label htmlFor="fw-notes">Release notes</Label>
              <Textarea id="fw-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-20" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!file || !version || !modelId || upload.isPending}>
              {upload.isPending ? <Spinner /> : <Upload />}
              Upload and sign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
