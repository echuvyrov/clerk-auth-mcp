import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createMcpHandler, withMcpAuth } from "@vercel/mcp-adapter";
import { getPrismaClient } from "@/src/db";
import {
  logNutritionParser,
  computeMealNutritionTotalsFromLog,
  computeNutritionTotals,
  isoDateFromTimestamp,
  type NutritionLog,
} from "@/src/nutrition-helpers";
import { z } from "zod";

const clerk = await clerkClient();

// Initialize Prisma client (will be null if DB not configured)
const prisma = getPrismaClient();
if (prisma) {
  console.log("[cocompetitorai] Prisma client initialized (database enabled)");
} else {
  console.warn(
    "[cocompetitorai] Prisma not available - using in-memory storage. Set POSTGRES_PRISMA_URL and POSTGRES_URL_NON_POOLING to enable persistence."
  );
}

// In-memory storage fallback (used when DB not available)
// Using Map to store events per user
type WorkoutEvent = {
  userId: string;
  occurredAt: string;
  sport: string;
  durationMinutes?: number;
  distanceKm?: number;
  notes?: string;
};

const workoutEventsByUser = new Map<string, Array<WorkoutEvent>>();
const nutritionEventsByUser = new Map<string, Array<NutritionLog & { userId: string }>>();

const logWorkoutParser = z.object({
  occurredAt: z.string(),
  sport: z.string(),
  durationMinutes: z.number().optional(),
  distanceKm: z.number().optional(),
  notes: z.string().optional(),
});

const getSummaryParser = z.object({
  date: z.string().optional(),
});

// Tool context type - matches the MCP adapter's RequestHandlerExtra type

