"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { Camera, Clock3, History, ImageUp, Menu, Mic2, Sparkles, Volume2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CoconutHistory } from "@/components/coconut-history"
import { UploadAssessor } from "@/components/upload-assessor"
import { AIChatbot } from "@/components/ai-chatbot"

interface CoconutRecord {
  id: string
  grade: string
  createdAt: string
  timestamp?: string
  image_path?: string
  weight: number
  height: number
  waterContent: number
  majorAxis: number | null
  minorAxis: number | null
  volume: number | null
  density: number | null
  surface_quality?: string
  ai_summary?: string
  geminiAnalysis?: string
  export_suitable?: boolean
  confidence_score?: number
  yolo_detections?: Array<{ class: string; confidence: number }>
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"upload" | "history">("upload")
  const [preferredInputMode, setPreferredInputMode] = useState<"upload" | "camera">("upload")
  const [history, setHistory] = useState<CoconutRecord[]>([])
  const [selectedRecord, setSelectedRecord] = useState<CoconutRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [chatbotOpen, setChatbotOpen] = useState(false)

  useEffect(() => {
    void fetchHistory()
  }, [])

  const fetchHistory = async () => {
    try {
      setLoading(true)
      const response = await fetch("http://localhost:5000/api/history")
      if (response.ok) {
        const data = await response.json()
        setHistory(data)
      }
    } catch (error) {
      console.error("Failed to fetch history:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteRecord = async (id: string) => {
    try {
      await fetch(`http://localhost:5000/api/coconut-assessments/${id}`, { method: "DELETE" })
      setHistory((current) => current.filter((record) => record.id !== id))
      setSelectedRecord((current) => (current?.id === id ? null : current))
    } catch (error) {
      console.error("Failed to delete record:", error)
    }
  }

  const recentAssessments = history.slice(0, 3)

  const getGradeLabel = (grade: string) => {
    if (grade === "A") return "Tender"
    if (grade === "B") return "Mature"
    if (grade === "C") return "Mature"
    return "Defective"
  }

  const getGradeBadge = (grade: string) => {
    if (grade === "A") return "bg-emerald-100 text-emerald-700"
    if (grade === "B" || grade === "C") return "bg-amber-100 text-amber-700"
    return "bg-rose-100 text-rose-700"
  }

  const formatRecordTime = (record: CoconutRecord) => {
    const value = record.createdAt || record.timestamp
    if (!value) return "Time unavailable"
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? "Time unavailable" : parsed.toLocaleString()
  }

  const getRecordThumbnail = (record: CoconutRecord) => {
    if (record.image_path && record.id) {
      return `http://localhost:5000/api/history-image/${record.id}`
    }
    return "/navbar-coconut.png"
  }

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-sm text-slate-900">
      <div
        className={`${sidebarOpen ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-300 ease-in-out md:static md:translate-x-0`}
      >
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center">
                <Image src="/navbar-coconut.png" alt="Coconut Grader" width={30} height={30} className="h-7 w-7 object-contain" />
              </div>
              <h1 className="whitespace-nowrap text-xl font-semibold tracking-tight text-slate-900">Coconut Grader</h1>
            </div>
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-3">
          <Button
            variant={activeTab === "upload" && preferredInputMode === "upload" ? "secondary" : "ghost"}
            onClick={() => {
              setActiveTab("upload")
              setPreferredInputMode("upload")
              setSelectedRecord(null)
              setSidebarOpen(false)
            }}
            className={`h-10 w-full justify-start gap-2.5 rounded-xl text-base ${activeTab === "upload" && preferredInputMode === "upload" ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-transparent text-slate-600 hover:bg-slate-50"}`}
          >
            <ImageUp className="h-4.5 w-4.5" />
            Upload Assessment
          </Button>
          <Button
            variant={activeTab === "upload" && preferredInputMode === "camera" ? "secondary" : "ghost"}
            onClick={() => {
              setActiveTab("upload")
              setPreferredInputMode("camera")
              setSidebarOpen(false)
            }}
            className={`h-10 w-full justify-start gap-2.5 rounded-xl text-base ${activeTab === "upload" && preferredInputMode === "camera" ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-transparent text-slate-600 hover:bg-slate-50"}`}
          >
            <Camera className="h-4.5 w-4.5" />
            Live Camera
          </Button>
          <Button
            variant={activeTab === "history" ? "secondary" : "ghost"}
            onClick={() => {
              setActiveTab("history")
              setSidebarOpen(false)
              void fetchHistory()
            }}
            className={`h-10 w-full justify-start gap-2.5 rounded-xl text-base ${activeTab === "history" ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-transparent text-slate-600 hover:bg-slate-50"}`}
          >
            <History className="h-4.5 w-4.5" />
            History
          </Button>
        </nav>

      </div>

      <Button
        variant="ghost"
        size="icon"
        className="fixed left-4 top-4 z-40 bg-white shadow-md md:hidden"
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex min-h-screen flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto px-3 py-3 md:px-4">
          <div className={`mx-auto max-w-[1120px] ${activeTab === "upload" ? "flex min-h-[calc(100vh-1.5rem)] flex-col" : ""}`}>
            <div className="mb-2 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-slate-900 md:text-2xl">Coconut Assessment</h2>
                <p className="text-xs text-slate-500 md:text-sm">Classify coconut quality by uploading images or using live camera capture.</p>
              </div>
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <div className="group relative overflow-hidden rounded-2xl border border-emerald-200 bg-white px-3 py-2 shadow-sm">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(16,185,129,0.16),transparent_34%),radial-gradient(circle_at_80%_0%,rgba(20,184,166,0.14),transparent_32%)] opacity-90" />
                  <div className="relative flex items-center gap-3">
                    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-emerald-700 shadow-[0_0_0_6px_rgba(16,185,129,0.10)]">
                      <Image src="/sarvam-symbol-transparent.png" alt="Sarvam AI" width={30} height={30} className="h-[30px] w-[30px] object-contain" unoptimized />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-700">Sarvam AI</p>
                        <Volume2 className="h-3.5 w-3.5 text-emerald-600" />
                      </div>
                      <p className="max-w-[270px] text-xs font-medium leading-snug text-slate-600">
                        Ask voice doubts on coconut grades, export quality, and farm decisions.
                      </p>
                    </div>
                  </div>
                </div>
                <Button
                  onClick={() => setChatbotOpen((open) => !open)}
                  className="h-11 rounded-2xl border border-emerald-300 bg-white px-4 text-sm font-bold text-emerald-700 shadow-sm hover:bg-emerald-50"
                >
                  <span className="relative mr-2 flex h-5 w-5 items-center justify-center">
                    <span className="absolute h-5 w-5 animate-ping rounded-full bg-emerald-300 opacity-35" />
                    <Mic2 className="relative h-4 w-4" />
                  </span>
                  Ask with Sarvam
                  <Sparkles className="ml-2 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {activeTab === "upload" ? (
              <>
                <div className="shrink-0">
                  <UploadAssessor onAssessmentSaved={fetchHistory} defaultInputMode={preferredInputMode} />
                </div>

