#!/usr/bin/env python3
"""agent-ui UI probe.

Drives the running web UI with Selenium, records anything that looks wrong and
writes a report you can read before deciding what (if anything) to fix. It never
asserts on business behaviour: it collects console errors, uncaught exceptions,
failed requests, missing or unclickable controls and broken layout, then leaves
the judgement to you.

The app must already be running (``npm run dev``), on http://127.0.0.1:4711 by
default.

    pip install -r e2e/requirements.txt
    python e2e/ui_probe.py --password <管理员密码>

Common flags:

    --headed             show the browser instead of running headless
    --allow-agent        also start a session and send a message (spends tokens)
    --only boot,rail     run a subset of scenarios
    --browser edge       use Edge rather than Chrome
    --server-log <file>  also scan a server log for exceptions

Output goes to ``reports/run-<timestamp>/``: ``report.md`` (read this first),
``report.json`` (machine readable) and ``screenshots/`` for every error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# ---------------------------------------------------------------------------
# In-page probes
# ---------------------------------------------------------------------------

# Installed through CDP so it survives navigation: window.onerror and friends
# only see what happens after they are registered, and a reload would otherwise
# silently drop the registration.
PROBE_JS = r"""
(() => {
	if (window.__agentUiProbe) {
		return;
	}
	const state = { errors: [] };
	window.__agentUiProbe = state;
	const push = (kind, message, extra) => {
		state.errors.push({ kind: kind, message: String(message), extra: extra || {}, at: Date.now() });
	};
	window.addEventListener('error', event => {
		push('error', event.message || 'unknown error', {
			source: event.filename || '',
			line: event.lineno || 0,
			column: event.colno || 0
		});
	});
	window.addEventListener('unhandledrejection', event => {
		const reason = event.reason;
		push('unhandledrejection', reason && (reason.stack || reason.message) || String(reason));
	});
	['error', 'warn'].forEach(level => {
		const original = console[level].bind(console);
		console[level] = (...args) => {
			push('console.' + level, args.map(argument => {
				if (typeof argument === 'string') {
					return argument;
				}
				try {
					return JSON.stringify(argument);
				} catch {
					return String(argument);
				}
			}).join(' '));
			original(...args);
		};
	});
})();
"""

# Layout checks aimed at the classes of bug this UI has actually had: controls
# that stack instead of lining up, and text that overlaps its neighbour.
VISUAL_JS = r"""
(() => {
	const problems = [];
	const describe = element => {
		const name = (element.className || '').toString().trim().split(/\s+/).slice(0, 2).join('.');
		return (element.tagName || 'node').toLowerCase() + (name ? '.' + name : '');
	};
	const root = document.documentElement;
	if (root.scrollWidth > root.clientWidth + 2) {
		problems.push({ check: 'page-overflow-x', detail: root.scrollWidth + ' > ' + root.clientWidth, severity: 'warning' });
	}
	document.querySelectorAll('.topbar, .chat-list, .session-rail, .code-pane, .file-pane, .md').forEach(container => {
		const style = getComputedStyle(container);
		if (style.overflowX === 'visible' && container.scrollWidth > container.clientWidth + 2) {
			problems.push({
				check: 'container-overflow-x',
				detail: describe(container) + ' ' + container.scrollWidth + ' > ' + container.clientWidth,
				severity: 'warning'
			});
		}
	});
	// streamdown draws its own toolbar; with no Tailwind build it collapses into a
	// column unless the app restores it. One row means all tops are equal.
	document.querySelectorAll('[data-streamdown="table-wrapper"] > div:first-child').forEach(row => {
		const tops = Array.from(row.children).map(child => Math.round(child.getBoundingClientRect().top));
		if (new Set(tops).size > 1) {
			problems.push({ check: 'table-controls-stacked', detail: 'tops=' + tops.join(','), severity: 'error' });
		}
	});
	const overlaps = [];
	document.querySelectorAll('.md, .msg, .session-rail, .pane-tabs, .terminal-tabs, .chat-header').forEach(parent => {
		const children = Array.from(parent.children).filter(child => {
			const rect = child.getBoundingClientRect();
			if (rect.height < 4 || rect.width < 4) {
				return false;
			}
			const style = getComputedStyle(child);
			return style.position === 'static' && style.display !== 'contents';
		});
		const rects = children.map(child => ({ child: child, rect: child.getBoundingClientRect() }));
		for (let index = 0; index < rects.length - 1; index++) {
			const first = rects[index];
			const second = rects[index + 1];
			const overlapY = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top);
			const overlapX = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left);
			if (overlapY > 2 && overlapX > 2) {
				overlaps.push(describe(first.child) + ' / ' + describe(second.child));
			}
		}
	});
	if (overlaps.length > 0) {
		problems.push({ check: 'sibling-overlap', detail: overlaps.slice(0, 5).join(' | '), severity: 'error' });
	}
	document.querySelectorAll('button, [role="button"]').forEach(element => {
		const style = getComputedStyle(element);
		if (style.display === 'none' || style.visibility === 'hidden') {
			return;
		}
		const rect = element.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) {
			problems.push({
				check: 'zero-size-control',
				detail: describe(element) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height),
				severity: 'warning'
			});
		}
	});
	return problems;
})()
"""

# Noise that says nothing about this app.
IGNORED_MESSAGES = (
	'Download the React DevTools',
	'ResizeObserver loop completed with undelivered notifications',
	'[vite] connecting',
	'[vite] connected',
)

SERVER_LOG_PATTERN = re.compile(
	r'\b(error|exception|unhandled|EADDRINUSE|ECONNREFUSED|stack)\b', re.IGNORECASE
)


class SkipScenario(Exception):
	"""Raised by a scenario that cannot run on this machine's data."""


# ---------------------------------------------------------------------------
# Options and state
# ---------------------------------------------------------------------------


@dataclass
class Options:
	base_url: str
	username: str
	password: str
	headed: bool
	browser: str
	timeout: float
	out_dir: Path
	allow_agent: bool
	server_log: Optional[Path]
	fail_on_error: bool
	only: str = ''
	skip: str = ''
	# Pause between actions, so a headed run can actually be watched.
	slow: float = 0.0


@dataclass
class Scenario:
	name: str
	note: str = ''
	status: str = 'passed'
	started: float = 0.0
	duration: float = 0.0
	issue_count: int = 0
	skipped_reason: str = ''


