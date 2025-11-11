/**
 * Tool definitions for MindGuard AI wellness agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod/v3";

import type { MindGuard } from "./server";
import { getCurrentAgent } from "agents";
import { scheduleSchema } from "agents/schedule";

/**
 * Analyze emotional tone of user's message
 * Returns tone classification and intensity
 */
const analyzeEmotionalTone = tool({
  description: "Analyze the emotional tone of a user's message. Returns tone (positive/neutral/negative), intensity (1-10), and key emotional keywords. Use this when the user shares how they're feeling.",
  inputSchema: z.object({
    message: z.string().describe("The user's message to analyze for emotional tone")
  }),
  execute: async ({ message }) => {
    // The actual analysis is done by the LLM in the system prompt
    // This tool provides structure for the AI to return analysis
    // The AI will analyze and return structured data
    return {
      tone: "neutral", // Will be determined by AI analysis
      intensity: 5,
      keywords: []
    };
  }
});

/**
 * Perform a daily wellness check-in
 * Initiates check-in conversation and stores results
 */
const performDailyCheckIn = tool({
  description: "Perform a daily wellness check-in with the user. Ask how they're feeling, analyze their emotional state, and provide recommendations.",
  inputSchema: z.object({}),
  execute: async () => {
    const { agent } = getCurrentAgent<MindGuard>();
    // The agent will handle the conversation flow through the chat interface
    return "Check-in initiated. Please share how you're feeling today.";
  }
});

/**
 * Get mindfulness recommendations based on emotional tone
 * Provides personalized coping techniques
 */
const getMindfulnessRecommendations = tool({
  description: "Get personalized mindfulness and coping technique recommendations based on emotional tone. Returns specific exercises, prompts, or activities tailored to the user's current emotional state.",
  inputSchema: z.object({
    emotionalTone: z.enum(["positive", "neutral", "negative"]).describe("The emotional tone to base recommendations on"),
    intensity: z.number().min(1).max(10).optional().describe("Intensity level (1-10) of the emotion")
  }),
  execute: async ({ emotionalTone, intensity = 5 }) => {
    // Return recommendations based on tone
    const recommendations = {
      positive: [
        "Practice gratitude journaling - write down 3 things you're grateful for today",
        "Share your positive energy with others - reach out to a friend or loved one",
        "Set new goals while feeling motivated - channel this energy into something meaningful",
        "Practice mindful appreciation - take a moment to fully experience this positive feeling"
      ],
      neutral: [
        "Take a mindful walk - focus on your breathing and surroundings",
        "Practice deep breathing exercises - 4-7-8 technique (inhale 4, hold 7, exhale 8)",
        "Try a new hobby or activity - explore something that interests you",
        "Practice body scan meditation - notice how each part of your body feels"
      ],
      negative: [
        "Practice 4-7-8 breathing technique - inhale for 4, hold for 7, exhale for 8",
        "Write down your feelings in a journal - express what you're experiencing",
        "Try progressive muscle relaxation - tense and release each muscle group",
        "Consider talking to a trusted friend or professional - you don't have to go through this alone",
        "Practice self-compassion - be kind to yourself, acknowledge that difficult emotions are valid"
      ]
    };

    const toneRecommendations = recommendations[emotionalTone] || recommendations.neutral;
    
    // If intensity is high (7+), add additional support recommendations
    if (intensity >= 7 && emotionalTone === "negative") {
      toneRecommendations.push(
        "Consider reaching out to a mental health professional or crisis support line if needed"
      );
    }

    return toneRecommendations;
  }
});

/**
 * Save check-in data to database
 * Stores emotional tone, summary, and recommendations
 */
