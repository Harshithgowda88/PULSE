import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// File-based persistence
const DATA_FILE = path.join(__dirname, 'pulse-central-data.json');

interface DatabaseSchema {
  drivers: Record<string, any>;
  hospitals: Record<string, any>;
  journeys: Record<string, any>;
  notifications: Record<string, any>;
  warningBoardEvents: any[];
  admins: Record<string, any>;
}

function loadDatabase(): DatabaseSchema {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error reading database file:', err);
  }
  return {
    drivers: {},
    hospitals: {},
    journeys: {},
    notifications: {},
    warningBoardEvents: [],
    admins: {
      'admin-1': {
        id: 'admin-1',
        email: 'admin@pulse.local',
        passwordHash: bcrypt.hashSync('admin123', 10),
        name: 'Pulse System Administrator',
        role: 'admin',
      },
    },
  };
}

let db = loadDatabase();

function saveDatabase() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

// WebSocket client connection management
interface AuthenticatedSocket extends WebSocket {
  clientId?: string;
  role?: string;
  accountId?: string;
  isAlive?: boolean;
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: AuthenticatedSocket, req) => {
  ws.isAlive = true;

  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    ws.role = url.searchParams.get('role') || 'guest';
    ws.accountId = url.searchParams.get('accountId') || '';
    ws.clientId = `${ws.role}_${ws.accountId || Math.random().toString(36).substring(7)}`;
  } catch (e) {
    ws.role = 'guest';
  }

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'IDENTIFY') {
        ws.role = data.role;
        ws.accountId = data.accountId;
      } else if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (e) {
      // ignore
    }
  });

  // Welcome message with server timestamp
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    role: ws.role,
    accountId: ws.accountId,
    serverTime: new Date().toISOString(),
  }));
});

// Periodic ping to keep connections healthy
setInterval(() => {
  wss.clients.forEach((client) => {
    const ws = client as AuthenticatedSocket;
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Targeted broadcast helpers
function sendToHospital(hospitalId: string, event: any) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    const ws = client as AuthenticatedSocket;
    if (ws.readyState === WebSocket.OPEN && ws.role === 'hospital' && ws.accountId === hospitalId) {
      ws.send(payload);
    }
  });
}

function sendToDriver(driverId: string, event: any) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    const ws = client as AuthenticatedSocket;
    if (ws.readyState === WebSocket.OPEN && ws.role === 'driver' && ws.accountId === driverId) {
      ws.send(payload);
    }
  });
}

function broadcastToAdmins(event: any) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    const ws = client as AuthenticatedSocket;
    if (ws.readyState === WebSocket.OPEN && ws.role === 'admin') {
      ws.send(payload);
    }
  });
}

function broadcastAll(event: any) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ==================== REST APIS ====================

// Health & System Status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    product: 'Pulse',
    mode: 'central-server',
    version: '1.0.0',
    dbType: 'persistent-json-central',
    timestamp: new Date().toISOString(),
    stats: {
      driversCount: Object.keys(db.drivers).length,
      hospitalsCount: Object.keys(db.hospitals).length,
      notificationsCount: Object.keys(db.notifications).length,
      activeJourneysCount: Object.values(db.journeys).filter((j: any) => j.status === 'active').length,
    },
  });
});

// Dev Reset Database for Section 24 Automated Testing
app.post('/api/dev/reset-database', (req, res) => {
  db = {
    drivers: {},
    hospitals: {},
    journeys: {},
    notifications: {},
    warningBoardEvents: [],
    admins: {
      'admin-1': {
        id: 'admin-1',
        email: 'admin@pulse.local',
        passwordHash: bcrypt.hashSync('admin123', 10),
        name: 'Pulse System Administrator',
        role: 'admin',
      },
    },
  };
  saveDatabase();
  broadcastAll({ type: 'DATABASE_RESET' });
  res.json({ success: true, message: 'Database reset to empty state.' });
});

// Seed Initial Sample for Testing (Optional helper)
app.post('/api/dev/seed-sample', (req, res) => {
  const hosp1Id = 'hosp_metro_1';
  db.hospitals[hosp1Id] = {
    id: hosp1Id,
    userId: 'user_hosp_1',
    hospitalName: 'Apex Metropolitan Emergency Hospital',
    identificationNumber: '1000000001',
    contactPhone: '+1-555-0199',
    email: 'dispatch@metro-apex.org',
    fullAddress: '450 Healthcare Boulevard, Metro District',
    location: {
      lat: 37.7749,
      lng: -122.4194,
      originalLink: 'https://maps.google.com/?q=37.7749,-122.4194',
      confirmedAt: new Date().toISOString(),
    },
    departments: ['Emergency medicine', 'Cardiology', 'Neurology', 'Orthopaedics', 'General surgery', 'ICU'],
    facilities: ['CT scan', 'MRI', 'X-ray', 'Ultrasound', 'ICU', 'Operation theatre', '24-hour emergency care'],
    emergencyHours: '24/7 All Days',
    is24HourEmergency: true,
    shortDescription: 'Level 1 Trauma Center with designated rapid cardiac cath lab and comprehensive stroke unit.',
    approvalStatus: 'approved',
    submissionTime: new Date(Date.now() - 3600000).toISOString(),
    decisionTime: new Date().toISOString(),
  };

  const dr1Id = 'dr_ambulance_1';
  db.drivers[dr1Id] = {
    id: dr1Id,
    userId: 'user_dr_1',
    fullName: 'Johnathan Walker',
    vehicleNumber: 'AMB-7701',
    phoneNumber: '+1-555-8833',
    approvalStatus: 'approved',
    submissionTime: new Date(Date.now() - 3600000).toISOString(),
    decisionTime: new Date().toISOString(),
    currentLocation: {
      lat: 37.7650,
      lng: -122.4300,
      accuracy: 8,
      lastUpdated: new Date().toISOString(),
      isManual: false,
    },
  };

  saveDatabase();
  res.json({ success: true, seeded: { hospitals: 1, drivers: 1 } });
});

// --- Driver Auth & Registration ---
app.post('/api/auth/driver/otp/request', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  // Local environment-controlled verification code: returns fixed code for dev/test
  const verificationCode = '742910';
  res.json({
    success: true,
    message: 'Verification OTP sent (Development test mode enabled)',
    devCode: verificationCode,
    expiresInSeconds: 300,
  });
});

