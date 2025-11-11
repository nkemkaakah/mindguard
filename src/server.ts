import { routeAgentRequest, type Schedule, type AgentNamespace, type Agent, type Connection } from "agents";

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
    agentName: string; // User-customizable agent name
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
          agent_name TEXT,
          updated_at TEXT
        )
      `;

      // Migration: Add agent_name column if it doesn't exist (for existing databases)
      // Check if column exists by querying table info
      try {
        const tableInfo = await this.sql<{ name: string }>`
          PRAGMA table_info(user_preferences)
        `;
        
        const hasAgentNameColumn = tableInfo.some(col => col.name === "agent_name");
        
        if (!hasAgentNameColumn) {
          // Column doesn't exist, add it
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN agent_name TEXT
          `;
        }
      } catch (error) {
        // If PRAGMA fails or column check fails, try to add the column anyway
        // This handles edge cases where the table structure might be different
        try {
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN agent_name TEXT
          `;
        } catch (alterError) {
          // Column likely already exists, which is fine
          // Only log if it's not a "duplicate column" error
          if (!(alterError instanceof Error && alterError.message.includes("duplicate column"))) {
            console.error("Error adding agent_name column:", alterError);
          }
        }
      }
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
    const agentName = await this.getAgentName();
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

          // Prevent duplicate responses: if the last message is already from the assistant,
          // don't process again (this happens when syncing messages on connection)
          const lastMessage = cleanedMessages[cleanedMessages.length - 1];
          if (lastMessage && lastMessage.role === "assistant") {
            // Last message is already from assistant, conversation is complete
            // Don't generate a new response - this is just message syncing
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
            system: `You are ${agentName}, a compassionate AI wellness companion. Your role is to:
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
   * Handle WebSocket connection - sync existing messages to client
   * We need to call saveMessages to sync messages, but onChatMessage will check
   * if the last message is already from assistant to prevent duplicate responses
   */
  async onConnect(connection: Connection) {
    // Sync existing messages to the newly connected client
    // onChatMessage will check if last message is from assistant and skip processing
    if (this.messages && this.messages.length > 0) {
      try {
        // Wait a brief moment for connection to be fully established
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Ensure all messages have timestamps before syncing
        // Preserve existing timestamps, don't overwrite them
        const messagesWithTimestamps = this.messages.map(msg => {
          if (!msg.metadata || !(msg.metadata as { createdAt?: string }).createdAt) {
            return {
              ...msg,
              metadata: {
                ...(msg.metadata || {}),
                createdAt: new Date().toISOString()
              }
            };
          }
          return msg;
        });
        
        // Call saveMessages to sync messages to the client
        // onChatMessage will be called but will exit early if last message is from assistant
        await this.saveMessages(messagesWithTimestamps);
      } catch (error) {
        console.error("Error syncing messages on connect:", error);
      }
    }
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
          timezone: "UTC",
          agentName: "MindGuard"
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

  /**
   * Get agent name from preferences
   */
  async getAgentName(): Promise<string> {
    try {
      // First check state
      if (this.state?.preferences?.agentName) {
        return this.state.preferences.agentName;
      }

      // If not in state, check database
      const userId = this.state?.userId || "default";
      try {
        const result = await this.sql<{ agent_name: string }>`
          SELECT agent_name FROM user_preferences 
          WHERE user_id = ${userId} 
          LIMIT 1
        `;

        if (result && result.length > 0 && result[0].agent_name) {
          return result[0].agent_name;
        }
      } catch (error) {
        // Column might not exist yet, fall through to default
        console.error("Error querying agent_name:", error);
      }

      // Default name
      return "MindGuard";
    } catch (error) {
      console.error("Error getting agent name:", error);
      return "MindGuard";
    }
  }

  /**
   * Update agent name in database and state
   */
  async updateAgentName(newName: string): Promise<void> {
    try {
      // Validate name
      if (!newName || newName.trim().length === 0) {
        throw new Error("Agent name cannot be empty");
      }

      if (newName.length > 50) {
        throw new Error("Agent name must be 50 characters or less");
      }

      const userId = this.state?.userId || "default";
      const trimmedName = newName.trim();

      // Update database
      await this.sql`
        INSERT INTO user_preferences (user_id, agent_name, updated_at)
        VALUES (${userId}, ${trimmedName}, ${new Date().toISOString()})
        ON CONFLICT(user_id) DO UPDATE SET
          agent_name = ${trimmedName},
          updated_at = ${new Date().toISOString()}
      `;

      // Update state
      await this.setState({
        ...this.state,
        preferences: {
          ...(this.state?.preferences || {
            checkInTime: "09:00",
            timezone: "UTC",
            agentName: "MindGuard"
          }),
          agentName: trimmedName
        }
      });
    } catch (error) {
      console.error("Error updating agent name:", error);
      throw error;
    }
  }

  /**
   * Handle HTTP requests (for API endpoints)
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle internal update-name request
    // Path could be /internal/update-name or /agents/mindguard/default/internal/update-name
    if ((pathname === "/internal/update-name" || pathname.endsWith("/internal/update-name")) && request.method === "POST") {
      try {
        await this.initializeDatabase();
        const body = await request.json() as { name?: string };
        const { name } = body;

        if (!name || typeof name !== "string") {
          return Response.json(
            { error: "Invalid name provided" },
            { status: 400 }
          );
        }

        await this.updateAgentName(name);
        return Response.json({ success: true, name });
      } catch (error) {
        console.error("Error in onRequest update-name:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to update agent name" },
          { status: 500 }
        );
      }
    }

    // For all other requests, let the parent class handle it
    // AIChatAgent doesn't override onRequest, so return 404 for unmatched routes
    return new Response("Not found", { status: 404 });
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

    // Handle agent name update endpoint
    if (url.pathname === "/api/update-agent-name" && request.method === "POST") {
      try {
        const body = await request.json() as { name?: string; agentName?: string };
        const newName = body.name || body.agentName;

        if (!newName || typeof newName !== "string") {
          return Response.json(
            { error: "Invalid name provided" },
            { status: 400 }
          );
        }

        // Create a properly formatted request that routeAgentRequest can handle
        // Pattern: /agents/:agent/:name/path
        const agentRequestUrl = new URL("/agents/mindguard/default/internal/update-name", request.url);
        const agentRequest = new Request(agentRequestUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: newName })
        });
        
        // Route the request through routeAgentRequest to get proper agent instance
        const response = await routeAgentRequest(agentRequest, env);
        if (response) {
          return response;
        }
        
        return Response.json(
          { error: "Failed to route request to agent" },
          { status: 500 }
        );
      } catch (error) {
        console.error("Error updating agent name:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to update agent name" },
          { status: 500 }
        );
      }
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
