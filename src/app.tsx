/** biome-ignore-all lint/correctness/useUniqueElementIds: it's alright */
import { useEffect, useState, useRef, useCallback, use } from "react";
import { useAgent } from "agents/react";
import { isToolUIPart } from "ai";
import { useAgentChat } from "agents/ai-react";
import type { UIMessage } from "@ai-sdk/react";
import type { tools } from "./tools";

// TypeScript definitions for Web Speech API
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

declare global {
  interface Window {
    SpeechRecognition: {
      new (): SpeechRecognition;
    };
    webkitSpeechRecognition: {
      new (): SpeechRecognition;
    };
  }
}

// Component imports
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { Textarea } from "@/components/textarea/Textarea";
import { MemoizedMarkdown } from "@/components/memoized-markdown";
import { ToolInvocationCard } from "@/components/tool-invocation-card/ToolInvocationCard";
import { DropdownMenu } from "@/components/dropdown/DropdownMenu";

// Icon imports
import {
  Moon,
  Robot,
  Sun,
  PaperPlaneTilt,
  Stop,
  PencilSimple,
  Check,
  X,
  Trash,
  Microphone,
  Paperclip,
  CaretDown
} from "@phosphor-icons/react";

// List of tools that require human confirmation
// NOTE: this should match the tools that don't have execute functions in tools.ts
const toolsRequiringConfirmation: (keyof typeof tools)[] = [];

