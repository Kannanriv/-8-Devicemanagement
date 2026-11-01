import type { Metadata } from "next";
import { IntegrationsView } from "@/views/integrations/integrations-view";

export const metadata: Metadata = { title: "Integrations & automation" };

export default function Page() {
  return <IntegrationsView />;
}
