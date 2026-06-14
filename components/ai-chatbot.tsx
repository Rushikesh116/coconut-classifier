"use client"

import { useEffect, useRef, useState } from "react"
import { Bot, Loader2, Mic, Send, Square, User, Volume2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface CopilotRow {
  [key: string]: string | number | boolean | null
}

interface ConversationMessage {
  role: "user" | "assistant"
  content: string
}

interface ChatMessage extends ConversationMessage {
  id: string
  data?: CopilotRow[]
  queryUsed?: string | null
}

interface CopilotResponse {
  answer: string
  data?: CopilotRow[]
  query_used?: string | null
}

interface SarvamSpeechResponse {
  transcript: string
  language_code?: string | null
  language_probability?: number | null
}

interface SarvamVoiceResponse {
  audio_base64: string
  audio_mime_type?: string
}

async function readApiError(response: Response, fallback: string) {
  try {
    const data = await response.json()
    return typeof data.error === "string" ? data.error : fallback
  } catch {
    return fallback
  }
}

const QUICK_PROMPTS = [
  "How many coconuts were graded today?",
  "What percentage are export suitable?",
  "Show me all Grade D coconuts",
  "What's the average weight by grade?",
]

const INITIAL_MESSAGE: ChatMessage = {
  id: "assistant-welcome",
  role: "assistant",
  content: "Hi! I’m your AI Copilot. Ask about coconut assessments, trends, grades, or export suitability.",
}

function formatCellValue(value: CopilotRow[string]) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No"
  }
  if (value === null || value === undefined || value === "") {
    return "-"
  }
  return String(value)
}

function getColumns(rows: CopilotRow[]) {
  const columns = new Set<string>()
  for (const row of rows) {
    Object.keys(row).forEach((key) => columns.add(key))
  }
  return Array.from(columns)
}

interface AIChatbotProps {
  onClose?: () => void
}

