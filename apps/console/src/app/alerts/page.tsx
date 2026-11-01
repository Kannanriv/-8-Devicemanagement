import type { Metadata } from "next";
import { AlertsView } from "@/views/alerts/alerts-view";

export const metadata: Metadata = { title: "Incidents & alerts" };

export default function Page() {
  return <AlertsView />;
}
