// Account registration / login and JWT helpers.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CONFIG } from './config.js';
import { userQueries } from './db.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, CONFIG.JWT_SECRET, {
    expiresIn: CONFIG.TOKEN_TTL,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT_SECRET);
  } catch {
    return null;
  }
}

export function register(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    return { error: 'Username must be 3-16 letters, numbers or underscores.' };
  }
  if (!password || password.length < 4) {
    return { error: 'Password must be at least 4 characters.' };
  }
  if (userQueries.byUsername.get(username)) {
    return { error: 'That username is already taken.' };
  }
  // The configured admin username, or the very first account, becomes admin.
  const firstUser = userQueries.count.get().n === 0;
  const isAdmin = (username === CONFIG.ADMIN_USERNAME || firstUser) ? 1 : 0;
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const info = userQueries.create.run(username, hash, isAdmin, now, now);
  const user = { id: info.lastInsertRowid, username };
  return { token: signToken(user), username, isAdmin: !!isAdmin };
}

export function login(username, password) {
  const user = userQueries.byUsername.get(username);
  if (!user || !bcrypt.compareSync(password || '', user.pass_hash)) {
    return { error: 'Invalid username or password.' };
  }
  if (user.banned) return { error: 'This account has been banned.' };
  userQueries.touch.run(Date.now(), user.id);
  return { token: signToken(user), username: user.username, isAdmin: !!user.is_admin };
}

// Returns the full user row if the token belongs to an admin, else null.
export function verifyAdmin(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = userQueries.byId.get(payload.id);
  return user && user.is_admin ? user : null;
}
