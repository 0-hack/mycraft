// Account registration / login and JWT helpers.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CONFIG } from './config.js';
import { userQueries } from './db.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
// A fixed bcrypt hash compared against when a username doesn't exist, to keep
// login timing constant and avoid leaking which accounts are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

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
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return { error: 'Password must be 6-200 characters.' };
  }
  if (userQueries.byUsername.get(username)) {
    return { error: 'That username is already taken.' };
  }
  // Admin is granted ONLY to the first account (bootstrap), or to a username
  // that the operator EXPLICITLY designated via the ADMIN_USERNAME env var.
  // The default name must never auto-grant admin (anyone could claim it).
  const firstUser = userQueries.count.get().n === 0;
  const namedAdmin = CONFIG.ADMIN_USERNAME_FROM_ENV && username === CONFIG.ADMIN_USERNAME;
  const isAdmin = (firstUser || namedAdmin) ? 1 : 0;
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const info = userQueries.create.run(username, hash, isAdmin, now, now);
  const user = { id: info.lastInsertRowid, username };
  return { token: signToken(user), username, isAdmin: !!isAdmin };
}

export function login(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) {
    return { error: 'Invalid username or password.' };
  }
  const user = userQueries.byUsername.get(username);
  // Always run a compare (even when the user doesn't exist) so response timing
  // doesn't reveal which usernames are registered.
  const ok = bcrypt.compareSync(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) {
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
