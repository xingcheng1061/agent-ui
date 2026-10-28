import { useState } from 'react';
import { login, setupAdmin } from '../api';

/**
 * Login, and first-run account creation.
 *
 * The server reports `setup-required` (401 with that error code) while no
 * account exists, which is the only state in which creating one is allowed —
 * otherwise anyone reaching the port could claim an unattended instance.
 */
export function AuthPage({ setupRequired, onDone }: {
	readonly setupRequired: boolean;
	readonly onDone: () => void;
}) {
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		setError(undefined);
		try {
			if (setupRequired) {
				await setupAdmin(username.trim(), password);
			} else {
				await login(username.trim(), password);
			}
			onDone();
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			setError(setupRequired ? `创建失败：${message}` : '用户名或密码错误。');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="auth-page">
			<form
				className="auth-card"
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<h1 className="auth-title">agent-ui</h1>
				<p className="auth-sub">
					{setupRequired ? '首次使用：创建管理员账号' : '登录以继续'}
				</p>

				<label className="auth-label" htmlFor="auth-username">用户名</label>
				<input
					id="auth-username"
					className="auth-input"
					value={username}
					autoComplete="username"
					onChange={event => setUsername(event.target.value)}
				/>

				<label className="auth-label" htmlFor="auth-password">密码</label>
				<input
					id="auth-password"
					className="auth-input"
					type="password"
					value={password}
					autoComplete={setupRequired ? 'new-password' : 'current-password'}
					onChange={event => setPassword(event.target.value)}
				/>

				{error && <div className="auth-error">{error}</div>}

				<button type="submit" className="primary auth-submit" disabled={busy || !username.trim() || password.length < 6}>
					{setupRequired ? '创建并登录' : '登录'}
				</button>

				{setupRequired && (
					<p className="auth-hint">密码至少 6 位。账号保存在服务端的 ~/.agent-ui/users.json。</p>
				)}
			</form>
		</div>
	);
}
