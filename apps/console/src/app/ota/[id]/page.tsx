import type { Metadata } from "next";
import { CampaignView } from "@/views/ota/campaign-view";

export const metadata: Metadata = { title: "OTA campaign" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignView id={decodeURIComponent(id)} />;
}
