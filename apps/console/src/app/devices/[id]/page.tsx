import type { Metadata } from "next";
import { DeviceView } from "@/views/device/device-view";

export const metadata: Metadata = { title: "Device" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeviceView id={decodeURIComponent(id)} />;
}
