"""Render Read / Write / Edit tool cards in a real conversation and screenshot them.

The cards are what the chat shows while an agent works, so the only honest check
is a real agent doing the real tools. This drives the UI the way a user does
(one prompt, three steps), then saves one screenshot per card plus a small index
so the result can be looked at instead of described.

    python e2e/card_render_demo.py --headed

Output goes to ``reports/card-render-demo/<timestamp>/``: ``index.md`` and the
PNGs it links. The conversation itself is created in the ``agent-ui`` project
and the only file it writes is ``reports/card-demo.txt`` (git-ignored).
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_FILE = 'reports/card-demo.txt'
CARDS_JS = """
	const cards = [...document.querySelectorAll('.chat-list .tool-card')];
	return cards.map((card, index) => {
		const text = selector => {
			const node = card.querySelector(selector);
			return node ? (node.textContent || '').replace(/\\u00a0/g, ' ').trim() : '';
		};
		return {
			index,
			name: text('.tool-name'),
			classes: card.className,
			file: text('.tool-file'),
			hasRawJson: Boolean(card.querySelector('.tool-input')),
			added: card.querySelectorAll('.diff-line.add').length,
			removed: card.querySelectorAll('.diff-line.remove').length,
			readLines: card.querySelectorAll('.read-line').length,
			open: card.hasAttribute('open'),
		};
	});
