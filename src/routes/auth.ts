import { Router } from 'express';
import { db, verifyPassword, hashPassword } from '../db.js';
import { createToken, requireAuth, type AuthedRequest, type AuthUser } from '../auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const row = db
    .prepare('SELECT id, username, full_name, role, password_hash, specialty, phone, is_active FROM users WHERE username = ?')
    .get(String(username).trim().toLowerCase()) as (AuthUser & { password_hash: string }) | undefined;

  if (!row || !verifyPassword(String(password), row.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'This staff account is deactivated. Contact your clinic administrator.' });
    return;
  }

  const user: AuthUser = {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    specialty: row.specialty,
    phone: row.phone,
    is_active: row.is_active,
  };

  const token = createToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword || String(newPassword).length < 6) {
    res.status(400).json({ error: 'Current password and a new password (min 6 characters) are required' });
    return;
  }

  const row = db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(req.user!.id) as { password_hash: string } | undefined;

  if (!row || !verifyPassword(String(currentPassword), row.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), req.user!.id);
  res.json({ message: 'Password updated successfully' });
});

router.get('/doctors', requireAuth, (_req, res) => {
  const doctors = db
    .prepare("SELECT id, full_name, specialty, phone FROM users WHERE role = 'doctor' AND is_active = 1 ORDER BY full_name ASC")
    .all();
  res.json({ doctors });
});

export default router;
