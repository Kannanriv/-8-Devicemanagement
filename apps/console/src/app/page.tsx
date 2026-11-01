import type { Metadata } from "next";
import { InboxView } from "@/views/inbox/inbox-view";

export const metadata: Metadata = { title: "Overview" };

export default function Page() {
  return <InboxView />;
}