class Probe:
	def __init__(self, options: Options) -> None:
		self.options = options
		self.driver: Optional[webdriver.Remote] = None
		self.issues: List[Dict[str, Any]] = []
		self.scenarios: List[Scenario] = []
		self.current: Optional[Scenario] = None
		self.step = ''
		self.logged_in = False
		self.started = time.time()
		self.run_dir = options.out_dir / ('run-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
		(self.run_dir / 'screenshots').mkdir(parents=True, exist_ok=True)
		self._seen_runtime = set()
		self._seen_network = set()
		self._seen_visual = set()
		self._shot_taken = False

	# -- driver ------------------------------------------------------------

	def start(self) -> None:
		self.driver = build_driver(self.options)
		self.driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {'source': PROBE_JS})

	def close(self) -> None:
		if self.driver is None:
			return
		try:
			self.driver.quit()
		except WebDriverException:
			pass
		self.driver = None

	# -- actions -----------------------------------------------------------

	def goto(self, path: str = '/') -> None:
		assert self.driver is not None
		url = self.options.base_url.rstrip('/') + path
		self.step = '打开 ' + url
		try:
			self.driver.get(url)
		except WebDriverException as exc:
			self.issue('navigation', '页面打开失败：' + url, detail=str(exc)[:500])

	def wait_for(self, selector: str, timeout: Optional[float] = None, visible: bool = True):
		assert self.driver is not None
		condition = EC.visibility_of_element_located if visible else EC.presence_of_element_located
		try:
			return WebDriverWait(self.driver, timeout or self.options.timeout).until(
				condition((By.CSS_SELECTOR, selector))
			)
		except TimeoutException:
			self.issue(
				'missing-element',
				'等待元素超时：' + selector,
				detail='页面停留在 ' + self.driver.current_url,
				severity='error',
			)
			return None
		except WebDriverException as exc:
			self.issue('missing-element', '查找元素失败：' + selector, detail=str(exc)[:400], severity='error')
			return None

	def on_app(self) -> bool:
		if self.driver is None:
			return False
		try:
			return str(self.driver.current_url or '').startswith(self.options.base_url)
		except WebDriverException:
			return False

	def exists(self, selector: str) -> bool:
		assert self.driver is not None
		try:
			return len(self.driver.find_elements(By.CSS_SELECTOR, selector)) > 0
		except WebDriverException:
			return False

	def find_all(self, selector: str) -> List[Any]:
		assert self.driver is not None
		try:
			return self.driver.find_elements(By.CSS_SELECTOR, selector)
		except WebDriverException:
			return []

	def click(self, element: Any, what: str = '') -> bool:
		assert self.driver is not None
		label = what or describe_element(element)
		try:
			WebDriverWait(self.driver, self.options.timeout).until(EC.element_to_be_clickable(element))
		except TimeoutException:
			self.issue('interaction', '元素不可点击（被遮挡、禁用或不可见）：' + label, severity='error')
			return False
		if self.options.slow > 0:
			self.highlight(element)
			time.sleep(self.options.slow)
		try:
			element.click()
			if self.options.slow > 0:
				time.sleep(self.options.slow)
			return True
		except WebDriverException as exc:
			self.issue('interaction', '点击失败：' + label, detail=str(exc)[:400], severity='error')
			return False

	def highlight(self, element: Any) -> None:
		"""Flash a red outline so a headed run shows what is about to be clicked."""
		if self.driver is None:
			return
		try:
			self.driver.execute_script("""
				const element = arguments[0];
				if (!element) { return; }
				element.style.outline = '3px solid #ff3b30';
				element.style.outlineOffset = '2px';
				window.setTimeout(() => {
					element.style.outline = '';
					element.style.outlineOffset = '';
				}, 900);
			""", element)
		except WebDriverException:
			pass

	def click_selector(self, selector: str) -> bool:
		element = self.wait_for(selector)
		return bool(element) and self.click(element, selector)

	def button_with_text(self, text: str, scope: str = '.topbar') -> Any:
		for element in self.find_all(scope + ' button'):
			try:
				if text in (element.text or ''):
					return element
			except WebDriverException:
				continue
		return None

	def first_text(self, selector: str) -> str:
		for element in self.find_all(selector):
			try:
				text = (element.text or '').strip()
			except WebDriverException:
				continue
			if text:
				return text
		return ''

	# -- bookkeeping -------------------------------------------------------

	def skip(self, reason: str) -> None:
		raise SkipScenario(reason)

	def issue(
		self,
		category: str,
		message: str,
		severity: str = 'error',
		detail: str = '',
		screenshot: bool = True,
	) -> None:
		shot = self.screenshot('issue') if screenshot and severity == 'error' else None
		self.issues.append({
			'category': category,
			'severity': severity,
			'message': message,
			'detail': detail,
			'scenario': self.current.name if self.current else '(setup)',
			'step': self.step,
			'screenshot': shot,
			'at': round(time.time() - self.started, 2),
		})

	def screenshot(self, tag: str) -> Optional[str]:
		if self.driver is None:
			return None
		if tag == 'issue' and self._shot_taken:
			# One shot per scenario is enough to see what broke.
			return None
		name = (self.current.name if self.current else 'setup') + '-' + tag + '-' + str(len(self.issues)) + '.png'
		path = self.run_dir / 'screenshots' / name
		try:
			self.driver.save_screenshot(str(path))
		except Exception:
			return None
		if tag == 'issue':
			self._shot_taken = True
		return 'screenshots/' + name

	@contextmanager
	def scenario(self, name: str) -> Iterator[Scenario]:
		entry = Scenario(name=name, started=time.time())
		self.current = entry
		self.step = '确保在应用页面'
		self._shot_taken = False
		print('[scenario] ' + name, flush=True)
		# A fresh driver starts on `data:,`. Without this, a run that does not begin
		# with `boot` (any `--only ...`) would poke a blank page and report the app
		# as broken.
		if self.driver is not None and not self.on_app():
			self.goto('/')
			self.wait_for('.app, .auth-page, .boot-error', visible=False, timeout=30)
		try:
			yield entry
		except SkipScenario as skip:
			entry.status = 'skipped'
			entry.skipped_reason = str(skip)
			print('  - 跳过：' + str(skip), flush=True)
		except Exception as exc:  # a crash is a finding, not a stop
			entry.status = 'crashed'
			self.issue(
				'scenario',
				'场景异常终止：' + str(exc)[:200],
				detail=traceback.format_exc()[:1500],
				screenshot=False,
			)
			print('  ! 异常：' + str(exc)[:200], flush=True)
		finally:
			for collect in (self.collect_runtime, self.collect_network, self.collect_visual):
				try:
					collect()
				except Exception:
					continue
			# A scenario that navigated the tab away (or left it on about:blank)
			# would poison every scenario after it: put the app back. A dead
			# browser raises here too, and that must not abort the whole run.
			if self.driver is not None:
				try:
					url = self.driver.current_url or ''
				except Exception:
					url = ''
				if url and not url.startswith(self.options.base_url):
					self.issue('navigation', '场景结束时页面已离开应用：' + url[:120], severity='warning', screenshot=False)
					try:
						self.goto('/')
					except Exception:
						pass
			entry.duration = round(time.time() - entry.started, 2)
			entry.issue_count = len([issue for issue in self.issues if issue['scenario'] == name])
			if entry.status == 'passed' and entry.issue_count > 0:
				entry.status = 'issues'
			self.scenarios.append(entry)
			self.current = None
			print('  -> ' + entry.status + '（' + str(entry.duration) + 's，问题 ' + str(entry.issue_count) + '）', flush=True)
			if self.options.slow > 0:
				time.sleep(self.options.slow * 3)

	# -- collectors --------------------------------------------------------

	def collect_runtime(self) -> None:
		if self.driver is None:
			return
		try:
			entries = self.driver.execute_script('return (window.__agentUiProbe && window.__agentUiProbe.errors) || []')
		except Exception:
			# A renderer that stopped answering must not cost the whole report.
			return
		for entry in entries or []:
			kind = str(entry.get('kind', 'runtime'))
			message = str(entry.get('message', '')).strip()
			if not message:
				continue
			key = (kind, message)
			if key in self._seen_runtime:
				continue
			self._seen_runtime.add(key)
			if self.is_ignored(message):
				continue
			severity = 'warning' if kind == 'console.warn' else 'error'
			self.issue('console', kind + ': ' + message[:600], severity=severity, screenshot=severity == 'error')

	def collect_network(self) -> None:
		if self.driver is None:
			return
		try:
			entries = self.driver.get_log('performance')
		except Exception:
			return
		for entry in entries:
			try:
				message = json.loads(entry['message'])['message']
			except (ValueError, KeyError, TypeError):
				continue
			if message.get('method') != 'Network.responseReceived':
				continue
			response = message.get('params', {}).get('response', {})
			status = int(response.get('status') or 0)
			url = str(response.get('url') or '')
			if status < 400 or url.startswith('data:'):
				continue
			if url.endswith('/favicon.ico'):
				continue  # no icon shipped; not a page defect
			# 401 is how the client probes "am I logged in?", and the login scenario
			# necessarily produces a few before the cookie exists.
			if status == 401 and ('/api/auth/me' in url or not self.logged_in):
				continue
			if status == 401 and self.current is not None and self.current.name == 'login':
				continue
			key = (status, url)
			if key in self._seen_network:
				continue
			self._seen_network.add(key)
			severity = 'error' if status >= 500 else 'warning'
			self.issue(
				'network',
				'HTTP ' + str(status) + ' ' + url[:300],
				severity=severity,
				screenshot=severity == 'error',
			)

	def collect_visual(self) -> None:
		if self.driver is None:
			return
		try:
			problems = self.driver.execute_script(VISUAL_JS) or []
		except Exception:
			return
		for problem in problems:
			check = str(problem.get('check', 'layout'))
			detail = str(problem.get('detail', ''))
			key = (check, detail)
			if key in self._seen_visual:
				continue
			self._seen_visual.add(key)
			severity = str(problem.get('severity', 'warning'))
			self.issue('visual', check + ' — ' + detail, severity=severity, screenshot=False)

	def is_ignored(self, message: str) -> bool:
		if any(ignored in message for ignored in IGNORED_MESSAGES):
			return True
		if 'status of 401' in message and not self.logged_in:
			return True
		return False

	# -- report ------------------------------------------------------------

	def finish(self) -> None:
		# Each collector is independent: one wedged renderer used to kill the run
		# before the report was written.
		for collect in (self.collect_runtime, self.collect_network, self.collect_visual):
			try:
				collect()
			except Exception:
				continue

	def write_report(self) -> Tuple[Path, Path]:
		merged = dedupe(self.issues)
		errors = [issue for issue in merged if issue['severity'] == 'error']
		warnings = [issue for issue in merged if issue['severity'] == 'warning']
		infos = [issue for issue in merged if issue['severity'] == 'info']
		passed = [entry for entry in self.scenarios if entry.status == 'passed']
		duration = round(time.time() - self.started, 1)

		json_path = self.run_dir / 'report.json'
		json_path.write_text(json.dumps({
			'started': datetime.now().isoformat(timespec='seconds'),
			'base_url': self.options.base_url,
			'duration_seconds': duration,
			'allow_agent': self.options.allow_agent,
			'scenarios': [entry.__dict__ for entry in self.scenarios],
			'issues': merged,
		}, ensure_ascii=False, indent=2), encoding='utf-8')

		lines: List[str] = []
		lines.append('# agent-ui UI 巡检报告')
		lines.append('')
		lines.append('- 时间：' + datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
		lines.append('- 入口：' + self.options.base_url)
		lines.append('- 浏览器：' + self.browser_label())
		lines.append('- 耗时：' + str(duration) + ' 秒')
		lines.append('- 场景：' + str(len(passed)) + '/' + str(len(self.scenarios)) + ' 无问题')
		lines.append('- 问题：' + str(len(errors)) + ' 个错误 / ' + str(len(warnings)) + ' 个警告 / ' + str(len(infos)) + ' 条信息')
		lines.append('')

		lines.append('## 场景')
		lines.append('')
		lines.append('| 场景 | 结果 | 问题 | 耗时 | 备注 |')
		lines.append('| --- | --- | --- | --- | --- |')
		for entry in self.scenarios:
			note = entry.skipped_reason or ''
			lines.append('| ' + entry.name + ' | ' + entry.status + ' | ' + str(entry.issue_count) + ' | ' + str(entry.duration) + 's | ' + note + ' |')
		lines.append('')

		for title, group in (('错误', errors), ('警告', warnings), ('信息', infos)):
			if not group:
				continue
			lines.append('## ' + title + '（' + str(len(group)) + '）')
			lines.append('')
			for issue in group:
				lines.append('### ' + issue['message'])
				lines.append('')
				lines.append('- 位置：场景 `' + issue['scenario'] + '` · 步骤 `' + issue['step'] + '`')
				if issue['detail']:
					lines.append('- 详情：')
					lines.append('')
					lines.append('```')
					lines.append(issue['detail'])
					lines.append('```')
				if issue['screenshot']:
					lines.append('- 截图：`' + issue['screenshot'] + '`')
				if issue['count'] > 1:
					lines.append('- 出现次数：' + str(issue['count']))
				lines.append('')

		if self.options.server_log:
			lines.extend(self.server_log_section())

		md_path = self.run_dir / 'report.md'
		md_path.write_text('\n'.join(lines), encoding='utf-8')
		return md_path, json_path

	def server_log_section(self) -> List[str]:
		path = self.options.server_log
		if path is None or not path.exists():
			return ['## 服务端日志', '', '（找不到 ' + str(path) + '）', '']
		try:
			text = path.read_text(encoding='utf-8', errors='replace')
		except OSError as error:
			return ['## 服务端日志', '', '（读取失败：' + str(error) + '）', '']
		lines = text.splitlines()
		hits = [(index + 1, line) for index, line in enumerate(lines) if SERVER_LOG_PATTERN.search(line)]
		section = ['## 服务端日志（' + str(len(hits)) + ' 条可疑行）', '']
		if not hits:
			section.extend(['没有匹配到 error / exception 等关键字。', ''])
			return section
		section.append('```')
		section.extend([str(number) + ': ' + line[:300] for number, line in hits[-40:]])
		section.append('```')
		section.append('')
		return section

	def browser_label(self) -> str:
		if self.driver is None:
			return '(未启动)'
		capabilities = self.driver.capabilities or {}
		return str(capabilities.get('browserName', '?')) + ' ' + str(capabilities.get('browserVersion', '?'))


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


def scenario_boot(probe: Probe) -> None:
	probe.goto('/')
	probe.wait_for('.app, .auth-page, .boot-error', visible=False)
	error = probe.find_all('.boot-error')
	if error:
		probe.issue('boot', '首页显示无法连接后端：' + probe.first_text('.boot-error'), severity='error')
		probe.skip('后端未就绪')


def scenario_login(probe: Probe) -> None:
	if probe.exists('.app .topbar'):
		probe.logged_in = True
		probe.skip('已是登录状态')
		return
	if not probe.options.password:
		probe.skip('未提供密码（--password 或 AGENT_UI_PASSWORD）')
	if not probe.exists('#auth-username'):
		probe.skip('没有登录表单')
	probe.step = '填写账号密码'
	field = probe.wait_for('#auth-username')
	if field is None:
		probe.skip('登录表单不可用')
	field.clear()
	field.send_keys(probe.options.username)
	password = probe.wait_for('#auth-password')
	if password is None:
		probe.skip('密码框不可用')
	password.clear()
	password.send_keys(probe.options.password)
	probe.step = '提交登录'
	submit = probe.find_all('.auth-card button[type="submit"]') or probe.find_all('.auth-submit')
	if not submit:
		probe.issue('login', '登录页没有提交按钮', severity='error')
		probe.skip('无法登录')
	probe.click(submit[0], '登录按钮')
	probe.step = '等待进入应用'
	if probe.wait_for('.app .topbar', timeout=20) is None:
		probe.issue('login', '登录后没有进入应用：' + probe.first_text('.auth-error'), severity='error')
		probe.skip('登录失败')
	probe.logged_in = True


def scenario_rail(probe: Probe) -> None:
	probe.step = '等待会话侧栏'
	if probe.wait_for('.session-rail', timeout=20) is None:
		probe.skip('侧栏未出现')
	rows = probe.find_all('.session-row')
	probe.current.note = '会话 ' + str(len(rows)) + ' 条'
	if not rows:
		probe.issue('rail', '侧栏没有任何会话，后续场景依赖已有会话', severity='info', screenshot=False)


def scenario_open_recent(probe: Probe) -> None:
	rows = probe.find_all('.session-row')
	if not rows:
		probe.skip('没有可打开的会话')
	probe.step = '打开第一个会话'
	if not probe.click(rows[0], '会话行'):
		return
	probe.step = '等待历史加载'
	if probe.wait_for('.chat-list, .chat-empty', timeout=25) is None:
		probe.skip('聊天区未出现')
	probe.step = '等待内容'
	probe.wait_for('.chat-list .msg, .chat-empty', timeout=15)


def scenario_switch_sessions(probe: Probe) -> None:
	"""The regression this protects: leaving a conversation and coming back."""
	rows = probe.find_all('.session-row')
	if len(rows) < 2:
		probe.skip('少于两个会话，无法来回切换')
	probe.step = '打开会话 A'
	probe.click(rows[0], '会话 A')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)
	text_a = probe.first_text('.chat-list .msg')
	probe.step = '切到会话 B'
	second = probe.find_all('.session-row')
	if len(second) < 2:
		probe.skip('会话列表变化，放弃对比')
	probe.click(second[1], '会话 B')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)
	probe.step = '切回会话 A'
	third = probe.find_all('.session-row')
	if len(third) < 1:
		probe.skip('会话列表变化，放弃对比')
	probe.click(third[0], '会话 A')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)
	probe.step = '比较切回后的内容'
	probe.wait_for('.chat-list .msg, .chat-empty', timeout=15)
	text_again = probe.first_text('.chat-list .msg')
	if text_a and text_again and text_a != text_again:
		probe.issue(
			'switch',
			'切走再切回后首条消息不一致',
			detail='切走前：' + text_a[:200] + '\n切回后：' + text_again[:200],
			severity='error',
		)


