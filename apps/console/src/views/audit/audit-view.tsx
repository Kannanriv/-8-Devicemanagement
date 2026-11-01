"use client";

import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { useAudit } from "@/lib/api";
import { AuditTable } from "./audit-table";

function useDebounced(v: string, ms = 300) {
  const [d, setD] = React.useState(v);
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function AuditView() {
  const [target, setTarget] = React.useState("");
  const [actor, setActor] = React.useState("");
  const [limit, setLimit] = React.useState("200");
  const t = useDebounced(target.trim());
  const a = useDebounced(actor.trim());
  const audit = useAudit({ target: t || undefined, actor: a || undefined, limit: Number(limit) });
  return (
    <>
      <PageHeader title="Audit log" description="Every change by people, agents and the platform, in order." />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_160px]">
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target, e.g. device:abc123" aria-label="Filter by target" />
        <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Actor, e.g. agent:rollout-guardian" aria-label="Filter by actor" />
        <NativeSelect value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Rows">
          <option value="100">Last 100</option>
          <option value="200">Last 200</option>
          <option value="500">Last 500</option>
        </NativeSelect>
      </div>
      <Panel className="overflow-hidden pt-2">
        <AuditTable query={audit} />
      </Panel>
    </>
  );
}
