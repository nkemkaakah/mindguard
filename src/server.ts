import { routeAgentRequest, type Schedule, type AgentNamespace, type Agent } from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "agents/ai-chat-agent";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { openai } from "@ai-sdk/openai";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";

const model = openai("gpt-4o-2024-11-20");

/**
 * Environment interface for Cloudflare Worker
 * Defines bindings available to the worker
 */
interface Env {
  mindguard: AgentNamespace<Agent>;
  OPENAI_API_KEY?: string;
}

/**
 * MindGuard State Interface
 * Tracks user wellness data and preferences
 */
interface MindGuardState {
  userId: string;
  dailyCheckIns: Array<{
    date: string;
    emotionalTone: string;
    summary: string;
    recommendations: string[];
  }>;
  lastCheckIn: string | null;
  preferences: {
    checkInTime: string; // e.g., "09:00"
    timezone: string;
  };
}

/**
 * MindGuard Agent - AI wellness companion for daily check-ins
 * Tracks emotional tone, provides recommendations, and schedules daily check-ins
 */
export class MindGuard extends AIChatAgent<Env, MindGuardState> {
  /**
   * Initialize database schema on first use
   */
  async initializeDatabase() {
    try {
      await this.sql`
        CREATE TABLE IF NOT EXISTS check_ins (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          date TEXT,
          emotional_tone TEXT,
          summary TEXT,
          recommendations TEXT,
          created_at TEXT
        )
      `;

      await this.sql`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id TEXT PRIMARY KEY,
          check_in_time TEXT,
          timezone TEXT,
          updated_at TEXT
        )
      `;
    } catch (error) {
      console.error("Error initializing database:", error);
    }
  }
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Initialize database on first message
    await this.initializeDatabase();

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    // Load recent check-in history for context
    const recentCheckIns = await this.getCheckInHistory(5);
    const checkInContext = recentCheckIns.length > 0
      ? `\nRecent check-in history:\n${recentCheckIns.map(ci => 
          `- ${ci.date}: ${ci.emotional_tone} - ${ci.summary}`
        ).join('\n')}`
      : "";

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          // Clean up incomplete tool calls to prevent API errors
          const cleanedMessages = cleanupMessages(this.messages);

          // Validate messages exist
          if (!cleanedMessages || cleanedMessages.length === 0) {
            writer.write({
              type: "text-delta",
              delta: "I'm here to help. Please share how you're feeling today.",
              id: generateId()
            });
            return;
          }

          // Process any pending tool calls from previous messages
          const processedMessages = await processToolCalls({
            messages: cleanedMessages,
            dataStream: writer,
            tools: allTools,
            executions
          });

          const result = streamText({
            system: `You are MindGuard, a compassionate AI wellness companion. Your role is to:
- Check in with users daily about their mental well-being
- Analyze the emotional tone of their messages (positive, neutral, or negative)
- Provide gentle, supportive responses
- Recommend appropriate mindfulness techniques and coping strategies
- Store summaries of daily check-ins for tracking progress
- Be empathetic, non-judgmental, and supportive

IMPORTANT: You are NOT a replacement for professional mental health care. If a user expresses serious distress, encourage them to seek professional help.

When analyzing emotional tone, consider:
- Word choice and language patterns
- Overall sentiment
- Intensity of emotions expressed
- Context of the conversation

When providing recommendations, match them to the user's emotional state and be specific and actionable.

${checkInContext}

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`,

            messages: convertToModelMessages(processedMessages),
            model,
            tools: allTools,
            onFinish: onFinish as unknown as StreamTextOnFinishCallback<
              typeof allTools
            >,
            stopWhen: stepCountIs(10)
          });

