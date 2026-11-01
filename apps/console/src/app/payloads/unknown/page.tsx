import type { Metadata } from "next";
import { UnknownView } from "@/views/payloads/unknown-view";

export const metadata: Metadata = { title: "Unknown payloads" };

export default function Page() {
  return <UnknownView />;
}
