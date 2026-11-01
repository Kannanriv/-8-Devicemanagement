"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import type { SpecImportJob } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge, Dot, type BadgeTone } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/button";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useSpecImports, useUploadSpec } from "@/lib/api";
import { cn, fmt } from "@/lib/utils";

const STATUS_TONE: Record<SpecImportJob["status"], BadgeTone> = {
  parsing: "signal",
  extracting: "signal",
  review: "ember",
  failed: "danger",
  published: "ion",
};
const STATUS_LABEL: Record<SpecImportJob["status"], string> = {
  parsing: "Parsing",
  extracting: "Extracting",
  review: "Needs review",
  failed: "Failed",
  published: "Published",
};

export function JobStatus({ status }: { status: SpecImportJob["status"] }) {
  const busy = status === "parsing" || status === "extracting";
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {busy ? <Dot tone="signal" live className="size-1.5 [&>span]:size-1.5" /> : null}
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function SpecImportsView() {
  const jobs = useSpecImports();
  const list = (jobs.data ?? []).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <PageHeader
        title="Spec imports"
        description="Drop an OEM message spec. The Spec Extractor drafts a codec with a source cell for every field, and you review it before publishing."
      />
      <Dropzone />
      <Panel className="mt-6 overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Imports</PanelTitle>
            <PanelDescription>Most recent first</PanelDescription>
          </div>
        </PanelHeader>
        {jobs.isPending ? (
          <div className="flex flex-col gap-2 px-7 pb-7">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : jobs.error ? (
          <ApiError error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : list.length === 0 ? (
          <Empty icon={FileSpreadsheet} title="No imports yet">
            Upload an Excel spec above. Sample sheets live in samples/excel.
          </Empty>
        ) : (
          <ul className="flex flex-col border-t border-line">
            {list.map((j) => (
              <li key={j.id} className="border-b border-line last:border-0">
                <Link
                  href={`/spec-imports/${j.id}`}
                  className="focus-ring flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-4 transition-colors hover:bg-hover sm:px-7"
                >
                  <span className="flex size-9 items-center justify-center rounded-[12px] bg-ion/10 text-ion ring-1 ring-ion/20 ring-inset">
                    <FileSpreadsheet className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{j.fileName}</p>
                    <p className="truncate font-mono text-xs text-subtle">{j.codecId ? `${j.codecId}@${j.draftVersion ?? "draft"}` : "Draft pending"}</p>
                  </div>
                  {j.confidence != null ? (
                    <span className={cn("text-sm tabular", j.confidence < 0.75 ? "text-ember" : "text-muted")}>{fmt.pct(j.confidence)} confidence</span>
                  ) : null}
                  {j.issues.length ? <Badge tone="ember">{j.issues.length} issues</Badge> : null}
                  <JobStatus status={j.status} />
                  <span className="w-20 text-right text-xs text-subtle">{fmt.ago(j.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function Dropzone() {
  const upload = useUploadSpec();
  const router = useRouter();
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);

  const send = (file: File | undefined) => {
    if (!file) return;
    if (!/\.(xlsx|xlsm|xls|csv)$/i.test(file.name)) {
      toast.error("Unsupported file", { description: "Upload an .xlsx, .xls or .csv spec." });
      return;
    }
    upload.mutate(file, {
      onSuccess: (job) => {
        toast.success(`Importing ${file.name}`);
        router.push(`/spec-imports/${job.id}`);
      },
      onError: (e) => toast.error("Upload failed", { description: errorMessage(e) }),
    });
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        send(e.dataTransfer.files[0]);
      }}
      className={cn(
        "relative overflow-hidden rounded-panel border border-dashed transition-colors duration-300",
        over ? "border-signal bg-signal/[0.05]" : "border-line-strong bg-panel",
      )}
    >
      {over ? <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-signature" /> : null}
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={upload.isPending}
        className="focus-ring flex w-full cursor-pointer flex-col items-center gap-3 rounded-panel px-6 py-14 text-center"
      >
        <span className="flex size-14 items-center justify-center rounded-2xl bg-raised ring-1 ring-line ring-inset">
          {upload.isPending ? <Spinner className="size-5" /> : <UploadCloud className="size-6 text-muted" strokeWidth={1.5} />}
        </span>
        <span className="text-[17px] font-semibold tracking-[-0.02em]">{upload.isPending ? "Uploading…" : "Drop an Excel spec here"}</span>
        <span className="text-sm text-muted">or click to choose a file (.xlsx, .xls or .csv)</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xlsm,.xls,.csv"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          send(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
