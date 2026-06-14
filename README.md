# 🥥 Coconut Quality Checker

An AI-powered, multi-agent computer vision system for real-time coconut grading, dimension measurement, and quality assessment.

## 🌟 Overview

The **Coconut Quality Checker** is a sophisticated industrial automation tool designed to standardize and speed up the coconut grading process. It combines high-speed computer vision, hardware sensor integration (Weight, Height, Water Content), and Generative AI to provide deep qualitative insights.

## 🚀 Core Features

-   **Real-time Video Feed**: Live MJPEG streaming with overlay detections and measurements.
-   **Automated Dimensioning**: Computer vision-based ellipsoid fitting to measure Major and Minor axes in cm.
-   **Hardware Integration**: Threaded serial communication with NodeMCU/Arduino for live weight and height data.
-   **AI Grading Engine**: 
    -   **ML Agent**: YOLOv8/v11 for object detection and defect identification (mold, cracks).
    -   **Analysis Agent**: Calculates volume, density, and assigns grades (A-D) based on physical parameters and defects.
    -   **Gemini Vision Agent**: Deep visual analysis using Google Gemini 2.5 Flash Lite for nuanced quality reports and crack detection.
-   **Historical Tracking**: SQLite database persistence for all assessments with image captures.
-   **AI Copilot**: Integrate chatbot for querying database records and general coconut quality advice.
-   **Export Capabilities**: Export assessment history to CSV for reporting.

## 🛠️ Tech Stack

### Frontend
-   **Framework**: Next.js 14 (App Router)
-   **Styling**: Tailwind CSS + Shadcn UI
-   **Visualization**: Recharts (20 FPS Live Trend Graph)
-   **Icons**: Lucide React

### Backend (Multi-Agent Orchestration)
-   **Framework**: Flask (Python 3.10+)
-   **Vision**: OpenCV (with CAP_DSHOW optimization)
-   **ML Inference**: Roboflow Inference SDK (running in Docker)
-   **Generative AI**: Google Gemini 2.5 Flash Lite
-   **Database**: SQLite3

### Hardware / IoT
-   **Controller**: NodeMCU / Arduino
-   **Sensors**: Load Cell (HX711), Ultrasonic Sensor, Moisture Probe
-   **Communication**: USB Serial (115200 Baud)

## 📁 Project Structure

```text
├── app/                  # Next.js Application Logic
├── components/           # UI Components (Webcam, History, Charts)
├── backend.py            # Flask Multi-Agent Server
├── list_models.py        # Roboflow Debug Utility
├── coconuts.db           # SQLite Database
├── captures/             # Assessment Image Storage
└── TECH_STACK.md         # Detailed Tech Architecture
```

## ⚙️ Installation & Setup

### 1. Prerequisites
-   Python 3.10+
-   Node.js 18+
-   Docker (for Roboflow Inference)
-   Google Gemini API Key

### 2. Backend Setup
```bash
# Install dependencies
pip install flask flask-cors opencv-python numpy google-genai inference-sdk pyserial

# Start Roboflow Inference Server (Docker)
docker run -d --name roboflow -p 9001:9001 roboflow/inference-server:latest

# Run the Flask server
python backend.py
```

### 3. Frontend Setup
```bash
# Install dependencies
npm install

# Run the development server
npm run dev
```

### 4. Configuration
Ensure your `backend.py` is configured with:
-   `GEMINI_API_KEY`: Your Google GenAI key.
-   `ROBOFLOW_API_KEY`: Your Roboflow project key.
-   `SERIAL_PORT`: The COM port for your sensor hub (e.g., `COM10`).

## 🧱 Architecture (Multi-Agent System)

The system operates using 5 specialized agents coordinated via the Flask backend:
1.  **Ingestion Agent**: Manages the high-speed camera feed.
2.  **ML Agent**: Performs object detection via Roboflow.
3.  **Analysis Agent**: Physics-based grading and metric calculation.
4.  **Trend Agent**: Handles database I/O and historical trends.
5.  **Gemini Agent**: Provides "Human-like" qualitative analysis.

## 📄 License
Private Repository - proprietary software.
