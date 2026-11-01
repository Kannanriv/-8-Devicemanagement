import { Suspense } from "react";
import type { Metadata } from "next";
import { InventoryView } from "@/views/inventory/inventory-view";

export const metadata: Metadata = { title: "Inventory" };

export default function Page() {
  return (
    <Suspense>
      <InventoryView />
    </Suspense>
  );
}
