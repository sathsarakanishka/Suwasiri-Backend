import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, DB_PATH } from './db.js';
import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import appointmentRoutes from './routes/appointments.js';
import inventoryRoutes from './routes/inventory.js';
import billingRoutes from './routes/billing.js';
import staffRoutes from './routes/staff.js';
import dashboardRoutes from './routes/dashboard.js';

initDatabase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3456);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', clinic: 'Suwasiri Ayurvedic Wellness Center' });
});

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api', staffRoutes);
app.use('/api', dashboardRoutes);

// Serve built React frontend when available (standalone / production mode)
const clientDistDir = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Suwasiri API Error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Suwasiri Clinic Server running at http://localhost:${PORT}`);
  console.log(`Local SQLite database: ${DB_PATH}`);
});
