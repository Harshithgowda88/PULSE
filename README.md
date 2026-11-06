# Pulse - Emergency Ambulance & Hospital Dispatch Network

Pulse connects ambulance drivers, hospital emergency departments, and municipal administrators in a single synchronized real-time web application.

---

## 1. Architecture Overview

```
pulse/
├── frontend/             # React 19 + TypeScript + Vite + Leaflet + Tailwind CSS
├── backend/              # Python FastAPI + SQLAlchemy + PostgreSQL + WebSockets + Alembic
├── server.ts             # Central Full-Stack Server & Dev Runner (Port 3000)
└── README.md             # Complete Deployment & Integration Manual
```

### Brand & Design System
- **Midnight Black**: `#030407` (Dominant canvas)
- **Electric Cobalt Blue**: `#1558C9` (Primary action affordance)
- **Acid Lime**: `#D4FF24` (High-priority emergency alerts and preemption status)
- **Typographic System**: Plus Jakarta Sans for interface typography, JetBrains Mono for telemetry, ETA timestamps, and coordinates.

---

## 2. Portals & Core Workflows

1. **Ambulance Driver Portal**:
   - Registration with mobile phone OTP verification (local dev test mode enabled).
   - Waiting for administrator clearance with live status updates.
   - GPS device location detection, accuracy display, and manual starting point pin selection.
   - Clinical hospital search with term expansion (e.g. `Cardiologist` → Cardiology, `CT` → CT Scan, `Cardiology and CT scan` matches both).
   - Radius filter switch (2, 4, 5, 8, 10 km circle) or Nearest First sorting.
   - Interactive Leaflet map with OSRM real road routing, corridor geometry, road distance, and live ETA calculation.
   - Incoming-case notification dispatch with duplicate retry protection.

2. **Hospital Management Portal**:
   - Institutional registration with exactly 10-digit identification number validation.
   - Ambulance entrance bay location picker (supports Google Maps / OSM link resolution with SSRF defense, map click pin, or manual lat/lng).
   - Digital Hospital Booklet: Departments and Facilities checklist with "+ Add another", 24-hour emergency care toggle, and operating hours.
   - Real-time incoming case alerts over WebSocket with dual-tone Web Audio alert chime.
   - Strict hospital isolation: Hospital B cannot access Hospital A's cases.
   - In-place ETA updates for active journeys (prevents duplicate tickets).

3. **Municipal Administrator Portal**:
   - Protected console with credential review for drivers and hospitals.
   - "Approve" or "Return for Correction" with audit notes.
   - **Section 19: Traffic Signal Preemption Demonstration**:
     - Route corridor visualization.
     - Overpass API query for real OSM traffic signals.
     - Simulated ambulance movement along route.
     - Virtual roadside LED matrix board displaying "EMERGENCY AMBULANCE APPROACHING" with audible alert beep.
     - Automatic preemption clearance after vehicle passes.
   - **Section 20: Future Roadside Device Hardware Adapter**:
     - Documented JSON command & acknowledgment schema.
     - Secure MQTT (TLS 1.3) specification.

4. **Section 21: Pulse Hands-Free Voice Assistant**:
   - Speech synthesis and speech recognition integration.
   - "Hey, Pulse" flow: spoken request → requirement confirmation → hospital options reading → verbal dispatch confirmation.

5. **Section 24: Automated 16-Step End-to-End Test Suite**:
   - Built-in live test runner verifying registration, approval, search, routing, notification dispatch, account isolation, persistence, ETA update in place, and signal demonstration.

---

## 3. Quick Local Startup

### Running the Integrated Full-Stack Application (Default)

```bash
# 1. Install dependencies
npm install

# 2. Start integrated Node.js Express + WebSocket server with Vite
npm run dev
```

Open `http://localhost:3000` in your browser.

---

### Running the Python FastAPI Backend Separately (PostgreSQL)

```bash
cd backend

# 1. Create and activate a Python virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install Python requirements
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env

# 4. Run database migrations
alembic upgrade head

# 5. Start FastAPI server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Connect the frontend to this Python backend by configuring in `.env`:
```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000/ws
```

---

### Docker Compose Deployment (PostgreSQL + FastAPI)

```bash
cd backend
docker-compose up -d --build
```

---

## 4. Completed Feature Checklist

- [x] Shared data model with stable IDs and text-based vehicle and 10-digit hospital numbers
- [x] Phone OTP verification with environment-controlled test method
- [x] Hospital 10-digit ID validation and ambulance entrance pin resolution
- [x] Digital Hospital Booklet with departments and facilities checkboxes
- [x] Administrator approval and return-for-correction workflows
- [x] Real road routing via OSRM engine and ETA calculation
- [x] Radius limit filter (2, 4, 5, 8, 10 km) and Leaflet map rendering
- [x] Account-specific WebSocket incoming-case notifications with hospital isolation
- [x] Web Audio API synthesized alert chime and roadside warning beeper
- [x] Traffic-signal demonstration with OpenStreetMap Overpass query & simulated movement
- [x] Future roadside hardware adapter documentation (MQTT schema)
- [x] Pulse voice assistant with Web Speech API integration
- [x] Automated 16-step Section 24 verification test suite runner
