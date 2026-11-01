import type { Metadata } from "next";
import { CodecsView } from "@/views/codecs/codecs-view";

export const metadata: Metadata = { title: "Codec catalog" };

export default function Page() {
  return <CodecsView />;
}
