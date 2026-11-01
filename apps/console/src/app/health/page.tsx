import type { Metadata } from "next";
import { HealthView } from "@/views/health/health-view";

export const metadata: Metadata = { title: "Health & monitoring" };

export default function Page() {
  return <HealthView />;
}
