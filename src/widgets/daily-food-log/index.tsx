"use client";

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface FoodItem {
  name: string;
  quantity: number;
  calories: number;
  macros: {
    protein: number;
    carbs: number;
    fat: number;
  };
  timestamp: string;
}

interface NutritionData {
  date: string;
  summary: {
    totalItems: number;
    totals: {
      calories: number;
      proteinGrams: number;
      carbsGrams: number;
      fatGrams: number;
    };
    macroBreakdown: {
      protein: { grams: number; calories: number; percentage: number };
      carbs: { grams: number; calories: number; percentage: number };
      fat: { grams: number; calories: number; percentage: number };
    };
  };
  pieChart: {
    labels: string[];
    values: number[];
    colors: string[];
  };
  barChart: {
    data: Array<{
      name: string;
      calories: number;
      protein: number;
      carbs: number;
      fat: number;
    }>;
  };
  foodItems: FoodItem[];
}

function MacroPieChart({ breakdown }: { breakdown: NutritionData["summary"]["macroBreakdown"] }) {
  const total = breakdown.protein.percentage + breakdown.carbs.percentage + breakdown.fat.percentage;
  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-500">
        No data available
      </div>
    );
  }

  // Simple pie chart using SVG
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  
  const proteinOffset = 0;
  const carbsOffset = (breakdown.protein.percentage / 100) * circumference;
  const fatOffset = ((breakdown.protein.percentage + breakdown.carbs.percentage) / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="120" className="transform -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="20"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="20"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (breakdown.protein.percentage / 100) * circumference}
          strokeLinecap="round"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#10b981"
          strokeWidth="20"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - ((breakdown.protein.percentage + breakdown.carbs.percentage) / 100) * circumference}
          strokeLinecap="round"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#f59e0b"
          strokeWidth="20"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - ((breakdown.protein.percentage + breakdown.carbs.percentage + breakdown.fat.percentage) / 100) * circumference}
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500"></div>
          <span>Protein: {breakdown.protein.percentage}%</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
          <span>Carbs: {breakdown.carbs.percentage}%</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-orange-500"></div>
          <span>Fat: {breakdown.fat.percentage}%</span>
        </div>
      </div>
    </div>
  );
}

function BarChart({ data }: { data: NutritionData["barChart"]["data"] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-500">
        No data available
      </div>
    );
  }

  const maxCalories = Math.max(...data.map((d) => d.calories), 1);

  return (
    <div className="space-y-2">
      {data.slice(0, 5).map((item, idx) => (
        <div key={idx} className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{item.name}</div>
            <div className="text-xs text-gray-500">{item.calories} cal</div>
          </div>
          <div className="flex-1 h-6 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full"
              style={{ width: `${(item.calories / maxCalories) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function DailyFoodLogWidget() {
  const [data, setData] = useState<NutritionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Get data from window if available (passed from MCP)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowWithOai = window as typeof window & { oai?: { widget?: { props?: { data?: unknown } } } };
    const widgetData = windowWithOai.oai?.widget?.props?.data;
    if (widgetData) {
      try {
        const parsed = typeof widgetData === "string" ? JSON.parse(widgetData) : widgetData;
        setData(parsed);
        setLoading(false);
      } catch {
        setError("Failed to parse widget data");
        setLoading(false);
      }
    } else {
      setError("No data provided");
      setLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading nutrition data...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-500">{error || "No data available"}</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-white text-black p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Daily Food Log</h1>
        <p className="text-sm text-gray-600">{data.date}</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="text-sm text-gray-600">Calories</div>
          <div className="text-2xl font-bold">{Math.round(data.summary.totals.calories)}</div>
        </div>
        <div className="bg-green-50 rounded-lg p-4">
          <div className="text-sm text-gray-600">Protein</div>
          <div className="text-2xl font-bold">{Math.round(data.summary.totals.proteinGrams)}g</div>
        </div>
        <div className="bg-yellow-50 rounded-lg p-4">
          <div className="text-sm text-gray-600">Carbs</div>
          <div className="text-2xl font-bold">{Math.round(data.summary.totals.carbsGrams)}g</div>
        </div>
        <div className="bg-orange-50 rounded-lg p-4">
          <div className="text-sm text-gray-600">Fat</div>
          <div className="text-2xl font-bold">{Math.round(data.summary.totals.fatGrams)}g</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        {/* Macro Breakdown Pie Chart */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Macro Breakdown</h2>
          <MacroPieChart breakdown={data.summary.macroBreakdown} />
        </div>

        {/* Top Foods Bar Chart */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Top Foods by Calories</h2>
          <BarChart data={data.barChart.data} />
        </div>
      </div>

      {/* Food Items List */}
      <div className="bg-gray-50 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">All Food Items ({data.summary.totalItems})</h2>
        <div className="space-y-3">
          {data.foodItems.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-8">
              No food items logged for this day
            </div>
          ) : (
            data.foodItems.map((item, idx) => (
              <div
                key={idx}
                className="bg-white rounded-lg p-4 border border-gray-200 hover:border-gray-300 transition-colors"
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    <div className="font-medium">{item.name}</div>
                    <div className="text-sm text-gray-500">
                      {item.quantity > 0 && `${item.quantity} × `}
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">{Math.round(item.calories)} cal</div>
                  </div>
                </div>
                <div className="flex gap-4 text-xs text-gray-600 mt-2">
                  <span>P: {Math.round(item.macros.protein)}g</span>
                  <span>C: {Math.round(item.macros.carbs)}g</span>
                  <span>F: {Math.round(item.macros.fat)}g</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Initialize the widget
if (typeof document !== "undefined") {
  const rootElement = document.getElementById("daily-food-log-root");
  if (rootElement) {
    const root = createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <DailyFoodLogWidget />
      </React.StrictMode>
    );
  }
}

export default DailyFoodLogWidget;

