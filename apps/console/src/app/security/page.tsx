import type { Metadata } from "next";
import { SecurityView } from "@/views/security/security-view";

export const metadata: Metadata = { title: "Security & access" };

export default function Page() {
  return <SecurityView />;
}
