"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShellProvider } from "@/components/shell/shell-context";
import { isOffline } from "@/lib/api";
import { useLiveConnection } from "@/lib/live";
import { useTheme } from "@/lib/theme";

function LiveConnection() {
  useLiveConnection();
  return null;
}

function ThemedToaster() {
  const theme = useTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!rounded-[18px] !border-line-strong !bg-raised !text-fg !shadow-float !font-sans",
          description: "!text-muted",
        },
      }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // Don't hammer a stopped API; keep polling to auto-recover.
            retry: (count, err) => (isOffline(err) ? count < 1 : count < 2),
            retryDelay: (n) => Math.min(1_000 * 2 ** n, 8_000),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={300}>
        <ShellProvider>
          <LiveConnection />
          {children}
          <ThemedToaster />
        </ShellProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