const handler = createMcpHandler((server) => {
  // Existing tools
  server.tool(
    "get-clerk-user-data",
    "Gets data about the Clerk user that authorized this request",
    {},
    async (_, { authInfo }) => {
      const userId = authInfo?.extra?.userId as string;
      const userData = await clerk.users.getUser(userId);

      return {
        content: [{ type: "text", text: JSON.stringify(userData) }],
      };
    }
  );

  server.tool(
    "echo-user-id",
    "Echoes back the user ID from the authenticated request with an ACK message",
    {},
    async (_, context) => {
      // Debug: Log what we're receiving
      console.log("[echo-user-id] args:", _);
      console.log("[echo-user-id] context:", JSON.stringify(context));
      console.log("[echo-user-id] context type:", typeof context);
      console.log("[echo-user-id] context keys:", context ? Object.keys(context) : "context is null/undefined");
      
      const authInfo = context?.authInfo;
      const userId = authInfo?.extra?.userId as string;
      return {
        content: [{ type: "text", text: `ACK User: ${userId}` }],
      };
    }
  );

  // Widget tools (UI surfaces)
  server.tool(
    "cocompetitorai-dashboard",
    "Open training dashboard widget",
    {
      type: "object",
      properties: {
        focusDate: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD) to focus the dashboard.",
        },
      },
      required: [],
    },
    async (_args) => {
      return {
        content: [{ type: "text", text: "Opened training dashboard." }],
      };
    }
  );

  server.tool(
    "cocompetitorai-workout",
    "Open workout session tracker widget",
    {
      type: "object",
      properties: {
        focusDate: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD) to focus the workout tracker.",
        },
      },
      required: [],
    },
    async (_args) => {
      return {
        content: [{ type: "text", text: "Opened workout session tracker." }],
      };
    }
  );

  server.tool(
    "cocompetitorai-nutrition",
    "Open nutrition tracker widget",
    {
      type: "object",
      properties: {
        focusDate: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD) to focus the nutrition tracker.",
        },
      },
      required: [],
    },
    async (_args) => {
      return {
        content: [{ type: "text", text: "Opened nutrition tracker." }],
      };
    }
  );

  // Tracking tools
  server.tool(
    "log-workout",
    "Log a workout session",
    {
      type: "object",
      properties: {
        occurredAt: {
          type: "string",
          description: "ISO timestamp (e.g. 2025-12-18T15:04:05Z).",
        },
        sport: {
          type: "string",
          description: 'Sport/category, e.g. "run", "bike", "lift", "swim".',
        },
        durationMinutes: { type: "number" },
        distanceKm: { type: "number" },
        notes: { type: "string" },
      },
      required: ["occurredAt", "sport"],
    },
    async (args, context) => {
      // Handle case where context might be undefined (when tool has parameters)
      if (!context || !context.authInfo) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const { authInfo } = context;
      const userId = authInfo.extra?.userId as string;
      const payload = logWorkoutParser.parse(args);

      // Note: No WorkoutLog table in schema - using in-memory storage only
      const userWorkouts = workoutEventsByUser.get(userId) || [];
      userWorkouts.push({ userId, ...payload });
      workoutEventsByUser.set(userId, userWorkouts);
      console.log("[cocompetitorai] log-workout (in-memory)", { userId, ...payload });

      return {
        content: [
          {
            type: "text",
            text: "Workout logged (in-memory only - no database table configured).",
          },
        ],
      };
    }
  );

  server.tool(
    "log-nutrition",
    "Log nutrition / meal. Requires protein/carbs/fat grams + sodium mg per item. Saturated fat + vitamins are optional.",
    {
      type: "object",
      properties: {
        occurredAt: {
          type: "string",
          description: "ISO timestamp (e.g. 2025-12-18T12:00:00Z).",
        },
        mealType: {
          type: "string",
          description: 'e.g. "breakfast", "lunch", "dinner", "snack".',
        },
        calories: { type: "number", description: "Optional calories for the meal." },
        proteinGrams: {
          type: "number",
          description: "Protein in grams for the meal (required).",
        },
        carbsGrams: {
          type: "number",
          description: "Carbohydrates in grams for the meal (required).",
        },
        fatGrams: {
          type: "number",
          description: "Fat in grams for the meal (required).",
        },
        sodiumMg: {
          type: "number",
          description: "Sodium in milligrams for the meal (required).",
        },
        saturatedFatGrams: {
          type: "number",
          description: "Optional saturated fat in grams for the meal.",
        },
        vitamins: {
          type: "array",
          description: "Optional vitamins/micros list (name + amount + unit).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: 'e.g. "Vitamin C".' },
              amount: { type: "number", description: "Amount (numeric)." },
              unit: { type: "string", description: 'Unit, e.g. "mg", "mcg", "IU".' },
            },
            required: ["name", "amount", "unit"],
          },
        },
        items: {
          type: "array",
          description:
            "Optional per-item breakdown. If provided, items may include macros and sodium; totals still come from the top-level fields.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string" },
              calories: { type: "number" },
              proteinGrams: { type: "number" },
              carbsGrams: { type: "number" },
              fatGrams: { type: "number" },
              sodiumMg: { type: "number" },
              saturatedFatGrams: { type: "number" },
            },
            required: ["name"],
          },
        },
        notes: { type: "string" },
      },
      required: ["occurredAt", "proteinGrams", "carbsGrams", "fatGrams", "sodiumMg"],
    },
    // re-push to the server
    async (args, contextOrAuthInfo) => {
      // Debug: Log what we're receiving
      console.log("[log-nutrition] args:", JSON.stringify(args));
      console.log("[log-nutrition] second param:", contextOrAuthInfo);
      console.log("[log-nutrition] second param type:", typeof contextOrAuthInfo);
      console.log("[log-nutrition] second param keys:", contextOrAuthInfo ? Object.keys(contextOrAuthInfo) : "null/undefined");
      
      // Try to extract authInfo - it might be passed directly or nested in context
      let authInfo: { extra?: { userId?: string } } | undefined;
      if (contextOrAuthInfo && 'authInfo' in contextOrAuthInfo) {
        authInfo = (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } }).authInfo;
      } else if (contextOrAuthInfo && 'extra' in contextOrAuthInfo) {
        // Maybe authInfo is passed directly?
        authInfo = contextOrAuthInfo as { extra?: { userId?: string } };
      }
      
      if (!authInfo) {
        console.error("[log-nutrition] Missing authInfo. Received:", contextOrAuthInfo);
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra?.userId as string;
      const payload = logNutritionParser.parse(args);
      // const mealTotals = computeMealNutritionTotalsFromLog(payload); // Available if needed for response

      // Extract date string from occurredAt (FoodLog.feeding_date is String, not DateTime)
      const feedingDate = payload.occurredAt.slice(0, 10); // YYYY-MM-DD

      // Insert into database if available, otherwise use in-memory storage
      if (prisma) {
        try {
          if (Array.isArray(payload.items) && payload.items.length > 0) {
            // Insert multiple FoodLog records (one per item)
            const items = payload.items;
            const foodLogs = await Promise.all(
              items.map((item) => {
                return prisma!.foodLog.create({
                  data: {
                    user_id: userId,
                    food_name: item.name,
                    food_qty: item.quantity ?? 1,
                    protein_grams: item.proteinGrams ?? payload.proteinGrams,
                    fat_grams: item.fatGrams ?? payload.fatGrams,
                    carbs_grams: item.carbsGrams ?? payload.carbsGrams,
                    kkcals: item.calories ?? payload.calories ?? 0,
                    feeding_date: feedingDate,
                  },
                });
              })
            );
            console.log(
              `[cocompetitorai] log-nutrition (DB) - inserted ${foodLogs.length} records`,
              { feeding_date: feedingDate }
            );
          } else {
            // Insert single FoodLog record with meal totals
            const dbRecord = await prisma.foodLog.create({
              data: {
                user_id: userId,
                food_name: payload.mealType ?? "Meal",
                food_qty: 1,
                protein_grams: payload.proteinGrams,
                fat_grams: payload.fatGrams,
                carbs_grams: payload.carbsGrams,
                kkcals: payload.calories ?? 0,
                feeding_date: feedingDate,
              },
            });
            console.log(`[cocompetitorai] log-nutrition (DB) - inserted 1 record`, {
              id: dbRecord.id,
              feeding_date: feedingDate,
            });
          }
        } catch (dbError) {
          console.error(`[cocompetitorai] Failed to insert nutrition log:`, dbError);
          // Fall through to in-memory storage
          const userNutrition = nutritionEventsByUser.get(userId) || [];
          userNutrition.push({ ...payload, userId });
          nutritionEventsByUser.set(userId, userNutrition);
        }
      } else {
        const userNutrition = nutritionEventsByUser.get(userId) || [];
        userNutrition.push({ ...payload, userId });
        nutritionEventsByUser.set(userId, userNutrition);
        console.log(`[cocompetitorai] log-nutrition (in-memory)`, { userId, ...payload });
      }

      return {
        content: [{ type: "text", text: "Nutrition logged." }],
      };
    }
  );

  server.tool(
    "get-daily-summary",
    "Get daily training + nutrition summary",
    {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "ISO date (YYYY-MM-DD). Defaults to today.",
        },
      },
      required: [],
    },
    async (args, contextOrAuthInfo) => {
      // Try to extract authInfo - it might be passed directly or nested in context
      let authInfo: { extra?: { userId?: string } } | undefined;
      if (contextOrAuthInfo && 'authInfo' in contextOrAuthInfo) {
        authInfo = (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } }).authInfo;
      } else if (contextOrAuthInfo && 'extra' in contextOrAuthInfo) {
        authInfo = contextOrAuthInfo as { extra?: { userId?: string } };
      }
      
      if (!authInfo) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra?.userId as string;
      const parsedArgs = getSummaryParser.parse(args);
      const date =
        parsedArgs.date ?? new Date().toISOString().slice(0, 10); /* YYYY-MM-DD */

      let dailyWorkouts: WorkoutEvent[] = [];
      let dailyMeals: NutritionLog[] = [];
      let persisted = false;

      if (prisma) {
        try {
          // Query FoodLog from database (feeding_date is String, not DateTime)
          const dbFoodLogs = await prisma.foodLog.findMany({
            where: {
              feeding_date: date,
              user_id: userId,
            },
            orderBy: { createdAt: "asc" },
          });

          // Aggregate FoodLog records into meal-like NutritionLog format
          type AggregateType = {
            proteinGrams: number;
            carbsGrams: number;
            fatGrams: number;
            calories: number;
            itemCount: number;
          };
          const initial: AggregateType = {
            proteinGrams: 0,
            carbsGrams: 0,
            fatGrams: 0,
            calories: 0,
            itemCount: 0,
          };
          const aggregated = dbFoodLogs.reduce(
            (
              acc: AggregateType,
              log: {
                protein_grams: number;
                carbs_grams: number;
                fat_grams: number;
                kkcals: number;
              }
            ) => {
              acc.proteinGrams += log.protein_grams;
              acc.carbsGrams += log.carbs_grams;
              acc.fatGrams += log.fat_grams;
              acc.calories = acc.calories + log.kkcals;
              acc.itemCount += 1;
              return acc;
            },
            initial
          );

          // Create a single NutritionLog entry representing all foods for the day
          if (aggregated.itemCount > 0) {
            dailyMeals = [
              {
                occurredAt: `${date}T12:00:00Z`,
                mealType: undefined,
                calories: aggregated.calories > 0 ? aggregated.calories : undefined,
                proteinGrams: aggregated.proteinGrams,
                carbsGrams: aggregated.carbsGrams,
                fatGrams: aggregated.fatGrams,
                sodiumMg: 0, // Not stored in FoodLog schema
                saturatedFatGrams: undefined,
                vitamins: undefined,
                items: undefined,
                notes: undefined,
              },
            ];
          }

          // Workouts: No WorkoutLog table in schema - skip DB query
          dailyWorkouts = [];

          persisted = true;
        } catch (dbError) {
          console.error(
            "[cocompetitorai] Failed to query database, falling back to in-memory:",
            dbError
          );
          // Fall through to in-memory
        }
      }

      // Fallback to in-memory if DB not available or query failed
      if (!persisted) {
        const userWorkouts = workoutEventsByUser.get(userId) || [];
        dailyWorkouts = userWorkouts.filter((w) => {
          const d = isoDateFromTimestamp(w.occurredAt);
          return d === date;
        });

        const userNutrition = nutritionEventsByUser.get(userId) || [];
        dailyMeals = userNutrition.filter((n) => {
          const d = isoDateFromTimestamp(n.occurredAt);
          return d === date;
        });
      }

      const workoutMinutes = dailyWorkouts.reduce(
        (sum: number, w: WorkoutEvent) => sum + (typeof w.durationMinutes === "number" ? w.durationMinutes : 0),
        0
      );
      const nutritionTotals = computeNutritionTotals(dailyMeals);

      return {
        content: [
          {
            type: "text",
            text: `Daily summary for ${date}: ${dailyWorkouts.length} workouts (${workoutMinutes} min), ${nutritionTotals.meals} meals (${nutritionTotals.macros.proteinGrams}g protein, ${nutritionTotals.macros.carbsGrams}g carbs, ${nutritionTotals.macros.fatGrams}g fat).`,
          },
        ],
      };
    }
  );

  server.tool(
    "get-week-summary",
    "Get weekly training + nutrition summary",
    {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "ISO date (YYYY-MM-DD). Defaults to today.",
        },
      },
      required: [],
    },
    async (args, contextOrAuthInfo) => {
      // Try to extract authInfo - it might be passed directly or nested in context
      let authInfo: { extra?: { userId?: string } } | undefined;
      if (contextOrAuthInfo && 'authInfo' in contextOrAuthInfo) {
        authInfo = (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } }).authInfo;
      } else if (contextOrAuthInfo && 'extra' in contextOrAuthInfo) {
        authInfo = contextOrAuthInfo as { extra?: { userId?: string } };
      }
      
      if (!authInfo) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra?.userId as string;
      // const parsedArgs = getSummaryParser.parse(args); // Available if needed
      const today = new Date().toISOString().slice(0, 10);

      // Week ending today = last 7 days
      const weekDates: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        weekDates.push(d.toISOString().slice(0, 10));
      }

      let weeklyWorkouts: WorkoutEvent[] = [];
      let weeklyMeals: NutritionLog[] = [];
      let persisted = false;

      if (prisma) {
        try {
          // Query FoodLog from database for last 7 days
          const dbFoodLogs = await prisma.foodLog.findMany({
            where: {
              feeding_date: { in: weekDates },
              user_id: userId,
            },
            orderBy: { createdAt: "asc" },
          });

          // Aggregate FoodLog records by date
          const dailyAggregates = new Map<
            string,
            {
              proteinGrams: number;
              carbsGrams: number;
              fatGrams: number;
              calories: number;
              itemCount: number;
            }
          >();

          for (const log of dbFoodLogs) {
            const existing = dailyAggregates.get(log.feeding_date) ?? {
              proteinGrams: 0,
              carbsGrams: 0,
              fatGrams: 0,
              calories: 0,
              itemCount: 0,
            };
            existing.proteinGrams += log.protein_grams;
            existing.carbsGrams += log.carbs_grams;
            existing.fatGrams += log.fat_grams;
            existing.calories += log.kkcals;
            existing.itemCount += 1;
            dailyAggregates.set(log.feeding_date, existing);
          }

          // Convert to NutritionLog format
          weeklyMeals = Array.from(dailyAggregates.entries()).map(([date, agg]) => ({
            occurredAt: `${date}T12:00:00Z`,
            mealType: undefined,
            calories: agg.calories > 0 ? agg.calories : undefined,
            proteinGrams: agg.proteinGrams,
            carbsGrams: agg.carbsGrams,
            fatGrams: agg.fatGrams,
            sodiumMg: 0, // Not stored in FoodLog schema
            saturatedFatGrams: undefined,
            vitamins: undefined,
            items: undefined,
            notes: undefined,
          }));

          // Workouts: No WorkoutLog table in schema - skip DB query
          weeklyWorkouts = [];

          persisted = true;
        } catch (dbError) {
          console.error(
            "[cocompetitorai] Failed to query database, falling back to in-memory:",
            dbError
          );
        }
      }

      if (!persisted) {
        weeklyWorkouts = workoutEventsByUser.get(userId) || [];
        weeklyMeals = nutritionEventsByUser.get(userId) || [];
      }

      const workoutMinutes = weeklyWorkouts.reduce(
        (sum: number, w: WorkoutEvent) => sum + (typeof w.durationMinutes === "number" ? w.durationMinutes : 0),
        0
      );
      const nutritionTotals = computeNutritionTotals(weeklyMeals);

      return {
        content: [
          {
            type: "text",
            text: `Weekly summary (ending ${today}): ${weeklyWorkouts.length} workouts (${workoutMinutes} min), ${nutritionTotals.meals} meals (${nutritionTotals.macros.proteinGrams}g protein, ${nutritionTotals.macros.carbsGrams}g carbs, ${nutritionTotals.macros.fatGrams}g fat).`,
          },
        ],
      };
    }
  );
});

const authHandler = withMcpAuth(
  handler,
  async (_, token) => {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    // Note: OAuth tokens are machine tokens. Machine token usage is free
    // during our public beta period but will be subject to pricing once
    // generally available. Pricing is expected to be competitive and below
    // market averages.
    return verifyClerkToken(clerkAuth, token);
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  }
);

export { authHandler as GET, authHandler as POST };
