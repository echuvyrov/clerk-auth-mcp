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
      const authInfo = context?.authInfo;
      const userId = authInfo?.extra?.userId as string;
      return {
        content: [{ type: "text", text: `ACK User: ${userId}` }],
      };
    }
  );

  // Test tool with a simple parameter to verify MCP Inspector shows input fields
  // IMPORTANT: Vercel MCP adapter expects Zod schemas, not JSON Schema!
  server.tool(
    "echo-user-id-test",
    "Test tool with a simple parameter to verify schema display",
    {
      testMessage: z.string().describe("A test message to echo back along with the user ID"),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; testMessage?: string; [key: string]: unknown };
      const authInfo = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
      const testMessage = argsWithAuth.testMessage || "No message provided";
      
      return {
        content: [{ type: "text", text: `ACK User: ${userId}, Message: ${testMessage}` }],
      };
    }
  );

  // Test tool with inline schema to verify MCP inspector shows input fields
  // IMPORTANT: Vercel MCP adapter expects Zod schemas, not JSON Schema!
  server.tool(
    "test-schema",
    "Test tool to verify schema display in MCP inspector",
    {
      testField: z.string().describe("A test field to verify schema display"),
      testNumber: z.number().optional().describe("A test number field"),
    },
    async (args) => {
      return {
        content: [{ type: "text", text: `Test received: ${JSON.stringify(args)}` }],
      };
    }
  );

  // Minimal test tool matching the exact format from mcp-handler CLI template
  server.tool(
    "roll-dice",
    "Rolls an N-sided die",
    {
      sides: z.number().int().min(2),
    },
    async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return {
        content: [{ type: "text", text: `🎲 You rolled a ${value}!` }],
      };
    }
  );

  // Widget tools (UI surfaces)
  server.tool(
    "cocompetitorai-dashboard",
    "Open training dashboard widget",
    {
      focusDate: z.string().optional().describe("Optional ISO date (YYYY-MM-DD) to focus the dashboard."),
    },
    async (_args: Record<string, unknown>) => {
      return {
        content: [{ type: "text", text: "Opened training dashboard." }],
      };
    }
  );

  server.tool(
    "cocompetitorai-workout",
    "Open workout session tracker widget",
    {
      focusDate: z.string().optional().describe("Optional ISO date (YYYY-MM-DD) to focus the workout tracker."),
    },
    async (_args: Record<string, unknown>) => {
      return {
        content: [{ type: "text", text: "Opened workout session tracker." }],
      };
    }
  );

  server.tool(
    "cocompetitorai-nutrition",
    "Open nutrition tracker widget",
    {
      focusDate: z.string().optional().describe("Optional ISO date (YYYY-MM-DD) to focus the nutrition tracker."),
    },
    async (_args: Record<string, unknown>) => {
      return {
        content: [{ type: "text", text: "Opened nutrition tracker." }],
      };
    }
  );

  // Tracking tools
  // IMPORTANT: Vercel MCP adapter expects Zod schemas, not JSON Schema!
  server.tool(
    "log-workout",
    "Log a workout session",
    {
      occurredAt: z.string().describe("ISO timestamp (e.g. 2025-12-18T15:04:05Z)."),
      sport: z.string().describe('Sport/category, e.g. "run", "bike", "lift", "swim".'),
      durationMinutes: z.number().optional(),
      distanceKm: z.number().optional(),
      notes: z.string().optional(),
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
      // IMPORTANT: Vercel MCP adapter expects Zod schemas, not JSON Schema!
      occurredAt: z.string().describe("ISO timestamp (e.g. 2025-12-18T12:00:00Z)."),
      mealType: z.string().optional().describe('e.g. "breakfast", "lunch", "dinner", "snack".'),
      calories: z.number().optional().describe("Optional calories for the meal."),
      proteinGrams: z.number().describe("Protein in grams for the meal (required)."),
      carbsGrams: z.number().describe("Carbohydrates in grams for the meal (required)."),
      fatGrams: z.number().describe("Fat in grams for the meal (required)."),
      sodiumMg: z.number().describe("Sodium in milligrams for the meal (required)."),
      saturatedFatGrams: z.number().optional().describe("Optional saturated fat in grams for the meal."),
      vitamins: z.array(
        z.object({
          name: z.string().describe('e.g. "Vitamin C".'),
          amount: z.number().describe("Amount (numeric)."),
          unit: z.string().describe('Unit, e.g. "mg", "mcg", "IU".'),
        })
      ).optional().describe("Optional vitamins/micros list (name + amount + unit)."),
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().optional(),
          unit: z.string().optional(),
          calories: z.number().optional(),
          proteinGrams: z.number().optional().describe("Optional protein in grams for this item."),
          carbsGrams: z.number().optional().describe("Optional carbohydrates in grams for this item."),
          fatGrams: z.number().optional().describe("Optional fat in grams for this item."),
          sodiumMg: z.number().optional().describe("Optional sodium in milligrams for this item."),
          saturatedFatGrams: z.number().optional().describe("Optional saturated fat in grams."),
          vitamins: z.array(
            z.object({
              name: z.string().describe('e.g. "Vitamin C".'),
              amount: z.number().describe("Amount (numeric)."),
              unit: z.string().describe('Unit, e.g. "mg", "mcg", "IU".'),
            })
          ).optional().describe("Optional vitamins/micros list (name + amount + unit)."),
          nutritionFacts: z.array(
            z.object({
              label: z.string(),
              value: z.string(),
            })
          ).optional(),
        })
      ).optional().describe("Optional per-item breakdown. If provided, items may include macros and sodium; totals still come from the top-level fields."),
      notes: z.string().optional(),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args, not as a second parameter
      // Extract authInfo from args first, fallback to second parameter for tools without params
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; [key: string]: unknown };
      const authInfo = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
      
      // Parse only the actual nutrition parameters (exclude authInfo, signal, etc.)
      const nutritionArgs = { ...argsWithAuth };
      delete nutritionArgs.authInfo;
      delete nutritionArgs.signal;
      delete nutritionArgs.requestId;
      delete nutritionArgs.requestInfo;
      delete nutritionArgs._meta;
      
      const payload = logNutritionParser.parse(nutritionArgs);
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
              `[cocompetitorai] log-nutrition (DB) - inserted ${foodLogs.length} records for date ${feedingDate}`
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
            console.log(`[cocompetitorai] log-nutrition (DB) - inserted 1 record for date ${feedingDate} (id: ${dbRecord.id})`);
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
      date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args, not as a second parameter
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; [key: string]: unknown };
      const authInfo = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
      
      // Parse only the actual summary parameters (exclude authInfo, signal, etc.)
      const summaryArgs = { ...argsWithAuth };
      delete summaryArgs.authInfo;
      delete summaryArgs.signal;
      delete summaryArgs.requestId;
      delete summaryArgs.requestInfo;
      delete summaryArgs._meta;
      
      const parsedArgs = getSummaryParser.parse(summaryArgs);
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
            `[cocompetitorai] Failed to query database for date ${date}, falling back to in-memory:`,
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
      date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args, not as a second parameter
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; [key: string]: unknown };
      const authInfoRaw = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      // Type guard to ensure authInfo has the expected structure
      const authInfo = authInfoRaw && 'extra' in authInfoRaw ? authInfoRaw as { extra?: { userId?: string } } : undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
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
            `[cocompetitorai] Failed to query database for week ending ${today}, falling back to in-memory:`,
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

  server.tool(
    "get-nutrition-chart",
    "Get today's nutrition data formatted for chart visualization. Returns structured data including individual food items, daily totals, and macro breakdown percentages.",
    {
      date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args, not as a second parameter
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; [key: string]: unknown };
      const authInfo = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
      
      // Parse only the actual tool parameters (exclude authInfo, signal, etc.)
      const chartArgs = { ...argsWithAuth };
      delete chartArgs.authInfo;
      delete chartArgs.signal;
      delete chartArgs.requestId;
      delete chartArgs.requestInfo;
      delete chartArgs._meta;
      
      const parsedArgs = getSummaryParser.parse(chartArgs);
      const date =
        parsedArgs.date ?? new Date().toISOString().slice(0, 10); /* YYYY-MM-DD */

      let foodItems: Array<{
        id: string;
        name: string;
        quantity: number;
        calories: number;
        proteinGrams: number;
        carbsGrams: number;
        fatGrams: number;
        timestamp: string;
      }> = [];
      let persisted = false;

      if (prisma) {
        try {
          // Query FoodLog from database for the specified date
          const dbFoodLogs = await prisma.foodLog.findMany({
            where: {
              feeding_date: date,
              user_id: userId,
            },
            orderBy: { createdAt: "asc" },
          });

          // Convert database records to chart-friendly format
          foodItems = dbFoodLogs.map((log) => ({
            id: log.id,
            name: log.food_name,
            quantity: log.food_qty,
            calories: log.kkcals,
            proteinGrams: log.protein_grams,
            carbsGrams: log.carbs_grams,
            fatGrams: log.fat_grams,
            timestamp: log.createdAt.toISOString(),
          }));

          persisted = true;
        } catch (dbError) {
          console.error(
            `[cocompetitorai] Failed to query database for date ${date} (daily-food-log widget), falling back to in-memory:`,
            dbError
          );
          // Fall through to in-memory
        }
      }

      // Fallback to in-memory if DB not available or query failed
      if (!persisted) {
        const userNutrition = nutritionEventsByUser.get(userId) || [];
        const dailyMeals = userNutrition.filter((n) => {
          const d = isoDateFromTimestamp(n.occurredAt);
          return d === date;
        });

        // Convert in-memory nutrition logs to chart format
        // Note: In-memory logs may have items array, so we need to expand them
        let itemIndex = 0;
        for (const meal of dailyMeals) {
          if (meal.items && Array.isArray(meal.items) && meal.items.length > 0) {
            // Expand meal items
            for (const item of meal.items) {
              foodItems.push({
                id: `in-memory-${itemIndex++}`,
                name: item.name,
                quantity: item.quantity || 1,
                calories: item.calories || 0,
                proteinGrams: item.proteinGrams || 0,
                carbsGrams: item.carbsGrams || 0,
                fatGrams: item.fatGrams || 0,
                timestamp: meal.occurredAt,
              });
            }
          } else {
            // Treat the whole meal as a single item
            foodItems.push({
              id: `in-memory-${itemIndex++}`,
              name: meal.mealType || "Meal",
              quantity: 1,
              calories: meal.calories || 0,
              proteinGrams: meal.proteinGrams,
              carbsGrams: meal.carbsGrams,
              fatGrams: meal.fatGrams,
              timestamp: meal.occurredAt,
            });
          }
        }
      }

      // Calculate daily totals
      const totals = foodItems.reduce(
        (acc, item) => ({
          calories: acc.calories + item.calories,
          proteinGrams: acc.proteinGrams + item.proteinGrams,
          carbsGrams: acc.carbsGrams + item.carbsGrams,
          fatGrams: acc.fatGrams + item.fatGrams,
        }),
        { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0 }
      );

      // Calculate macro percentages (calories from each macro)
      // Protein: 4 cal/g, Carbs: 4 cal/g, Fat: 9 cal/g
      const proteinCalories = totals.proteinGrams * 4;
      const carbsCalories = totals.carbsGrams * 4;
      const fatCalories = totals.fatGrams * 9;
      const totalMacroCalories = proteinCalories + carbsCalories + fatCalories;

      const macroBreakdown = totalMacroCalories > 0
        ? {
            protein: {
              grams: totals.proteinGrams,
              calories: proteinCalories,
              percentage: Math.round((proteinCalories / totalMacroCalories) * 100),
            },
            carbs: {
              grams: totals.carbsGrams,
              calories: carbsCalories,
              percentage: Math.round((carbsCalories / totalMacroCalories) * 100),
            },
            fat: {
              grams: totals.fatGrams,
              calories: fatCalories,
              percentage: Math.round((fatCalories / totalMacroCalories) * 100),
            },
          }
        : {
            protein: { grams: 0, calories: 0, percentage: 0 },
            carbs: { grams: 0, calories: 0, percentage: 0 },
            fat: { grams: 0, calories: 0, percentage: 0 },
          };

      // Format data for different chart types
      const chartData = {
        date,
        summary: {
          totalItems: foodItems.length,
          totals: {
            calories: totals.calories,
            proteinGrams: totals.proteinGrams,
            carbsGrams: totals.carbsGrams,
            fatGrams: totals.fatGrams,
          },
          macroBreakdown,
        },
        // Data for pie chart (macro breakdown)
        pieChart: {
          labels: ["Protein", "Carbs", "Fat"],
          values: [
            macroBreakdown.protein.percentage,
            macroBreakdown.carbs.percentage,
            macroBreakdown.fat.percentage,
          ],
          colors: ["#3b82f6", "#10b981", "#f59e0b"], // blue, green, orange
        },
        // Data for bar chart (top foods by calories)
        barChart: {
          data: foodItems
            .sort((a, b) => b.calories - a.calories)
            .slice(0, 10) // Top 10 items
            .map((item) => ({
              name: item.name,
              calories: item.calories,
              protein: item.proteinGrams,
              carbs: item.carbsGrams,
              fat: item.fatGrams,
            })),
        },
        // Data for timeline chart (nutrition over time)
        timelineChart: {
          data: foodItems.map((item) => ({
            time: item.timestamp,
            calories: item.calories,
            protein: item.proteinGrams,
            carbs: item.carbsGrams,
            fat: item.fatGrams,
          })),
        },
        // Raw food items for detailed view
        foodItems: foodItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          calories: item.calories,
          macros: {
            protein: item.proteinGrams,
            carbs: item.carbsGrams,
            fat: item.fatGrams,
          },
          timestamp: item.timestamp,
        })),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(chartData, null, 2),
          },
        ],
      };
    }
  );

  // Daily Food Log Widget Tool
  server.tool(
    "daily-food-log",
    "Get today's nutrition data displayed as an interactive widget with charts and visualizations",
    {
      date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
    },
    async (args, contextOrAuthInfo) => {
      // When tools have parameters, authInfo is passed INSIDE args, not as a second parameter
      const argsWithAuth = args as { authInfo?: { extra?: { userId?: string } }; [key: string]: unknown };
      const authInfo = argsWithAuth.authInfo || (contextOrAuthInfo as { authInfo?: { extra?: { userId?: string } } })?.authInfo || contextOrAuthInfo as { extra?: { userId?: string } } | undefined;
      
      if (!authInfo || !authInfo.extra?.userId) {
        throw new Error("Authentication required. authInfo is missing.");
      }
      const userId = authInfo.extra.userId as string;
      
      // Parse only the actual tool parameters (exclude authInfo, signal, etc.)
      const logArgs = { ...argsWithAuth };
      delete logArgs.authInfo;
      delete logArgs.signal;
      delete logArgs.requestId;
      delete logArgs.requestInfo;
      delete logArgs._meta;
      
      const parsedArgs = getSummaryParser.parse(logArgs);
      const date =
        parsedArgs.date ?? new Date().toISOString().slice(0, 10); /* YYYY-MM-DD */

      let foodItems: Array<{
        id: string;
        name: string;
        quantity: number;
        calories: number;
        proteinGrams: number;
        carbsGrams: number;
        fatGrams: number;
        timestamp: string;
      }> = [];
      let persisted = false;

      if (prisma) {
        try {
          // Query FoodLog from database for the specified date
          const dbFoodLogs = await prisma.foodLog.findMany({
            where: {
              feeding_date: date,
              user_id: userId,
            },
            orderBy: { createdAt: "asc" },
          });

          // Convert database records to chart-friendly format
          foodItems = dbFoodLogs.map((log) => ({
            id: log.id,
            name: log.food_name,
            quantity: log.food_qty,
            calories: log.kkcals,
            proteinGrams: log.protein_grams,
            carbsGrams: log.carbs_grams,
            fatGrams: log.fat_grams,
            timestamp: log.createdAt.toISOString(),
          }));

          persisted = true;
        } catch (dbError) {
          console.error(
            `[cocompetitorai] Failed to query database for date ${date} (get-nutrition-chart), falling back to in-memory:`,
            dbError
          );
          // Fall through to in-memory
        }
      }

      // Fallback to in-memory if DB not available or query failed
      if (!persisted) {
        const userNutrition = nutritionEventsByUser.get(userId) || [];
        const dailyMeals = userNutrition.filter((n) => {
          const d = isoDateFromTimestamp(n.occurredAt);
          return d === date;
        });

        // Convert in-memory nutrition logs to chart format
        let itemIndex = 0;
        for (const meal of dailyMeals) {
          if (meal.items && Array.isArray(meal.items) && meal.items.length > 0) {
            // Expand meal items
            for (const item of meal.items) {
              foodItems.push({
                id: `in-memory-${itemIndex++}`,
                name: item.name,
                quantity: item.quantity || 1,
                calories: item.calories || 0,
                proteinGrams: item.proteinGrams || 0,
                carbsGrams: item.carbsGrams || 0,
                fatGrams: item.fatGrams || 0,
                timestamp: meal.occurredAt,
              });
            }
          } else {
            // Treat the whole meal as a single item
            foodItems.push({
              id: `in-memory-${itemIndex++}`,
              name: meal.mealType || "Meal",
              quantity: 1,
              calories: meal.calories || 0,
              proteinGrams: meal.proteinGrams,
              carbsGrams: meal.carbsGrams,
              fatGrams: meal.fatGrams,
              timestamp: meal.occurredAt,
            });
          }
        }
      }

      // Calculate daily totals
      const totals = foodItems.reduce(
        (acc, item) => ({
          calories: acc.calories + item.calories,
          proteinGrams: acc.proteinGrams + item.proteinGrams,
          carbsGrams: acc.carbsGrams + item.carbsGrams,
          fatGrams: acc.fatGrams + item.fatGrams,
        }),
        { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0 }
      );

      // Calculate macro percentages (calories from each macro)
      // Protein: 4 cal/g, Carbs: 4 cal/g, Fat: 9 cal/g
      const proteinCalories = totals.proteinGrams * 4;
      const carbsCalories = totals.carbsGrams * 4;
      const fatCalories = totals.fatGrams * 9;
      const totalMacroCalories = proteinCalories + carbsCalories + fatCalories;

      const macroBreakdown = totalMacroCalories > 0
        ? {
            protein: {
              grams: totals.proteinGrams,
              calories: proteinCalories,
              percentage: Math.round((proteinCalories / totalMacroCalories) * 100),
            },
            carbs: {
              grams: totals.carbsGrams,
              calories: carbsCalories,
              percentage: Math.round((carbsCalories / totalMacroCalories) * 100),
            },
            fat: {
              grams: totals.fatGrams,
              calories: fatCalories,
              percentage: Math.round((fatCalories / totalMacroCalories) * 100),
            },
          }
        : {
            protein: { grams: 0, calories: 0, percentage: 0 },
            carbs: { grams: 0, calories: 0, percentage: 0 },
            fat: { grams: 0, calories: 0, percentage: 0 },
          };

      // Format data for widget
      const widgetData = {
        date,
        summary: {
          totalItems: foodItems.length,
          totals: {
            calories: totals.calories,
            proteinGrams: totals.proteinGrams,
            carbsGrams: totals.carbsGrams,
            fatGrams: totals.fatGrams,
          },
          macroBreakdown,
        },
        pieChart: {
          labels: ["Protein", "Carbs", "Fat"],
          values: [
            macroBreakdown.protein.percentage,
            macroBreakdown.carbs.percentage,
            macroBreakdown.fat.percentage,
          ],
          colors: ["#3b82f6", "#10b981", "#f59e0b"],
        },
        barChart: {
          data: foodItems
            .sort((a, b) => b.calories - a.calories)
            .slice(0, 10)
            .map((item) => ({
              name: item.name,
              calories: item.calories,
              protein: item.proteinGrams,
              carbs: item.carbsGrams,
              fat: item.fatGrams,
            })),
        },
        foodItems: foodItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          calories: item.calories,
          macros: {
            protein: item.proteinGrams,
            carbs: item.carbsGrams,
            fat: item.fatGrams,
          },
          timestamp: item.timestamp,
        })),
      };

      // Generate widget HTML with embedded data
      const widgetHtml = generateDailyFoodLogWidgetHtml(widgetData);

      return {
        content: [
          {
            type: "text",
            text: widgetHtml,
            mimeType: "text/html",
          },
        ],
      };
    }
  );
});