export function AIChatbot({ onClose }: AIChatbotProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isVoiceLoading, setIsVoiceLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isLoading])

  const playSarvamAnswer = async (text: string, languageCode?: string | null) => {
    try {
      const response = await fetch("http://localhost:5000/api/sarvam/text-to-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language_code: languageCode || "hi-IN",
        }),
      })

      if (!response.ok) {
        throw new Error(`Sarvam TTS failed with status ${response.status}`)
      }

      const data: SarvamVoiceResponse = await response.json()
      if (!data.audio_base64) return

      activeAudioRef.current?.pause()
      const audio = new Audio(`data:${data.audio_mime_type || "audio/wav"};base64,${data.audio_base64}`)
      activeAudioRef.current = audio
      await audio.play()
    } catch (error) {
      console.warn("Sarvam voice playback warning:", error)
    }
  }

  const handleSend = async (prefilledQuestion?: string, options?: { speakResponse?: boolean; languageCode?: string | null }) => {
    const userMessage = (prefilledQuestion ?? input).trim()
    if (!userMessage || isLoading) return

    const conversationHistory: ConversationMessage[] = messages.map(({ role, content }) => ({ role, content }))
    const newUserMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: userMessage,
    }

    setInput("")
    setMessages((prev) => [...prev, newUserMessage])
    setIsLoading(true)

    try {
      const response = await fetch("http://localhost:5000/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: userMessage,
          conversation_history: conversationHistory,
        }),
      })

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const data: CopilotResponse = await response.json()
      const answer = data.answer || "I couldn't generate a response just now."
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: answer,
          data: Array.isArray(data.data) ? data.data : [],
          queryUsed: data.query_used ?? null,
        },
      ])
      if (options?.speakResponse) {
        void playSarvamAnswer(answer, options.languageCode)
      }
    } catch (error) {
      console.error("Chatbot error:", error)
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: "Failed to connect to AI Copilot. Please check that the backend is running and try again.",
        },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const transcribeVoiceQuestion = async (audioBlob: Blob) => {
    setIsVoiceLoading(true)
    try {
      const formData = new FormData()
      formData.append("audio", audioBlob, "farmer-question.webm")
      formData.append("language_code", "unknown")

      const response = await fetch("http://localhost:5000/api/sarvam/speech-to-text", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const errorMessage = await readApiError(response, `Sarvam STT failed with status ${response.status}`)
        throw new Error(errorMessage)
      }

      const data: SarvamSpeechResponse = await response.json()
      const transcript = data.transcript?.trim()
      if (!transcript) {
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-voice-empty-${Date.now()}`,
            role: "assistant",
            content: "I couldn't hear a clear question. Please try recording again.",
          },
        ])
        return
      }

      setInput(transcript)
      await handleSend(transcript, { speakResponse: true, languageCode: data.language_code || "hi-IN" })
    } catch (error) {
      console.warn("Sarvam speech-to-text warning:", error)
      const message = error instanceof Error ? error.message : "Unknown Sarvam voice error."
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-voice-error-${Date.now()}`,
          role: "assistant",
          content: `Voice input is not available right now. ${message} You can still type the question.`,
        },
      ])
    } finally {
      setIsVoiceLoading(false)
    }
  }

  const startVoiceRecording = async () => {
    if (isLoading || isVoiceLoading || isRecording) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined })
      audioChunksRef.current = []
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" })
        void transcribeVoiceQuestion(audioBlob)
      }

      recorder.start()
      setIsRecording(true)
    } catch (error) {
      console.warn("Microphone warning:", error)
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-mic-error-${Date.now()}`,
          role: "assistant",
          content: "I couldn't access the microphone. Please allow microphone permission or type your question.",
        },
      ])
    }
  }

  const stopVoiceRecording = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") return
    mediaRecorderRef.current.stop()
    setIsRecording(false)
  }

  return (
    <div className="flex h-full flex-col border-l border-green-200 bg-white">
      <div className="border-b border-green-200 bg-green-50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-green-600" />
            <h2 className="font-semibold text-green-800">AI Copilot</h2>
          </div>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 text-green-700 hover:bg-green-100"
              aria-label="Close AI Copilot"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-green-600">
          <span>Ask questions about assessment history and coconut quality data.</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-medium text-green-700">
            <Volume2 className="h-3 w-3" />
            Sarvam voice enabled
          </span>
        </div>
      </div>

      <div className="border-b border-green-100 px-4 py-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-green-700">Quick prompts</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setInput(prompt)}
              disabled={isLoading}
              className="h-auto whitespace-normal border-green-200 text-left text-xs text-green-700 hover:bg-green-50"
            >
              {prompt}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message) => {
          const columns = message.data && message.data.length > 0 ? getColumns(message.data) : []

          return (
            <div
              key={message.id}
              className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {message.role === "assistant" && (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-green-100">
                  <Bot className="h-4 w-4 text-green-600" />
                </div>
              )}

              <div
                className={`max-w-[82%] rounded-2xl px-4 py-3 ${
                  message.role === "user" ? "bg-green-600 text-white" : "bg-gray-100 text-gray-800"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>

                {message.role === "assistant" && message.data && message.data.length > 0 && (
                  <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <Table className="text-xs">
                      <TableHeader>
                        <TableRow>
                          {columns.map((column) => (
                            <TableHead key={column} className="h-8 bg-gray-50 px-3 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
                              {column.replace(/_/g, " ")}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {message.data.map((row, rowIndex) => (
                          <TableRow key={`${message.id}-row-${rowIndex}`}>
                            {columns.map((column) => (
                              <TableCell key={`${message.id}-${rowIndex}-${column}`} className="max-w-40 px-3 py-2 align-top whitespace-normal text-gray-700">
                                {formatCellValue(row[column])}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              {message.role === "user" && (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-green-600">
                  <User className="h-4 w-4 text-white" />
                </div>
              )}
            </div>
          )
        })}

        {isLoading && (
          <div className="flex justify-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-green-100">
              <Bot className="h-4 w-4 text-green-600" />
            </div>
            <div className="rounded-2xl bg-gray-100 px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-green-600" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-green-200 p-4">
        {(isRecording || isVoiceLoading) && (
          <div className="mb-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
            {isRecording ? "Listening... tap stop when the farmer finishes speaking." : "Sarvam is transcribing the voice question..."}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={isRecording ? stopVoiceRecording : () => void startVoiceRecording()}
            disabled={isLoading || isVoiceLoading}
            className={`border-green-200 ${isRecording ? "bg-red-50 text-red-600 hover:bg-red-100" : "text-green-700 hover:bg-green-50"}`}
            aria-label={isRecording ? "Stop voice question" : "Ask by voice"}
          >
            {isRecording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type or use mic: ask in Hindi, English, or mixed language..."
            disabled={isLoading || isVoiceLoading}
            className="flex-1 text-gray-900 placeholder:text-gray-400"
          />
          <Button
            type="button"
            onClick={() => void handleSend()}
            disabled={isLoading || isVoiceLoading || !input.trim()}
            className="bg-green-600 hover:bg-green-700"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
