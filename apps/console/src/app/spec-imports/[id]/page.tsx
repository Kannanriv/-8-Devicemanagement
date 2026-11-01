import type { Metadata } from "next";
import { ReviewView } from "@/views/spec-imports/review-view";

export const metadata: Metadata = { title: "Spec review" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewView id={decodeURIComponent(id)} />;
}