app.post('/api/auth/driver/register', (req, res) => {
  const { fullName, vehicleNumber, phoneNumber, otpCode } = req.body;

  if (!fullName || !vehicleNumber || !phoneNumber) {
    return res.status(400).json({ error: 'Full name, vehicle registration number, and phone number are required.' });
  }

  // Validate vehicle number (normalize whitespace/uppercase)
  const normVehicle = vehicleNumber.trim().toUpperCase();
  const normPhone = phoneNumber.trim().replace(/[^\d+]/g, '');

  // Check if driver with vehicle or phone already registered
  const existing = Object.values(db.drivers).find(
    (d: any) => d.vehicleNumber === normVehicle || d.phoneNumber === normPhone
  );

  const driverId = existing ? existing.id : `dr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const driverRecord = {
    id: driverId,
    userId: `user_${driverId}`,
    fullName: fullName.trim(),
    vehicleNumber: normVehicle,
    phoneNumber: normPhone,
    approvalStatus: 'pending',
    submissionTime: new Date().toISOString(),
    currentLocation: {
      lat: 37.7749,
      lng: -122.4194,
      accuracy: 10,
      lastUpdated: new Date().toISOString(),
    },
  };

  db.drivers[driverId] = driverRecord;
  saveDatabase();

  broadcastToAdmins({
    type: 'NEW_DRIVER_APPLICATION',
    driver: driverRecord,
  });

  res.status(201).json({
    success: true,
    driver: driverRecord,
    token: `token_dr_${driverId}`,
  });
});

app.post('/api/auth/driver/login', (req, res) => {
  const { vehicleNumber, phoneNumber } = req.body;
  if (!vehicleNumber || !phoneNumber) {
    return res.status(400).json({ error: 'Vehicle number and phone number are required' });
  }

  const normVehicle = vehicleNumber.trim().toUpperCase();
  const normPhone = phoneNumber.trim().replace(/[^\d+]/g, '');

  const driver = Object.values(db.drivers).find(
    (d: any) => d.vehicleNumber === normVehicle && (d.phoneNumber === normPhone || d.phoneNumber.includes(normPhone.slice(-7)))
  );

  if (!driver) {
    return res.status(404).json({ error: 'No driver found with this vehicle and phone combination.' });
  }

  res.json({
    success: true,
    driver,
    token: `token_dr_${driver.id}`,
  });
});

app.get('/api/drivers/:id', (req, res) => {
  const driver = db.drivers[req.params.id];
  if (!driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  res.json(driver);
});

// Update Driver Location
app.post('/api/drivers/:id/location', (req, res) => {
  const driver = db.drivers[req.params.id];
  if (!driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  const { lat, lng, accuracy, isManual } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  driver.currentLocation = {
    lat,
    lng,
    accuracy: accuracy || 10,
    isManual: !!isManual,
    lastUpdated: new Date().toISOString(),
  };

  saveDatabase();
  res.json({ success: true, currentLocation: driver.currentLocation });
});

// --- Hospital Auth & Registration ---
app.post('/api/auth/hospital/register', (req, res) => {
  const {
    hospitalName,
    identificationNumber,
    contactPhone,
    email,
    password,
    fullAddress,
    location,
    departments,
    facilities,
    emergencyHours,
    is24HourEmergency,
    shortDescription,
    supportingDocName,
  } = req.body;

  // Validate 10-digit ID
  const cleanId = String(identificationNumber || '').trim();
  if (!/^\d{10}$/.test(cleanId)) {
    return res.status(400).json({ error: 'Hospital Identification Number must be exactly 10 digits.' });
  }

  if (!hospitalName || !contactPhone || !email || !password || !location || location.lat == null || location.lng == null) {
    return res.status(400).json({ error: 'Missing mandatory registration fields (Hospital Name, Contact Phone, Email, Password, or Confirmed Location).' });
  }

  const existing = Object.values(db.hospitals).find((h: any) => h.identificationNumber === cleanId);
  if (existing) {
    return res.status(400).json({ error: 'A hospital with this 10-digit identification number is already registered.' });
  }

  const hospitalId = `hosp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const passwordHash = bcrypt.hashSync(password, 10);

  const hospitalRecord = {
    id: hospitalId,
    userId: `user_${hospitalId}`,
    hospitalName: hospitalName.trim(),
    identificationNumber: cleanId, // preserved as text
    contactPhone: contactPhone.trim(),
    email: email.trim(),
    passwordHash,
    fullAddress: fullAddress ? fullAddress.trim() : `Ambulance Entrance GPS: ${Number(location.lat).toFixed(5)}, ${Number(location.lng).toFixed(5)}`,
    location: {
      lat: Number(location.lat),
      lng: Number(location.lng),
      originalLink: location.originalLink || '',
      confirmedAt: new Date().toISOString(),
    },
    departments: Array.isArray(departments) ? departments : [],
    facilities: Array.isArray(facilities) ? facilities : [],
    emergencyHours: emergencyHours || (is24HourEmergency ? '24/7' : 'Standard Emergency Hours'),
    is24HourEmergency: is24HourEmergency !== false,
    shortDescription: shortDescription || '',
    supportingDocName: supportingDocName || 'Hospital_Accreditation_Proof.pdf',
    approvalStatus: 'pending',
    submissionTime: new Date().toISOString(),
  };

  db.hospitals[hospitalId] = hospitalRecord;
  saveDatabase();

  broadcastToAdmins({
    type: 'NEW_HOSPITAL_APPLICATION',
    hospital: hospitalRecord,
  });

  // Do not expose password hash in response
  const { passwordHash: _, ...safeHospital } = hospitalRecord;
  res.status(201).json({
    success: true,
    hospital: safeHospital,
    token: `token_hosp_${hospitalId}`,
  });
});

app.post('/api/auth/hospital/login', (req, res) => {
  const { identificationNumber, password } = req.body;
  if (!identificationNumber || !password) {
    return res.status(400).json({ error: 'Hospital Identification Number and password are required' });
  }

  const cleanId = String(identificationNumber).trim();
  const hospital = Object.values(db.hospitals).find((h: any) => h.identificationNumber === cleanId);

  if (!hospital) {
    return res.status(404).json({ error: 'No hospital found with this identification number.' });
  }

  const isValid = bcrypt.compareSync(password, hospital.passwordHash || '');
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid identification number or password.' });
  }

  const { passwordHash: _, ...safeHospital } = hospital;
  res.json({
    success: true,
    hospital: safeHospital,
    token: `token_hosp_${hospital.id}`,
  });
});

app.get('/api/hospitals/:id', (req, res) => {
  const hospital = db.hospitals[req.params.id];
  if (!hospital) {
    return res.status(404).json({ error: 'Hospital not found' });
  }
  const { passwordHash: _, ...safeHospital } = hospital;
  res.json(safeHospital);
});

