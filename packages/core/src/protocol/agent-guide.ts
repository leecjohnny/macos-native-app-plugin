export type AgentGuide = { app: string; sections: readonly string[] };
export const composeGuides = (guides: AgentGuide[]) =>
  guides.map((g) => g.sections.join("\n\n")).join("\n\n");
