import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';

export type UserRole = 'admin' | 'doctor' | 'receptionist';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  specialty: string;
  phone: string;
  is_active: number;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

let cachedSecret: string | null = null;
function getTokenSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (process.env.SUWASIRI_SECRET) {
    cachedSecret = process.env.SUWASIRI_SECRET;
    return cachedSecret;
  }
  const row = db.prepare("SELECT value FROM clinic_settings WHERE key = 'auth_secret'").get() as { value: string } | undefined;
  if (row?.value) {
    cachedSecret = row.value;
    return cachedSecret;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO clinic_settings (key, value) VALUES ('auth_secret', ?)").run(generated);
  cachedSecret = generated;
  return cachedSecret;
}

const TOKEN_TTL_MS = 1000 * 60 * 60 * 16; // 16-hour clinic shift

export function createToken(user: AuthUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.id,
      role: user.role,
      exp: Date.now() + TOKEN_TTL_MS,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', getTokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): { uid: number; role: UserRole; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', getTokenSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    return;
  }

  const user = db
    .prepare('SELECT id, username, full_name, role, specialty, phone, is_active FROM users WHERE id = ?')
    .get(decoded.uid) as AuthUser | undefined;

  if (!user || !user.is_active) {
    res.status(401).json({ error: 'Account is disabled or no longer exists' });
    return;
  }

  req.user = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'You do not have permission to perform this action' });
      return;
    }
    next();
  };
}
