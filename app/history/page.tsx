"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { CoconutHistory } from "@/components/coconut-history"

interface CoconutRecord {
  id: string
  grade: string
  createdAt: string
  weight: number
  height: number
  waterContent: number
  majorAxis: number | null
  minorAxis: number | null
  volume: number | null
  density: number | null
  export_suitable?: boolean
  confidence_score?: number
  yolo_detections?: Array<{ class: string; confidence: number }>
  ai_summary?: string
  geminiAnalysis?: string
}

export default function HistoryPage() {
  const router = useRouter()
  const [history, setHistory] = useState<CoconutRecord[]>([])
  const [selectedRecord, setSelectedRecord] = useState<CoconutRecord | null>(null)
  const [loading, setLoading] = useState(true)

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

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <div className="flex items-center justify-between border-b border-green-200 bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/")}
            className="text-green-600 hover:bg-green-50 hover:text-green-700"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Upload
          </Button>
          <h1 className="text-2xl font-bold text-green-700">Assessment History</h1>
        </div>
      </div>

      <div className="flex-1 p-6">
        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-green-600" />
          </div>
        ) : (
          <div className="mx-auto max-w-6xl">
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
  )
}
