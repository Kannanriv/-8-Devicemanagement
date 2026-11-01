import type { Metadata } from "next";
import { SpecImportsView } from "@/views/spec-imports/spec-imports-view";

export const metadata: Metadata = { title: "Spec imports" };

export default function Page() {
  return <SpecImportsView />;
}
