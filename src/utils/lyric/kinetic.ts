export type KineticJumpGranularity = "auto" | "character" | "word";

export function resolveKineticJumpGranularity(value: unknown): KineticJumpGranularity {
  return value === "character" || value === "word" ? value : "auto";
}