// Update Hospital Profile Checkboxes (Booklet)
app.put('/api/hospitals/:id/profile', (req, res) => {
  const hospital = db.hospitals[req.params.id];
  if (!hospital) {
    return res.status(404).json({ error: 'Hospital not found' });
  }

  const {
    departments,
    facilities,
    emergencyHours,
    is24HourEmergency,
    shortDescription,
    contactPhone,
    fullAddress,
    location,
  } = req.body;

  if (Array.isArray(departments)) hospital.departments = departments;
  if (Array.isArray(facilities)) hospital.facilities = facilities;
  if (emergencyHours !== undefined) hospital.emergencyHours = emergencyHours;
  if (is24HourEmergency !== undefined) hospital.is24HourEmergency = is24HourEmergency;
  if (shortDescription !== undefined) hospital.shortDescription = shortDescription;
  if (contactPhone !== undefined) hospital.contactPhone = contactPhone;
  if (fullAddress !== undefined) hospital.fullAddress = fullAddress;
  if (location && typeof location.lat === 'number' && typeof location.lng === 'number') {
    hospital.location = {
      lat: location.lat,
      lng: location.lng,
      originalLink: location.originalLink || hospital.location.originalLink,
      confirmedAt: new Date().toISOString(),
    };
  }

  saveDatabase();

  const { passwordHash: _, ...safeHospital } = hospital;
  res.json({ success: true, hospital: safeHospital });
});

