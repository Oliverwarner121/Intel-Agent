import { briefingDefinitionSchema, type BriefingDefinition } from "@/briefings/briefing.types";
import { morningBriefing } from "@/briefings/definitions/morning-briefing";

/** Validates definitions and rejects duplicate IDs or Cron routes. */
export function createRegistry(inputs: readonly unknown[]): ReadonlyMap<string, BriefingDefinition> {
  const registry = new Map<string, BriefingDefinition>();
  const routes = new Set<string>();
  for (const input of inputs) {
    const definition = briefingDefinitionSchema.parse(input);
    if (registry.has(definition.id)) throw new Error(`Duplicate briefing ID: ${definition.id}`);
    if (routes.has(definition.schedule.route)) {
      throw new Error(`Duplicate briefing route: ${definition.schedule.route}`);
    }
    registry.set(definition.id, definition);
    routes.add(definition.schedule.route);
  }
  return registry;
}

const registry = createRegistry([morningBriefing]);

export function getBriefingDefinition(id: string): BriefingDefinition | undefined {
  return registry.get(id);
}

export function listBriefingDefinitions(): BriefingDefinition[] {
  return [...registry.values()];
}
