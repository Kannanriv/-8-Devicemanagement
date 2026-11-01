import type { Metadata } from "next";
import { FirmwareView } from "@/views/ota/firmware-view";

export const metadata: Metadata = { title: "Firmware library" };

export default function Page() {
  return <FirmwareView />;
}
