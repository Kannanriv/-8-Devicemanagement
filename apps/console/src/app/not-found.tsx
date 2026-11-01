import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";

export default function NotFound() {
  return (
    <Panel>
      <Empty
        icon={Compass}
        title="This page doesn’t exist"
        action={
          <Button variant="primary" size="sm" asChild>
            <Link href="/">Back to Overview</Link>
          </Button>
        }
      >
        Check the address, or press ⌘K to search devices, codecs and pages.
      </Empty>
    </Panel>
  );
}
