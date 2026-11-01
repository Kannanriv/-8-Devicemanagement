import type { Metadata } from "next";
import { AssetView } from "@/views/assets/asset-view";

export const metadata: Metadata = { title: "Asset" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssetView id={decodeURIComponent(id)} />;
}