def scenario_file_tree(probe: Probe) -> None:
	probe.step = '定位文件树'
	if probe.wait_for('.file-tree', timeout=20) is None:
		probe.skip('文件树未渲染')
	rows = probe.find_all('.file-tree .tree-row')
	if not rows:
		probe.skip('文件树为空')
	probe.step = '展开目录'
	directories = probe.find_all('.file-tree .tree-row[aria-expanded]')
	if directories:
		probe.click(directories[0], '目录节点')
		probe.wait_for('.file-tree .tree-row', timeout=10)
	probe.step = '打开文件'
	files = [row for row in probe.find_all('.file-tree .tree-row') if not row.get_attribute('aria-expanded')]
	if not files:
		probe.skip('目录里没有文件')
	probe.click(files[0], '文件节点')
	probe.wait_for('.code-pane .tabbar, .editor-host', timeout=20)


def scenario_editor(probe: Probe) -> None:
	probe.step = '等待编辑器'
	if probe.wait_for('.code-pane', timeout=20) is None:
		probe.skip('代码面板未出现')
	tabs = probe.find_all('.code-pane .tabbar .tab')
	if not tabs:
		probe.skip('没有打开的标签')
	probe.click(tabs[0], '编辑器标签')
	probe.step = '等待编辑器容器'
	probe.wait_for('.editor-host', timeout=20)


def scenario_terminal(probe: Probe) -> None:
	probe.step = '新建终端'
	add = probe.find_all('.terminal-tabs .terminal-tab.add')
	if not add:
		probe.skip('没有终端入口')
	probe.click(add[0], '新建终端')
	probe.step = '等待 xterm'
	if probe.wait_for('.terminal-panel .xterm, .terminal-panel canvas', timeout=25) is None:
		probe.skip('终端未渲染')
	# The panel can show an empty xterm for a second before the shell speaks.
	wait_for_prompt(probe, 25)


def scenario_theme(probe: Probe) -> None:
	probe.step = '读取当前主题'
	before = probe.driver.execute_script("return document.documentElement.dataset.theme || ''")
	button = probe.button_with_text('深色') or probe.button_with_text('浅色') or probe.button_with_text('主题')
	if button is None:
		probe.skip('找不到主题按钮')
	probe.step = '切换主题'
	probe.click(button, '主题按钮')
	time.sleep(0.6)
	after = probe.driver.execute_script("return document.documentElement.dataset.theme || ''")
	if before == after:
		probe.issue('theme', '点击主题按钮后 data-theme 没有变化（' + str(before) + '）', severity='warning')
	probe.step = '切回原主题'
	back = probe.button_with_text('深色') or probe.button_with_text('浅色') or probe.button_with_text('主题')
	if back is not None:
		probe.click(back, '主题按钮')


def scenario_attention_toggle(probe: Probe) -> None:
	"""The reminder switch added for approvals: on → off → on must stick."""
	button = probe.button_with_text('提醒')
	if button is None:
		probe.skip('找不到提醒开关')
	probe.step = '关闭提醒'
	probe.click(button, '提醒开关')
	time.sleep(0.3)
	stored = probe.driver.execute_script("return window.localStorage.getItem('agentui.attention')")
	if stored != 'off':
		probe.issue('attention', '关闭提醒后 localStorage 未变为 off：' + str(stored), severity='warning')
	probe.step = '重新开启提醒'
	again = probe.button_with_text('提醒')
	if again is not None:
		probe.click(again, '提醒开关')
		time.sleep(0.3)
		stored = probe.driver.execute_script("return window.localStorage.getItem('agentui.attention')")
		if stored != 'on':
			probe.issue('attention', '重新开启提醒后 localStorage 未变为 on：' + str(stored), severity='warning')


def scenario_layout_audit(probe: Probe) -> None:
	"""A dedicated pass over the current page; the checks themselves run after
	every scenario, but this one records a summary in the scenario table."""
	probe.step = '整页布局检查'
	findings = probe.driver.execute_script(VISUAL_JS) or []
	if probe.current is not None:
		probe.current.note = ('发现 ' + str(len(findings)) + ' 处布局问题') if findings else '未发现布局问题'


def scenario_new_session(probe: Probe) -> None:
	probe.step = '打开新建会话'
	new_button = probe.button_with_text('新建会话', '.session-rail')
	if new_button is None:
		new_button = probe.find_all('.rail-new')
		if not new_button:
			probe.skip('找不到新建会话按钮')
		else:
			new_button = new_button[0]
	if not probe.click(new_button, '新建会话'):
		probe.skip('新建会话未打开')
	probe.step = '等待对话框'
	if probe.wait_for('.modal', timeout=15) is None:
		probe.skip('对话框未出现')
	items = probe.find_all('.modal .modal-item:not(.dir)')
	if not items:
		probe.skip('没有可选项目')
	probe.step = '选择一个项目'
	probe.click(items[0], '项目条目')
	probe.step = '等待新会话'
	probe.wait_for('.chat-composer', timeout=30)


def scenario_send_and_stop(probe: Probe) -> None:
	"""Spends real tokens: only runs with --allow-agent."""
	if not probe.options.allow_agent:
		probe.skip('未开启 --allow-agent')
	probe.step = '定位输入框'
	box = probe.find_all('.chat-composer textarea')
	if not box:
		probe.skip('没有输入框')
	textarea = box[0]
	textarea.click()
	textarea.send_keys('请只回复 OK，不要执行任何工具。')
	probe.step = '发送消息'
	send = probe.find_all('.composer-actions .primary')
	if not send:
		probe.issue('composer', '找不到发送按钮', severity='error')
		probe.skip('无法发送')
	probe.click(send[0], '发送按钮')
	probe.step = '等待流式输出'
	probe.wait_for('.chat-list .msg', timeout=60)
	time.sleep(3)
	probe.step = '点击停止'
	stop = probe.find_all('.composer-actions .primary.stop')
	if stop:
		probe.click(stop[0], '停止按钮')
		probe.step = '等待本轮结束'
		if probe.wait_for('.composer-actions .primary:not(.stop)', timeout=60) is None:
			probe.issue('composer', '点击停止后仍处于运行状态', severity='error')
	else:
		probe.current.note = '本轮在停止前已结束'


def fill_composer(probe: Probe, text: str) -> bool:
	"""Type without pressing Enter, so we control when (and whether) it is sent."""
	if not probe.find_all('.chat-composer textarea'):
		return False
	probe.driver.execute_script("""
		const element = document.querySelector('.chat-composer textarea');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
		setter.call(element, arguments[0]);
		element.dispatchEvent(new Event('input', { bubbles: true }));
	""", text)
	time.sleep(0.2)
	return True


def send_message(probe: Probe, text: str, what: str = '消息') -> bool:
	if not fill_composer(probe, text):
		probe.issue('composer', '找不到输入框，无法发送' + what, severity='error')
		return False
	buttons = probe.find_all('.composer-actions .primary')
	if not buttons:
		probe.issue('composer', '找不到发送按钮，无法发送' + what, severity='error')
		return False
	return probe.click(buttons[0], '发送按钮')


def create_session(probe: Probe) -> bool:
	button = probe.button_with_text('新建会话', '.session-rail')
	if button is None:
		return False
	probe.click(button, '新建会话')
	if probe.wait_for('.modal', timeout=10) is None:
		return False
	items = probe.find_all('.modal .modal-item:not(.dir)')
	if not items:
		return False
	probe.click(items[0], '项目条目')
	return probe.wait_for('.chat-composer', timeout=30) is not None


def current_title(probe: Probe) -> str:
	return probe.first_text('.topbar .topbar-title')


def find_session_row(probe: Probe, needle: str, seconds: float = 0) -> Any:
	"""Find the rail row whose text contains `needle`, preferring a running one.

	A conversation's title is its first user message, so earlier probe runs leave
	rows that start exactly the same way: the text alone cannot tell them apart.
	The busy marker can — only the conversation still being answered has it.
	"""
	deadline = time.time() + seconds
	while True:
		fallback = None
		for row in probe.find_all('.session-row'):
			try:
				if needle not in (row.text or ''):
					continue
				if row.find_elements(By.CSS_SELECTOR, '.session-run.busy'):
					return row
				fallback = fallback or row
			except WebDriverException:
				continue
		if fallback is not None or time.time() >= deadline:
			return fallback
		time.sleep(0.5)


def message_count(probe: Probe) -> int:
	return len(probe.find_all('.chat-list .msg'))


def wait_for_message_count(probe: Probe, minimum: int, seconds: float) -> bool:
	deadline = time.time() + seconds
	while time.time() < deadline:
		if message_count(probe) >= minimum:
			return True
		time.sleep(0.5)
	return False


def click_session(probe: Probe, row: Any, what: str) -> bool:
	"""Scroll the row into view first: the rail toolbar sits on top of row 0."""
	try:
		probe.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", row)
		time.sleep(0.2)
	except WebDriverException:
		pass
	if probe.click(row, what):
		time.sleep(0.4)
		return True
	try:
		probe.driver.execute_script("arguments[0].click();", row)
		probe.issue('interaction', '会话行被遮挡，改用 DOM 点击：' + what, severity='warning', screenshot=True)
		time.sleep(0.4)
		return True
	except WebDriverException:
		return False


def chat_text_length(probe: Probe) -> int:
	return int(probe.driver.execute_script(
		"const list = document.querySelector('.chat-list'); return list ? list.innerText.length : 0;"
	) or 0)


def is_streaming(probe: Probe) -> bool:
	return probe.exists('.composer-actions .primary.stop')


def wait_until_idle(probe: Probe, seconds: float) -> bool:
	deadline = time.time() + seconds
	while time.time() < deadline:
		if not is_streaming(probe):
			return True
		time.sleep(1.0)
	return False


# The long task has to outlive every detour: a detour costs a switch, a short
# turn and a growth sample, so a task that is too short finishes mid-scenario and
# every "it kept running while I was away" check turns into noise.
LONG_TASK_STEPS = 10
LONG_TASK_SLEEP = 15
DETOURS = 4
GROWTH_THRESHOLD = 20


def make_long_task(steps: int, sleep_seconds: int) -> str:
	"""A prompt that keeps one conversation busy while others are used."""
	commands = '  '.join(
		'%d) echo step%d; sleep %d' % (index + 1, index + 1, sleep_seconds)
		for index in range(steps)
	)
	return (
		'UI probe 长任务：依次执行 ' + str(steps) + ' 条 bash 命令，每条单独调用一次 Bash 工具，'
		'执行完再下一条：' + commands + '。全部完成后只回复 LONGTASK-DONE。'
	)


def other_session_row(probe: Probe, needle_a: str, seen: List[str]) -> Any:
	"""First rail row that is neither A nor a conversation already visited."""
	for row in probe.find_all('.session-row'):
		try:
			text = row.text or ''
		except WebDriverException:
			continue
		if needle_a and needle_a in text:
			continue
		if any(title and title in text for title in seen):
			continue
		return row
	return None


def rail_has_running_session(probe: Probe) -> bool:
	"""True while some conversation in the rail is still being answered."""
	return bool(probe.find_all('.session-row .session-run.busy'))


def wait_for_rail_running(probe: Probe, seconds: float = 8.0) -> bool:
	"""The rail marker is polled every 3 s, so give it more than one tick."""
	deadline = time.time() + seconds
	while time.time() < deadline:
		if rail_has_running_session(probe):
			return True
		time.sleep(0.5)
	return False


def wait_for_streaming(probe: Probe, seconds: float = 10.0) -> bool:
	"""A reattached panel learns "still running" from the server, not instantly."""
	deadline = time.time() + seconds
	while time.time() < deadline:
		if is_streaming(probe):
			return True
		time.sleep(0.5)
	return False


def wait_for_selector(probe: Probe, selector: str, seconds: float = 20.0) -> bool:
	"""Quiet version of `probe.wait_for`: used where a retry follows the timeout."""
	deadline = time.time() + seconds
	while time.time() < deadline:
		if probe.exists(selector):
			return True
		time.sleep(0.5)
	return False


def measure_growth(probe: Probe, seconds: float, threshold: int = GROWTH_THRESHOLD) -> Tuple[int, List[int]]:
	"""Sample the chat list while the turn runs; stop once it grew enough."""
	wait_for_streaming(probe, 10)
	start = chat_text_length(probe)
	lengths = [start]
	deadline = time.time() + seconds
	while time.time() < deadline and is_streaming(probe) and lengths[-1] - start < threshold:
		time.sleep(2.0)
		lengths.append(chat_text_length(probe))
	return start, lengths


