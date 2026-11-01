import type { Metadata } from "next";
import { SpecStudio } from "@/views/codecs/spec-studio";

export const metadata: Metadata = { title: "Spec Studio" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SpecStudio id={decodeURIComponent(id)} />;
}