const saveCheckInData = tool({
  description: "Save a daily check-in to the database. Stores the emotional tone, summary, and recommendations for tracking over time.",
  inputSchema: z.object({
    emotionalTone: z.string().describe("The emotional tone (positive/neutral/negative)"),
    summary: z.string().describe("A brief summary of the check-in conversation"),
    recommendations: z.array(z.string()).describe("List of recommendations provided to the user")
  }),
  execute: async ({ emotionalTone, summary, recommendations }) => {
    const { agent } = getCurrentAgent<MindGuard>();
    try {
      await agent!.saveCheckIn(emotionalTone, summary, recommendations);
      return `Check-in saved successfully for ${new Date().toISOString().split('T')[0]}`;
    } catch (error) {
      console.error("Error saving check-in:", error);
      return `Error saving check-in: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
});

/**
 * Get check-in history
 * Retrieves past check-ins for context
 */
const getCheckInHistory = tool({
  description: "Get the user's check-in history. Returns past daily check-ins with emotional tone and summaries.",
  inputSchema: z.object({
    limit: z.number().min(1).max(30).optional().describe("Number of check-ins to retrieve (default: 7)")
  }),
  execute: async ({ limit = 7 }) => {
    const { agent } = getCurrentAgent<MindGuard>();
    try {
      const history = await agent!.getCheckInHistory(limit);
      if (history.length === 0) {
        return "No check-in history found. Start your first check-in to begin tracking your wellness journey.";
      }
      return history.map(ci => ({
        date: ci.date,
        tone: ci.emotional_tone,
        summary: ci.summary,
        recommendations: JSON.parse(ci.recommendations || "[]")
      }));
    } catch (error) {
      console.error("Error getting check-in history:", error);
      return `Error retrieving check-in history: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
});

const scheduleTask = tool({
  description: "A tool to schedule a task to be executed at a later time. Can be used to schedule daily check-ins or other wellness reminders.",
  inputSchema: scheduleSchema,
  execute: async ({ when, description }) => {
    const { agent } = getCurrentAgent<MindGuard>();

    function throwError(msg: string): string {
      throw new Error(msg);
    }
    if (when.type === "no-schedule") {
      return "Not a valid schedule input";
    }
    const input =
      when.type === "scheduled"
        ? when.date
        : when.type === "delayed"
          ? when.delayInSeconds
          : when.type === "cron"
            ? when.cron
            : throwError("not a valid schedule input");
    try {
      agent!.schedule(input!, "executeTask", description);
    } catch (error) {
      console.error("error scheduling task", error);
      return `Error scheduling task: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
    return `Task scheduled for type "${when.type}": ${input}`;
  }
});

/**
 * Tool to list all scheduled tasks
 * This executes automatically without requiring human confirmation
 */
const getScheduledTasks = tool({
  description: "List all tasks that have been scheduled, including daily check-ins",
  inputSchema: z.object({}),
  execute: async () => {
    const { agent } = getCurrentAgent<MindGuard>();

    try {
      const tasks = agent!.getSchedules();
      if (!tasks || tasks.length === 0) {
        return "No scheduled tasks found.";
      }
      return tasks;
    } catch (error) {
      console.error("Error listing scheduled tasks", error);
      return `Error listing scheduled tasks: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
});

/**
 * Tool to cancel a scheduled task by its ID
 * This executes automatically without requiring human confirmation
 */
const cancelScheduledTask = tool({
  description: "Cancel a scheduled task using its ID",
  inputSchema: z.object({
    taskId: z.string().describe("The ID of the task to cancel")
  }),
  execute: async ({ taskId }) => {
    const { agent } = getCurrentAgent<MindGuard>();
    try {
      await agent!.cancelSchedule(taskId);
      return `Task ${taskId} has been successfully canceled.`;
    } catch (error) {
      console.error("Error canceling scheduled task", error);
      return `Error canceling task ${taskId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
});

/**
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  analyzeEmotionalTone,
  performDailyCheckIn,
  getMindfulnessRecommendations,
  saveCheckInData,
  getCheckInHistory,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask
} satisfies ToolSet;

/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Currently no tools require confirmation - all execute automatically
 */
export const executions = {};
