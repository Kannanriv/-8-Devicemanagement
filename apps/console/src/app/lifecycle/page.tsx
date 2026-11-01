import type { Metadata } from "next";
import { LifecycleView } from "@/views/lifecycle/lifecycle-view";

export const metadata: Metadata = { title: "Lifecycle" };

export default function Page() {
  return <LifecycleView />;
}