def return_to_session_a(probe: Probe, needle_a: str, title_a: str, came_from: str, expect_running: bool = True) -> bool:
	"""Switch back to A and check it is still live and still producing output.

	Reattaching rebuilds the transcript from the jsonl, so the absolute length is
	not comparable with what was on screen before switching away. What must hold
	is that the conversation keeps printing after coming back — a frozen
	transcript is the failure this scenario exists to catch.
	"""
	probe.step = '从' + came_from + '切回会话 A'
	target = find_session_row(probe, needle_a, seconds=10) if needle_a else None
	if target is None:
		probe.issue(
			'concurrency',
			'会话列表里找不到会话 A',
			detail='从' + came_from + '切回时，没有标题包含「' + needle_a + '」的行',
			severity='error',
		)
		return False
	click_session(probe, target, '会话 A')
	if probe.wait_for('.chat-list, .chat-empty', timeout=25) is None:
		probe.issue('concurrency', '从' + came_from + '切回后 A 没有加载', severity='error')
		return False
	time.sleep(1.0)

	back_title = current_title(probe)
	if needle_a and needle_a not in back_title:
		probe.issue(
			'concurrency',
			'没能切回会话 A',
			detail='从' + came_from + '切回，期望 ' + title_a + '，实际 ' + back_title,
			severity='error',
		)
		return False
	if expect_running and not wait_for_streaming(probe, 10):
		probe.issue(
			'concurrency',
			'从' + came_from + '切回 A 后发送框不认为它在运行（没有停止按钮）',
			detail='A 仍在执行长任务，切回时应显示「停止」',
			severity='error',
		)

	probe.step = '确认从' + came_from + '切回后仍在输出'
	start, lengths = measure_growth(probe, 30)
	if expect_running and lengths[-1] - start < GROWTH_THRESHOLD and is_streaming(probe):
		probe.issue(
			'concurrency',
			'从' + came_from + '切回 A 后聊天区几乎没有新内容',
			detail='切回时 ' + str(start) + ' 字符，之后每 2 秒依次为：'
			+ ', '.join(str(value) for value in lengths) + '；A 仍在运行',
			severity='error',
		)
	if probe.current is not None:
		probe.current.note += ('；' if probe.current.note else '') + (
			came_from + ' 往返后 ' + str(start) + ' → ' + str(lengths[-1]) + ' 字'
		)
	return True


def scenario_concurrent_stream(probe: Probe) -> None:
	"""Many conversations at once, the way the user actually works.

	Starts a long task in a new conversation, then keeps working in several other
	conversations while it runs — a short turn in each one — and returns to the
	first after every detour to check that it kept streaming, that the composer
	still knows it is running and that the transcript kept growing. The long task
	is sized to outlive all the detours.
	"""
	if not probe.options.allow_agent:
		probe.skip('未开启 --allow-agent（会真实启动进程并消耗 token）')

	probe.step = '新建会话 A'
	if not create_session(probe):
		probe.skip('无法新建会话')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)

	probe.step = '在 A 发送长任务'
	long_task = make_long_task(LONG_TASK_STEPS, LONG_TASK_SLEEP)
	count_a = message_count(probe)
	if not send_message(probe, long_task, '长任务'):
		probe.skip('消息未能发出')
	if not wait_for_message_count(probe, count_a + 1, 30):
		probe.issue('concurrency', 'A 发出的消息没有出现在聊天区', severity='error')
		probe.skip('A 没有接收消息')

	# The rail title is the first user message, so the message we just sent is a
	# stable handle on session A even before the topbar has caught up. Earlier
	# runs left rows with the same beginning, hence the busy marker in the lookup.
	needle_a = long_task[:15]
	probe.step = 'A 出现在会话列表'
	if find_session_row(probe, needle_a, seconds=15) is None:
		probe.issue(
			'concurrency',
			'新建的会话没有出现在会话列表里',
			detail='侧栏里没有标题包含「' + needle_a + '」的行，切走之后就切不回来了',
			severity='error',
		)
		probe.skip('A 不在会话列表，无法切走再切回')

	probe.step = '确认 A 进入运行状态'
	deadline = time.time() + 30
	while time.time() < deadline and not is_streaming(probe):
		time.sleep(0.5)
	if not is_streaming(probe):
		probe.issue('concurrency', 'A 发送后 30 秒内没有进入运行状态（看不到停止按钮）', severity='error')
	time.sleep(2.0)
	length_before_switch = chat_text_length(probe)
	title_a = current_title(probe)

	# (label, title, 进入时的历史长度, 短任务结束后的长度) for every conversation
	# used as a detour, so the transcript can be checked again once A is done.
	visited: List[Tuple[str, str, int, int]] = []
	for index in range(DETOURS):
		label = '会话 ' + chr(ord('B') + index)
		probe.step = '切到' + label
		row = other_session_row(probe, needle_a, [title for _, title, _, _ in visited])
		if row is None:
			probe.issue(
				'concurrency',
				'侧栏里可用的其它会话不够',
				detail='计划旁路 ' + str(DETOURS) + ' 个，只找到 ' + str(len(visited)) + ' 个',
				severity='warning',
			)
			break
		click_session(probe, row, label)
		if probe.wait_for('.chat-list, .chat-empty', timeout=25) is None:
			probe.issue('concurrency', label + ' 没有加载出来', severity='error')
			break
		time.sleep(0.6)
		title = current_title(probe)
		if not title or needle_a in title or title == title_a or any(title == seen for _, seen, _, _ in visited):
			probe.issue(
				'concurrency',
				'点击' + label + '后没有换到另一个会话',
				detail='标题：' + title + '（A 的标题：' + title_a + '）',
				severity='error',
			)
			continue
		entered = chat_text_length(probe)
		running = wait_for_rail_running(probe, 8)
		if not running:
			probe.issue(
				'concurrency',
				'切到' + label + '后侧栏看不到仍在运行的会话',
				detail='A 那轮已经结束（长任务偏短），或侧栏丢了运行标记；本轮不再检查运行态',
				severity='warning',
			)
		probe.step = '在' + label + '发送短任务'
		count = message_count(probe)
		if send_message(probe, 'UI probe 短任务：只回复 OK，不要调用任何工具。', '短任务'):
			wait_for_message_count(probe, count + 1, 30)
			time.sleep(1.5)
			if not wait_until_idle(probe, 120):
				probe.issue('concurrency', label + ' 的短任务 120 秒内没有结束', severity='warning')
		else:
			probe.issue('concurrency', label + ' 的消息未能发出', severity='warning')
		visited.append((label, title, entered, chat_text_length(probe)))
		if not return_to_session_a(probe, needle_a, title_a, label, expect_running=running):
			probe.skip('无法从' + label + '切回会话 A，后面的断言没有意义')
		if not running:
			break

	probe.step = '等 A 跑完'
	wait_for_streaming(probe, 15)
	if not wait_until_idle(probe, 300):
		probe.issue('concurrency', 'A 的长任务 300 秒内没有结束', severity='warning')
		stop = probe.find_all('.composer-actions .primary.stop')
		if stop:
			probe.click(stop[0], '停止按钮')
	else:
		final_text = probe.driver.execute_script("return document.querySelector('.chat-list').innerText;") or ''
		last_step = 'step' + str(LONG_TASK_STEPS)
		if 'LONGTASK-DONE' not in final_text and last_step not in final_text:
			probe.issue(
				'concurrency',
				'A 的最终输出里没有长任务的完成标记',
				detail='没看到 LONGTASK-DONE 或 ' + last_step + '；结尾片段：' + str(final_text)[-400:],
				severity='warning',
			)

	probe.step = '回访旁路会话'
	for label, title, entered, after_turn in visited:
		needle = title[:20]
		target = find_session_row(probe, needle, seconds=5) if needle else None
		if target is None:
			probe.issue('concurrency', '回访时找不到' + label, detail='没有标题包含「' + needle + '」的行', severity='warning')
			continue
		click_session(probe, target, label)
		if probe.wait_for('.chat-list, .chat-empty', timeout=25) is None:
			probe.issue('concurrency', '回访时' + label + ' 没有加载出来', severity='warning')
			continue
		time.sleep(1.0)
		again = chat_text_length(probe)
		# Compared against the length of the rebuilt history, not against what was
		# on screen after the short turn: that view still held the result footer
		# ("完成 · 12s"), which history deliberately does not keep. A tolerance is
		# needed as well — a conversation holding megabytes of history renders a
		# few hundred characters differently between two rebuilds.
		tolerance = max(200, int(entered * 0.02))
		if again == 0:
			probe.issue('concurrency', '回访时' + label + ' 的聊天区是空的', severity='warning')
		elif again + tolerance < entered:
			probe.issue(
				'concurrency',
				'回访时' + label + ' 的历史比进入时还少',
				detail='进入时 ' + str(entered) + ' 字符，回访时 ' + str(again) + ' 字符'
				+ '（容差 ' + str(tolerance) + '；短任务结束后为 ' + str(after_turn) + ' 字符，含临时结果卡）',
				severity='warning',
			)
	if probe.current is not None:
		probe.current.note = (
			'旁路 ' + str(len(visited)) + ' 个会话；A 切走前 ' + str(length_before_switch) + ' 字'
			+ ('；' + probe.current.note if probe.current.note else '')
		)


def scenario_refresh_recovery(probe: Probe) -> None:
	probe.step = '记录当前会话标题'
	title_before = probe.first_text('.topbar .topbar-title')
	probe.step = '刷新页面'
	probe.driver.refresh()
	if probe.wait_for('.app, .auth-page', visible=False, timeout=30) is None:
		probe.skip('刷新后页面未恢复')
	probe.step = '等待会话恢复'
	probe.wait_for('.chat-list, .chat-empty, .rail-empty', timeout=30)
	title_after = probe.first_text('.topbar .topbar-title')
	if title_before and title_after and title_before != title_after:
		probe.issue(
			'refresh',
			'刷新后回到了另一个会话',
			detail='刷新前：' + title_before + '\n刷新后：' + title_after,
			severity='warning',
		)


def scenario_reload_while_running(probe: Probe) -> None:
	"""Reload in the middle of a turn: the page must pick the turn back up.

	Sends a task long enough to still be running after a reload, reloads, and
	then checks that the same conversation came back, that the composer still
	shows the run as live, that output keeps arriving and that the page is
	usable again.
	"""
	if not probe.options.allow_agent:
		probe.skip('未开启 --allow-agent（需要真实跑一轮）')

	probe.step = '新建会话'
	if not create_session(probe):
		probe.skip('无法新建会话')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)

	probe.step = '发送刷新前的任务'
	task = make_long_task(5, 10)
	count = message_count(probe)
	if not send_message(probe, task, '刷新前的任务'):
		probe.skip('消息未能发出')
	if not wait_for_message_count(probe, count + 1, 30):
		probe.skip('消息没有出现在聊天区')
	needle = task[:15]

	probe.step = '等待进入运行状态'
	deadline = time.time() + 30
	while time.time() < deadline and not is_streaming(probe):
		time.sleep(0.5)
	if not is_streaming(probe):
		probe.skip('这一轮在刷新前就结束了')
	time.sleep(2.0)
	title_before = current_title(probe)
	length_before = chat_text_length(probe)

	probe.step = '刷新页面'
	probe.driver.refresh()
	# 60 s: a reload right after a long concurrent run has to refetch the whole
	# session list, and the biggest transcripts take seconds per file.
	if not wait_for_selector(probe, '.app, .auth-page', 60):
		state = probe.driver.execute_script(
			"return document.readyState + ' | ' + (document.body ? document.body.innerText.slice(0, 200) : '无 body');"
		)
		probe.issue('refresh', '刷新后页面没有恢复', detail='60 秒后仍是：' + str(state), severity='error')
		probe.skip('刷新后页面未恢复')
	if probe.exists('.auth-page'):
		probe.issue('refresh', '刷新后要求重新登录', severity='error')
		probe.skip('刷新后未登录')

	probe.step = '等待会话恢复'
	if not wait_for_selector(probe, '.chat-list, .chat-empty', 60):
		state = probe.driver.execute_script(
			"const boot = document.querySelector('.boot, .boot-error'); return boot ? boot.innerText.slice(0, 200) : '没有 boot 状态';"
		)
		probe.issue('refresh', '刷新后聊天区没有恢复', detail='60 秒后：' + str(state), severity='error')
		probe.skip('刷新后聊天区未恢复')
	title_after = current_title(probe)
	if needle not in title_after:
		probe.issue(
			'refresh',
			'刷新后没有回到刷新前的会话',
			detail='刷新前：' + title_before + '\n刷新后：' + title_after,
			severity='error',
		)
		probe.skip('刷新后回到了别的会话')

	probe.step = '刷新后仍在运行'
	if not wait_for_streaming(probe, 15):
		probe.issue(
			'refresh',
			'刷新后发送框不认为它在运行（没有停止按钮）',
			detail='后端仍在跑这一轮，刷新后应显示「停止」',
			severity='error',
		)

	probe.step = '刷新后仍在输出'
	start, lengths = measure_growth(probe, 30)
	if lengths[-1] - start < GROWTH_THRESHOLD and is_streaming(probe):
		probe.issue(
			'refresh',
			'刷新后聊天区几乎没有新内容',
			detail='刷新后 ' + str(start) + ' 字符，之后每 2 秒依次为：'
			+ ', '.join(str(value) for value in lengths),
			severity='error',
		)

	probe.step = '刷新后可以继续输入'
	if not fill_composer(probe, 'UI probe 刷新后草稿'):
		probe.issue('refresh', '刷新后找不到输入框', severity='error')
	else:
		value = probe.driver.execute_script(
			"const box = document.querySelector('.chat-composer textarea'); return box ? box.value : '';"
		)
		if value != 'UI probe 刷新后草稿':
			probe.issue('refresh', '刷新后输入框无法输入', detail='输入后内容为：' + str(value)[:120], severity='error')
		fill_composer(probe, '')

	probe.step = '停止这一轮'
	stop = probe.find_all('.composer-actions .primary.stop')
	if stop:
		probe.click(stop[0], '停止按钮')
		if not wait_until_idle(probe, 90):
			probe.issue('refresh', '点停止后这一轮 90 秒内没有结束', severity='warning')
	if probe.current is not None:
		probe.current.note = (
			'刷新前 ' + str(length_before) + ' 字 → 刷新后 ' + str(start) + ' → '
			+ str(lengths[-1]) + ' 字（' + str(len(lengths) * 2) + ' 秒采样）'
		)