// Secure Google Maps & OpenStreetMap Link Resolver
app.post('/api/location/resolve-link', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Location link or coordinates required' });
  }

  const raw = url.trim();

  // 1. Direct coordinate check (e.g. "12.9716, 77.5946" or "12.9716,77.5946")
  const coordDirect = raw.match(/^(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)$/);
  if (coordDirect) {
    const lat = parseFloat(coordDirect[1]);
    const lng = parseFloat(coordDirect[2]);
    return res.json({
      success: true,
      candidateLocation: { lat, lng },
      method: 'direct-coordinates',
      message: `Location confirmed from coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    });
  }

  try {
    let candidateLat: number | null = null;
    let candidateLng: number | null = null;

    // Pattern A: Google Maps !3d<lat>!4d<lng>
    const bangMatch = raw.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (bangMatch) {
      candidateLat = parseFloat(bangMatch[1]);
      candidateLng = parseFloat(bangMatch[2]);
    }

    // Pattern B: @lat,lng e.g. @12.9716,77.5946
    if (!candidateLat) {
      const atMatch = raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (atMatch) {
        candidateLat = parseFloat(atMatch[1]);
        candidateLng = parseFloat(atMatch[2]);
      }
    }

    // Pattern C: ?q=lat,lng or &q=lat,lng or ll=lat,lng or center=lat,lng
    if (!candidateLat) {
      const qMatch = raw.match(/[?&](?:q|ll|center|destination|origin)=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (qMatch) {
        candidateLat = parseFloat(qMatch[1]);
        candidateLng = parseFloat(qMatch[2]);
      }
    }

    // Pattern D: OpenStreetMap /#map=zoom/lat/lng
    if (!candidateLat) {
      const osmMatch = raw.match(/#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
      if (osmMatch) {
        candidateLat = parseFloat(osmMatch[1]);
        candidateLng = parseFloat(osmMatch[2]);
      }
    }

    if (candidateLat !== null && candidateLng !== null) {
      return res.json({
        success: true,
        candidateLocation: { lat: candidateLat, lng: candidateLng },
        method: 'direct-google-maps-pattern',
        message: `Google Maps link resolved: ${candidateLat.toFixed(5)}, ${candidateLng.toFixed(5)}`,
      });
    }

    // Shortened URL resolution (e.g. maps.app.goo.gl or goo.gl/maps)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timeout);

    const finalUrl = response.url || '';
    const bodyText = await response.text();

    // Check final URL
    const finalBang = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (finalBang) {
      candidateLat = parseFloat(finalBang[1]);
      candidateLng = parseFloat(finalBang[2]);
    }

    if (!candidateLat) {
      const finalAt = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (finalAt) {
        candidateLat = parseFloat(finalAt[1]);
        candidateLng = parseFloat(finalAt[2]);
      }
    }

    if (!candidateLat) {
      const finalQ = finalUrl.match(/[?&](?:q|ll|center)=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (finalQ) {
        candidateLat = parseFloat(finalQ[1]);
        candidateLng = parseFloat(finalQ[2]);
      }
    }

    // If still not in URL, scan HTML body
    if (!candidateLat && bodyText) {
      const bodyBang = bodyText.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      if (bodyBang) {
        candidateLat = parseFloat(bodyBang[1]);
        candidateLng = parseFloat(bodyBang[2]);
      }
    }

    if (!candidateLat && bodyText) {
      const bodyAt = bodyText.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (bodyAt) {
        candidateLat = parseFloat(bodyAt[1]);
        candidateLng = parseFloat(bodyAt[2]);
      }
    }

    if (candidateLat !== null && candidateLng !== null) {
      return res.json({
        success: true,
        candidateLocation: { lat: candidateLat, lng: candidateLng },
        method: 'shortened-link-resolved',
        message: `Google Maps short link resolved: ${candidateLat.toFixed(5)}, ${candidateLng.toFixed(5)}`,
      });
    }

    return res.json({
      success: false,
      message: 'Could not extract exact coordinates from Google Maps link. Please select location on map.',
    });
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      message: 'Network link resolution failed or timed out. Please click on the map to set entrance pin.',
    });
  }
});

// --- Administrator Portal APIs ---
app.post('/api/auth/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const admin = Object.values(db.admins).find((a: any) => a.email.toLowerCase() === email.trim().toLowerCase());
  if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  res.json({
    success: true,
    admin: { id: admin.id, email: admin.email, name: admin.name, role: 'admin' },
    token: `token_admin_${admin.id}`,
  });
});

app.get('/api/admin/drivers', (req, res) => {
  const drivers = Object.values(db.drivers).sort((a: any, b: any) =>
    new Date(b.submissionTime).getTime() - new Date(a.submissionTime).getTime()
  );
  res.json(drivers);
});

app.post('/api/admin/drivers/:id/decision', (req, res) => {
  const driver = db.drivers[req.params.id];
  if (!driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }

  const { decision, reason, adminId } = req.body;
  if (!['approved', 'rejected', 'correction_needed'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision value' });
  }

  driver.approvalStatus = decision;
  driver.decisionTime = new Date().toISOString();
  driver.decidedByAdminId = adminId || 'admin-1';
  if (reason) {
    driver.correctionReason = reason;
  } else {
    delete driver.correctionReason;
  }

  saveDatabase();

  // Notify driver via WebSocket
  sendToDriver(driver.id, {
    type: 'APPROVAL_STATUS_CHANGED',
    role: 'driver',
    status: decision,
    reason: driver.correctionReason,
  });

  res.json({ success: true, driver });
});

app.get('/api/admin/hospitals', (req, res) => {
  const hospitals = Object.values(db.hospitals).map((h: any) => {
    const { passwordHash: _, ...safe } = h;
    return safe;
  }).sort((a: any, b: any) =>
    new Date(b.submissionTime).getTime() - new Date(a.submissionTime).getTime()
  );
  res.json(hospitals);
});

app.post('/api/admin/hospitals/:id/decision', (req, res) => {
  const hospital = db.hospitals[req.params.id];
  if (!hospital) {
    return res.status(404).json({ error: 'Hospital not found' });
  }

  const { decision, reason, adminId } = req.body;
  if (!['approved', 'rejected', 'correction_needed'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision value' });
  }

  hospital.approvalStatus = decision;
  hospital.decisionTime = new Date().toISOString();
  hospital.decidedByAdminId = adminId || 'admin-1';
  if (reason) {
    hospital.correctionReason = reason;
  } else {
    delete hospital.correctionReason;
  }

  saveDatabase();

  // Notify hospital via WebSocket
  sendToHospital(hospital.id, {
    type: 'APPROVAL_STATUS_CHANGED',
    role: 'hospital',
    status: decision,
    reason: hospital.correctionReason,
  });

  const { passwordHash: _, ...safeHospital } = hospital;
  res.json({ success: true, hospital: safeHospital });
});

// Haversine distance in KM
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

// Clinical Search Variation Map (Section 11)
interface ClinicalRule {
  primaryDepartment: string;
  departments: string[];
  facilities: string[];
  explanation: string;
}

const CLINICAL_MAPPINGS: Record<string, ClinicalRule> = {
  // Cardiology & Heart Conditions
  'heart attack': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG', 'ICU'],
    explanation: 'Cardiology department suggested for acute heart attack / cardiac emergency.',
  },
  'cardiac arrest': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG', 'ICU'],
    explanation: 'Cardiology department suggested for cardiac arrest management.',
  },
  'chest pain': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department suggested for acute chest pain triage.',
  },
  'cardiology': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department.',
  },
  'cardiologist': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department.',
  },
  'heart': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department suggested for heart conditions.',
  },
  'cardiac': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department suggested for cardiac care.',
  },
  'angina': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'Cardiology department suggested for angina.',
  },

  // Orthopedics & Bone / Fracture Conditions
  'bone fracture': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department suggested for bone fractures.',
  },
  'broken bone': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department suggested for broken bones.',
  },
  'fracture': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department suggested for fracture trauma.',
  },
  'bone': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department suggested for bone and skeletal injuries.',
  },
  'orthopedic': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department.',
  },
  'orthopaedic': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department.',
  },
  'orthopaedics': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department.',
  },
  'joint dislocation': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'Orthopaedics (Orthopedic) department suggested for joint dislocation.',
  },

  // Neurology & Stroke
  'stroke': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan', 'ICU'],
    explanation: 'Neurology department suggested for acute stroke.',
  },
  'brain': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan', 'MRI'],
    explanation: 'Neurology department suggested for neurological trauma.',
  },
  'neurology': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan'],
    explanation: 'Neurology department.',
  },
  'neurologist': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan'],
    explanation: 'Neurology department.',
  },

  // Diagnostics & General
  'ct scan': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['CT scan'],
    explanation: 'CT scan diagnostic facility requested.',
  },
  'ct': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['CT scan'],
    explanation: 'CT scan facility requested.',
  },
  'mri': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['MRI'],
    explanation: 'MRI diagnostic imaging requested.',
  },
  'x-ray': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'X-ray diagnostic imaging requested.',
  },
  'xray': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'X-ray diagnostic imaging requested.',
  },
  'icu': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['ICU'],
    explanation: 'Intensive Care Unit (ICU) required.',
  },
  'pediatric': {
    primaryDepartment: 'Paediatrics',
    departments: ['Paediatrics'],
    facilities: [],
    explanation: 'Paediatrics department suggested for pediatric emergency.',
  },
  'pediatrics': {
    primaryDepartment: 'Paediatrics',
    departments: ['Paediatrics'],
    facilities: [],
    explanation: 'Paediatrics department.',
  },
  'paediatrics': {
    primaryDepartment: 'Paediatrics',
    departments: ['Paediatrics'],
    facilities: [],
    explanation: 'Paediatrics department.',
  },
  'oncology': {
    primaryDepartment: 'Oncology',
    departments: ['Oncology'],
    facilities: [],
    explanation: 'Oncology department.',
  },
  'cancer': {
    primaryDepartment: 'Oncology',
    departments: ['Oncology'],
    facilities: [],
    explanation: 'Oncology department.',
  },
  'urology': {
    primaryDepartment: 'Urology',
    departments: ['Urology'],
    facilities: [],
    explanation: 'Urology department.',
  },
  'surgery': {
    primaryDepartment: 'General surgery',
    departments: ['General surgery'],
    facilities: ['Operation theatre'],
    explanation: 'General surgery department.',
  },
  'emergency': {
    primaryDepartment: 'Emergency medicine',
    departments: ['Emergency medicine'],
    facilities: ['24-hour emergency care'],
    explanation: 'Emergency medicine department.',
  },
  'trauma': {
    primaryDepartment: 'Emergency medicine',
    departments: ['Emergency medicine', 'General surgery'],
    facilities: ['Operation theatre', 'ICU', 'CT scan'],
    explanation: 'Level trauma and emergency department.',
  },

  // Kannada Clinical Mappings (Section 21 Multilingual)
  'ಹೃದಯಾಘಾತ': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG', 'ICU'],
    explanation: 'ಹೃದಯಾಘಾತಕ್ಕಾಗಿ ಕಾರ್ಡಿಯಾಲಜಿ (Cardiology) ವಿಭಾಗವನ್ನು ಶಿಫಾರಸು ಮಾಡಲಾಗಿದೆ.',
  },
  'ಹೃದಯ': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG', 'ICU'],
    explanation: 'ಹೃದಯ ಆರೈಕೆಗಾಗಿ ಕಾರ್ಡಿಯಾಲಜಿ (Cardiology) ವಿಭಾಗ.',
  },
  'ಹಾರ್ಟ್': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'ಕಾರ್ಡಿಯಾಲಜಿ (Cardiology) ವಿಭಾಗ.',
  },
  'ಕಾರ್ಡಿಯಾಲಜಿ': {
    primaryDepartment: 'Cardiology',
    departments: ['Cardiology'],
    facilities: ['ECG'],
    explanation: 'ಕಾರ್ಡಿಯಾಲಜಿ (Cardiology) ವಿಭಾಗ.',
  },
  'ಮೂಳೆ ಮುರಿತ': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಮೂಳೆ ಮುರಿತಕ್ಕೆ ಆರ್ಥೋಪೆಡಿಕ್ಸ್ (Orthopaedics) ವಿಭಾಗವನ್ನು ಶಿಫಾರಸು ಮಾಡಲಾಗಿದೆ.',
  },
  'ಮೂಳೆ': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಆರ್ಥೋಪೆಡಿಕ್ಸ್ (Orthopaedics) ವಿಭಾಗ.',
  },
  'ಮುರಿತ': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಆರ್ಥೋಪೆಡಿಕ್ಸ್ (Orthopaedics) ವಿಭಾಗ.',
  },
  'ಆರ್ಥೋಪೆಡಿಕ್': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಆರ್ಥೋಪೆಡಿಕ್ಸ್ (Orthopaedics) ವಿಭಾಗ.',
  },
  'ಮೆದುಳು': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan', 'MRI'],
    explanation: 'ನ್ಯೂರಾಲಜಿ (Neurology) ವಿಭಾಗ.',
  },
  'ನ್ಯೂರೋ': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan'],
    explanation: 'ನ್ಯೂರಾಲಜಿ (Neurology) ವಿಭಾಗ.',
  },
  'ಪಾರ್ಶ್ವವಾಯು': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan', 'ICU'],
    explanation: 'ಪಾರ್ಶ್ವವಾಯು ತುರ್ತು ಚಿಕಿತ್ಸೆಗೆ ನ್ಯೂರಾಲಜಿ (Neurology) ವಿಭಾಗ.',
  },
  'ಸ್ಟ್ರೋಕ್': {
    primaryDepartment: 'Neurology',
    departments: ['Neurology'],
    facilities: ['CT scan', 'ICU'],
    explanation: 'ನ್ಯೂರಾಲಜಿ (Neurology) ವಿಭಾಗ.',
  },
  'ಸಿಟಿ ಸ್ಕ್ಯಾನ್': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['CT scan'],
    explanation: 'ಸಿಟಿ ಸ್ಕ್ಯಾನ್ ಸೌಲಭ್ಯ.',
  },
  'ಸಿಟಿ': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['CT scan'],
    explanation: 'ಸಿಟಿ ಸ್ಕ್ಯಾನ್ ಸೌಲಭ್ಯ.',
  },
  'ಎಂಆರ್ಐ': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['MRI'],
    explanation: 'ಎಂಆರ್‌ಐ ಸ್ಕ್ಯಾನ್ ಸೌಲಭ್ಯ.',
  },
  'ಎಂಆರ್‌ಐ': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['MRI'],
    explanation: 'ಎಂಆರ್‌ಐ ಸ್ಕ್ಯಾನ್ ಸೌಲಭ್ಯ.',
  },
  'ಎಕ್ಸರೇ': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಎಕ್ಸ್‌ರೇ ಸೌಲಭ್ಯ.',
  },
  'ಎಕ್ಸ್‌ರೇ': {
    primaryDepartment: 'Orthopaedics',
    departments: ['Orthopaedics'],
    facilities: ['X-ray'],
    explanation: 'ಎಕ್ಸ್‌ರೇ ಸೌಲಭ್ಯ.',
  },
  'ಐಸಿಯು': {
    primaryDepartment: 'Emergency medicine',
    departments: [],
    facilities: ['ICU'],
    explanation: 'ಐಸಿಯು ತುರ್ತು ಸೌಲಭ್ಯ.',
  },
  'ತುರ್ತು': {
    primaryDepartment: 'Emergency medicine',
    departments: ['Emergency medicine'],
    facilities: ['24-hour emergency care'],
    explanation: 'ತುರ್ತು ಚಿಕಿತ್ಸಾ ವಿಭಾಗ.',
  },
  'ಅಪಘಾತ': {
    primaryDepartment: 'Emergency medicine',
    departments: ['Emergency medicine', 'General surgery'],
    facilities: ['Operation theatre', 'ICU', 'CT scan'],
    explanation: 'ಅಪಘಾತ ಮತ್ತು ತುರ್ತು ಶಸ್ತ್ರಚಿಕಿತ್ಸಾ ವಿಭಾಗ.',
  },
  'ಮಕ್ಕಳ': {
    primaryDepartment: 'Paediatrics',
    departments: ['Paediatrics'],
    facilities: [],
    explanation: 'ಮಕ್ಕಳ ತಜ್ಞರ ವಿಭಾಗ.',
  },
  'ಕ್ಯಾನ್ಸರ್': {
    primaryDepartment: 'Oncology',
    departments: ['Oncology'],
    facilities: [],
    explanation: 'ಕ್ಯಾನ್ಸರ್ (ಆಂಕೊಲಾಜಿ) ವಿಭಾಗ.',
  },
};

// Expand free-text query into suggested department & facilities
function interpretClinicalQuery(query: string) {
  if (!query || !query.trim()) {
    return {
      primaryDepartment: undefined,
      suggestedDepartments: [] as string[],
      suggestedFacilities: [] as string[],
      requiredDepartments: [] as string[],
      requiredFacilities: [] as string[],
      explanation: '',
    };
  }

  const full = query.toLowerCase();
  const matchedDepts = new Set<string>();
  const matchedFacs = new Set<string>();
  let primaryDepartment: string | undefined = undefined;
  let explanation = '';

  // Sort keys by length descending to match specific multi-word phrases first
  const sortedKeys = Object.keys(CLINICAL_MAPPINGS).sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    if (full.includes(key)) {
      const val = CLINICAL_MAPPINGS[key];
      if (!primaryDepartment && val.primaryDepartment) {
        primaryDepartment = val.primaryDepartment;
        explanation = val.explanation;
      }
      val.departments.forEach((d) => matchedDepts.add(d));
      val.facilities.forEach((f) => matchedFacs.add(f));
    }
  }

  if (primaryDepartment) {
    matchedDepts.add(primaryDepartment);
  }

  const deptsArr = Array.from(matchedDepts);
  const facsArr = Array.from(matchedFacs);

  return {
    primaryDepartment,
    suggestedDepartments: deptsArr,
    suggestedFacilities: facsArr,
    requiredDepartments: deptsArr,
    requiredFacilities: facsArr,
    explanation,
  };
}

// Department matching helper with clinical synonyms and variations
function hospitalMatchesDepartment(hospitalDepts: string[], requiredDept: string): boolean {
  if (!requiredDept) return true;
  const target = requiredDept.toLowerCase().trim();
  const list = (hospitalDepts || []).map((d) => (typeof d === 'string' ? d.toLowerCase().trim() : ''));

  // Direct substring match
  if (list.some((d) => d.includes(target) || target.includes(d))) {
    return true;
  }

  // Cardiology & Heart variations
  if (target.includes('cardio') || target.includes('heart') || target.includes('cardiac')) {
    return list.some((d) => d.includes('cardio') || d.includes('heart') || d.includes('cardiac'));
  }

  // Orthopedics / Bone / Fracture variations
  if (target.includes('ortho') || target.includes('bone') || target.includes('fracture')) {
    return list.some((d) => d.includes('ortho') || d.includes('bone') || d.includes('fracture'));
  }

  // Neurology / Brain variations
  if (target.includes('neuro') || target.includes('brain') || target.includes('stroke')) {
    return list.some((d) => d.includes('neuro') || d.includes('brain'));
  }

  // Paediatrics / Child variations
  if (target.includes('paediatr') || target.includes('pediatr')) {
    return list.some((d) => d.includes('paediatr') || d.includes('pediatr'));
  }

  // General Surgery
  if (target.includes('surgery') || target.includes('surgical')) {
    return list.some((d) => d.includes('surgery') || d.includes('surgical'));
  }

  return false;
}

// --- Hospital Search API (Section 11 & 13) ---
app.post('/api/search/hospitals', (req, res) => {
  const {
    originLat,
    originLng,
    query,
    radiusKm,
    departments,
    facilities,
    limit = 50,
  } = req.body;

  let approvedHospitals = Object.values(db.hospitals).filter((h: any) => h.approvalStatus === 'approved');

  // Fallback: If no approved hospitals exist in DB, check all hospitals
  if (approvedHospitals.length === 0) {
    approvedHospitals = Object.values(db.hospitals);
  }

  const interpretation = (query && typeof query === 'string' && query.trim())
    ? interpretClinicalQuery(query)
    : { primaryDepartment: undefined, suggestedDepartments: [] as string[], suggestedFacilities: [] as string[], explanation: '' };

  const explicitDepts: string[] = Array.isArray(departments) ? departments : [];
  const explicitFacs: string[] = Array.isArray(facilities) ? facilities : [];

  const filterDepts = [...new Set([...explicitDepts, ...(interpretation.suggestedDepartments || [])])];
  const primaryDept = interpretation.primaryDepartment || (filterDepts.length > 0 ? filterDepts[0] : undefined);

  const results: any[] = [];

  for (const hospital of approvedHospitals) {
    const hospDepts = hospital.departments || [];
    const hospFacs = (hospital.facilities || []).map((f: string) => (typeof f === 'string' ? f.toLowerCase() : ''));

    // 1. Check department match
    let matchesDept = false;
    const matchedDeptNames: string[] = [];

    if (filterDepts.length > 0) {
      for (const reqDept of filterDepts) {
        if (hospitalMatchesDepartment(hospDepts, reqDept)) {
          matchesDept = true;
          matchedDeptNames.push(reqDept);
        }
      }
    } else {
      matchesDept = true;
    }

    // 2. Also check if hospital name, address, or description matches text query (e.g. searching "Apex", "Manipal", "Canada")
    const cleanQ = (query || '').toLowerCase().trim();
    let matchesText = false;
    if (cleanQ) {
      const name = (hospital.hospitalName || '').toLowerCase();
      const addr = (hospital.fullAddress || '').toLowerCase();
      const desc = (hospital.shortDescription || '').toLowerCase();
      if (name.includes(cleanQ) || addr.includes(cleanQ) || desc.includes(cleanQ)) {
        matchesText = true;
      }
    }

    // If query was clinical (implied a department like Cardiology/Orthopaedics):
    // The hospital MUST match the department OR text.
    if (filterDepts.length > 0 && !matchesDept && !matchesText) {
      continue;
    }

    // If query was purely textual (no clinical dept found) and didn't match text:
    if (cleanQ && filterDepts.length === 0 && !matchesText) {
      continue;
    }

    // Verify explicit user-selected facility checkboxes from UI filters if supplied
    if (explicitFacs.length > 0) {
      const allExplicitMatch = explicitFacs.every((ef) =>
        hospFacs.some((hf: string) => hf.includes(ef.toLowerCase()))
      );
      if (!allExplicitMatch) {
        continue;
      }
    }

    // Calculate geographic distance
    let distKm = 0;
    if (originLat && originLng && hospital.location) {
      distKm = calculateDistanceKm(originLat, originLng, hospital.location.lat, hospital.location.lng);
    }

    // Radius filter if enabled
    if (radiusKm && radiusKm > 0) {
      if (distKm > radiusKm) {
        continue;
      }
    }

    // Identify matched facilities for display
    const matchedFacs = (hospital.facilities || []).filter((f: string) =>
      (interpretation.suggestedFacilities || []).some((sf) => f.toLowerCase().includes(sf.toLowerCase()))
    );

    const { passwordHash: _, ...safe } = hospital;
    results.push({
      ...safe,
      distanceGeographicKm: distKm,
      matchedDepartments: matchedDeptNames.length > 0 ? matchedDeptNames : hospital.departments || [],
      matchedFacilities: matchedFacs,
      suggestedDepartment: primaryDept,
      matchReason: primaryDept
        ? `Offers specialized ${primaryDept} care`
        : 'Emergency trauma center',
    });
  }

  // Sort hospitals:
  // 1. Hospitals matching the primary suggested department rank first
  // 2. Nearest geographic distance
  results.sort((a, b) => {
    const aHasPrimary = primaryDept && hospitalMatchesDepartment(a.departments, primaryDept) ? 1 : 0;
    const bHasPrimary = primaryDept && hospitalMatchesDepartment(b.departments, primaryDept) ? 1 : 0;
    if (aHasPrimary !== bHasPrimary) {
      return bHasPrimary - aHasPrimary;
    }
    return a.distanceGeographicKm - b.distanceGeographicKm;
  });

  res.json({
    total: results.length,
    results: results.slice(0, limit),
    suggestedDepartment: primaryDept || null,
    suggestedDepartments: interpretation.suggestedDepartments,
    interpretedRequirements: {
      departments: interpretation.suggestedDepartments,
      facilities: interpretation.suggestedFacilities,
      primaryDepartment: primaryDept,
      explanation: interpretation.explanation,
    },
  });
});

// --- Real Road Routing API (Section 14) ---
app.post('/api/routing/route', async (req, res) => {
  const { originLat, originLng, destinationLat, destinationLng } = req.body;
  if (!originLat || !originLng || !destinationLat || !destinationLng) {
    return res.status(400).json({ error: 'Origin and destination coordinates required' });
  }

  try {
    // Request real road routing from public OSRM driving engine
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destinationLng},${destinationLat}?overview=full&geometries=geojson&steps=true`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const osrmRes = await fetch(osrmUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PulseEmergencyDispatcher/1.0' },
    });
    clearTimeout(timeout);

    if (osrmRes.ok) {
      const data = await osrmRes.json();
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        // Coordinates in OSRM are [lng, lat]; Leaflet expects [lat, lng]
        const latLngCoords = route.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]]);
        const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
        const durationMinutes = Math.max(1, Math.round(route.duration / 60));

        return res.json({
          provider: 'OSRM OpenStreetMap Driving Engine',
          coordinates: latLngCoords,
          distanceKm,
          durationMinutes,
          summary: route.legs?.[0]?.summary || 'Primary Road Route',
        });
      }
    }
  } catch (e) {
    // Fallback road corridor generation if OSRM is slow or offline
  }

  // High-fidelity fallback road geometry interpolation
  const directDistKm = calculateDistanceKm(originLat, originLng, destinationLat, destinationLng);
  const roadDistKm = Math.round(directDistKm * 1.25 * 10) / 10;
  const durationMin = Math.max(2, Math.round(roadDistKm * 2.2)); // ~30 km/h emergency city speed

  // Generate intermediate road-like waypoints
  const points: [number, number][] = [];
  const steps = 15;
  for (let i = 0; i <= steps; i++) {
    const fraction = i / steps;
    // slight curve to mimic city roads
    const curve = Math.sin(fraction * Math.PI) * 0.003;
    const lat = originLat + (destinationLat - originLat) * fraction + curve;
    const lng = originLng + (destinationLng - originLng) * fraction - curve * 0.5;
    points.push([lat, lng]);
  }

  res.json({
    provider: 'Pulse Road Corridor Engine (Emergency Trajectory)',
    coordinates: points,
    distanceKm: roadDistKm,
    durationMinutes: durationMin,
    summary: 'Emergency Corridor',
  });
});