                <div className="mt-2 grid flex-1 auto-rows-fr gap-2 lg:grid-cols-3">
                  <section className="flex min-h-[250px] flex-col rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <Camera className="h-4 w-4 text-slate-500" />
                        Live Camera
                      </div>
                      <Badge className="bg-emerald-100 text-xs text-emerald-700">Ready</Badge>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
                      <Camera className="mb-2 h-8 w-8 text-slate-400" />
                      <p className="text-sm text-slate-500">Camera preview will appear here</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPreferredInputMode("camera")}
                      className="mt-3 h-9 w-full border-emerald-200 text-sm text-emerald-700 hover:bg-emerald-50"
                    >
                      <Camera className="mr-1.5 h-4 w-4" />
                      Open Camera
                    </Button>
                  </section>

                  <section className="flex min-h-[250px] flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="mb-3 text-base font-semibold text-slate-900">Quality Categories</h3>
                    <div className="grid min-h-0 flex-1 content-around">
                      <div className="flex items-start gap-2">
                        <div className="mt-1.5 h-2.5 w-2.5 rounded-full bg-emerald-500" />
                        <div>
                          <p className="text-base font-semibold text-slate-800">Tender</p>
                          <p className="text-sm text-slate-500">Young coconuts with soft shell and high water content.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="mt-1.5 h-2.5 w-2.5 rounded-full bg-amber-400" />
                        <div>
                          <p className="text-base font-semibold text-slate-800">Mature</p>
                          <p className="text-sm text-slate-500">Fully grown coconuts with thick shell and firm meat.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="mt-1.5 h-2.5 w-2.5 rounded-full bg-rose-500" />
                        <div>
                          <p className="text-base font-semibold text-slate-800">Defective</p>
                          <p className="text-sm text-slate-500">Coconuts with visible defects, cracks, or damage.</p>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="flex min-h-[250px] flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-base font-semibold">
                        <Clock3 className="h-4 w-4 text-slate-500" />
                        Recent Assessments
                      </div>
                      <Button
                        variant="ghost"
                        className="h-auto p-0 text-xs font-medium text-emerald-700 hover:bg-transparent"
                        onClick={() => {
                          setActiveTab("history")
                          void fetchHistory()
                        }}
                      >
                        View all
                      </Button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col justify-around overflow-hidden">
                      {recentAssessments.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">No assessments yet.</p>
                      ) : (
                        recentAssessments.map((record) => (
                          <div key={record.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                            <div className="flex items-center gap-3">
                              <img src={getRecordThumbnail(record)} alt={`Assessment ${record.id.slice(0, 8)}`} className="h-9 w-9 rounded-md border border-slate-200 object-cover" />
                              <div>
                                <p className="max-w-[170px] truncate text-sm font-medium text-slate-900">Assessment {record.id.slice(0, 8)}</p>
                                <p className="text-xs text-slate-500">{formatRecordTime(record)}</p>
                              </div>
                            </div>
                            <Badge className={`${getGradeBadge(record.grade)} border-0 text-xs`}>{getGradeLabel(record.grade)}</Badge>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <CoconutHistory
                  history={history}
                  loading={loading}
                  selectedId={selectedRecord?.id}
                  onSelectRecord={setSelectedRecord}
                  onDeleteRecord={handleDeleteRecord}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className={`${chatbotOpen ? "translate-x-0" : "translate-x-full"} fixed inset-y-0 right-0 z-40 w-full border-l border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out md:w-[22rem]`}
      >
        <AIChatbot onClose={() => setChatbotOpen(false)} />
      </div>

      {chatbotOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setChatbotOpen(false)} />}
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}
    </div>
  )
}
