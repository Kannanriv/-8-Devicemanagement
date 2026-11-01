import type { Metadata } from "next";
import { ConfigurationView } from "@/views/configuration/configuration-view";

export const metadata: Metadata = { title: "Configuration" };

export default function Page() {
  return <ConfigurationView />;
}