def close_extra_tabs(probe: Probe, keep: str) -> None:
	"""Close every tab but `keep` and activate it again."""
	if probe.driver is None:
		return
	try:
		handles = probe.driver.window_handles
	except WebDriverException:
		return
	for handle in handles:
		if handle == keep:
			continue
		try:
			probe.driver.switch_to.window(handle)
			probe.driver.close()
		except WebDriverException:
			continue
	try:
		probe.driver.switch_to.window(keep)
	except WebDriverException:
		pass


def scenario_multi_tab(probe: Probe) -> None:
	"""A second tab on the same app: both stay usable and share the same data.

	Opens the app in another tab, checks it lands on the same conversation with
	the same login and a populated rail, optionally sends a message there, then
	comes back and confirms the first tab still works.
	"""
	if not probe.find_all('.session-rail'):
		probe.skip('不在应用页面上')
	assert probe.driver is not None

	probe.step = '记录当前标签页'
	first = probe.driver.current_window_handle
	title_first = current_title(probe)
	rows_first = len(probe.find_all('.session-row'))

	try:
		probe.step = '打开第二个标签页'
		try:
			probe.driver.switch_to.new_window('tab')
		except (AttributeError, WebDriverException) as exc:
			probe.skip('浏览器不支持标签页切换：' + str(exc)[:120])

		probe.step = '在第二个标签页打开应用'
		probe.goto('/')
		if probe.wait_for('.app, .auth-page', visible=False, timeout=30) is None:
			probe.skip('第二个标签页没有加载出应用')
		if probe.exists('.auth-page'):
			probe.issue(
				'tabs',
				'第二个标签页要求重新登录',
				detail='同一个浏览器里的另一个标签页丢了登录状态',
				severity='error',
			)
			probe.skip('第二个标签页未登录')
		probe.wait_for('.chat-list, .chat-empty, .rail-empty', timeout=30)

		title_second = current_title(probe)
		if title_first and title_second and title_first != title_second:
			probe.issue(
				'tabs',
				'第二个标签页打开的是另一个会话',
				detail='第一个：' + title_first + '\n第二个：' + title_second,
				severity='warning',
			)
		rows_second = len(probe.find_all('.session-row'))
		if rows_second == 0:
			probe.issue('tabs', '第二个标签页的会话列表是空的', detail='第一个标签页有 ' + str(rows_first) + ' 条', severity='error')

		if probe.options.allow_agent and probe.exists('.chat-composer textarea'):
			probe.step = '在第二个标签页发消息'
			count = message_count(probe)
			if send_message(probe, 'UI probe 多标签页：只回复 OK，不要调用任何工具。', '多标签页消息'):
				if not wait_for_message_count(probe, count + 1, 30):
					probe.issue('tabs', '第二个标签页发出的消息没有出现在聊天区', severity='error')
				if not wait_until_idle(probe, 120):
					probe.issue('tabs', '第二个标签页这一轮 120 秒内没有结束', severity='warning')
				else:
					text = probe.driver.execute_script(
						"const list = document.querySelector('.chat-list'); return list ? list.innerText : '';"
					) or ''
					if 'OK' not in text:
						probe.issue('tabs', '第二个标签页没有收到回复', detail='结尾片段：' + str(text)[-300:], severity='warning')

		probe.step = '切回第一个标签页'
		probe.driver.switch_to.window(first)
		if probe.wait_for('.app', visible=False, timeout=30) is None:
			probe.issue('tabs', '切回第一个标签页后应用不见了', severity='error')
			probe.skip('第一个标签页已损坏')
		probe.step = '第一个标签页仍可交互'
		rows = probe.find_all('.session-row')
		if not rows:
			probe.issue('tabs', '第一个标签页的会话列表空了', detail='打开第二个标签页前有 ' + str(rows_first) + ' 条', severity='error')
		else:
			target = rows[1] if len(rows) > 1 else rows[0]
			click_session(probe, target, '第一个标签页里的会话')
			if probe.wait_for('.chat-list, .chat-empty', timeout=25) is None:
				probe.issue('tabs', '第一个标签页切换会话后没有加载出来', severity='error')
			if not probe.find_all('.chat-composer textarea'):
				probe.issue('tabs', '第一个标签页切换会话后没有输入框', severity='error')
	finally:
		probe.step = '关闭第二个标签页'
		close_extra_tabs(probe, first)


def terminal_text(probe: Probe) -> str:
	"""Everything xterm has on screen, scrollback included."""
	return probe.driver.execute_script(
		"const rows = document.querySelector('.terminal-host-xterm .xterm-rows'); return rows ? rows.innerText : '';"
	) or ''


def wait_for_terminal_text(probe: Probe, needle: str, seconds: float) -> bool:
	"""Whitespace-insensitive: xterm wraps long lines, which splits a word in two."""
	wanted = re.sub(r'\s+', '', needle)
	deadline = time.time() + seconds
	while time.time() < deadline:
		if wanted in re.sub(r'\s+', '', terminal_text(probe)):
			return True
		time.sleep(1.0)
	return False


def wait_for_terminal_ready(probe: Probe, seconds: float) -> bool:
	"""Ready means xterm is mounted and neither the connect nor the lost overlay is up."""
	deadline = time.time() + seconds
	while time.time() < deadline:
		if probe.exists('.terminal-host-xterm .xterm-rows') and not probe.exists('.terminal-overlay'):
			return True
		time.sleep(0.5)
	return False


def wait_for_prompt(probe: Probe, seconds: float) -> bool:
	"""xterm mounting is not the shell being ready.

	PowerShell prints its banner *after* the terminal mounts and repaints the
	screen while doing so, which wipes anything typed into the first line. Typing
	into a terminal whose prompt has not appeared yet looks exactly like "the
	terminal does not echo input" — the bytes do reach the PTY, they are just
	painted over.
	"""
	deadline = time.time() + seconds
	while time.time() < deadline:
		text = terminal_text(probe)
		if 'PS ' in text and '>' in text:
			return True
		time.sleep(0.5)
	return False


def type_in_terminal(probe: Probe, text: str) -> bool:
	"""xterm listens on its hidden helper textarea, so focus that instead of the canvas.

	A freshly opened terminal mounts and remounts xterm while it sizes itself, so
	the node found in one attempt is often already replaced by the next.
	"""
	last: Optional[str] = None
	for _ in range(6):
		boxes = probe.find_all('.xterm-helper-textarea')
		if not boxes:
			time.sleep(0.5)
			continue
		try:
			probe.driver.execute_script('arguments[0].focus();', boxes[0])
			boxes[0].send_keys(text)
			return True
		except WebDriverException as exc:
			last = str(exc)
			if 'stale' not in last:
				probe.issue('terminal', '终端无法接收输入', detail=last[:300], severity='error')
				return False
			time.sleep(0.6)
	probe.issue('terminal', '终端无法接收输入', detail=str(last or '找不到输入区')[:300], severity='error')
	return False


def terminal_state(probe: Probe) -> Dict[str, Any]:
	"""Which terminal the page thinks it is on, plus what the server holds."""
	try:
		state = probe.driver.execute_async_script("""
			const done = arguments[arguments.length - 1];
			const activeTab = document.querySelector('.terminal-tabs .terminal-tab.active');
			const overlay = document.querySelector('.terminal-overlay');
			const view = {
				preferred: localStorage.getItem('agentui.terminal.active'),
				tabs: document.querySelectorAll('.terminal-tabs .terminal-tab:not(.add)').length,
				active: activeTab ? (activeTab.textContent || '').trim() : null,
				overlay: overlay ? (overlay.innerText || '').trim() : null,
				// The root the page filters terminals by; a mismatch with the stored
				// `root` is what makes it create a new shell instead of reattaching.
				pageRoot: (document.querySelector('.project-root') || {}).textContent || null,
				savedView: localStorage.getItem('agentui.active'),
			};
			fetch('/api/terminals').then(r => r.json()).then(data => {
				const list = data.terminals || [];
				done(Object.assign(view, {
					count: list.length,
					ids: list.slice(0, 6).map(t => (t.id || '').slice(0, 8)),
					roots: [...new Set(list.map(t => t.root))].slice(0, 3),
				}));
			}).catch(e => done(Object.assign(view, { server: 'error: ' + e })));
		""") or {}
	except WebDriverException:
		state = {}
	return state


def other_row_of_project(probe: Probe, root: str, title: str) -> Any:
	"""Another conversation in `root`, found through the rail row's title tooltip."""
	for row in probe.find_all('.session-row'):
		try:
			hint = row.get_attribute('title') or ''
			text = row.text or ''
		except WebDriverException:
			continue
		if root and root not in hint:
			continue
		if title and title in text:
			continue
		return row
	return None


def row_of_project(probe: Probe, root: str, needle: str) -> Any:
	"""The conversation matching `needle` **in the same project**.

	Earlier runs leave conversations whose title starts identically, and picking
	one from another project silently moves the page there — which is how the
	terminal appeared to vanish: the new project had no shell of its own.
	"""
	for row in probe.find_all('.session-row'):
		try:
			hint = row.get_attribute('title') or ''
			text = row.text or ''
		except WebDriverException:
			continue
		if root and root not in hint:
			continue
		if needle and needle in text:
			return row
	return None


