import type { Metadata } from "next";
import { ConnectivityView } from "@/views/connectivity/connectivity-view";

export const metadata: Metadata = { title: "Connectivity & SIM" };

export default function Page() {
  return <ConnectivityView />;
}
