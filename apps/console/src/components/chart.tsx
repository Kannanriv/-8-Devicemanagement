"use client";

import * as React from "react";
import type { EChartsCoreOption, ECharts } from "echarts/core";
import { chartPalette, useTheme, type ChartPalette } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Lazy, tree-shaken ECharts loader (only line + scatter + bar). Loaded once per tab. */
let loader: Promise<typeof import("echarts/core")> | null = null;
function loadECharts() {
  loader ??= (async () => {
    const [core, charts, components, renderers] = await Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ]);
    core.use([
      charts.LineChart,
      charts.ScatterChart,
      charts.BarChart,
      components.GridComponent,
      components.TooltipComponent,
      components.DataZoomComponent,
      components.VisualMapComponent,
      renderers.CanvasRenderer,
    ]);
    return core;
  })();
  return loader;
}

export function EChart({
  option,
  className,
  label,
  onClick,
}: {
  /** Build the option from the theme palette so charts follow light/dark. */
  option: (p: ChartPalette) => EChartsCoreOption;
  className?: string;
  label: string;
  onClick?: (params: { data?: unknown; dataIndex?: number }) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<ECharts | null>(null);
  const theme = useTheme();
  const optionRef = React.useRef(option);
  optionRef.current = option;
  const clickRef = React.useRef(onClick);
  clickRef.current = onClick;
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void loadECharts().then((echarts) => {
      if (disposed || !ref.current) return;
      const inst = echarts.init(ref.current, undefined, { renderer: "canvas" });
      chart.current = inst;
      inst.on("click", (p) => clickRef.current?.(p as { data?: unknown; dataIndex?: number }));
      ro = new ResizeObserver(() => inst.resize());
      ro.observe(ref.current);
      setReady(true);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (!ready || !chart.current) return;
    chart.current.setOption(
      { backgroundColor: "transparent", animationDuration: 600, animationEasing: "cubicOut", ...optionRef.current(chartPalette(theme)) },
      { notMerge: false, lazyUpdate: true },
    );
  });

  React.useEffect(() => {
    if (!ready || !chart.current) return;
    chart.current.setOption(
      { backgroundColor: "transparent", ...optionRef.current(chartPalette(theme)) },
      { notMerge: true },
    );
  }, [theme, ready]);

  return <div ref={ref} role="img" aria-label={label} className={cn("h-40 w-full", className)} />;
}

/** Shared tooltip styling. */
export function tooltipStyle(p: ChartPalette) {
  return {
    backgroundColor: p.raised,
    borderColor: p.line,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: p.fg, fontFamily: "inherit", fontSize: 12 },
    extraCssText: "border-radius:12px;box-shadow:0 12px 32px -12px rgba(0,0,0,.5);",
  };
}
