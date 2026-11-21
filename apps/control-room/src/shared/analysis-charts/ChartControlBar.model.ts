interface ChartRangeOption {
  label: string;
  value: string;
}

export function chartRangeOptions(
  timeRangeSupported = true,
  fixedRangeAvailable = false,
): readonly ChartRangeOption[] {
  return [
    { label: "Follow", value: "follow" },
    { label: "Last 100 points", value: "tailRows:100" },
    { label: "Last 160 points", value: "tailRows:160" },
    { label: "Last 400 points", value: "tailRows:400" },
    ...(timeRangeSupported
      ? [
          { label: "Last 1 ns", value: "tailTime:1e-9" },
          { label: "Last 10 ns", value: "tailTime:10e-9" },
        ]
      : []),
    ...(fixedRangeAvailable ? [{ label: "Fixed range", value: "fixed" }] : []),
    { label: "Full (decimated)", value: "fullDecimated" },
  ];
}
