import type { Metadata } from "next";
import { OtaView } from "@/views/ota/ota-view";

export const metadata: Metadata = { title: "Firmware & OTA" };

export default function Page() {
  return <OtaView />;
}
