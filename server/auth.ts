import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { JsonStore } from './store.js';

/**
 * Account and session storage. File-backed on purpose: the service is a
 * single-user local tool, so a JSON document under `~/.agent-ui` is easier to
 * inspect and back up than a database, and there is no concurrency to speak of.
 */

export type Role = 'admin' | 'user';

export interface User {
	readonly id: string;
	readonly username: string;
	readonly passwordHash: string;
	readonly salt: string;
	readonly role: Role;
	readonly createdAt: number;
}

/** What the browser is allowed to see; the hash never leaves the server. */
export interface PublicUser {
	readonly id: string;
	readonly username: string;
	readonly role: Role;
	readonly createdAt: number;
}

interface Session {
	readonly token: string;
	readonly userId: string;
	readonly createdAt: number;
	readonly lastSeenAt: number;
}

const USER_FILE = 'users.json';
const SESSION_FILE = 'sessions.json';

/** How long an unused session stays valid. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const COOKIE_NAME = 'agentui_session';

const userStore = new JsonStore<{ users: readonly User[] }>(USER_FILE, { users: [] });
const sessionStore = new JsonStore<{ sessions: readonly Session[] }>(SESSION_FILE, { sessions: [] });

export async function preloadAuth(): Promise<void> {
	await Promise.all([userStore.load(), sessionStore.load()]);
}

function hash(password: string, salt: string): string {
	return scryptSync(password, salt, 64).toString('hex');
}

function newId(): string {
	return randomBytes(16).toString('hex');
}

export function sanitize(user: User): PublicUser {
	return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

/** Creates an account. Returns `undefined` when the name is taken. */
export async function createUser(username: string, password: string, role: Role = 'user'): Promise<User | undefined> {
	const name = username.trim();
	if (name.length === 0 || password.length === 0) {
		return undefined;
	}
	if (userStore.snapshot.users.some(user => user.username.toLowerCase() === name.toLowerCase())) {
		return undefined;
	}
	const salt = randomBytes(16).toString('hex');
	const user: User = {
		id: newId(),
		username: name,
		passwordHash: hash(password, salt),
		salt,
		role,
		createdAt: Date.now(),
	};
	await userStore.update(draft => {
		(draft.users as User[]).push(user);
	});
	return user;
}

export function userCount(): number {
	return userStore.snapshot.users.length;
}

export async function verifyCredentials(username: string, password: string): Promise<User | undefined> {
	const user = userStore.snapshot.users.find(
		candidate => candidate.username.toLowerCase() === username.trim().toLowerCase(),
	);
	if (!user) {
		// Hash anyway so a missing account and a wrong password cost the same.
		hash(password, 'decoy');
		return undefined;
	}
	const expected = Buffer.from(user.passwordHash, 'hex');
	const actual = Buffer.from(hash(password, user.salt), 'hex');
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return undefined;
	}
	return user;
}

export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
	const user = userStore.snapshot.users.find(candidate => candidate.id === userId);
	if (!user) {
		return false;
	}
	const expected = Buffer.from(user.passwordHash, 'hex');
	const actual = Buffer.from(hash(current, user.salt), 'hex');
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return false;
	}
	const salt = randomBytes(16).toString('hex');
	await userStore.update(draft => {
		const index = draft.users.findIndex(candidate => candidate.id === userId);
		if (index >= 0) {
			(draft.users as User[])[index] = { ...user, passwordHash: hash(next, salt), salt };
		}
	});
	return true;
}

/** Issues a session token; the cookie value the browser will hold. */
export async function createSession(userId: string): Promise<string> {
	const session: Session = {
		token: randomBytes(32).toString('hex'),
		userId,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
	};
	await sessionStore.update(draft => {
		(draft.sessions as Session[]).push(session);
	});
	return session.token;
}

export async function userForToken(token: string | undefined): Promise<User | undefined> {
	if (!token) {
		return undefined;
	}
	const session = sessionStore.snapshot.sessions.find(candidate => candidate.token === token);
	if (!session) {
		return undefined;
	}
	if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
		await destroySession(token);
		return undefined;
	}
	// Refresh the sliding window without blocking the request on a disk write.
	void sessionStore.update(draft => {
		const index = draft.sessions.findIndex(candidate => candidate.token === token);
		if (index >= 0) {
			(draft.sessions as Session[])[index] = { ...draft.sessions[index]!, lastSeenAt: Date.now() };
		}
	});
	return userStore.snapshot.users.find(candidate => candidate.id === session.userId);
}

export async function destroySession(token: string | undefined): Promise<void> {
	if (!token) {
		return;
	}
	await sessionStore.update(draft => {
		const sessions = draft.sessions as Session[];
		const index = sessions.findIndex(candidate => candidate.token === token);
		if (index >= 0) {
			sessions.splice(index, 1);
		}
	});
}

/**
 * Boot-time bootstrap for scripted setups: creates the account, or resets its
 * password when it already exists. Driven by `AGENT_UI_ADMIN_USER` /
 * `AGENT_UI_ADMIN_PASSWORD`.
 */
export async function ensureAdmin(username: string, password: string): Promise<void> {
	const existing = userStore.snapshot.users.find(
		candidate => candidate.username.toLowerCase() === username.trim().toLowerCase(),
	);
	if (!existing) {
		const created = await createUser(username, password, 'admin');
		if (created) {
			console.log(`[agent-ui] created admin account "${created.username}"`);
		}
		return;
	}
	const salt = randomBytes(16).toString('hex');
	await userStore.update(draft => {
		const index = draft.users.findIndex(candidate => candidate.id === existing.id);
		if (index >= 0) {
			(draft.users as User[])[index] = { ...existing, passwordHash: hash(password, salt), salt, role: 'admin' };
		}
	});
	console.log(`[agent-ui] reset password for "${existing.username}"`);
}

/** Reads the session token from a cookie header or a `?token=` query value. */
export function tokenFrom(request: { headers: { cookie?: string }; url?: string }): string | undefined {
	const cookie = request.headers.cookie;
	if (cookie) {
		for (const part of cookie.split(';')) {
			const [name, ...rest] = part.trim().split('=');
			if (name === COOKIE_NAME && rest.length > 0) {
				return decodeURIComponent(rest.join('='));
			}
		}
	}
	const query = request.url?.split('?')[1];
	if (query) {
		const value = new URLSearchParams(query).get('token');
		if (value) {
			return value;
		}
	}
	return undefined;
}

export function cookieFor(token: string, maxAgeSeconds: number): string {
	return [
		`${COOKIE_NAME}=${encodeURIComponent(token)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${maxAgeSeconds}`,
	].join('; ');
}
