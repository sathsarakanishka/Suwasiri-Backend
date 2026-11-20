import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();
router.use(requireAuth);

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

router.get('/dashboard', (_req, res) => {
  const today = todayIso();

  const totalPatients = (db.prepare('SELECT COUNT(*) as count FROM patients').get() as { count: number }).count;

  const queueCounts = db
    .prepare(`
      SELECT
        COUNT(*) as total_today,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'in_consultation' THEN 1 ELSE 0 END) as in_consultation,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM appointments
      WHERE appointment_date = ?
    `)
    .get(today) as { total_today: number; waiting: number | null; in_consultation: number | null; completed: number | null };

  const revenueToday = (
    db
      .prepare(`
        SELECT COALESCE(SUM(paid_amount), 0) as total
        FROM invoices
        WHERE date(created_at) = date('now', 'localtime') AND payment_status != 'void'
      `)
      .get() as { total: number }
  ).total;

  const revenueMonth = (
    db
      .prepare(`
        SELECT COALESCE(SUM(paid_amount), 0) as total
        FROM invoices
        WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND payment_status != 'void'
      `)
      .get() as { total: number }
  ).total;

  const outstandingBalance = (
    db
      .prepare(`
        SELECT COALESCE(SUM(total_amount - paid_amount), 0) as total
        FROM invoices
        WHERE payment_status IN ('pending', 'partial')
      `)
      .get() as { total: number }
  ).total;

  const lowStockItems = db
    .prepare(`
      SELECT * FROM inventory_items
      WHERE is_active = 1 AND category != 'treatment' AND stock_quantity <= reorder_level
      ORDER BY stock_quantity ASC
      LIMIT 10
    `)
    .all();

  const todayQueue = db
    .prepare(`
      SELECT a.*, p.patient_code, p.full_name as patient_name, p.phone as patient_phone, u.full_name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.appointment_date = ? AND a.status IN ('waiting', 'in_consultation')
      ORDER BY a.token_number ASC
      LIMIT 15
    `)
    .all(today);

  const recentPatients = db
    .prepare('SELECT id, patient_code, full_name, phone, prakriti, created_at FROM patients ORDER BY id DESC LIMIT 6')
    .all();

  res.json({
    today,
    stats: {
      totalPatients,
      todayAppointments: queueCounts.total_today || 0,
      waitingCount: queueCounts.waiting || 0,
      inConsultationCount: queueCounts.in_consultation || 0,
      completedCount: queueCounts.completed || 0,
      revenueToday,
      revenueMonth,
      outstandingBalance,
      lowStockCount: lowStockItems.length,
    },
    lowStockItems,
    todayQueue,
    recentPatients,
  });
});

router.get('/admin/backup', requireRole('admin'), (_req, res) => {
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `suwasiri-backup-${stamp}.db`);

  try {
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
    const escapedPath = backupFile.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedPath}'`);
    const fileData = fs.readFileSync(backupFile);
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="suwasiri-backup-${stamp}.db"`);
    res.send(fileData);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
  }
});

export default router;
