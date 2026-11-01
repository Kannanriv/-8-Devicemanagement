import type { Metadata } from "next";
import { ReportsView } from "@/views/reports/reports-view";

export const metadata: Metadata = { title: "Reports & analytics" };

export default function Page() {
  return <ReportsView />;
}