"""


def main(argv=None):
	parser = argparse.ArgumentParser(description='给 Read / Write / Edit 的卡片渲染截图。')
	parser.add_argument('--headed', action='store_true', help='显示浏览器窗口')
	parser.add_argument('--port', type=int, default=4794)
	parser.add_argument('--password', default='probe-pass-1', help='probe 账号的密码')
	parser.add_argument('--out', default='reports/card-render-demo')
	args = parser.parse_args(argv)

	base = 'http://127.0.0.1:' + str(args.port)
	out_dir = os.path.join(ROOT, args.out, time.strftime('%Y%m%d-%H%M%S'))
	os.makedirs(out_dir, exist_ok=True)

	# The demo writes this file; starting from scratch keeps the Write step from
	# failing with "file has not been read yet".
	stale = os.path.join(ROOT, DEMO_FILE)
	if os.path.exists(stale):
		os.remove(stale)

	env = dict(os.environ)
	env['AGENT_UI_PORT'] = str(args.port)
	env['AGENT_UI_HOST'] = '127.0.0.1'
	env['AGENT_UI_ADMIN_USER'] = 'probe'
	env['AGENT_UI_ADMIN_PASSWORD'] = args.password

	server = subprocess.Popen(['node', 'dist/server/index.js'], cwd=ROOT, env=env,
	                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	driver = None
	cards = []
	try:
		for _ in range(120):
			try:
				with urllib.request.urlopen(base + '/api/health', timeout=1) as response:
					if response.status == 200:
						break
			except Exception:
				time.sleep(0.25)
		else:
			raise SystemExit('server did not start')

		options = webdriver.ChromeOptions()
		if not args.headed:
			options.add_argument('--headless=new')
		options.add_argument('--window-size=1440,1000')
		driver = webdriver.Chrome(options=options)
		wait = WebDriverWait(driver, 30)

		driver.get(base)
		wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '#auth-username'))
		driver.find_element(By.CSS_SELECTOR, '#auth-username').send_keys('probe')
		driver.find_element(By.CSS_SELECTOR, '#auth-password').send_keys(args.password)
		driver.find_element(By.CSS_SELECTOR, '.auth-card button[type="submit"], .auth-submit').click()
		wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '.session-row'))

		for button in driver.find_elements(By.CSS_SELECTOR, '.session-rail button'):
			if '新建会话' in (button.text or ''):
				driver.execute_script('arguments[0].click()', button)
				break
		wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '.modal .modal-item'))
		project = None
		for item in driver.find_elements(By.CSS_SELECTOR, '.modal .modal-item:not(.dir)'):
			if 'agent-ui' in (item.text or ''):
				project = item
				break
		if project is None:
			raise SystemExit('新建会话对话框里没有 agent-ui 项目')
		driver.execute_script('arguments[0].click()', project)
		wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '.chat-composer textarea'))
		time.sleep(1.5)

		prompt = (
			'请严格按三步执行，不要跳步：'
			'一、用 Read 读 package.json 的前 5 行；'
			'二、用 Write 创建 ' + DEMO_FILE + '，内容三行：alpha、beta、gamma；'
			'三、用 Edit 把该文件里的 beta 改成 beta-changed，其它不动。'
			'完成后一句话总结。'
		)
		# A JS setter, not send_keys: a literal newline is the send shortcut and
		# would split the prompt into several messages.
		driver.execute_script("""
			const element = document.querySelector('.chat-composer textarea');
			const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
			setter.call(element, arguments[0]);
			element.dispatchEvent(new Event('input', { bubbles: true }));
		""", prompt)
		time.sleep(0.3)
		for button in driver.find_elements(By.CSS_SELECTOR, '.composer-actions .primary'):
			driver.execute_script('arguments[0].click()', button)
			break

		deadline = time.time() + 180
		while time.time() < deadline:
			names = driver.execute_script("""
				return [...document.querySelectorAll('.chat-list .tool-card .tool-name')]
					.map(node => node.textContent.trim());
			""") or []
			if {'Read', 'Write', 'Edit'}.issubset(set(names)):
				break
			time.sleep(1)
		time.sleep(3)

		cards = driver.execute_script(CARDS_JS) or []
		driver.save_screenshot(os.path.join(out_dir, '00-conversation.png'))

		elements = driver.find_elements(By.CSS_SELECTOR, '.chat-list .tool-card')
		for card in cards:
			index = card['index']
			if index >= len(elements):
				continue
			try:
				driver.execute_script('arguments[0].scrollIntoView({block: "center"});', elements[index])
				time.sleep(0.3)
				elements[index].screenshot(os.path.join(out_dir, '01-' + str(index) + '-' + card['name'] + '.png'))
			except Exception as error:
				print('卡片 ' + str(index) + ' 截图失败：' + str(error))

		# Reads start closed; open the first one to show the line column too.
		opened = False
		for index, card in enumerate(cards):
			if card['name'] == 'Read' and not card['open'] and index < len(elements):
				try:
					driver.execute_script('arguments[0].open = true;', elements[index])
					time.sleep(0.5)
					elements[index].screenshot(os.path.join(out_dir, '02-' + str(index) + '-Read-open.png'))
					opened = True
				except Exception as error:
					print('展开 Read 失败：' + str(error))
		if opened:
			driver.save_screenshot(os.path.join(out_dir, '03-read-expanded.png'))
	finally:
		if driver is not None:
			driver.quit()
		server.terminate()
		try:
			server.wait(timeout=10)
		except Exception:
			server.kill()
		if os.path.exists(stale):
			os.remove(stale)

	index_lines = ['# 工具卡片渲染', '', '| # | 工具 | 样式 | 文件 | 原始 JSON | + | − | Read 行 | 默认展开 |',
	               '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
	for card in cards:
		index_lines.append('| {index} | {name} | {classes} | {file} | {json} | {added} | {removed} | {read} | {open} |'.format(
			index=card['index'], name=card['name'], classes=card['classes'], file=card['file'],
			json='有' if card['hasRawJson'] else '无', added=card['added'], removed=card['removed'],
			read=card['readLines'], open='是' if card['open'] else '否'))
	index_lines.append('')
	index_lines.append('截图按 序号-工具.png 命名；`00-conversation.png` 是整页，`02-*` 是展开后的 Read。')
	with open(os.path.join(out_dir, 'index.md'), 'w', encoding='utf-8') as handle:
		handle.write('\n'.join(index_lines) + '\n')

	with open(os.path.join(out_dir, 'cards.json'), 'w', encoding='utf-8') as handle:
		json.dump(cards, handle, ensure_ascii=False, indent=2)
	# ASCII on purpose: Windows consoles decode stdout as the OEM codepage.
	print('report: ' + os.path.join(out_dir, 'index.md'))


if __name__ == '__main__':
	main()
