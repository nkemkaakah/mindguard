# 🛡️ MindGuard - AI Wellness Companion

**Live Demo:** [https://mindguard.nkemkaomeiza.workers.dev/](https://mindguard.nkemkaomeiza.workers.dev/)

MindGuard is an AI-powered wellness companion built on Cloudflare Workers that helps users track their mental well-being through daily check-ins, emotional tone analysis, and personalized mindfulness recommendations.

## ✨ Features

### Core Wellness Features
- **Daily Check-ins** - Proactive wellness check-ins with automated scheduling
- **Emotional Tone Analysis** - AI-powered analysis of user messages (positive/neutral/negative)
- **Mindfulness Recommendations** - Personalized coping techniques based on emotional state
- **Check-in History** - Track your wellness journey over time with persistent storage
- **Voice Input** - Speak your thoughts using browser-based speech recognition
- **Model Provider Switching** - Choose between OpenAI GPT-4 or Cloudflare Workers AI (Llama 3.3)

### User Experience Features
- **Customizable Agent Name** - Personalize your AI companion's name
- **Dark/Light Theme** - Toggle between themes with persistent preferences
- **Real-time Chat Interface** - Stream responses with modern, responsive UI
- **Message History** - Persistent conversation history across sessions
- **Task Scheduling** - Schedule one-time, delayed, or recurring tasks using cron patterns

### Technical Features
- **Durable Objects** - Persistent state management and real-time communication
- **SQLite Database** - Embedded database for check-in history and preferences
- **Cloudflare Workflows** - Optional workflow orchestration for complex check-in processes
- **WebSocket Support** - Real-time bidirectional communication
- **Tool System** - Extensible tool framework for AI capabilities

## 🚀 Quick Start

### Try It Online

Visit the live deployment: **[https://mindguard.nkemkaomeiza.workers.dev/](https://mindguard.nkemkaomeiza.workers.dev/)**

No setup required - just start chatting with MindGuard!

### Run Locally

#### Prerequisites

- Node.js 18+ and npm
- Cloudflare account
- OpenAI API key (optional - can use Workers AI instead)

#### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd mindguard
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**

   Create a `.dev.vars` file in the root directory:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   ```

   > **Note:** If you prefer to use Cloudflare Workers AI (Llama 3.3), you don't need an OpenAI API key. The app will automatically use Workers AI when OpenAI is not configured.

4. **Run locally**
   ```bash
   npm start
   ```

   The app will be available at `http://localhost:5173`

5. **Deploy to Cloudflare**
   ```bash
   npm run deploy
   ```

   For production, set your OpenAI API key as a secret:
   ```bash
   wrangler secret put OPENAI_API_KEY
   ```

## 📖 Usage Guide

### Getting Started

1. **Start a Conversation**
   - Simply type a message about how you're feeling
   - Example: "I'm feeling stressed about work today"

2. **Voice Input**
   - Click the microphone icon in the input area
   - Speak your message (requires browser support)
   - Click stop when finished

3. **Switch AI Models**
   - Click the model provider dropdown in the header (GPT-4 / Llama 3.3)
   - Select your preferred model

4. **Customize Your Agent**
   - Click the pencil icon next to the agent name
   - Enter a custom name (up to 50 characters)
   - Press Enter or click the checkmark to save

### Daily Check-ins

**Manual Check-in:**
- Tell MindGuard how you're feeling
- The AI will analyze your emotional tone
- Receive personalized mindfulness recommendations
- Your check-in is automatically saved

**Scheduled Check-ins:**
- Ask MindGuard to schedule daily check-ins
- Example: "Schedule a daily check-in at 9 AM"
- MindGuard will proactively message you at the scheduled time

**View History:**
- Ask: "Show me my check-in history"
- View past emotional states and summaries
- Track your wellness journey over time

### Task Scheduling

MindGuard supports flexible task scheduling:

- **One-time tasks:** "Remind me to meditate tomorrow at 8 PM"
- **Delayed tasks:** "Remind me in 30 minutes to take a break"
- **Recurring tasks:** "Schedule a daily wellness reminder at 9 AM"

### Example Conversations

```
You: I'm feeling anxious about my presentation tomorrow

MindGuard: I understand that presentations can be stressful. Let me help you with some 
strategies to manage this anxiety. Would you like me to analyze your emotional state 
and provide some personalized recommendations?

You: Yes, please

MindGuard: [Analyzes tone] Based on your message, I detect a negative emotional tone 
with moderate intensity. Here are some recommendations:
- Practice 4-7-8 breathing technique
- Write down your feelings in a journal
- Try progressive muscle relaxation
- Consider talking to a trusted friend

Would you like me to save this check-in?
```

## 🏗️ Project Structure

```
mindguard/
├── src/
│   ├── app.tsx              # Main React chat interface
│   ├── server.ts            # MindGuard agent implementation
│   ├── tools.ts             # AI tool definitions
│   ├── utils.ts             # Helper functions
│   ├── workflows/
│   │   └── checkInWorkflow.ts  # Optional workflow for check-ins
│   ├── components/          # React UI components
│   │   ├── button/
│   │   ├── card/
│   │   ├── dropdown/
│   │   ├── tooltip/
│   │   └── ...
│   └── styles.css           # Global styles
├── public/                  # Static assets
├── wrangler.jsonc          # Cloudflare Workers configuration
├── package.json            # Dependencies and scripts
└── README.md              # This file
```

## 🔧 Configuration

### Environment Variables

- `OPENAI_API_KEY` - Your OpenAI API key (optional if using Workers AI)

### Wrangler Configuration

The `wrangler.jsonc` file configures:
- Durable Objects for state management
- Workers AI binding for Llama 3.3
- SQLite database migrations
- Workflows (optional)
- Static assets

### Model Providers

**OpenAI (GPT-4):**
- Requires `OPENAI_API_KEY` in environment
- High-quality responses
- Paid service

**Workers AI (Llama 3.3):**
- No API key required
- Free tier available
- Runs on Cloudflare's edge network

## 🛠️ Development

### Available Scripts

- `npm start` - Start development server
- `npm run deploy` - Build and deploy to Cloudflare
- `npm test` - Run tests
- `npm run format` - Format code with Prettier
- `npm run check` - Run linting and type checking

### Key Technologies

- **Cloudflare Workers** - Serverless runtime
- **Cloudflare Agents SDK** - AI agent framework
- **Durable Objects** - Persistent state
- **React** - UI framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Vite** - Build tool

## 📊 Architecture

### Agent System

MindGuard extends `AIChatAgent` from Cloudflare's Agents SDK:
- Handles WebSocket connections for real-time chat
- Manages conversation state and history
- Provides tool execution capabilities
- Supports scheduled tasks

### Data Storage

- **SQLite Database** - Embedded database for:
  - Check-in records (date, tone, summary, recommendations)
  - User preferences (check-in time, timezone, agent name, model provider)
- **Reactive State** - Real-time state synchronization via `setState()`

### Tool System

Tools are functions the AI can call:
- `analyzeEmotionalTone` - Analyzes message sentiment
- `getMindfulnessRecommendations` - Provides coping strategies
- `saveCheckInData` - Persists check-ins
- `getCheckInHistory` - Retrieves past check-ins
- `scheduleTask` - Schedules future tasks
- `updateAgentName` - Customizes agent name

## 🔐 Privacy & Security

- All data is stored locally in your Durable Object instance
- No data is shared between users
- Conversations are private to your session
- Check-in history persists across sessions

## ⚠️ Important Note

**MindGuard is not a replacement for professional mental health care.** If you're experiencing a crisis or serious mental health concerns, please seek immediate professional help.

## 📚 Learn More

- [Cloudflare Agents Documentation](https://developers.cloudflare.com/agents/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)

## 📝 License

MIT

## 🙏 Acknowledgments

Built with [Cloudflare Agents SDK](https://www.npmjs.com/package/agents) and powered by Cloudflare Workers.