// Helper function to generate widget HTML
function generateDailyFoodLogWidgetHtml(data: {
  date: string;
  summary: {
    totalItems: number;
    totals: { calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number };
    macroBreakdown: {
      protein: { grams: number; calories: number; percentage: number };
      carbs: { grams: number; calories: number; percentage: number };
      fat: { grams: number; calories: number; percentage: number };
    };
  };
  pieChart: { labels: string[]; values: number[]; colors: string[] };
  barChart: { data: Array<{ name: string; calories: number; protein: number; carbs: number; fat: number }> };
  foodItems: Array<{ name: string; quantity: number; calories: number; macros: { protein: number; carbs: number; fat: number }; timestamp: string }>;
}): string {
  const dataJson = JSON.stringify(data).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  
  // Build food items HTML
  const foodItemsHtml = data.foodItems.length === 0
    ? '<div class="text-sm text-gray-500 text-center py-8">No food items logged for this day</div>'
    : data.foodItems.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString();
        const qty = item.quantity > 0 ? item.quantity + " × " : "";
        return `
          <div class="bg-white rounded-lg p-4 border border-gray-200 hover:border-gray-300 transition-colors">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                <div class="font-medium">${escapeHtml(item.name)}</div>
                <div class="text-sm text-gray-500">${qty}${time}</div>
              </div>
              <div class="text-right">
                <div class="font-semibold">${Math.round(item.calories)} cal</div>
              </div>
            </div>
            <div class="flex gap-4 text-xs text-gray-600 mt-2">
              <span>P: ${Math.round(item.macros.protein)}g</span>
              <span>C: ${Math.round(item.macros.carbs)}g</span>
              <span>F: ${Math.round(item.macros.fat)}g</span>
            </div>
          </div>
        `;
      }).join("");

  // Build bar chart HTML
  const maxCal = data.barChart.data.length > 0 
    ? Math.max(...data.barChart.data.map(d => d.calories), 1)
    : 1;
  const barChartHtml = data.barChart.data.length === 0
    ? '<div class="text-sm text-gray-500 text-center py-8">No data available</div>'
    : data.barChart.data.slice(0, 5).map(item => {
        const width = (item.calories / maxCal) * 100;
        return `
          <div class="flex items-center gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">${escapeHtml(item.name)}</div>
              <div class="text-xs text-gray-500">${Math.round(item.calories)} cal</div>
            </div>
            <div class="flex-1 h-6 bg-gray-200 rounded-full overflow-hidden">
              <div class="h-full bg-blue-500 rounded-full" style="width: ${width}%"></div>
            </div>
          </div>
        `;
      }).join("");

  // Calculate pie chart offsets
  const circumference = 314;
  const proteinOffset = circumference - (data.summary.macroBreakdown.protein.percentage / 100) * circumference;
  const carbsOffset = circumference - ((data.summary.macroBreakdown.protein.percentage + data.summary.macroBreakdown.carbs.percentage) / 100) * circumference;
  const fatOffset = circumference - ((data.summary.macroBreakdown.protein.percentage + data.summary.macroBreakdown.carbs.percentage + data.summary.macroBreakdown.fat.percentage) / 100) * circumference;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Food Log - ${escapeHtml(data.date)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body>
  <div class="w-full min-h-screen bg-white text-black p-6">
    <div class="mb-6">
      <h1 class="text-2xl font-bold mb-2">Daily Food Log</h1>
      <p class="text-sm text-gray-600">${escapeHtml(data.date)}</p>
    </div>
    
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-blue-50 rounded-lg p-4">
        <div class="text-sm text-gray-600">Calories</div>
        <div class="text-2xl font-bold">${Math.round(data.summary.totals.calories)}</div>
      </div>
      <div class="bg-green-50 rounded-lg p-4">
        <div class="text-sm text-gray-600">Protein</div>
        <div class="text-2xl font-bold">${Math.round(data.summary.totals.proteinGrams)}g</div>
      </div>
      <div class="bg-yellow-50 rounded-lg p-4">
        <div class="text-sm text-gray-600">Carbs</div>
        <div class="text-2xl font-bold">${Math.round(data.summary.totals.carbsGrams)}g</div>
      </div>
      <div class="bg-orange-50 rounded-lg p-4">
        <div class="text-sm text-gray-600">Fat</div>
        <div class="text-2xl font-bold">${Math.round(data.summary.totals.fatGrams)}g</div>
      </div>
    </div>
    
    <div class="grid md:grid-cols-2 gap-6 mb-6">
      <div class="bg-gray-50 rounded-lg p-6">
        <h2 class="text-lg font-semibold mb-4">Macro Breakdown</h2>
        <div class="flex flex-col items-center">
          <svg width="120" height="120" class="transform -rotate-90">
            <circle cx="60" cy="60" r="50" fill="none" stroke="#e5e7eb" stroke-width="20" />
            <circle cx="60" cy="60" r="50" fill="none" stroke="#3b82f6" stroke-width="20" 
              stroke-dasharray="314" 
              stroke-dashoffset="${proteinOffset}"
              stroke-linecap="round" />
            <circle cx="60" cy="60" r="50" fill="none" stroke="#10b981" stroke-width="20" 
              stroke-dasharray="314" 
              stroke-dashoffset="${carbsOffset}"
              stroke-linecap="round" />
            <circle cx="60" cy="60" r="50" fill="none" stroke="#f59e0b" stroke-width="20" 
              stroke-dasharray="314" 
              stroke-dashoffset="${fatOffset}"
              stroke-linecap="round" />
          </svg>
          <div class="mt-4 space-y-2 text-sm">
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 rounded-full bg-blue-500"></div>
              <span>Protein: ${data.summary.macroBreakdown.protein.percentage}%</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 rounded-full bg-green-500"></div>
              <span>Carbs: ${data.summary.macroBreakdown.carbs.percentage}%</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 rounded-full bg-orange-500"></div>
              <span>Fat: ${data.summary.macroBreakdown.fat.percentage}%</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="bg-gray-50 rounded-lg p-6">
        <h2 class="text-lg font-semibold mb-4">Top Foods by Calories</h2>
        <div class="space-y-2">
          ${barChartHtml}
        </div>
      </div>
    </div>
    
    <div class="bg-gray-50 rounded-lg p-6">
      <h2 class="text-lg font-semibold mb-4">All Food Items (${data.summary.totalItems})</h2>
      <div class="space-y-3">
        ${foodItemsHtml}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  // Simple HTML escaping without DOM manipulation
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
