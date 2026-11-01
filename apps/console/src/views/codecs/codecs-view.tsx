"use client";

import * as React from "react";
import Link from "next/link";
import { Binary, FileSpreadsheet, Search } from "lucide-react";
import type { CodecVersionSummary } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { CodecStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCodecs } from "@/lib/api";
import { cn, fmt } from "@/lib/utils";

function semverCmp(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function groupCodecs(list: CodecVersionSummary[]) {
  const m = new Map<string, CodecVersionSummary[]>();
  for (const c of list) m.set(c.codecId, [...(m.get(c.codecId) ?? []), c]);
  return [...m.entries()].map(([id, versions]) => {
    const sorted = versions.toSorted((a, b) => semverCmp(b.version, a.version));
    return { id, versions: sorted, latest: sorted[0]!, published: sorted.find((v) => v.status === "published") };
  });
}
export { semverCmp };

export function CodecsView() {
  const codecs = useCodecs();
  const [q, setQ] = React.useState("");
  const groups = React.useMemo(() => {
    const g = groupCodecs(codecs.data ?? []);
    const s = q.trim().toLowerCase();
    return s ? g.filter((x) => `${x.id} ${x.latest.vendor} ${x.latest.model}`.toLowerCase().includes(s)) : g;
  }, [codecs.data, q]);

  return (
    <>
      <PageHeader
        title="Codec catalog"
        description="Verified decoders for every device model, each traceable to the OEM’s own spec."
        actions={
          <Button variant="primary" asChild>
            <Link href="/spec-imports">
              <FileSpreadsheet />
              Import Excel spec
            </Link>
          </Button>
        }
      />
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor, model or codec id" className="pl-10" aria-label="Search codecs" />
      </div>
      {codecs.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-52 rounded-panel" />
          ))}
        </div>
      ) : codecs.error ? (
        <Panel>
          <ApiError error={codecs.error} onRetry={() => void codecs.refetch()} />
        </Panel>
      ) : groups.length === 0 ? (
        <Panel>
          <Empty
            icon={Binary}
            title={q ? "No codecs match" : "No codecs yet"}
            action={
              !q ? (
                <Button asChild variant="primary" size="sm">
                  <Link href="/spec-imports">Import an Excel spec</Link>
                </Button>
              ) : undefined
            }
          >
            {q ? "Try a vendor or model name." : "Upload an OEM message spec and the Spec Extractor drafts a codec for you."}
          </Empty>
        </Panel>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {groups.map((g) => {
            const v = g.published ?? g.latest;
            const pass = v.vectorsTotal ? v.vectorsPassed / v.vectorsTotal : 0;
            return (
              <li key={g.id}>
                <Link
                  href={`/codecs/${encodeURIComponent(g.id)}`}
                  className="focus-ring group flex h-full flex-col rounded-panel border border-line bg-panel p-6 transition-colors hover:border-line-strong hover:bg-raised/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] text-muted">{v.vendor}</p>
                      <p className="truncate text-lg font-semibold tracking-[-0.02em]">{v.model}</p>
                    </div>
                    <CodecStatusBadge status={g.latest.status} />
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-subtle">
                    {g.id}@{g.latest.version}
                    {g.versions.length > 1 ? ` (+${g.versions.length - 1} versions)` : ""}
                  </p>
                  <dl className="mt-6 grid grid-cols-3 gap-4">
                    <div>
                      <dt className="text-xs text-subtle">Messages</dt>
                      <dd className="text-lg font-semibold tabular">{v.messageCount}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-subtle">Fields</dt>
                      <dd className="text-lg font-semibold tabular">{v.fieldCount}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-subtle">Vectors</dt>
                      <dd className={cn("text-lg font-semibold tabular", v.vectorsTotal && pass < 1 && "text-ember")}>
                        {v.vectorsPassed}/{v.vectorsTotal}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-auto pt-5">
                    <div className="h-1 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={Math.round(pass * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Vectors passing">
                      <div className={cn("h-full rounded-full", pass === 1 ? "bg-ion" : "bg-ember")} style={{ width: `${pass * 100}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-subtle">
                      {v.publishedAt ? `Published ${fmt.ago(v.publishedAt)}` : `Drafted ${fmt.ago(v.createdAt)}`}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
