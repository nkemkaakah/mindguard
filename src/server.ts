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
import { createWorkersAI } from "workers-ai-provider";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";

// Model will be selected dynamically based on user preference

/**
 * Environment interface for Cloudflare Worker
 * Defines bindings available to the worker
 */
interface Env {
  mindguard: AgentNamespace<Agent>;
  OPENAI_API_KEY?: string;
  AI?: any; // Workers AI binding (from wrangler.jsonc)
  CHECKIN_WORKFLOW?: any; // Workflows binding for check-in workflow
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
    modelProvider: "openai" | "workers-ai"; // AI model provider preference
  };
}

/**
 * MindGuard Agent - AI wellness companion for daily check-ins
 * Tracks emotional tone, provides recommendations, and schedules daily check-ins
 */
export class MindGuard extends AIChatAgent<Env, MindGuardState> {
  // Toggle between workflows (true) and cron jobs (false)
  // Set to true to use workflows, false to use cron jobs
  private readonly USE_WORKFLOWS = false;

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
          model_provider TEXT,
          updated_at TEXT
        )
      `;

      // Migration: Add agent_name and model_provider columns if they don't exist
      try {
        const tableInfo = await this.sql<{ name: string }>`
          PRAGMA table_info(user_preferences)
        `;
        
        const hasAgentNameColumn = tableInfo.some(col => col.name === "agent_name");
        const hasModelProviderColumn = tableInfo.some(col => col.name === "model_provider");
        
        if (!hasAgentNameColumn) {
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN agent_name TEXT
          `;
        }
        
        if (!hasModelProviderColumn) {
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN model_provider TEXT DEFAULT 'openai'
          `;
        }
      } catch (error) {
        // If PRAGMA fails, try to add columns anyway
        try {
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN agent_name TEXT
          `;
        } catch (alterError) {
          if (!(alterError instanceof Error && alterError.message.includes("duplicate column"))) {
            console.error("Error adding agent_name column:", alterError);
          }
        }
        try {
          await this.sql`
            ALTER TABLE user_preferences ADD COLUMN model_provider TEXT DEFAULT 'openai'
          `;
        } catch (alterError) {
          if (!(alterError instanceof Error && alterError.message.includes("duplicate column"))) {
            console.error("Error adding model_provider column:", alterError);
          }
        }
      }
    } catch (error) {
      console.error("Error initializing database:", error);
    }
  }

  /**
   * Called when the Agent instance starts or wakes from hibernation
   * Initializes the database and schedules the daily check-in cron job
   */
  async onStart() {
    try {
      // Initialize database schema
      await this.initializeDatabase();
      
      // Schedule the daily check-in cron job
      await this.scheduleDailyCheckIn();
      
      console.log("Agent started: database initialized and daily check-in scheduled");
    } catch (error) {
      console.error("Error in onStart:", error);
    }
  }

  /**
   * Get the AI model based on user preference
   */
  getModel() {
    const modelProvider = this.state?.preferences?.modelProvider || "openai";
    
    if (modelProvider === "workers-ai") {
      if (!this.env.AI) {
        console.warn("Workers AI binding not available, falling back to OpenAI");
        return openai("gpt-4o-2024-11-20");
      }
      
      try {
        const workersAI = createWorkersAI({ binding: this.env.AI });
        // Use @cf/meta/llama-3.3-70b-instruct-fp8-fast for Llama 3.3 (faster fp8 quantized version)
        // Note: Workers AI requires remote: true in wrangler.jsonc and may not work in local dev
        return workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any);
      } catch (error) {
        console.error("Error initializing Workers AI, falling back to OpenAI:", error);
        return openai("gpt-4o-2024-11-20");
      }
    }
    
    // Default to OpenAI
    return openai("gpt-4o-2024-11-20");
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

    // Check if this is a response to a check-in workflow
    // If workflow is waiting, send event to workflow
    if (this.env.CHECKIN_WORKFLOW && this.messages.length > 0) {
      const lastMessage = this.messages[this.messages.length - 1];
      if (lastMessage.role === "user" && lastMessage.parts?.[0]?.type === "text") {
        const userText = lastMessage.parts[0].text;
        // Check if this looks like a check-in response (simple heuristic)
        // In production, you might want a more sophisticated check
        const userId = this.state?.userId || "default";
        
        try {
          // Try to send event to workflow (workflow might not be waiting, which is fine)
          // Note: This is a simplified approach - in production you'd track active workflows
          await this.env.CHECKIN_WORKFLOW.sendEvent("user-check-in-response", {
            userId,
            response: userText
          });
        } catch (error) {
          // Workflow might not be waiting for this event, which is fine
          // Only log if it's not a "no workflow waiting" type error
          if (!(error instanceof Error && error.message.includes("not found"))) {
            console.log("Could not send event to workflow (workflow may not be active):", error);
          }
        }
      }
    }

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    // Check if we're using Workers AI - it has limited tool calling support
    const modelProvider = this.state?.preferences?.modelProvider || "openai";
    const isWorkersAI = modelProvider === "workers-ai";

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

          // Get the model (may fallback to OpenAI if Workers AI fails)
          const model = this.getModel();
          
          // Workers AI (Llama 3.3) has limited tool calling support through ai-sdk
          // So we conditionally disable tools and use a different prompt approach
          const toolsToUse = isWorkersAI ? {} : allTools;
          
          // Enhanced system prompt for Workers AI that doesn't rely on tools
          const systemPrompt = isWorkersAI
            ? `You are ${agentName}, a compassionate AI wellness companion. Your role is to:
- Check in with users daily about their mental well-being
- Analyze the emotional tone of their messages (positive, neutral, or negative) and respond naturally
- Provide gentle, supportive responses in natural conversation
- Recommend appropriate mindfulness techniques and coping strategies directly in your responses
- Be empathetic, non-judgmental, and supportive

IMPORTANT: You are NOT a replacement for professional mental health care. If a user expresses serious distress, encourage them to seek professional help.

When analyzing emotional tone, consider:
- Word choice and language patterns
- Overall sentiment
- Intensity of emotions expressed
- Context of the conversation

When providing recommendations, match them to the user's emotional state and be specific and actionable. Provide recommendations naturally in your conversation - don't use function calls or JSON.

${checkInContext}

Respond naturally and conversationally. If the user shares how they're feeling, acknowledge their emotions and provide appropriate support and recommendations directly in your response.`
            : `You are ${agentName}, a compassionate AI wellness companion. Your role is to:
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

If the user asks to schedule a task, use the schedule tool to schedule the task.`;
          
          const result = streamText({
            system: systemPrompt,

            messages: convertToModelMessages(processedMessages),
            model,
            tools: toolsToUse,
            onFinish: onFinish as any,
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
   * Execute scheduled daily check-in - can use workflows or cron jobs based on preference
   */
  async executeDailyCheckIn(description: string, _task: Schedule<string>) {
    console.log(`[Cron Jobs] executeDailyCheckIn called at ${new Date().toISOString()}`);
    console.log(`[Cron Jobs] Description: ${description}, Task:`, _task?.id || "N/A");
    try {
      // Use workflows if enabled AND available
      if (this.USE_WORKFLOWS && this.env.CHECKIN_WORKFLOW) {
        const userId = this.state?.userId || "default";
        // Use the Durable Object's name/id - for default agent, use "default"
        const agentId = "default"; // The agent name used in routing
        
        // Trigger the check-in workflow
        // Get the worker URL from the request context or use default
        const workerUrl = "https://mindguard.nkemkaomeiza.workers.dev";
        
        await this.env.CHECKIN_WORKFLOW.create({
          userId,
          agentId,
          checkInTime: new Date().toISOString(),
          workerUrl: workerUrl
        });
        
        console.log(`[Workflows] Check-in workflow triggered for user ${userId}`);
      } else {
        // Use cron job approach (simple message sent directly)
        console.log(`[Cron Jobs] Executing daily check-in via cron job`);
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
      }
    } catch (error) {
      console.error("Error executing daily check-in:", error);
      // Fallback to simple message on error
      try {
        console.log(`[Fallback] Using cron job fallback due to error`);
        await this.saveMessages([
          ...this.messages,
          {
            id: generateId(),
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "Good morning! 🌅 It's time for your daily check-in. How are you feeling today?"
              }
            ],
            metadata: {
              createdAt: new Date()
            }
          }
        ]);
      } catch (fallbackError) {
        console.error("Error in fallback check-in message:", fallbackError);
      }
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
          agentName: "MindGuard",
          modelProvider: "openai"
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

      // TEMPORARY: Commented out for testing (cron runs every minute)
      // const [hour, minute] = checkInTime.split(':');

      // Cron: minute hour * * * (runs daily at specified time)
      // TEMPORARY: Changed to run every minute for testing
      // TODO: Change back to: const cronPattern = `${minute} ${hour} * * *`;
      const cronPattern = "* * * * *"; // Runs every minute

      // Check if daily check-in is already scheduled
      // Look for schedules that call executeDailyCheckIn
      const existingSchedules = this.getSchedules();
      console.log(`[Schedule] Existing schedules:`, existingSchedules.length);
      const hasDailyCheckIn = existingSchedules.some(
        schedule => schedule.callback === "executeDailyCheckIn"
      );

      if (!hasDailyCheckIn) {
        console.log(`[Schedule] Creating new schedule with pattern: ${cronPattern}`);
        const scheduleResult = await this.schedule(cronPattern, "executeDailyCheckIn", "Daily wellness check-in");
        console.log(`[Schedule] Schedule created successfully:`, scheduleResult?.id || "unknown");
        
        // Verify it was created
        const verifySchedules = this.getSchedules();
        console.log(`[Schedule] Total schedules after creation:`, verifySchedules.length);
        const verifyCheckIn = verifySchedules.find(s => s.callback === "executeDailyCheckIn");
        if (verifyCheckIn) {
          console.log(`[Schedule] Verified check-in schedule exists:`, {
            id: verifyCheckIn.id,
            callback: verifyCheckIn.callback,
            type: verifyCheckIn.type,
            time: verifyCheckIn.time ? new Date(verifyCheckIn.time).toISOString() : "N/A",
            cron: (verifyCheckIn as any).cron || "N/A"
          });
        } else {
          console.error(`[Schedule] ERROR: Check-in schedule was not found after creation!`);
        }
      } else {
        console.log(`[Schedule] Daily check-in already scheduled, skipping creation`);
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
   * Get model provider preference
   */
  async getModelProvider(): Promise<"openai" | "workers-ai"> {
    try {
      // First check state
      if (this.state?.preferences?.modelProvider) {
        return this.state.preferences.modelProvider;
      }

      // If not in state, check database
      const userId = this.state?.userId || "default";
      try {
        const result = await this.sql<{ model_provider: string }>`
          SELECT model_provider FROM user_preferences 
          WHERE user_id = ${userId} 
          LIMIT 1
        `;

        if (result && result.length > 0 && result[0].model_provider) {
          const provider = result[0].model_provider as "openai" | "workers-ai";
          if (provider === "openai" || provider === "workers-ai") {
            return provider;
          }
        }
      } catch (error) {
        // Column might not exist yet, fall through to default
        console.error("Error querying model_provider:", error);
      }

      // Default to OpenAI
      return "openai";
    } catch (error) {
      console.error("Error getting model provider:", error);
      return "openai";
    }
  }

  /**
   * Update model provider preference
   */
  async updateModelProvider(provider: "openai" | "workers-ai"): Promise<void> {
    try {
      const userId = this.state?.userId || "default";
      const now = new Date().toISOString();

      // Update database
      await this.sql`
        INSERT INTO user_preferences (user_id, model_provider, updated_at)
        VALUES (${userId}, ${provider}, ${now})
        ON CONFLICT(user_id) DO UPDATE SET
          model_provider = ${provider},
          updated_at = ${now}
      `;

      // Update state
      this.setState({
        ...this.state,
        preferences: {
          ...this.state?.preferences,
          modelProvider: provider,
          checkInTime: this.state?.preferences?.checkInTime || "09:00",
          timezone: this.state?.preferences?.timezone || "UTC",
          agentName: this.state?.preferences?.agentName || "MindGuard"
        }
      });
    } catch (error) {
      console.error("Error updating model provider:", error);
      throw error;
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
            agentName: "MindGuard",
            modelProvider: "openai"
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

    // Handle internal update-model-provider request
    if ((pathname === "/internal/update-model-provider" || pathname.endsWith("/internal/update-model-provider")) && request.method === "POST") {
      try {
        await this.initializeDatabase();
        const body = await request.json() as { provider?: string };
        const { provider } = body;

        if (!provider || (provider !== "openai" && provider !== "workers-ai")) {
          return Response.json(
            { error: "Invalid provider. Must be 'openai' or 'workers-ai'" },
            { status: 400 }
          );
        }

        await this.updateModelProvider(provider as "openai" | "workers-ai");
        return Response.json({ success: true, provider });
      } catch (error) {
        console.error("Error in onRequest update-model-provider:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to update model provider" },
          { status: 500 }
        );
      }
    }

    // Handle workflow internal endpoints
    if (pathname === "/internal/send-check-in-message" || pathname.endsWith("/internal/send-check-in-message")) {
      if (request.method === "POST") {
        try {
          const body = await request.json() as { message?: string };
          const { message } = body;

          if (!message) {
            return Response.json({ error: "Message is required" }, { status: 400 });
          }

          await this.saveMessages([
            ...this.messages,
            {
              id: generateId(),
              role: "assistant",
              parts: [{ type: "text", text: message }],
              metadata: { createdAt: new Date() }
            }
          ]);

          return Response.json({ success: true });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to send message" },
            { status: 500 }
          );
        }
      }
    }

    if (pathname === "/internal/analyze-tone" || pathname.endsWith("/internal/analyze-tone")) {
      if (request.method === "POST") {
        try {
          const body = await request.json() as { message?: string };
          const { message } = body;

          if (!message) {
            return Response.json({ error: "Message is required" }, { status: 400 });
          }

          // Simple tone analysis - can be enhanced with AI
          const lowerMessage = message.toLowerCase();
          let tone = "neutral";
          let intensity = 5;

          if (lowerMessage.includes("good") || lowerMessage.includes("great") || lowerMessage.includes("happy") || lowerMessage.includes("excited")) {
            tone = "positive";
            intensity = 7;
          } else if (lowerMessage.includes("bad") || lowerMessage.includes("sad") || lowerMessage.includes("angry") || lowerMessage.includes("worried") || lowerMessage.includes("anxious")) {
            tone = "negative";
            intensity = 7;
          }

          return Response.json({ tone, intensity, keywords: [] });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to analyze tone" },
            { status: 500 }
          );
        }
      }
    }

    if (pathname === "/internal/get-recommendations" || pathname.endsWith("/internal/get-recommendations")) {
      if (request.method === "POST") {
        try {
          const body = await request.json() as { emotionalTone?: string; intensity?: number };
          const { emotionalTone = "neutral" } = body;

          // Get recommendations based on tone
          const recommendations = {
            positive: [
              "Practice gratitude journaling - write down 3 things you're grateful for today",
              "Share your positive energy with others - reach out to a friend or loved one",
              "Set new goals while feeling motivated - channel this energy into something meaningful"
            ],
            neutral: [
              "Take a mindful walk - focus on your breathing and surroundings",
              "Practice deep breathing exercises - 4-7-8 technique",
              "Try a new hobby or activity - explore something that interests you"
            ],
            negative: [
              "Practice 4-7-8 breathing technique - inhale for 4, hold for 7, exhale for 8",
              "Write down your feelings in a journal - express what you're experiencing",
              "Consider talking to a trusted friend or professional - you don't have to go through this alone"
            ]
          };

          const toneKey = emotionalTone.toLowerCase() as keyof typeof recommendations;
          const recs = recommendations[toneKey] || recommendations.neutral;

          return Response.json({ recommendations: recs });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to get recommendations" },
            { status: 500 }
          );
        }
      }
    }

    if (pathname === "/internal/save-check-in" || pathname.endsWith("/internal/save-check-in")) {
      if (request.method === "POST") {
        try {
          await this.initializeDatabase();
          const body = await request.json() as { emotionalTone?: string; summary?: string; recommendations?: string[] };
          const { emotionalTone, summary, recommendations = [] } = body;

          if (!emotionalTone || !summary) {
            return Response.json({ error: "Emotional tone and summary are required" }, { status: 400 });
          }

          await this.saveCheckIn(emotionalTone, summary, recommendations);
          return Response.json({ success: true });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to save check-in" },
            { status: 500 }
          );
        }
      }
    }

    if (pathname === "/internal/send-message" || pathname.endsWith("/internal/send-message")) {
      if (request.method === "POST") {
        try {
          const body = await request.json() as { message?: string };
          const { message } = body;

          if (!message) {
            return Response.json({ error: "Message is required" }, { status: 400 });
          }

          await this.saveMessages([
            ...this.messages,
            {
              id: generateId(),
              role: "assistant",
              parts: [{ type: "text", text: message }],
              metadata: { createdAt: new Date() }
            }
          ]);

          return Response.json({ success: true });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to send message" },
            { status: 500 }
          );
        }
      }
    }

    // Handle get-messages endpoint (used by useAgentChat to fetch initial messages)
    if ((pathname === "/get-messages" || pathname.endsWith("/get-messages")) && request.method === "GET") {
      try {
        // Return the current messages from the agent
        // AIChatAgent stores messages in this.messages
        return Response.json(this.messages || []);
      } catch (error) {
        console.error("Error getting messages:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to get messages" },
          { status: 500 }
        );
      }
    }

    // TEST ENDPOINT: Manually trigger check-in (for testing cron jobs)
    if ((pathname === "/test-check-in" || pathname.endsWith("/test-check-in")) && request.method === "POST") {
      try {
        console.log("[TEST] Manually triggering check-in...");
        await this.executeDailyCheckIn("Manual test check-in", {} as any);
        return Response.json({ success: true, message: "Check-in triggered manually" });
      } catch (error) {
        console.error("Error in test check-in:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to trigger check-in" },
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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

    // Handle model provider update endpoint
    if (url.pathname === "/api/update-model-provider" && request.method === "POST") {
      try {
        const body = await request.json() as { provider?: string };
        const provider = body.provider;

        if (!provider || (provider !== "openai" && provider !== "workers-ai")) {
          return Response.json(
            { error: "Invalid provider. Must be 'openai' or 'workers-ai'" },
            { status: 400 }
          );
        }

        // Create a properly formatted request that routeAgentRequest can handle
        const agentRequestUrl = new URL("/agents/mindguard/default/internal/update-model-provider", request.url);
        const agentRequest = new Request(agentRequestUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ provider })
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
        console.error("Error updating model provider:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to update model provider" },
          { status: 500 }
        );
      }
    }

    // Test endpoint: Trigger workflow manually
    if (url.pathname === "/api/test-workflow" && request.method === "POST") {
      try {
        if (!env.CHECKIN_WORKFLOW) {
          return Response.json(
            { error: "Workflow binding not available" },
            { status: 500 }
          );
        }

        const body = await request.json() as { userId?: string; agentId?: string };
        const userId = body.userId || "test-user";
        const agentId = body.agentId || "default";

        const instance = await env.CHECKIN_WORKFLOW.create({
          userId,
          agentId,
          checkInTime: new Date().toISOString()
        });

        return Response.json({
          success: true,
          instanceId: instance.id,
          message: "Workflow triggered successfully"
        });
      } catch (error) {
        console.error("Error triggering workflow:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to trigger workflow" },
          { status: 500 }
        );
      }
    }

    // Test endpoint: Send event to workflow
    if (url.pathname === "/api/test-workflow-event" && request.method === "POST") {
      try {
        if (!env.CHECKIN_WORKFLOW) {
          return Response.json(
            { error: "Workflow binding not available" },
            { status: 500 }
          );
        }

        const body = await request.json() as { instanceId?: string; response?: string };
        const instanceId = body.instanceId;
        const response = body.response;

        if (!instanceId || !response) {
          return Response.json(
            { error: "instanceId and response are required" },
            { status: 400 }
          );
        }

        const instance = await env.CHECKIN_WORKFLOW.get(instanceId);
        await instance.sendEvent("user-check-in-response", {
          userId: "test-user",
          response: response
        });

        return Response.json({
          success: true,
          message: "Event sent successfully"
        });
      } catch (error) {
        console.error("Error sending event:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to send event" },
          { status: 500 }
        );
      }
    }

    // Test endpoint: Get workflow status
    if (url.pathname === "/api/workflow-status" && request.method === "GET") {
      try {
        if (!env.CHECKIN_WORKFLOW) {
          return Response.json(
            { error: "Workflow binding not available" },
            { status: 500 }
          );
        }

        const instanceId = url.searchParams.get("instanceId");
        if (!instanceId) {
          return Response.json(
            { error: "instanceId query parameter is required" },
            { status: 400 }
          );
        }

        const instance = await env.CHECKIN_WORKFLOW.get(instanceId);
        const status = await instance.status();

        return Response.json({
          success: true,
          status: status
        });
      } catch (error) {
        console.error("Error getting workflow status:", error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to get workflow status" },
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
