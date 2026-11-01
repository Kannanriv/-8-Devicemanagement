"use client";

import { AuditTable } from "@/views/audit/audit-table";
import { useAudit } from "@/lib/api";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";

export function AuditTab({ id }: { id: string }) {
  const audit = useAudit({ target: `device:${id}`, limit: 200 });
  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Audit</PanelTitle>
          <PanelDescription>Who changed what on this device</PanelDescription>
        </div>
      </PanelHeader>
      <AuditTable query={audit} hideTarget />
    </Panel>
  );
}