def scenario_terminal_reconnect(probe: Probe) -> None:
	"""A long command in the terminal must survive switching away and a reload.

	The shell lives on the server, so nothing printed may be lost and the sleep
	must still finish afterwards: switching conversation, reloading the page and
	typing again all have to reconnect to the same running process.
	"""
	# Always a fresh terminal: earlier scenarios leave their own around, and the
	# page remembers whichever one was picked last — reusing a stale tab made the
	# reload land on a different shell and looked like a lost command.
	probe.step = '新建一个终端'
	add = probe.find_all('.terminal-tabs .terminal-tab.add')
	if not add:
		probe.skip('没有终端入口')
	probe.click(add[0], '新建终端')
	if not wait_for_terminal_ready(probe, 30):
		probe.skip('终端没有连上')
	# The clicked-open terminal replaces the previous one on screen a moment
	# later, so a prompt check right away would match the *old* shell. Let the new
	# xterm mount, then wait for its prompt: typing during PowerShell's banner
	# repaint loses the echo on screen.
	time.sleep(1.5)
	if not wait_for_prompt(probe, 25):
		probe.skip('终端没有出现提示符')

	mark = 'PROBE' + str(int(time.time()))[-6:]
	probe.step = '在终端里运行长命令'
	# The echo argument is assembled by the shell, so the echoed command line
	# cannot contain the finished marker: only real output can match it.
	if not type_in_terminal(probe, 'sleep 25; echo ("' + mark + '" + "-DONE")' + Keys.ENTER):
		probe.skip('终端不接受输入')
	if not wait_for_terminal_text(probe, mark, 10):
		if not type_in_terminal(probe, Keys.ENTER):
			probe.skip('终端不接受输入')
	if not wait_for_terminal_text(probe, mark, 10):
		probe.issue('terminal', '终端没有回显输入的命令', detail='10 秒内屏幕上没出现 ' + mark, severity='error')
		probe.skip('命令没有进入终端')

	probe.step = '切到另一个会话'
	title = current_title(probe)
	root = probe.first_text('.project-root')
	target = other_row_of_project(probe, root, title)
	if target is None:
		probe.skip('同一个项目里没有另一个会话可切换')
	click_session(probe, target, '另一个会话')
	if not wait_for_selector(probe, '.chat-list, .chat-empty', 25):
		probe.skip('另一个会话没有加载出来')
	time.sleep(2.0)

	probe.step = '切回原会话'
	needle = title[:15]
	back = row_of_project(probe, root, needle) if needle else None
	if back is None:
		probe.issue('terminal', '找不到原来的会话', detail='没有标题包含「' + needle + '」的行', severity='error')
		probe.skip('切不回原会话')
	click_session(probe, back, '原会话')
	if not wait_for_selector(probe, '.chat-list, .chat-empty', 25):
		probe.skip('原会话没有加载出来')
	if not wait_for_terminal_ready(probe, 30):
		probe.issue('terminal', '切回会话后终端没有重新连上', detail='终端面板上没有 xterm，或一直显示连接覆盖层', severity='error')
	elif not wait_for_terminal_text(probe, mark, 15):
		probe.issue(
			'terminal',
			'切回会话后终端里看不到切换前的命令',
			detail='屏幕上没有 ' + mark + '；结尾片段：' + terminal_text(probe)[-300:],
			severity='warning',
		)

	probe.step = '刷新页面'
	before = terminal_state(probe)
	probe.driver.refresh()
	if not wait_for_selector(probe, '.app, .auth-page', 60):
		probe.issue('terminal', '刷新后页面没有恢复', severity='error')
		probe.skip('刷新后页面未恢复')
	wait_for_selector(probe, '.terminal-tabs', 30)
	after = terminal_state(probe)
	if before.get('preferred') and after.get('preferred') and before['preferred'] != after['preferred']:
		probe.issue(
			'terminal',
			'刷新后换成了一个新终端，之前的输出跟着丢了',
			detail='刷新前 ' + str(before.get('preferred'))[:8] + '（服务端 ' + str(before.get('count')) + ' 个终端，页面 '
			+ str(before.get('tabs')) + ' 个标签）→ 刷新后 ' + str(after.get('preferred'))[:8] + '（服务端 '
			+ str(after.get('count')) + ' 个，页面 ' + str(after.get('tabs')) + ' 个标签）',
			severity='error',
		)
		probe.skip('刷新后不是同一个终端，后面的重连断言无从判断')
	probe.step = '刷新后终端重新连上'
	if not wait_for_terminal_ready(probe, 45):
		probe.issue(
			'terminal',
			'刷新后终端没有重新连上',
			detail='终端面板上没有 xterm，或一直显示「连接已断开 / 连接中」',
			severity='error',
		)
		probe.skip('刷新后终端没有重连')
	if not wait_for_terminal_text(probe, mark, 20):
		probe.issue(
			'terminal',
			'刷新后终端里看不到刷新前的命令',
			detail='服务端应该回放快照，屏幕上却没有 ' + mark + '；结尾片段：' + terminal_text(probe)[-300:],
			severity='error',
		)

	probe.step = '刷新后仍能输入'
	alive = mark + '-ALIVE'
	if not type_in_terminal(probe, 'echo ("' + mark + '" + "-ALIVE")' + Keys.ENTER):
		probe.issue('terminal', '刷新后终端不接受输入', severity='error')
	# The queued `sleep 25` from before the reload has to finish first, so this
	# wait is for two commands, not one.
	elif not wait_for_terminal_text(probe, alive, 45):
		probe.issue(
			'terminal',
			'刷新后输入的命令没有输出',
			detail='45 秒内没看到 ' + alive + '；结尾片段：' + terminal_text(probe)[-300:],
			severity='error',
		)

	probe.step = '确认长命令没有被打断'
	if not wait_for_terminal_text(probe, mark + '-DONE', 45):
		text = terminal_text(probe)
		probe.issue(
			'terminal',
			'长命令没有输出完成标记（进程可能被中断）',
			detail='没等到 ' + mark + '-DONE；结尾片段：' + text[-400:],
			severity='error',
		)
	if probe.current is not None:
		probe.current.note = '命令 ' + mark + '：切换会话 + 刷新后仍完成'


def message_texts(probe: Probe, selector: str = '.chat-list .msg') -> List[str]:
	texts: List[str] = []
	for element in probe.find_all(selector):
		try:
			texts.append(element.text or '')
		except WebDriverException:
			texts.append('')
	return texts


def queue_count(probe: Probe) -> int:
	return len(probe.find_all('.queue-strip .queue-item'))


def wait_for_queue_count(probe: Probe, expected: int, seconds: float) -> bool:
	deadline = time.time() + seconds
	while time.time() < deadline:
		if queue_count(probe) >= expected:
			return True
		time.sleep(0.5)
	return False


def wait_for_user_messages(probe: Probe, minimum: int, seconds: float) -> bool:
	deadline = time.time() + seconds
	while time.time() < deadline:
		if len(probe.find_all('.chat-list .msg.user')) >= minimum:
			return True
		time.sleep(0.5)
	return False


def wait_for_assistant_text(probe: Probe, needles: Tuple[str, ...], seconds: float) -> bool:
	"""True once every needle shows up in some assistant bubble."""
	deadline = time.time() + seconds
	while time.time() < deadline:
		answers = message_texts(probe, '.chat-list .msg.assistant')
		if all(any(needle in text for text in answers) for needle in needles):
			return True
		time.sleep(1.0)
	return False


QUEUE_MESSAGES = (
	'UI probe 排队消息一：只回复 QUEUE-ONE，不要调用任何工具。',
	'UI probe 排队消息二：只回复 QUEUE-TWO，不要调用任何工具。',
)


def scenario_queue_messages(probe: Probe) -> None:
	"""Typing while a turn runs has to queue, survive a reload and keep the order.

	The CLI runs stdin messages in order; the UI mirrors that queue. Losing a
	queued message silently is the failure mode this scenario looks for.
	"""
	if not probe.options.allow_agent:
		probe.skip('未开启 --allow-agent（需要真实跑一轮）')

	probe.step = '新建会话'
	if not create_session(probe):
		probe.skip('无法新建会话')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)

	probe.step = '发送会跑一会儿的第一条消息'
	first = 'UI probe 排队第一轮：只调用一次 Bash 工具执行命令 sleep 12，然后只回复 FIRST-DONE。'
	count = message_count(probe)
	if not send_message(probe, first, '第一条消息'):
		probe.skip('第一条消息未能发出')
	if not wait_for_message_count(probe, count + 1, 30):
		probe.skip('第一条消息没有出现在聊天区')
	if not wait_for_streaming(probe, 40):
		probe.skip('第一轮没有跑起来')

	probe.step = '运行中发送两条消息'
	for index, text in enumerate(QUEUE_MESSAGES):
		if not send_message(probe, text, '排队消息 ' + str(index + 1)):
			probe.issue('queue', '第 ' + str(index + 1) + ' 条排队消息没有发出去', severity='error')
			probe.skip('排队消息未能发出')
		time.sleep(0.4)

	probe.step = '确认消息进入排队'
	if not wait_for_queue_count(probe, len(QUEUE_MESSAGES), 15):
		probe.issue(
			'queue',
			'运行中发送的消息没有进入排队',
			detail='队列里只有 ' + str(queue_count(probe)) + ' 条，期望 ' + str(len(QUEUE_MESSAGES)) + ' 条',
			severity='error',
		)
	else:
		title = probe.first_text('.queue-title')
		if title and str(len(QUEUE_MESSAGES)) not in title:
			probe.issue('queue', '排队计数不对', detail='标题显示：' + title, severity='warning')
		items = [element.text or '' for element in probe.find_all('.queue-strip .queue-item')]
		for index, text in enumerate(QUEUE_MESSAGES):
			needle = text[:14]
			if not any(needle in item for item in items):
				probe.issue(
					'queue',
					'排队列表里看不到第 ' + str(index + 1) + ' 条消息',
					detail=' | '.join(items)[:300],
					severity='warning',
				)

	probe.step = '未投递的队列已落盘'
	# The CLI never saw these messages, so the jsonl cannot know about them; the
	# server's own file is the only copy a restart can recover from.
	queue_file = os.path.join(os.path.expanduser('~'), '.agent-ui', 'agent-queues.json')
	needles = [text[:14] for text in QUEUE_MESSAGES]
	deadline = time.time() + 8
	written = False
	while time.time() < deadline:
		try:
			with open(queue_file, encoding='utf-8') as handle:
				raw = handle.read()
		except OSError:
			raw = ''
		if all(needle in raw for needle in needles):
			written = True
			break
		time.sleep(0.5)
	if not written:
		probe.issue(
			'queue',
			'排队消息没有落盘（服务端重启就会丢）',
			detail='文件 ' + queue_file + ' 里找不到这两条：' + str(needles) + '；内容片段：' + raw[:300],
			severity='error',
		)

	probe.step = '排队中刷新页面'
	probe.driver.refresh()
	if not wait_for_selector(probe, '.app, .auth-page', 60):
		probe.issue('queue', '刷新后页面没有恢复', severity='error')
		probe.skip('刷新后页面未恢复')
	probe.step = '刷新后排队状态还在'
	# A message may already be running by the time the page is back, in which case
	# it is in the transcript instead of the queue: count both.
	deadline = time.time() + 30
	visible = 0
	while time.time() < deadline:
		started = len([text for text in message_texts(probe, '.chat-list .msg.user') if '排队消息' in text])
		visible = queue_count(probe) + started
		if visible >= len(QUEUE_MESSAGES):
			break
		time.sleep(1.0)
	if visible < len(QUEUE_MESSAGES):
		probe.issue(
			'queue',
			'刷新后排队状态丢了',
			detail='刷新后队列 ' + str(queue_count(probe)) + ' 条 + 已开始执行 ' + str(visible - queue_count(probe))
			+ ' 条，期望合计 ' + str(len(QUEUE_MESSAGES)) + ' 条',
			severity='error',
		)

	probe.step = '刷新后这一轮仍在跑'
	if not wait_for_streaming(probe, 30) and queue_count(probe) == 0:
		probe.issue(
			'queue',
			'刷新后这一轮看起来停了',
			detail='既没有停止按钮，队列也不见了；排队消息可能被丢弃',
			severity='error',
		)
		probe.skip('刷新后状态丢失，后续断言没有意义')

	probe.step = '等排队消息执行完'
	# Not `wait_until_idle`: the gap between the running turn and the first queued
	# message looks idle, so the queue has to be tracked by its answers instead.
	if not wait_for_assistant_text(probe, ('QUEUE-ONE', 'QUEUE-TWO'), 240):
		probe.issue(
			'queue',
			'排队消息 240 秒内没有得到回复',
			detail='队列 ' + str(queue_count(probe)) + ' 条；助手消息：'
			+ ' | '.join(text[:40] for text in message_texts(probe, '.chat-list .msg.assistant'))[-400:],
			severity='error',
		)
		probe.skip('队列没有执行完')
	if probe.exists('.queue-strip'):
		probe.issue('queue', '排队消息执行完后队列里还剩 ' + str(queue_count(probe)) + ' 条消息', severity='error')

	probe.step = '确认三条消息都按顺序执行'
	users = message_texts(probe, '.chat-list .msg.user')
	if not wait_for_user_messages(probe, len(QUEUE_MESSAGES) + 1, 30):
		users = message_texts(probe, '.chat-list .msg.user')
		probe.issue(
			'queue',
			'聊天区没有渲染出全部三条消息',
			detail='用户消息 ' + str(len(users)) + ' 条：' + ' | '.join(text[:40] for text in users)
			+ '；队列 ' + str(queue_count(probe)) + ' 条；标题 ' + current_title(probe),
			severity='error',
		)
	users = message_texts(probe, '.chat-list .msg.user')
	positions = []
	for needle in ('排队消息一', '排队消息二'):
		positions.append(next((index for index, text in enumerate(users) if needle in text), -1))
	if -1 in positions:
		probe.issue(
			'queue',
			'排队消息没有作为用户消息出现在聊天区',
			detail='用户消息共 ' + str(len(users)) + ' 条',
			severity='error',
		)
	elif positions[0] > positions[1]:
		probe.issue('queue', '排队消息的执行顺序反了', detail='第二条排在第一条前面', severity='error')
	answers = message_texts(probe, '.chat-list .msg.assistant')
	for needle, label in (('FIRST-DONE', '第一轮'), ('QUEUE-ONE', '第一条排队消息'), ('QUEUE-TWO', '第二条排队消息')):
		if not any(needle in text for text in answers):
			probe.issue(
				'queue',
				label + '没有得到回复',
				detail='助手消息共 ' + str(len(answers)) + ' 条；结尾片段：' + ' | '.join(answers)[-400:],
				severity='error',
			)
	probe.step = '执行完后清理落盘记录'
	deadline = time.time() + 8
	cleaned = False
	while time.time() < deadline:
		try:
			with open(queue_file, encoding='utf-8') as handle:
				raw = handle.read()
		except OSError:
			raw = ''
		if not all(needle in raw for needle in needles):
			cleaned = True
			break
		time.sleep(0.5)
	if not cleaned:
		probe.issue(
			'queue',
			'排队消息执行完后仍留在落盘文件里',
			detail='下次重启会把这些已经执行过的消息再发一遍',
			severity='warning',
		)

	probe.step = '确认默认模式没有中途吸收'
	first_turns = [text for text in answers if 'FIRST-DONE' in text]
	if any('QUEUE-ONE' in text or 'QUEUE-TWO' in text for text in first_turns):
		probe.issue(
			'queue',
			'默认排队模式下第一轮就回答了排队消息',
			detail='说明消息仍被中途写进 stdin 吸收了，刷新后就会从历史里消失',
			severity='error',
		)
	if probe.current is not None:
		probe.current.note = '队列 ' + str(len(QUEUE_MESSAGES)) + ' 条：排队 → 刷新 → 按序执行'