// --- Journeys & Arrival Estimates (Section 15) ---
app.post('/api/journeys', (req, res) => {
  const {
    driverId,
    hospitalId,
    driverName,
    vehicleNumber,
    driverPhone,
    originLat,
    originLng,
    destinationLat,
    destinationLng,
    roadDistanceKm,
    durationMinutes,
    routeGeometry,
  } = req.body;

  if (!driverId || !hospitalId) {
    return res.status(400).json({ error: 'Driver and Hospital IDs required' });
  }

  const journeyId = `jrn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date();
  const etaDate = new Date(now.getTime() + (durationMinutes || 15) * 60000);

  const journey = {
    id: journeyId,
    driverId,
    hospitalId,
    driverName: driverName || 'Emergency Driver',
    vehicleNumber: vehicleNumber || 'AMB-000',
    driverPhone: driverPhone || '',
    originLat,
    originLng,
    destinationLat,
    destinationLng,
    status: 'active',
    roadDistanceKm: roadDistanceKm || 5.0,
    remainingDurationMinutes: durationMinutes || 15,
    estimatedArrivalTime: etaDate.toISOString(),
    estimateLastUpdated: now.toISOString(),
    routeGeometry: routeGeometry || [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  db.journeys[journeyId] = journey;
  saveDatabase();

  res.status(201).json(journey);
});

app.post('/api/journeys/:id/refresh-eta', (req, res) => {
  const journey = db.journeys[req.params.id];
  if (!journey) {
    return res.status(404).json({ error: 'Journey not found' });
  }

  const { durationMinutes, roadDistanceKm } = req.body;
  const newDuration = durationMinutes !== undefined ? durationMinutes : Math.max(1, journey.remainingDurationMinutes - 2);

  const now = new Date();
  const etaDate = new Date(now.getTime() + newDuration * 60000);

  journey.remainingDurationMinutes = newDuration;
  if (roadDistanceKm) journey.roadDistanceKm = roadDistanceKm;
  journey.estimatedArrivalTime = etaDate.toISOString();
  journey.estimateLastUpdated = now.toISOString();
  journey.updatedAt = now.toISOString();

  // Find linked notification and update ETA in place (no duplicate!)
  const linkedNotification = Object.values(db.notifications).find(
    (n: any) => n.journeyId === journey.id
  );

  if (linkedNotification) {
    linkedNotification.availableEta = etaDate.toISOString();
    linkedNotification.remainingDurationMinutes = newDuration;
    linkedNotification.lastUpdated = now.toISOString();

    // Broadcast update to the specific destination hospital
    sendToHospital(linkedNotification.destinationHospitalId, {
      type: 'ETA_UPDATED',
      notificationId: linkedNotification.id,
      journeyId: journey.id,
      availableEta: linkedNotification.availableEta,
      remainingDurationMinutes: newDuration,
      lastUpdated: now.toISOString(),
    });
  }

  saveDatabase();
  res.json({ success: true, journey, linkedNotification });
});

// --- Incoming-Case Notifications (Section 16, 17, 18) ---
app.post('/api/notifications', (req, res) => {
  const {
    journeyId,
    driverAccountId,
    destinationHospitalId,
    driverName,
    vehicleNumber,
    contactNumber,
    reportedEmergency,
    availableEta,
    remainingDurationMinutes,
    clientRequestId,
  } = req.body;

  if (!destinationHospitalId || !reportedEmergency || !driverName) {
    return res.status(400).json({ error: 'Missing mandatory notification parameters.' });
  }

  // Duplicate protection for retries (Section 16)
  if (clientRequestId) {
    const existing = Object.values(db.notifications).find(
      (n: any) => (n as any).clientRequestId === clientRequestId
    );
    if (existing) {
      return res.json({ success: true, notification: existing, duplicated: true });
    }
  }

  const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();

  const notification = {
    id: notificationId,
    journeyId: journeyId || `jrn_${Date.now()}`,
    driverAccountId: driverAccountId || 'unknown_driver',
    destinationHospitalId,
    driverName,
    vehicleNumber,
    contactNumber: contactNumber || '',
    reportedEmergency,
    availableEta: availableEta || new Date(Date.now() + 15 * 60000).toISOString(),
    remainingDurationMinutes: remainingDurationMinutes || 15,
    timeSent: now,
    lastUpdated: now,
    isRead: false,
    clientRequestId,
  };

  db.notifications[notificationId] = notification;
  saveDatabase();

  // Strict account-specific delivery: send ONLY to destination hospital WebSocket
  sendToHospital(destinationHospitalId, {
    type: 'CASE_NOTIFICATION',
    notification,
  });

  res.status(201).json({
    success: true,
    notification,
  });
});

// Strictly scoped to destination hospital ID (Section 18)
app.get('/api/hospitals/:id/notifications', (req, res) => {
  const hospitalId = req.params.id;
  const hospitalNotifications = Object.values(db.notifications)
    .filter((n: any) => n.destinationHospitalId === hospitalId)
    .sort((a: any, b: any) => new Date(b.timeSent).getTime() - new Date(a.timeSent).getTime());

  res.json(hospitalNotifications);
});

app.patch('/api/notifications/:id/read', (req, res) => {
  const notif = db.notifications[req.params.id];
  if (!notif) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  notif.isRead = true;
  notif.readAt = new Date().toISOString();
  saveDatabase();
  res.json({ success: true, notification: notif });
});

// --- Signal Warning Demonstration & OSM Overpass (Section 19 & 20) ---
app.post('/api/signals/query-route', async (req, res) => {
  const { coordinates } = req.body;
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
    return res.status(400).json({ error: 'Route coordinates required' });
  }

  // Calculate bounding box around route
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  coordinates.forEach(([lat, lng]: [number, number]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  });

  // Expand bounding box slightly (~200m)
  minLat -= 0.003;
  maxLat += 0.003;
  minLng -= 0.003;
  maxLng += 0.003;

  try {
    const overpassQuery = `[out:json][timeout:5];node["highway"="traffic_signals"](${minLat},${minLng},${maxLat},${maxLng});out 15;`;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(overpassUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PulseEmergencyTrafficSignals/1.0' },
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      if (data.elements && data.elements.length > 0) {
        // Group and arrange along the route
        const signals = data.elements.slice(0, 5).map((el: any, idx: number) => ({
          id: `sig_osm_${el.id}`,
          label: `Signal ${String.fromCharCode(65 + idx)}`,
          name: el.tags?.name || `Junction Approach ${String.fromCharCode(65 + idx)}`,
          lat: el.lat,
          lng: el.lon,
          approachRadiusMeters: 180,
          roadName: el.tags?.street || 'Emergency Corridor Crossing',
          osmNodeId: String(el.id),
          status: 'idle',
        }));

        return res.json({
          source: 'OpenStreetMap Overpass Live Signals',
          signals,
        });
      }
    }
  } catch (e) {
    // If Overpass is rate-limited or times out, place realistic demonstration signals along route points
  }

  // Fallback high-fidelity demonstration signals along route
  const total = coordinates.length;
  const indices = [
    Math.floor(total * 0.25),
    Math.floor(total * 0.55),
    Math.floor(total * 0.85),
  ].filter(i => i < total && i > 0);

  const signals = indices.map((idx, i) => {
    const [lat, lng] = coordinates[idx];
    return {
      id: `sig_demo_${i + 1}`,
      label: `Signal ${String.fromCharCode(65 + i)}`,
      name: `Grand Crossroad Junction ${String.fromCharCode(65 + i)}`,
      lat,
      lng,
      approachRadiusMeters: 180,
      roadName: `Main Avenue Corridor Junction ${i + 1}`,
      status: 'idle',
    };
  });

  res.json({
    source: 'Demonstration Junction Coordinates Along Route',
    signals,
  });
});

// Future Roadside Device Interface (Section 20) Command & Acknowledgment
app.post('/api/signals/board-command', (req, res) => {
  const { boardId, journeyId, alertId, action, direction, timestamp, expiry } = req.body;

  if (!boardId || !action || !['ACTIVATE', 'CLEAR'].includes(action)) {
    return res.status(400).json({ error: 'Valid boardId and action (ACTIVATE or CLEAR) required' });
  }

  const eventRecord = {
    id: `event_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    boardId,
    journeyId: journeyId || 'jrn_demo',
    signalId: alertId || boardId,
    action,
    message: action === 'ACTIVATE'
      ? 'EMERGENCY AMBULANCE APPROACHING - YIELD RIGHT OF WAY'
      : 'ALL CLEAR - NORMAL TRAFFIC RESTORED',
    timestamp: timestamp || new Date().toISOString(),
    direction: direction || 'Northbound',
    acknowledged: true,
  };

  db.warningBoardEvents.unshift(eventRecord);
  if (db.warningBoardEvents.length > 50) {
    db.warningBoardEvents.pop();
  }
  saveDatabase();

  // Broadcast event to administrator portal
  broadcastToAdmins({
    type: 'SIGNAL_BOARD_EVENT',
    event: eventRecord,
  });

  const response = {
    boardId,
    alertId: alertId || `alt_${Date.now()}`,
    acknowledgedAction: action,
    timestamp: new Date().toISOString(),
  };

  res.json({
    success: true,
    protocol: 'Roadside Virtual Adapter v1.0 (MQTT/HTTPS Ready)',
    response,
  });
});

