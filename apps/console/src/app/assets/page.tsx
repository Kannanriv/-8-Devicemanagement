import type { Metadata } from "next";
import { AssetsView } from "@/views/assets/assets-view";

export const metadata: Metadata = { title: "Assets" };

export default function Page() {
  return <AssetsView />;
}
