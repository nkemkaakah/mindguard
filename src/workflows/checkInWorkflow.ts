/**
 * Check-In Workflow
 * Orchestrates the daily wellness check-in process with multiple steps:
 * 1. Send check-in message
 * 2. Wait for user response (with timeout)
 * 3. Analyze emotional tone
 * 4. Generate recommendations
 * 5. Save check-in to database
 * 6. Send summary to user
 */

import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

interface CheckInWorkflowInput {
  userId: string;
  agentId: string; // Durable Object ID for the agent
  checkInTime: string; // Time when check-in was triggered
  workerUrl?: string; // Worker URL for making HTTP requests
}

interface WorkflowEnv {
  // Workflows don't have direct access to Durable Objects
  // We'll use HTTP requests to the Worker instead
}

/**
 * Workflow for automated daily check-in process
 */
export class CheckInWorkflow extends WorkflowEntrypoint<WorkflowEnv, CheckInWorkflowInput> {
  async run(
    event: WorkflowEvent<CheckInWorkflowInput>,
    step: WorkflowStep
  ): Promise<void> {
    // Extract payload from event
    const input = event.payload;
    const agentId = input.agentId;
    // Use worker URL from input, or construct from current request context
    const workerUrl = input.workerUrl || "https://mindguard.nkemkaomeiza.workers.dev";

    // Step 1: Send check-in message to user
      await step.do("send-check-in-message", async () => {
        // Call Worker's HTTP endpoint instead of accessing Durable Object directly
        // Pattern: /agents/:agent/:name/internal/endpoint
        const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/send-check-in-message`;
        
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Good morning! 🌅 It's time for your daily check-in. How are you feeling today? Take a moment to reflect on your emotional state and share what's on your mind."
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to send check-in message: ${response.statusText}`);
        }

        return { success: true };
      });

      // Step 2: Wait for user response (with 24-hour timeout)
      const userResponseEvent = await step.waitForEvent("user-check-in-response", {
        type: "user-check-in-response",
        timeout: 24 * 60 * 60 // 24 hours in seconds
      });

      if (userResponseEvent) {
        const userResponseText = (userResponseEvent.payload as { response: string }).response;

        // Step 3: Analyze emotional tone
        const analysis = await step.do("analyze-emotional-tone", async () => {
          // Call Worker's HTTP endpoint
          const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/analyze-tone`;
          
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: userResponseText
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to analyze tone: ${response.statusText}`);
          }

          const data = await response.json() as { tone: string; intensity: number; keywords: string[] };
          
          return data;
        });

        // Step 4: Generate recommendations based on emotional tone
        const recommendationsResult = await step.do("generate-recommendations", async () => {
          // Call Worker's HTTP endpoint
          const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/get-recommendations`;
          
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              emotionalTone: analysis.tone,
              intensity: analysis.intensity || 5
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to get recommendations: ${response.statusText}`);
          }

          return await response.json() as { recommendations: string[] };
        });

        // Step 5: Save check-in to database
        await step.do("save-check-in", async () => {
          // Generate summary
          const summary = `Daily check-in: User reported feeling ${analysis.tone}. Response: ${userResponseText.substring(0, 200)}...`;

          // Call Worker's HTTP endpoint
          const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/save-check-in`;

          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              emotionalTone: analysis.tone,
              summary: summary,
              recommendations: recommendationsResult.recommendations || []
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to save check-in: ${response.statusText}`);
          }

          return { success: true };
        });

        // Step 6: Send summary to user
        await step.do("send-summary", async () => {
          const summaryMessage = `Thank you for your check-in! Based on your response, I've noted that you're feeling ${analysis.tone}. Here are some personalized recommendations:\n\n${recommendationsResult.recommendations?.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}\n\nTake care! 💙`;

          // Call Worker's HTTP endpoint
          const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/send-message`;

          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: summaryMessage
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to send summary: ${response.statusText}`);
          }

          return { success: true };
        });
      } else {
        // Timeout - user didn't respond
        await step.do("handle-timeout", async () => {
          // Call Worker's HTTP endpoint
          const endpoint = `${workerUrl}/agents/mindguard/${agentId}/internal/send-message`;

          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "I noticed you haven't responded to today's check-in. That's okay! Feel free to share how you're feeling whenever you're ready. I'm here for you. 💙"
            })
          });

          return { success: true, timeout: true };
        });
      }
  }
}