app.get('/api/signals/events', (req, res) => {
  res.json(db.warningBoardEvents);
});

// --- Speech & Voice Assistant API (Section 21 Multilingual) ---
app.post('/api/voice/interpret', (req, res) => {
  const { transcript, language } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'Transcript required' });
  }

  const isKannada = language === 'kn';
  const interpretation = interpretClinicalQuery(transcript);
  let summary = isKannada ? 'ಸಾಮಾನ್ಯ ತುರ್ತು ಚಿಕಿತ್ಸೆ' : 'General emergency care';

  if (interpretation.requiredDepartments.length > 0 && interpretation.requiredFacilities.length > 0) {
    summary = isKannada
      ? `${interpretation.requiredDepartments.join(', ')} ಮತ್ತು ${interpretation.requiredFacilities.join(', ')} ಸೌಲಭ್ಯವಿರುವ ಆಸ್ಪತ್ರೆ`
      : `${interpretation.requiredDepartments.join(', ')} with ${interpretation.requiredFacilities.join(', ')}`;
  } else if (interpretation.requiredDepartments.length > 0) {
    summary = isKannada
      ? `${interpretation.requiredDepartments.join(', ')} ವಿಭಾಗದ ತುರ್ತು ಆರೈಕೆ`
      : `${interpretation.requiredDepartments.join(', ')} Emergency Care`;
  } else if (interpretation.requiredFacilities.length > 0) {
    summary = isKannada
      ? `${interpretation.requiredFacilities.join(', ')} ಸೌಲಭ್ಯವಿರುವ ತುರ್ತು ಆಸ್ಪತ್ರೆ`
      : `Hospital with ${interpretation.requiredFacilities.join(', ')}`;
  }

  res.json({
    transcript,
    language: isKannada ? 'kn' : 'en',
    interpretedSummary: summary,
    requiredDepartments: interpretation.requiredDepartments,
    requiredFacilities: interpretation.requiredFacilities,
  });
});

// Vite Middleware for Development / Static Hosting for Production
async function setupViteOrStatic() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }
}

setupViteOrStatic().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pulse Central Full-Stack Server running at http://0.0.0.0:${PORT}`);
    console.log(`WebSocket server mounted at ws://0.0.0.0:${PORT}/ws`);
  });
});
