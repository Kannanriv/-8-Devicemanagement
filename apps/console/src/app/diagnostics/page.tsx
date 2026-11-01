import type { Metadata } from "next";
import { DiagnosticsView } from "@/views/diagnostics/diagnostics-view";

export const metadata: Metadata = { title: "Diagnostics & commands" };

export default function Page() {
  return <DiagnosticsView />;
}