export default function Chat() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    // Check localStorage first, default to dark if not found
    const savedTheme = localStorage.getItem("theme");
    return (savedTheme as "dark" | "light") || "dark";
  });
  const [showDebug] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState("auto");
  const [agentName, setAgentName] = useState("MindGuard");
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("MindGuard");
  const [modelProvider, setModelProvider] = useState<"openai" | "workers-ai">("openai");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const manuallyStoppedRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    // Apply theme class on mount and when theme changes
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    }

    // Save theme preference to localStorage
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Scroll to bottom on mount
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
  };

  // Check if Speech Recognition is supported
  const isSpeechRecognitionSupported = () => {
    return (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  };

  // Initialize Speech Recognition
  const initializeRecognition = useCallback(() => {
    if (!isSpeechRecognitionSupported()) {
      return null;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    const recognition = new SpeechRecognition();
    recognition.continuous = true; // Keep listening until manually stopped
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      setAgentInput((prev) => prev + (prev ? " " : "") + transcript);
      setRecognitionError(null);
      // Don't stop recording - keep listening for more speech
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("Speech recognition error:", event.error);
      
      // Only stop on critical errors, not on "no-speech" which is normal
      if (event.error === "audio-capture" || event.error === "not-allowed" || event.error === "network") {
        setIsRecording(false);
        manuallyStoppedRef.current = false;
        
        let errorMessage = "Speech recognition failed. Please try again.";
        if (event.error === "audio-capture") {
          errorMessage = "Microphone not found. Please check your microphone.";
        } else if (event.error === "not-allowed") {
          errorMessage = "Microphone permission denied. Please allow microphone access.";
        } else if (event.error === "network") {
          errorMessage = "Network error. Please check your connection.";
        }
        
        setRecognitionError(errorMessage);
        // Clear error after 5 seconds
        setTimeout(() => setRecognitionError(null), 5000);
      }
      // Ignore "no-speech" errors - they're normal when user pauses
    };

    recognition.onend = () => {
      // Only update state if it wasn't manually stopped (manual stop already updated state)
      if (!manuallyStoppedRef.current && isRecording) {
        // Recognition ended unexpectedly, restart it if we're still supposed to be recording
        if (recognitionRef.current && isRecording) {
          try {
            recognitionRef.current.start();
          } catch (error) {
            // If restart fails, stop recording
            setIsRecording(false);
            setRecognitionError("Recording stopped unexpectedly. Please try again.");
            setTimeout(() => setRecognitionError(null), 5000);
          }
        }
      } else {
        manuallyStoppedRef.current = false; // Reset flag
      }
    };

    return recognition;
  }, []);

  // Start voice recording
  const handleStartRecording = useCallback(() => {
    if (!isSpeechRecognitionSupported()) {
      setRecognitionError("Voice input is not supported in your browser. Please use Chrome or Edge.");
      setTimeout(() => setRecognitionError(null), 5000);
      return;
    }

    // Reset manual stop flag
    manuallyStoppedRef.current = false;
    
    // Create new recognition instance each time to ensure clean state
    recognitionRef.current = initializeRecognition();

    if (recognitionRef.current) {
      try {
        setRecognitionError(null);
        setIsRecording(true);
        recognitionRef.current.start();
      } catch (error) {
        console.error("Error starting recognition:", error);
        setIsRecording(false);
        setRecognitionError("Failed to start recording. Please try again.");
        setTimeout(() => setRecognitionError(null), 5000);
      }
    }
  }, [initializeRecognition, isRecording]);

  // Stop voice recording
  const handleStopRecording = useCallback(() => {
    if (recognitionRef.current && isRecording) {
      try {
        manuallyStoppedRef.current = true; // Mark as manually stopped
        recognitionRef.current.stop();
        setIsRecording(false);
      } catch (error) {
        console.error("Error stopping recognition:", error);
        manuallyStoppedRef.current = true;
        setIsRecording(false);
      }
    }
  }, [isRecording]);

  // Start recording (microphone button only starts, doesn't stop)
  const handleStartRecordingClick = useCallback(() => {
    if (!isRecording) {
      handleStartRecording();
    }
  }, [isRecording, handleStartRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (error) {
          // Ignore errors on cleanup
        }
      }
    };
  }, []);

  const agent = useAgent({
    agent: "mindguard",
    onStateUpdate: (newState: any) => {
      // Sync agent name from state
      if (newState?.preferences?.agentName) {
        setAgentName(newState.preferences.agentName);
        setEditNameValue(newState.preferences.agentName);
      }
      // Sync model provider from state
      if (newState?.preferences?.modelProvider) {
        setModelProvider(newState.preferences.modelProvider);
      }
    }
  });

  // State will sync automatically via onStateUpdate when agent connects
  // The agent name will be loaded from database/state when first message is sent

  const [agentInput, setAgentInput] = useState("");
  const handleAgentInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setAgentInput(e.target.value);
  };

  const handleAgentSubmit = async (
    e: React.FormEvent,
    extraData: Record<string, unknown> = {}
  ) => {
    e.preventDefault();
    
    // Input validation
    const trimmedInput = agentInput.trim();
    if (!trimmedInput) return;
    
    // Limit message length to prevent abuse
    if (trimmedInput.length > 5000) {
      alert("Message is too long. Please keep it under 5000 characters.");
      return;
    }

    const message = trimmedInput;
    setAgentInput("");

    try {
      // Send message to agent with timestamp
      await sendMessage(
        {
          role: "user",
          parts: [{ type: "text", text: message }],
          metadata: {
            createdAt: new Date().toISOString()
          }
        },
        {
          body: extraData
        }
      );
    } catch (error) {
      console.error("Error sending message:", error);
      // Optionally show user-friendly error message
      setAgentInput(message); // Restore message on error
    }
  };

  const {
    messages: agentMessages,
    addToolResult,
    status,
    sendMessage,
    stop,
    clearHistory
  } = useAgentChat<unknown, UIMessage<{ createdAt: string }>>({
    agent
  });

  // Scroll to bottom when messages change
  useEffect(() => {
    agentMessages.length > 0 && scrollToBottom();
  }, [agentMessages, scrollToBottom]);

  const pendingToolCallConfirmation = agentMessages.some((m: UIMessage) =>
    m.parts?.some(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        // Manual check inside the component
        toolsRequiringConfirmation.includes(
          part.type.replace("tool-", "") as keyof typeof tools
        )
    )
  );

  const handleUpdateAgentName = async () => {
    const trimmedName = editNameValue.trim();
    if (!trimmedName) {
      alert("Agent name cannot be empty");
      setEditNameValue(agentName);
      setIsEditingName(false);
      return;
    }

    if (trimmedName.length > 50) {
      alert("Agent name must be 50 characters or less");
      setEditNameValue(agentName);
      setIsEditingName(false);
      return;
    }

    // Store original name for potential rollback
    const originalName = agentName;

    try {
      // Update state immediately for instant UI feedback
      setAgentName(trimmedName);
      setIsEditingName(false);

      // Call the API endpoint to update the name in the backend
      const response = await fetch("/api/update-agent-name", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: trimmedName })
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || "Failed to update agent name");
      }

      // State will sync automatically via onStateUpdate callback
      // But we've already updated it locally for instant feedback
    } catch (error) {
      console.error("Error updating agent name:", error);
      // Revert on error
      setAgentName(originalName);
      setEditNameValue(originalName);
      alert(error instanceof Error ? error.message : "Failed to update agent name");
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const handleUpdateModelProvider = async (provider: "openai" | "workers-ai") => {
    // Store original provider for potential rollback
    const originalProvider = modelProvider;

    try {
      // Update state immediately for instant UI feedback
      setModelProvider(provider);

      // Call the API endpoint to update the provider in the backend
      const response = await fetch("/api/update-model-provider", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ provider })
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || "Failed to update model provider");
      }

      // State will sync automatically via onStateUpdate callback
    } catch (error) {
      console.error("Error updating model provider:", error);
      // Revert on error
      setModelProvider(originalProvider);
      alert(error instanceof Error ? error.message : "Failed to update model provider");
    }
  };

  const handleDeleteChat = () => {
    const confirmed = window.confirm(
      "Are you sure you want to delete all chat messages? This will permanently remove all conversation history and cannot be undone."
    );
    if (confirmed) {
      clearHistory();
    }
  };

  // Get last seen time (for now, just show current time formatted)- Not in Use
  // const getLastSeenTime = () => {
  //   const now = new Date();
  //   const hours = now.getHours();
  //   const minutes = now.getMinutes();
  //   const ampm = hours >= 12 ? 'PM' : 'AM';
  //   const displayHours = hours % 12 || 12;
  //   const displayMinutes = minutes.toString().padStart(2, '0');
  //   return `today at ${displayHours}:${displayMinutes} ${ampm}`;
  // };

  return (
    <div className="h-[100vh] w-full bg-neutral-100 dark:bg-neutral-950 flex justify-center items-center overflow-hidden">
      <HasOpenAIKey />
      
      <div className="h-[100vh] w-full max-w-2xl flex flex-col bg-white dark:bg-neutral-900 shadow-2xl relative">
        {/* Modern Header */}
        <div className="px-6 py-4 bg-neutral-800 dark:bg-neutral-900 border-b border-neutral-700 dark:border-neutral-800 sticky top-0 ">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-1">
              {isEditingName ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={editNameValue}
                    onChange={(e) => setEditNameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleUpdateAgentName();
                      } else if (e.key === "Escape") {
                        setEditNameValue(agentName);
                        setIsEditingName(false);
                      }
                    }}
                    className="bg-neutral-700 dark:bg-neutral-800 border border-[#F48120] rounded-lg px-3 py-1.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#F48120]/50"
                    autoFocus
                    maxLength={50}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    className="h-7 w-7 p-0 text-green-400 hover:text-green-300"
                    onClick={handleUpdateAgentName}
                    aria-label="Save name"
                  >
                    <Check size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                    onClick={() => {
                      setEditNameValue(agentName);
                      setIsEditingName(false);
                    }}
                    aria-label="Cancel"
                  >
                    <X size={16} />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-1">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F48120] to-orange-600 flex items-center justify-center text-white font-semibold text-sm">
                        {agentName.charAt(0).toUpperCase()}
                      </div>
                      <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-neutral-800 dark:border-neutral-900"></div>
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <h2 className="font-semibold text-base text-white">{agentName}</h2>
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          className="h-5 w-5 p-0 opacity-60 hover:opacity-100 text-neutral-300"
                          onClick={() => setIsEditingName(true)}
                          aria-label="Edit agent name"
                        >
                          <PencilSimple size={12} />
                        </Button>
                        <DropdownMenu
                          align="start"
                          side="bottom"
                          MenuItems={[
                            {
                              type: "button",
                              label: modelProvider === "openai" ? "✓ OpenAI" : "OpenAI",
                              onClick: () => handleUpdateModelProvider("openai"),
                              checked: modelProvider === "openai"
                            },
                            {
                              type: "button",
                              label: modelProvider === "workers-ai" ? "✓ Workers AI" : "Workers AI",
                              onClick: () => handleUpdateModelProvider("workers-ai"),
                              checked: modelProvider === "workers-ai"
                            }
                          ]}
                        >
                          <div className="flex items-center gap-1 text-neutral-300 hover:text-white z-20 cursor-pointer">
                            <span className="text-[10px] font-medium uppercase">
                              {modelProvider === "openai" ? "GPT-4" : "Llama 3.3"}
                            </span>
                            <CaretDown size={10} weight="bold" />
                          </div>
                        </DropdownMenu>
                      </div>
                      {/* <p className="text-xs text-neutral-400">Last seen {getLastSeenTime()}</p> */}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1">
            
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="h-9 w-9 text-neutral-300 hover:text-white hover:bg-neutral-700"
                onClick={toggleTheme}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
              </Button>
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="h-9 w-9 text-neutral-300 hover:text-red-400 hover:bg-neutral-700"
                onClick={handleDeleteChat}
                aria-label="Delete chat"
              >
                <Trash size={20} />
              </Button>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3 pb-24 bg-neutral-50 dark:bg-neutral-950">
          {agentMessages.length === 0 && (
            <div className="h-full flex items-center justify-center">
              <Card className="p-8 max-w-md mx-auto bg-white dark:bg-neutral-900 shadow-lg rounded-2xl">
                <div className="text-center space-y-4">
                  <div className="bg-gradient-to-br from-[#F48120] to-orange-600 text-white rounded-full p-4 inline-flex">
                    <Robot size={32} />
                  </div>
                  <h3 className="font-semibold text-xl text-neutral-900 dark:text-white">Welcome to MindGuard</h3>
                  <p className="text-neutral-600 dark:text-neutral-300 text-sm">
                    Your AI wellness companion for daily check-ins and emotional support.
                  </p>
                  <p className="text-neutral-500 dark:text-neutral-400 text-xs">
                    I'm here to help you track your mental well-being, analyze your emotional state, 
                    and provide personalized mindfulness recommendations.
                  </p>
                  <ul className="text-sm text-left space-y-2 mt-6 text-neutral-700 dark:text-neutral-300">
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120] font-bold">•</span>
                      <span>Share how you're feeling today</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120] font-bold">•</span>
                      <span>Get personalized mindfulness recommendations</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120] font-bold">•</span>
                      <span>View your check-in history</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120] font-bold">•</span>
                      <span>Schedule daily wellness check-ins</span>
                    </li>
                  </ul>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                    <strong>Note:</strong> MindGuard is not a replacement for professional mental health care. 
                    If you're experiencing a crisis, please seek immediate professional help.
                  </p>
                </div>
              </Card>
            </div>
          )}

          {agentMessages.map((m, index) => {
            const isUser = m.role === "user";
            const showAvatar =
              index === 0 || agentMessages[index - 1]?.role !== m.role;

            return (
              <div key={m.id}>
                {showDebug && (
                  <pre className="text-xs text-muted-foreground overflow-scroll mb-2">
                    {JSON.stringify(m, null, 2)}
                  </pre>
                )}
                <div
                  className={`flex ${isUser ? "justify-end" : "justify-start"} items-end gap-2`}
                >
                  {!isUser && showAvatar && (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#F48120] to-orange-600 flex items-center justify-center text-white font-semibold text-xs flex-shrink-0">
                      {agentName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div
                    className={`flex flex-col gap-1 max-w-[75%] ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    {showAvatar && !isUser && (
                      <p className="text-xs font-medium text-[#F48120] px-2 mb-0.5">
                        {agentName}
                      </p>
                    )}

                    <div>
                      {m.parts?.map((part, i) => {
                        if (part.type === "text") {
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: immutable index
                            <div key={i} className="relative">
                              <div
                                className={`px-4 py-2.5 rounded-2xl ${
                                  isUser
                                    ? "bg-gradient-to-br from-blue-500 to-cyan-500 text-white rounded-br-sm"
                                    : "bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-bl-sm"
                                } ${
                                  part.text.startsWith("scheduled message")
                                    ? "border-2 border-[#F48120]/50"
                                    : ""
                                } shadow-sm`}
                              >
                                {part.text.startsWith("scheduled message") && (
                                  <span className="absolute -top-2 -left-2 text-lg">🕒</span>
                                )}
                                <div className={isUser ? "text-white [&_*]:text-white" : ""}>
                                  <MemoizedMarkdown
                                    id={`${m.id}-${i}`}
                                    content={part.text.replace(
                                      /^scheduled message: /,
                                      ""
                                    )}
                                  />
                                </div>
                              </div>
                              <p
                                className={`text-[10px] text-neutral-500 dark:text-neutral-400 mt-1 px-1 ${
                                  isUser ? "text-right" : "text-left"
                                }`}
                              >
                                {formatTime(
                                  m.metadata?.createdAt
                                    ? new Date(m.metadata.createdAt)
                                    : new Date()
                                )}
                              </p>
                            </div>
                          );
                        }

                        if (
                          isToolUIPart(part) &&
                          m.id.startsWith("assistant")
                        ) {
                          const toolCallId = part.toolCallId;
                          const toolName = part.type.replace("tool-", "");
                          const needsConfirmation =
                            toolsRequiringConfirmation.includes(
                              toolName as keyof typeof tools
                            );

                          // Skip rendering the card in debug mode
                          if (showDebug) return null;

                          return (
                            <ToolInvocationCard
                              // biome-ignore lint/suspicious/noArrayIndexKey: using index is safe here as the array is static
                              key={`${toolCallId}-${i}`}
                              toolUIPart={part}
                              toolCallId={toolCallId}
                              needsConfirmation={needsConfirmation}
                              onSubmit={({ toolCallId, result }) => {
                                addToolResult({
                                  tool: part.type.replace("tool-", ""),
                                  toolCallId,
                                  output: result
                                });
                              }}
                              addToolResult={(toolCallId, result) => {
                                addToolResult({
                                  tool: part.type.replace("tool-", ""),
                                  toolCallId,
                                  output: result
                                });
                              }}
                            />
                          );
                        }
                        return null;
                      })}
                      </div>
                    </div>
                  </div>
                </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Modern Input Area */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAgentSubmit(e, {
              annotations: {
                hello: "world"
              }
            });
            setTextareaHeight("auto");
          }}
          className="px-4 py-3 bg-white dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 sticky bottom-0 z-10"
        >
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="h-9 w-9 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                type="button"
                aria-label="Attach file"
              >
                <Paperclip size={20} />
              </Button>
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className={`h-9 w-9 transition-colors ${
                  isRecording
                    ? "text-red-500 hover:text-red-600 animate-pulse"
                    : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                } ${!isSpeechRecognitionSupported() ? "opacity-50 cursor-not-allowed" : ""} ${isRecording ? "cursor-not-allowed" : ""}`}
                type="button"
                aria-label="Start voice recording"
                onClick={handleStartRecordingClick}
                disabled={!isSpeechRecognitionSupported() || isRecording}
                title={
                  !isSpeechRecognitionSupported()
                    ? "Voice input not supported in this browser"
                    : isRecording
                      ? ""
                      : ""
                }
              >
                <Microphone size={20} weight={isRecording ? "fill" : "regular"} />
              </Button>
            </div>
            <div className="flex-1 relative">
              {isRecording ? (
                // Recording UI
                <div className="w-full border border-red-300 dark:border-red-700 px-1 py-1 pr-12 rounded-2xl bg-red-50 dark:bg-red-950/20 text-neutral-900 dark:text-neutral-100 min-h-[44px] flex items-center justify-center">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-8 bg-red-500 rounded-full animate-waveform" style={{ animationDelay: "0s" }}></div>
                      <div className="w-2 h-6 bg-red-500 rounded-full animate-waveform" style={{ animationDelay: "0.1s" }}></div>
                      <div className="w-2 h-10 bg-red-500 rounded-full animate-waveform" style={{ animationDelay: "0.2s" }}></div>
                      <div className="w-2 h-7 bg-red-500 rounded-full animate-waveform" style={{ animationDelay: "0.3s" }}></div>
                      <div className="w-2 h-9 bg-red-500 rounded-full animate-waveform" style={{ animationDelay: "0.4s" }}></div>
                    </div>
                    <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording...</span>
                  </div>
                  <div className="absolute bottom-2 right-2">
                    <button
                      type="button"
                      onClick={handleStopRecording}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 shadow-md"
                      aria-label="Stop recording"
                    >
                      <Stop size={16} weight="fill" />
                    </button>
                  </div>
                </div>
              ) : recognitionError ? (
                // Error state
                <div className="w-full border border-red-300 dark:border-red-700 px-4 py-3 pr-12 rounded-2xl bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 min-h-[44px] flex items-center">
                  <span className="text-sm">{recognitionError}</span>
                  <div className="absolute bottom-2 right-2">
                    <button
                      type="button"
                      onClick={() => setRecognitionError(null)}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
                      aria-label="Dismiss error"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                // Normal input state
                <>
                  <Textarea
                    disabled={pendingToolCallConfirmation}
                    placeholder={
                      pendingToolCallConfirmation
                        ? "Please respond to the tool confirmation above..."
                        : "Type a message..."
                    }
                    className="w-full border border-neutral-300 dark:border-neutral-700 px-4 py-3 pr-12 rounded-2xl bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 text-sm min-h-[44px] max-h-[120px] overflow-hidden resize-none"
                    value={agentInput}
                    onChange={(e) => {
                      handleAgentInputChange(e);
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                      setTextareaHeight(`${Math.min(e.target.scrollHeight, 120)}px`);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        handleAgentSubmit(e as unknown as React.FormEvent);
                        setTextareaHeight("auto");
                      }
                    }}
                    rows={1}
                    style={{ height: textareaHeight }}
                  />
                  <div className="absolute bottom-2 right-2">
                    {status === "submitted" || status === "streaming" ? (
                      <button
                        type="button"
                        onClick={stop}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                        aria-label="Stop generation"
                      >
                        <Stop size={16} />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-white hover:from-blue-600 hover:to-cyan-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 shadow-md"
                        disabled={pendingToolCallConfirmation || !agentInput.trim()}
                        aria-label="Send message"
                      >
                        <PaperPlaneTilt size={16} weight="fill" />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const hasOpenAiKeyPromise = fetch("/check-open-ai-key").then((res) =>
  res.json<{ success: boolean }>()
);

function HasOpenAIKey() {
  const hasOpenAiKey = use(hasOpenAiKeyPromise);

  if (!hasOpenAiKey.success) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-red-500/10 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-red-200 dark:border-red-900 p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                <svg
                  className="w-5 h-5 text-red-600 dark:text-red-400"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-labelledby="warningIcon"
                >
                  <title id="warningIcon">Warning Icon</title>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
                  OpenAI API Key Not Configured
                </h3>
                <p className="text-neutral-600 dark:text-neutral-300 mb-1">
                  Requests to the API, including from the frontend UI, will not
                  work until an OpenAI API key is configured.
                </p>
                <p className="text-neutral-600 dark:text-neutral-300">
                  Please configure an OpenAI API key by setting a{" "}
                  <a
                    href="https://developers.cloudflare.com/workers/configuration/secrets/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    secret
                  </a>{" "}
                  named{" "}
                  <code className="bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 font-mono text-sm">
                    OPENAI_API_KEY
                  </code>
                  . <br />
                  You can also use a different model provider by following these{" "}
                  <a
                    href="https://github.com/cloudflare/agents-starter?tab=readme-ov-file#use-a-different-ai-model-provider"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    instructions.
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
