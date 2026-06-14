# Coconut Quality Checker - Tech Stack Document

This document outlines the full technical architecture and technology stack used in the Coconut Quality Checker application.

## 1. Frontend Architecture
The frontend is built using a modern React-based stack designed for high-frequency real-time updates.

*   **Framework**: Next.js 14 (App Router)
*   **Language**: TypeScript
*   **Styling**: Tailwind CSS + Shadcn UI (Radix UI primitives)
*   **Icons**: Lucide React
*   **Visualization**: **Recharts** (High-frequency live weight trend graph at 20 FPS)
*   **Data Fetching**: Native Fetch API with polling for real-time sensor integration.

## 2. Backend Architecture (Multi-Agent System)
The backend is a robust Python Flask application implementing a Multi-Agent Orchestration pattern.

*   **Framework**: Flask (Python 3.10+)
*   **Agents**:
    *   **Ingestion Agent**: Manages USB camera feed, lazy loading, and MJPEG streaming using OpenCV with `CAP_DSHOW` optimization.
    *   **ML Agent**: Connects to a local **Roboflow Inference Server** (Docker) for object detection.
    *   **Analysis Agent**: Calculates physical metrics like volume (ellipsoid approx.), density, and performs base grading logic.
    *   **Sensor Agent**: Handles threaded serial communication (`pyserial`) with NodeMCU hardware.
    *   **Gemini Vision Agent**: Utilizes **Google Gemini 2.5 Flash Lite** for deep quality analysis and visual crack/fissure detection.
    *   **Trend Agent**: Manages SQLite data persistence and historical record retrieval.

## 3. AI & Model Stack
*   **Reasoning/Vision**: Google Gemini 2.5 Flash Lite (`google-genai` SDK).
*   **Detection**: Roboflow YOLOv8/v11 (Private Fine-tuned Model).
*   **Inference Hub**: Roboflow Inference Docker Container (`localhost:9001`).

## 4. Hardware & IoT Integration
*   **Controller**: NodeMCU / Arduino-based sensor hub.
*   **Sensors**: 
    *   Load Cell + HX711 (Weight)
    *   Ultrasonic/IR Sensor (Height)
    *   Moisture/Analog Probe (Water content estimate)
*   **Communication**: USB Serial (115200 Baud).

## 5. Persistence & Storage
*   **Primary Database**: SQLite3 (`coconuts.db`).
*   **Image Storage**: Local filesystem (`captures/` directory) for assessment screenshots.
*   **Schema**: Relational table with JSON-serialized fields for issues/recommendations.

## 6. Performance Optimizations
*   **High Frequency**: Frontend polling and graph updates at 50ms intervals.
*   **Non-Blocking Serial**: Dedicated background thread for serial reading to prevent Flask response delays.
*   **Visual Debugging**: Detailed server-side logging for vision analysis and hardware handshakes.
