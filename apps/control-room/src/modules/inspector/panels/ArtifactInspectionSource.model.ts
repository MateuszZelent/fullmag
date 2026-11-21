export function artifactInspectionSourceGuidance({ loading, error, candidateCount, selectedStatus, inspectionState }: {
  loading: boolean;
  error: string | null;
  candidateCount: number;
  selectedStatus: string | null;
  inspectionState?: "retained" | "absent" | "unknown";
}): string {
  if (error) return "Execution information is unavailable. Check the diagnostic below or open Results for a saved run.";
  if (loading) return "Loading executions. Existing display settings remain unchanged.";
  if (candidateCount === 0) return "No execution is retained in this session. Open Results and choose Saved to inspect an existing field. A solve definition or visible mesh alone does not contain field values.";
  if (!selectedStatus) return "Select the antenna execution whose field you want to inspect. This does not start a simulation.";
  if (inspectionState === "absent") return "This execution has no retained field in the current session. Open Results → Saved to choose a stored result. No new computation is needed to inspect a saved field.";
  if (inspectionState === "unknown") return "Retained field availability is not confirmed. Field requests are paused; refresh the execution information or open Results → Saved.";
  if (selectedStatus === "failed" || selectedStatus === "cancelled") return "This execution did not complete successfully. Check its diagnostic or choose another result; completion and field availability are checked separately.";
  if (selectedStatus === "completed" || selectedStatus === "succeeded") return "Execution completed. Choose an available Quantity source below, then enable Vectors to inspect a vector field. Only verified field data on a compatible sampling mesh can be displayed.";
  return "The selected execution has not completed. Field values appear only after they are published; mesh visibility does not indicate a computed field.";
}
