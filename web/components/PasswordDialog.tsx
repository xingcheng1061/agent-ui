import { useState } from 'react';
import { changePassword } from '../api';

/**
 * Change-password dialog. The server requires the current password, so a stolen
 * cookie alone is not enough to take over an account.
 */
export function PasswordDialog({ onClose }: { readonly onClose: () => void }) {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState<string | undefined>(undefined);
	const [done, setDone] = useState(false);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setError(undefined);
		if (next !== confirm) {
			setError('两次输入的新密码不一致。');
			return;
		}
		if (next.length < 6) {
			setError('新密码至少 6 位。');
			return;
		}
		setBusy(true);
		try {
			await changePassword(current, next);
			setDone(true);
			setTimeout(onClose, 1200);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<form
				className="modal auth-card"
				onClick={event => event.stopPropagation()}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<h2 className="auth-title">修改密码</h2>
				<p className="auth-sub">修改后当前会话保持登录，其他设备需要重新登录。</p>

				<label className="auth-label" htmlFor="pw-current">当前密码</label>
				<input
					id="pw-current"
					className="auth-input"
					type="password"
					autoComplete="current-password"
					value={current}
					onChange={event => setCurrent(event.target.value)}
				/>

				<label className="auth-label" htmlFor="pw-next">新密码（至少 6 位）</label>
				<input
					id="pw-next"
					className="auth-input"
					type="password"
					autoComplete="new-password"
					value={next}
					onChange={event => setNext(event.target.value)}
				/>

				<label className="auth-label" htmlFor="pw-confirm">确认新密码</label>
				<input
					id="pw-confirm"
					className="auth-input"
					type="password"
					autoComplete="new-password"
					value={confirm}
					onChange={event => setConfirm(event.target.value)}
				/>

				{error && <div className="auth-error">{error}</div>}
				{done && <div className="auth-ok">密码已修改。</div>}

				<div className="permission-actions">
					<button type="button" className="toggle" onClick={onClose}>取消</button>
					<button type="submit" className="primary auth-submit" disabled={busy || !current || !next || !confirm}>
						{busy ? '提交中…' : '确认修改'}
					</button>
				</div>
			</form>
		</div>
	);
}
