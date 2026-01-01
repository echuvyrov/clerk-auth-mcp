import { z } from "zod";

export const nutritionFactParser = z.object({
  label: z.string(),
  value: z.string(),
});

export const vitaminParser = z.object({
  name: z.string(),
  amount: z.number().nonnegative(),
  unit: z.string(),
});

export const nutritionItemParser = z.object({
  name: z.string(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  calories: z.number().optional(),
  proteinGrams: z.number().nonnegative().optional(),
  carbsGrams: z.number().nonnegative().optional(),
  fatGrams: z.number().nonnegative().optional(),
  sodiumMg: z.number().nonnegative().optional(),
  saturatedFatGrams: z.number().nonnegative().optional(),
  vitamins: z.array(vitaminParser).optional(),
  nutritionFacts: z.array(nutritionFactParser).optional(),
});

export const logNutritionParser = z.object({
  occurredAt: z.string(),
  mealType: z.string().optional(),
  calories: z.number().nonnegative().optional(),
  proteinGrams: z.number().nonnegative(),
  carbsGrams: z.number().nonnegative(),
  fatGrams: z.number().nonnegative(),
  sodiumMg: z.number().nonnegative(),
  saturatedFatGrams: z.number().nonnegative().optional(),
  vitamins: z.array(vitaminParser).optional(),
  items: z.array(nutritionItemParser).optional(),
  notes: z.string().optional(),
});

export type NutritionLog = z.infer<typeof logNutritionParser>;
export type NutritionItem = z.infer<typeof nutritionItemParser>;

export function computeMealNutritionTotalsFromLog(log: NutritionLog) {
  const vitamins = Array.isArray(log.vitamins) ? [...log.vitamins] : [];
  vitamins.sort((a, b) => a.name.localeCompare(b.name));

  return {
    calories: typeof log.calories === "number" ? log.calories : null,
    macros: {
      proteinGrams: log.proteinGrams,
      carbsGrams: log.carbsGrams,
      fatGrams: log.fatGrams,
    },
    sodiumMg: log.sodiumMg,
    saturatedFatGrams:
      typeof log.saturatedFatGrams === "number" ? log.saturatedFatGrams : null,
    vitamins,
  };
}

export function computeNutritionTotals(logs: NutritionLog[]) {
  let meals = 0;
  let caloriesSum: number | null = null;
  let proteinGrams = 0;
  let carbsGrams = 0;
  let fatGrams = 0;
  let sodiumMg = 0;
  let saturatedFatGrams: number | null = null;
  const vitaminTotals = new Map<string, { name: string; amount: number; unit: string }>();

  for (const log of logs) {
    meals += 1;
    if (typeof log.calories === "number") {
      caloriesSum = (caloriesSum ?? 0) + log.calories;
    }
    proteinGrams += log.proteinGrams;
    carbsGrams += log.carbsGrams;
    fatGrams += log.fatGrams;
    sodiumMg += log.sodiumMg;
    if (typeof log.saturatedFatGrams === "number") {
      saturatedFatGrams = (saturatedFatGrams ?? 0) + log.saturatedFatGrams;
    }
    if (Array.isArray(log.vitamins)) {
      for (const v of log.vitamins) {
        const key = `${v.name}__${v.unit}`;
        const existing = vitaminTotals.get(key);
        if (existing) {
          existing.amount += v.amount;
        } else {
          vitaminTotals.set(key, { name: v.name, amount: v.amount, unit: v.unit });
        }
      }
    }
  }

  const vitamins = Array.from(vitaminTotals.values());
  vitamins.sort((a, b) => a.name.localeCompare(b.name));

  return {
    meals,
    calories: caloriesSum,
    macros: { proteinGrams, carbsGrams, fatGrams },
    sodiumMg,
    saturatedFatGrams,
    vitamins,
  };
}

export function isoDateFromTimestamp(ts: string): string | null {
  // Accept YYYY-MM-DD..., return the date prefix if present.
  if (typeof ts !== "string" || ts.length < 10) return null;
  return ts.slice(0, 10);
}