def scenario_queue_send_now(probe: Probe) -> None:
	"""「立即发送」on a queued message: steered into the turn, still visible later.

	This is the A mode: the CLI absorbs the text mid-turn and records only a
	`queued_command` attachment, so the transcript has to rebuild the bubble from
	it — otherwise a reload silently loses what the user said.
	"""
	if not probe.options.allow_agent:
		probe.skip('未开启 --allow-agent（需要真实跑一轮）')

	probe.step = '新建会话'
	if not create_session(probe):
		probe.skip('无法新建会话')
	probe.wait_for('.chat-list, .chat-empty', timeout=20)

	probe.step = '发送会跑一会儿的任务'
	task = 'UI probe 插话第一轮：只调用一次 Bash 工具执行命令 sleep 15，然后只回复 FIRST-OK。'
	count = message_count(probe)
	if not send_message(probe, task, '第一轮任务'):
		probe.skip('消息未能发出')
	if not wait_for_message_count(probe, count + 1, 30):
		probe.skip('消息没有出现在聊天区')
	if not wait_for_streaming(probe, 40):
		probe.skip('第一轮没有跑起来')

	probe.step = '运行中发送一条排队消息'
	text = 'UI probe 插话消息：只回复 NOW-ONE，不要调用任何工具。'
	if not send_message(probe, text, '插话消息'):
		probe.skip('插话消息未能发出')
	if not wait_for_queue_count(probe, 1, 15):
		probe.issue(
			'queue',
			'运行中发送的消息没有进入排队',
			detail='队列 ' + str(queue_count(probe)) + ' 条',
			severity='error',
		)
		probe.skip('没有可插话的排队消息')

	probe.step = '点击排队条目的立即发送'
	buttons = probe.find_all('.queue-strip .queue-item .queue-now')
	if not buttons:
		probe.skip('排队条目上没有「立即发送」按钮')
	probe.click(buttons[0], '立即发送')
	deadline = time.time() + 20
	while time.time() < deadline and queue_count(probe) > 0:
		time.sleep(0.5)
	if queue_count(probe) > 0:
		probe.issue('queue', '点了立即发送后队列没有减少', detail='仍有 ' + str(queue_count(probe)) + ' 条', severity='error')

	probe.step = '等插话被这一轮吸收'
	if not wait_for_assistant_text(probe, ('NOW-ONE',), 90):
		probe.issue(
			'queue',
			'插话消息没有得到回应',
			detail='助手消息：'
			+ ' | '.join(text[:40] for text in message_texts(probe, '.chat-list .msg.assistant'))[-300:],
			severity='error',
		)

	probe.step = '刷新后插话仍在历史里'
	probe.driver.refresh()
	if not wait_for_selector(probe, '.app, .auth-page', 60):
		probe.issue('queue', '刷新后页面没有恢复', severity='error')
		probe.skip('刷新后页面未恢复')
	if not wait_for_selector(probe, '.chat-list', 60):
		probe.issue('queue', '刷新后聊天区没有恢复', severity='error')
		probe.skip('刷新后聊天区未恢复')

	deadline = time.time() + 20
	found = False
	while time.time() < deadline and not found:
		for row in probe.find_all('.chat-list .msg.user'):
			try:
				if '插话消息' in (row.text or ''):
					found = True
					break
			except WebDriverException:
				continue
		if not found:
			time.sleep(0.5)
	if not found:
		probe.issue(
			'queue',
			'刷新后看不到插话的消息',
			detail='历史里的用户消息：'
			+ ' | '.join(text[:30] for text in message_texts(probe, '.chat-list .msg.user')),
			severity='error',
		)
	elif not probe.exists('.chat-list .msg.user.queued'):
		probe.issue(
			'queue',
			'插话消息没有显示「插话」标记',
			detail='应渲染成 .msg.user.queued',
			severity='warning',
		)
	if probe.current is not None:
		probe.current.note = '插话：排队 → 立即发送 → 本轮吸收 → 刷新后仍在'


def scenario_resize_extremes(probe: Probe) -> None:
	"""A phone width and an ultra-wide window: nothing may overflow or overlap."""
	original = probe.driver.get_window_size()
	try:
		for label, width, height in (('mobile', 420, 820), ('wide', 2200, 1100)):
			probe.step = '调整窗口到 ' + label + ' ' + str(width) + 'x' + str(height)
			probe.driver.set_window_size(width, height)
			time.sleep(0.8)
			findings = probe.driver.execute_script(VISUAL_JS) or []
			if findings:
				summary = '; '.join(str(item.get('check')) + ': ' + str(item.get('detail'))[:120] for item in findings[:4])
				probe.issue('responsive', label + ' 尺寸下布局异常：' + summary, severity='warning', screenshot=True)
	finally:
		probe.step = '恢复窗口尺寸'
		probe.driver.set_window_size(original['width'], original['height'])


def scenario_rapid_actions(probe: Probe) -> None:
	"""Click faster than the UI settles, the way an impatient user does."""
	baseline = probe.driver.current_url
	probe.step = '快速来回切换会话'
	for _ in range(6):
		rows = probe.find_all('.session-row')
		if len(rows) < 2:
			break
		for row in rows[:2]:
			label = describe_element(row)
			try:
				row.click()
			except WebDriverException:
				probe.issue('rapid', '快速点击会话行时元素失效（切换过程中 DOM 重建）', severity='warning', screenshot=False)
			time.sleep(0.05)
			if probe.driver.current_url != baseline:
				probe.issue('rapid', '点击会话行后页面被导航：' + label + ' -> ' + probe.driver.current_url, severity='error')
				return
	probe.step = '快速切换主题'
	for _ in range(4):
		button = probe.button_with_text('深色') or probe.button_with_text('浅色')
		if button is None:
			break
		label = describe_element(button)
		try:
			button.click()
		except WebDriverException:
			probe.issue('rapid', '快速切换主题时按钮不可点', severity='warning', screenshot=False)
		time.sleep(0.1)
		if probe.driver.current_url != baseline:
			probe.issue('rapid', '点击主题按钮后页面被导航：' + label + ' -> ' + probe.driver.current_url, severity='error')
			return
	probe.wait_for('.chat-list, .chat-empty', timeout=20)


def scenario_weird_input(probe: Probe) -> None:
	"""Type what the composer should survive — without ever pressing Enter."""
	boxes = probe.find_all('.chat-composer textarea')
	if not boxes:
		probe.skip('没有输入框')
	samples = (
		'<script>alert(1)</script>',
		'```js\nconst value = 1;\n```',
		'🙂🙃 中文 English 日本語',
		'\u202eRTL override\u202c',
		'a' * 400,
	)
	for index, sample in enumerate(samples):
		probe.step = '输入第 ' + str(index + 1) + ' 种内容'
		# Set the value through the native setter: `send_keys` would press Enter on
		# the embedded newlines and actually send a message.
		try:
			probe.driver.execute_script("""
				const element = document.querySelector('.chat-composer textarea');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
				setter.call(element, arguments[0]);
				element.dispatchEvent(new Event('input', { bubbles: true }));
			""", sample)
		except WebDriverException as error:
			probe.issue('input', '输入特殊文本失败：' + str(error)[:200], screenshot=False)
			continue
		time.sleep(0.2)
		height = probe.driver.execute_script(
			'const element = document.querySelector(".chat-composer textarea"); return element ? element.scrollHeight : 0;'
		)
		if height and height > 400:
			probe.issue('input', '输入长文本后输入框高度 ' + str(height) + 'px，可能撑破布局', severity='warning', screenshot=True)
	probe.step = '清空输入框'
	probe.driver.execute_script("""
		const element = document.querySelector('.chat-composer textarea');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
		setter.call(element, '');
		element.dispatchEvent(new Event('input', { bubbles: true }));
	""")


def scenario_modal_escape(probe: Probe) -> None:
	"""Escape and backdrop both have to close the new-session dialog."""
	button = probe.button_with_text('新建会话', '.session-rail')
	if button is None:
		probe.skip('找不到新建会话按钮')
	probe.click(button, '新建会话')
	if probe.wait_for('.modal', timeout=10) is None:
		probe.skip('对话框未出现')
	probe.step = '按 Esc'
	probe.driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
	time.sleep(0.5)
	if probe.exists('.modal'):
		probe.issue('modal', '按 Esc 不能关闭新建会话对话框', severity='warning', screenshot=True)
		probe.step = '点击遮罩关闭'
		probe.driver.execute_script("""
			const backdrop = document.querySelector('.modal-backdrop');
			if (backdrop) { backdrop.click(); }
		""")
		time.sleep(0.5)
		if probe.exists('.modal'):
			probe.issue('modal', '点击遮罩也无法关闭对话框', severity='error', screenshot=True)


def scenario_storage_poison(probe: Probe) -> None:
	"""Corrupt the remembered state: the shell still has to come up."""
	probe.step = '记录原值'
	original = probe.driver.execute_script("""
		return {
			active: localStorage.getItem('agentui.active'),
			theme: localStorage.getItem('agentui.theme'),
			terminal: localStorage.getItem('agentui.terminal.active')
		};
	""")
	probe.step = '写入非法值'
	probe.driver.execute_script("""
		localStorage.setItem('agentui.active', '{{{ not json');
		localStorage.setItem('agentui.theme', 'neon');
		localStorage.setItem('agentui.terminal.active', '{"broken":true}');
	""")
	probe.step = '刷新页面'
	probe.driver.refresh()
	if probe.wait_for('.app, .auth-page, .boot-error', visible=False, timeout=30) is None:
		probe.issue('storage', '损坏 localStorage 后页面没有恢复', severity='error')
	elif probe.exists('.boot-error'):
		probe.issue('storage', '损坏 localStorage 后进入错误页：' + probe.first_text('.boot-error'), severity='error')
	probe.step = '恢复原值'
	probe.driver.execute_script("""
		const keys = { active: 'agentui.active', theme: 'agentui.theme', terminal: 'agentui.terminal.active' };
		const original = arguments[0] || {};
		Object.keys(keys).forEach(name => {
			const stored = original[name];
			if (stored === null || stored === undefined) {
				localStorage.removeItem(keys[name]);
			} else {
				localStorage.setItem(keys[name], stored);
			}
		});
	""", original)
	probe.driver.refresh()
	probe.wait_for('.app, .auth-page', visible=False, timeout=30)


