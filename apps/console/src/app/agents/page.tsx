import type { Metadata } from "next";
import { AgentsView } from "@/views/agents/agents-view";

export const metadata: Metadata = { title: "AI agents" };

export default function Page() {
  return <AgentsView />;
}