          writer.merge(result.toUIMessageStream());
        } catch (error) {
          console.error("Error in chat message processing:", error);
          writer.write({
            type: "text-delta",
            delta: "I apologize, but I encountered an error. Please try again. If the issue persists, feel free to share how you're feeling and I'll do my best to help.",
            id: generateId()
          });
        }
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
  /**
   * Execute scheduled daily check-in
   */
  async executeDailyCheckIn(description: string, _task: Schedule<string>) {
    try {
      // Send proactive check-in message
      await this.saveMessages([
        ...this.messages,
        {
          id: generateId(),
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Good morning! 🌅 It's time for your daily check-in. How are you feeling today? Take a moment to reflect on your emotional state and share what's on your mind."
            }
          ],
          metadata: {
            createdAt: new Date()
          }
        }
      ]);
    } catch (error) {
      console.error("Error executing daily check-in:", error);
    }
  }

  /**
   * Generic task executor (for other scheduled tasks)
   */
  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
  }

  /**
   * Save a check-in to database and state
   * Handles duplicate check-ins for the same day by updating existing record
   */
  async saveCheckIn(
    emotionalTone: string,
    summary: string,
    recommendations: string[]
  ) {
    try {
      // Validate inputs
      if (!emotionalTone || !summary) {
        throw new Error("Emotional tone and summary are required");
      }

      if (!Array.isArray(recommendations)) {
        throw new Error("Recommendations must be an array");
      }

      // Validate emotional tone
      const validTones = ["positive", "neutral", "negative"];
      if (!validTones.includes(emotionalTone.toLowerCase())) {
        emotionalTone = "neutral"; // Default to neutral if invalid
      }

      const checkInId = generateId();
      const userId = this.state?.userId || "default";
      const date = new Date().toISOString().split('T')[0];

      // Check if check-in already exists for today
      const existingCheckIn = await this.sql<{ id: string }>`
        SELECT id FROM check_ins 
        WHERE user_id = ${userId} AND date = ${date} 
        LIMIT 1
      `;

      if (existingCheckIn && existingCheckIn.length > 0) {
        // Update existing check-in
        await this.sql`
          UPDATE check_ins 
          SET emotional_tone = ${emotionalTone.toLowerCase()}, 
              summary = ${summary}, 
              recommendations = ${JSON.stringify(recommendations)}, 
              created_at = ${new Date().toISOString()}
          WHERE id = ${existingCheckIn[0].id}
        `;
      } else {
        // Insert new check-in
        await this.sql`
          INSERT INTO check_ins (id, user_id, date, emotional_tone, summary, recommendations, created_at)
          VALUES (${checkInId}, ${userId}, ${date}, ${emotionalTone.toLowerCase()}, ${summary}, ${JSON.stringify(recommendations)}, ${new Date().toISOString()})
        `;
      }

      // Update state
      const updatedCheckIns = this.state?.dailyCheckIns || [];
      const existingIndex = updatedCheckIns.findIndex(ci => ci.date === date);
      
      const checkInEntry = { date, emotionalTone: emotionalTone.toLowerCase(), summary, recommendations };
      
      if (existingIndex >= 0) {
        updatedCheckIns[existingIndex] = checkInEntry;
      } else {
        updatedCheckIns.push(checkInEntry);
      }

      await this.setState({
        userId,
        lastCheckIn: date,
        dailyCheckIns: updatedCheckIns,
        preferences: this.state?.preferences || {
          checkInTime: "09:00",
          timezone: "UTC"
        }
      });
    } catch (error) {
      console.error("Error saving check-in:", error);
      throw error;
    }
  }

  /**
   * Get check-in history from database
   */
  async getCheckInHistory(limit: number = 7) {
    try {
      const userId = this.state?.userId || "default";
      const results = await this.sql<{
        id: string;
        date: string;
        emotional_tone: string;
        summary: string;
        recommendations: string;
      }>`
        SELECT * FROM check_ins 
        WHERE user_id = ${userId} 
        ORDER BY created_at DESC 
        LIMIT ${limit}
      `;

      return results;
    } catch (error) {
      console.error("Error getting check-in history:", error);
      return [];
    }
  }

  /**
   * Schedule daily check-in at specified time
   * Prevents duplicate scheduling by checking existing schedules first
   */
  async scheduleDailyCheckIn() {
    try {
      const checkInTime = this.state?.preferences?.checkInTime || "09:00";
      
      // Validate time format (HH:MM)
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(checkInTime)) {
        console.error("Invalid time format:", checkInTime);
        return;
      }

      const [hour, minute] = checkInTime.split(':');

      // Cron: minute hour * * * (runs daily at specified time)
      const cronPattern = `${minute} ${hour} * * *`;

      // Check if daily check-in is already scheduled
      // Look for schedules that call executeDailyCheckIn
      const existingSchedules = this.getSchedules();
      const hasDailyCheckIn = existingSchedules.some(
        schedule => schedule.callback === "executeDailyCheckIn"
      );

      if (!hasDailyCheckIn) {
        this.schedule(cronPattern, "executeDailyCheckIn", "Daily wellness check-in");
      }
    } catch (error) {
      console.error("Error scheduling daily check-in:", error);
    }
  }

  /**
   * Get last check-in date
   */
  async getLastCheckIn(): Promise<string | null> {
    try {
      const userId = this.state?.userId || "default";
      const result = await this.sql<{ date: string }>`
        SELECT date FROM check_ins 
        WHERE user_id = ${userId} 
        ORDER BY created_at DESC 
        LIMIT 1
      `;

      if (result && result.length > 0) {
        return result[0].date;
      }
      return null;
    } catch (error) {
      console.error("Error getting last check-in:", error);
      return null;
    }
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