def scenario_offline_recovery(probe: Probe) -> None:
	"""Cut the network, then put it back: the socket has to reconnect itself."""
	probe.step = '启用网络模拟'
	try:
		probe.driver.execute_cdp_cmd('Network.enable', {})
		probe.driver.execute_cdp_cmd(
			'Network.emulateNetworkConditions',
			{'offline': True, 'latency': 0, 'downloadThroughput': 0, 'uploadThroughput': 0},
		)
	except WebDriverException as error:
		probe.skip('CDP 不可用：' + str(error)[:120])
	probe.step = '离线 3 秒'
	time.sleep(3)
	probe.step = '恢复网络'
	probe.driver.execute_cdp_cmd(
		'Network.emulateNetworkConditions',
		{'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1},
	)
	time.sleep(5)
	probe.step = '检查连接状态'
	dots = probe.find_all('.chat-header .dot')
	if dots:
		state = (dots[0].get_attribute('class') or '').replace('dot', '').strip()
		if state and state != 'open':
			probe.issue('reconnect', '断网恢复 5 秒后连接状态仍是 ' + state, severity='warning', screenshot=True)


def scenario_terminal_stress(probe: Probe) -> None:
	"""Three terminals, then close one: the panel must survive both."""
	for index in range(3):
		probe.step = '新建终端 ' + str(index + 1)
		add = probe.find_all('.terminal-tabs .terminal-tab.add')
		if not add:
			probe.skip('没有终端入口')
		probe.click(add[0], '新建终端')
		time.sleep(1.2)
	tabs = probe.find_all('.terminal-tabs .terminal-tab:not(.add)')
	if len(tabs) < 3:
		probe.issue('terminal', '连续新建三个终端后只有 ' + str(len(tabs)) + ' 个标签', severity='warning', screenshot=True)
	probe.step = '关闭一个终端'
	closes = probe.find_all('.terminal-tab-close')
	if closes:
		probe.click(closes[0], '关闭终端')
		time.sleep(1.0)
		remaining = probe.find_all('.terminal-tabs .terminal-tab:not(.add)')
		if len(remaining) != max(len(tabs) - 1, 0):
			probe.issue('terminal', '关闭终端后标签数量不符：' + str(len(remaining)) + ' 个', severity='warning')


def scenario_theme_persist(probe: Probe) -> None:
	"""A theme choice has to survive a reload."""
	button = probe.button_with_text('深色') or probe.button_with_text('浅色')
	if button is None:
		probe.skip('找不到主题按钮')
	probe.click(button, '主题按钮')
	time.sleep(0.5)
	switched = probe.driver.execute_script("return document.documentElement.dataset.theme || ''")
	probe.step = '刷新页面'
	probe.driver.refresh()
	if probe.wait_for('.app', visible=False, timeout=30) is None:
		probe.skip('刷新后应用未恢复')
	time.sleep(0.6)
	after = probe.driver.execute_script("return document.documentElement.dataset.theme || ''")
	if switched and after != switched:
		probe.issue('theme', '刷新后主题没有保持：' + switched + ' -> ' + after, severity='warning', screenshot=True)
	probe.step = '恢复原主题'
	restore = probe.button_with_text('深色') or probe.button_with_text('浅色')
	if restore is not None:
		probe.click(restore, '主题按钮')


def scenario_keyboard_walk(probe: Probe) -> None:
	"""Tab through the shell: focus must move, and stay visible while moving."""
	body = probe.driver.find_element(By.TAG_NAME, 'body')
	seen: List[Dict[str, Any]] = []
	for index in range(20):
		body.send_keys(Keys.TAB)
		info = probe.driver.execute_script("""
			const element = document.activeElement;
			if (!element || element === document.body) {
				return { tag: 'BODY', label: '', outline: 'none' };
			}
			const style = getComputedStyle(element);
			return {
				tag: element.tagName,
				label: (element.getAttribute('class') || element.getAttribute('aria-label') || '').slice(0, 40),
				outline: style.outlineStyle + '/' + style.outlineWidth
			};
		""")
		seen.append(info)
		if info.get('tag') == 'BODY' and index > 3:
			probe.issue('focus', '第 ' + str(index + 1) + ' 次 Tab 后焦点回到 body，可聚焦元素不足', severity='info', screenshot=False)
			break
	invisible = [item for item in seen if str(item.get('outline', '')).startswith('none') and item.get('tag') != 'BODY']
	if invisible:
		probe.issue(
			'focus',
			str(len(invisible)) + ' 个可聚焦元素没有 outline（若依赖 box-shadow 会误报）',
			severity='warning',
			screenshot=False,
		)


def scenario_cache_disabled_reload(probe: Probe) -> None:
	"""Hard reload with an empty cache: no asset may 404 or throw."""
	try:
		probe.driver.execute_cdp_cmd('Network.enable', {})
		probe.driver.execute_cdp_cmd('Network.setCacheDisabled', {'cacheDisabled': True})
	except WebDriverException as error:
		probe.skip('CDP 不可用：' + str(error)[:120])
	probe.step = '禁用缓存后刷新'
	probe.driver.refresh()
	probe.wait_for('.app, .auth-page', visible=False, timeout=30)
	probe.step = '等待界面稳定'
	probe.wait_for('.session-rail, .auth-page', timeout=20)
	probe.driver.execute_cdp_cmd('Network.setCacheDisabled', {'cacheDisabled': False})


SCENARIOS: Tuple[Tuple[str, Any], ...] = (
	('boot', scenario_boot),
	('login', scenario_login),
	('rail', scenario_rail),
	('open-recent', scenario_open_recent),
	('switch-sessions', scenario_switch_sessions),
	('file-tree', scenario_file_tree),
	('editor', scenario_editor),
	('terminal', scenario_terminal),
	('theme', scenario_theme),
	('attention-toggle', scenario_attention_toggle),
	('layout-audit', scenario_layout_audit),
	('resize-extremes', scenario_resize_extremes),
	('rapid-actions', scenario_rapid_actions),
	('weird-input', scenario_weird_input),
	('modal-escape', scenario_modal_escape),
	('terminal-stress', scenario_terminal_stress),
	('keyboard-walk', scenario_keyboard_walk),
	('theme-persist', scenario_theme_persist),
	('storage-poison', scenario_storage_poison),
	('offline-recovery', scenario_offline_recovery),
	('cache-disabled-reload', scenario_cache_disabled_reload),
	('new-session', scenario_new_session),
	('send-and-stop', scenario_send_and_stop),
	('concurrent-stream', scenario_concurrent_stream),
	('reload-while-running', scenario_reload_while_running),
	('multi-tab', scenario_multi_tab),
	('terminal-reconnect', scenario_terminal_reconnect),
	('queue-messages', scenario_queue_messages),
	('queue-send-now', scenario_queue_send_now),
	('refresh-recovery', scenario_refresh_recovery),
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def describe_element(element: Any) -> str:
	try:
		name = (element.get_attribute('class') or '').split(' ')[0]
		text = (element.text or '').strip()[:40]
		return element.tag_name + ('.' + name if name else '') + ('「' + text + '」' if text else '')
	except WebDriverException:
		return '(元素)'


def dedupe(issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
	merged: Dict[Tuple[str, str], Dict[str, Any]] = {}
	order: List[Tuple[str, str]] = []
	for issue in issues:
		key = (issue['category'], issue['message'])
		if key not in merged:
			merged[key] = dict(issue, count=1)
			order.append(key)
		else:
			merged[key]['count'] = merged[key]['count'] + 1
	severity_rank = {'error': 0, 'warning': 1, 'info': 2}
	return sorted([merged[key] for key in order], key=lambda issue: severity_rank.get(issue['severity'], 3))


def build_driver(options: Options) -> webdriver.Remote:
	if options.browser == 'edge':
		edge_options = webdriver.EdgeOptions()
		if not options.headed:
			edge_options.add_argument('--headless=new')
		edge_options.add_argument('--window-size=1440,960')
		edge_options.set_capability('ms:loggingPrefs', {'browser': 'ALL', 'performance': 'ALL'})
		driver = webdriver.Edge(options=edge_options)
	else:
		chrome_options = webdriver.ChromeOptions()
		if not options.headed:
			chrome_options.add_argument('--headless=new')
		chrome_options.add_argument('--window-size=1440,960')
		chrome_options.add_argument('--disable-gpu')
		chrome_options.add_argument('--no-first-run')
		chrome_options.add_argument('--no-default-browser-check')
		chrome_options.add_argument('--disable-search-engine-choice-screen')
		chrome_options.set_capability('goog:loggingPrefs', {'browser': 'ALL', 'performance': 'ALL'})
		driver = webdriver.Chrome(options=chrome_options)
	driver.set_window_size(1440, 960)
	driver.set_page_load_timeout(60)
	return driver


def parse_args(argv: Optional[List[str]] = None) -> Options:
	parser = argparse.ArgumentParser(
		description='用 Selenium 巡检 agent-ui 的网页 UI，把异常写进报告。',
		formatter_class=argparse.RawDescriptionHelpFormatter,
		epilog='场景列表：' + ', '.join(name for name, _ in SCENARIOS),
	)
	parser.add_argument('--base-url', default=os.environ.get('AGENT_UI_URL', 'http://127.0.0.1:4711'), help='应用地址')
	parser.add_argument('--username', default=os.environ.get('AGENT_UI_USER', 'admin'), help='登录用户名')
	parser.add_argument('--password', default=os.environ.get('AGENT_UI_PASSWORD', ''), help='登录密码（也可用 AGENT_UI_PASSWORD）')
	parser.add_argument('--headed', action='store_true', help='显示浏览器窗口')
	parser.add_argument('--browser', choices=('chrome', 'edge'), default='chrome', help='使用的浏览器')
	parser.add_argument('--timeout', type=float, default=20.0, help='单个等待的秒数')
	parser.add_argument('--out', default='reports', help='报告输出根目录')
	parser.add_argument('--allow-agent', action='store_true', help='允许新建会话、发送消息（会消耗 token）')
	parser.add_argument('--only', default='', help='只跑指定场景，逗号分隔')
	parser.add_argument('--skip', default='', help='跳过指定场景，逗号分隔')
	parser.add_argument('--server-log', default='', help='服务端日志文件路径，报告里附带可疑行')
	parser.add_argument('--fail-on-error', action='store_true', help='发现 error 级问题时以退出码 1 结束')
	parser.add_argument('--slow', type=float, default=0.0, help='每个操作之间停顿的秒数，配合 --headed 看清点击过程')
	args = parser.parse_args(argv)

	return Options(
		base_url=args.base_url.rstrip('/'),
		username=args.username,
		password=args.password,
		headed=args.headed,
		browser=args.browser,
		timeout=args.timeout,
		out_dir=Path(args.out),
		allow_agent=args.allow_agent,
		server_log=Path(args.server_log) if args.server_log else None,
		fail_on_error=args.fail_on_error,
		only=args.only,
		skip=args.skip,
		slow=args.slow,
	)


def selected_scenarios(only: str, skipped: str) -> List[Tuple[str, Any]]:
	chosen = [(name, function) for name, function in SCENARIOS]
	if only:
		wanted = [item.strip() for item in only.split(',') if item.strip()]
		unknown = [name for name in wanted if name not in [candidate for candidate, _ in SCENARIOS]]
		if unknown:
			raise SystemExit('未知场景：' + ', '.join(unknown))
		chosen = [item for item in chosen if item[0] in wanted]
	if skipped:
		dropped = [item.strip() for item in skipped.split(',') if item.strip()]
		chosen = [item for item in chosen if item[0] not in dropped]
	return chosen


def main(argv: Optional[List[str]] = None) -> int:
	if hasattr(sys.stdout, 'reconfigure'):
		sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]

	options = parse_args(argv)
	if not options.password:
		# stdout, not stderr: Windows consoles decode stderr as the OEM codepage and
		# turn this into mojibake, which looks like a failure.
		print('提示：未提供密码，login 及其后的场景会被跳过（只做未登录状态检查）。')

	probe = Probe(options)
	scenarios = selected_scenarios(options.only, options.skip)
	try:
		probe.start()
	except WebDriverException as error:
		print('浏览器启动失败：' + str(error)[:500])
		print('检查 Chrome/Edge 是否安装；首次运行需要联网下载 driver。')
		return 2

	try:
		for name, function in scenarios:
			with probe.scenario(name):
				function(probe)
	finally:
		for collect in (probe.finish,):
			try:
				collect()
			except Exception:
				pass
		md_path, json_path = probe.write_report()
		try:
			probe.close()
		except Exception:
			pass

	errors = len([issue for issue in dedupe(probe.issues) if issue['severity'] == 'error'])
	print('')
	print('报告：' + str(md_path))
	print('JSON：' + str(json_path))
	print('错误 ' + str(errors) + ' 个')
	return 1 if (options.fail_on_error and errors > 0) else 0


if __name__ == '__main__':
	sys.exit(main())
