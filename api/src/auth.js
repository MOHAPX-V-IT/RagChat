import jwt from 'jsonwebtoken';
import { store, publicUser } from './store.js';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: '12h' });
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, secret);
    const user = store.read().users.find((item) => item.id === payload.sub && item.isActive);
    if (!user) return res.status(401).json({ error: 'Учётная запись недоступна.' });
    req.user = publicUser(user);
    next();
  } catch {
    res.status(401).json({ error: 'Требуется авторизация.' });
  }
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия.' });
    }
    next();
  };
}
