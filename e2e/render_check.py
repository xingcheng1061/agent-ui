"""Renderer check for agent-ui: markdown, KaTeX and mermaid.

Serves a throwaway bundle of `web/__render_probe.html` from memory (no dev
server has to survive the tool call) and drives it with Selenium/Chrome.

    npx vite build --config e2e/render_probe.vite.config.ts
    python e2e/render_check.py --dist <build dir>
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import socket
import sys
import threading
import time
from typing import Any, Callable, List, Tuple

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return int(sock.getsockname()[1])


class SilentHandler(http.server.SimpleHTTPRequestHandler):
    """One-line-per-file logging would bury the assertions."""

    def log_message(self, *args: Any) -> None:
        pass


def serve(directory: str) -> Tuple[http.server.ThreadingHTTPServer, str]:
    port = free_port()
    handler = functools.partial(SilentHandler, directory=directory)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, 'http://127.0.0.1:' + str(port) + '/__render_probe.html'


def build_driver(headless: bool) -> webdriver.Chrome:
    options = Options()
    if headless:
        options.add_argument('--headless=new')
    options.add_argument('--window-size=1280,1000')
    options.add_argument('--hide-scrollbars')
    options.add_argument('--disable-gpu')
    options.add_argument('--no-sandbox')
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    return webdriver.Chrome(options=options)


class Checker:
    def __init__(self, driver: webdriver.Chrome) -> None:
        self.driver = driver
        self.results: List[Tuple[str, bool, str]] = []

    def check(self, name: str, ok: bool, detail: str = '') -> None:
        self.results.append((name, bool(ok), detail))
        print(('  PASS  ' if ok else '  FAIL  ') + name + ('' if not detail else '  — ' + detail), flush=True)

    def count(self, selector: str) -> int:
        return len(self.driver.find_elements(By.CSS_SELECTOR, selector))

    def text(self, selector: str) -> str:
        elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
        return elements[0].text if elements else ''

    def text_content(self, selector: str) -> str:
        """`innerText` skips nodes Selenium considers unrendered; this does not."""
        return str(self.js(
            "const node = document.querySelector(arguments[0]);"
            "return node ? node.textContent : '';", selector) or '')

    def js(self, script: str, *args: Any) -> Any:
        return self.driver.execute_script(script, *args)


def assert_markdown(check: Checker, scope: str, label: str) -> None:
    check.check(label + ' 标题 <h1>', check.text(scope + ' h1') == '渲染探针', check.text(scope + ' h1'))
    # streamdown renders emphasis as `<span data-streamdown="strong">`, and the
    # weight has to come from this app's CSS (there is no Tailwind build).
    weight = check.js(
        "const node = document.querySelector(arguments[0] + \" [data-streamdown='strong']\");"
        "return node ? getComputedStyle(node).fontWeight : '';", scope)
    check.check(label + ' 粗体已加粗', str(weight) in ('600', '700', 'bold'), 'font-weight=' + str(weight))
    check.check(label + ' 行内代码', check.count(scope + ' code') >= 1)
    check.check(label + ' 列表项 = 2', check.count(scope + ' li') == 2, str(check.count(scope + ' li')))
    check.check(label + ' 表格行 = 1', check.count(scope + ' tbody tr') == 1, str(check.count(scope + ' tbody tr')))
    check.check(label + ' 链接 target=_blank',
                check.js("const a = document.querySelector(arguments[0] + ' a'); return a ? a.target : '';", scope) == '_blank')
    fenced = check.js(
        "const code = document.querySelector(arguments[0] + ' pre code');"
        "return code ? code.textContent : '';", scope)
    check.check(label + ' 代码块内容', 'const answer = 42' in str(fenced), str(fenced)[:40].replace('\n', ' '))


def assert_math(check: Checker, scope: str, label: str) -> None:
    display = check.count(scope + ' .katex-display')
    inline = check.count(scope + ' .katex')
    check.check(label + ' 块级公式 .katex-display', display >= 1, 'count=' + str(display))
    check.check(label + ' 行内公式 .katex', inline >= 2, 'count=' + str(inline))
    # `text_content`, not `text`: innerText drops whatever the app shell's
    # clipped containers hide, which has nothing to do with the renderer.
    body = check.text_content(scope)
    check.check(label + ' $HOME 未被当成公式', '$HOME' in body, 'len=' + str(len(body)))
    check.check(label + ' $5 未被当成公式', '$5' in body)
    # KaTeX keeps the TeX source in a hidden MathML annotation, so the formulas
    # have to be dropped before asking whether raw TeX leaked into the text.
    plain = str(check.js(
        "const scope = document.querySelector(arguments[0]);"
        "if (!scope) { return ''; }"
        "const copy = scope.cloneNode(true);"
        "copy.querySelectorAll('.katex').forEach(node => node.remove());"
        "return copy.textContent;", scope) or '')
    check.check(label + ' 公式里没有裸露的命令', '\\int' not in plain, plain[:50].replace('\n', ' '))
    # Documented limitation: only `$$…$$` is a delimiter. `\(…\)` / `\[…\]`
    # arrive as escaped literal text, and must not add KaTeX nodes.
    check.check(label + ' \\( \\) 与 \\[ \\] 保持字面', '(x^2)' in body and '[x^2]' in body,
                'katex=' + str(check.count(scope + ' .katex')))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', required=True)
    parser.add_argument('--headed', action='store_true')
    parser.add_argument('--screenshot', default='')
    parser.add_argument('--dump', action='store_true')
    args = parser.parse_args()

    httpd, url = serve(os.path.abspath(args.dist))
    driver = build_driver(headless=not args.headed)
    started = time.time()
    try:
        print('[render] ' + url, flush=True)
        driver.get(url)
        WebDriverWait(driver, 120).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "#probe-preview [data-streamdown='mermaid'] svg"))
        )
        # Let the second (broken) diagram settle into its fallback.
        time.sleep(2.0)

        check = Checker(driver)
        if args.dump:
            for scope in ('#probe-chat', '#probe-preview'):
                print('\n[html] ' + scope + '\n' + str(check.js(
                    "const node = document.querySelector(arguments[0]);"
                    "if (!node) { return 'missing'; }"
                    "return (node.querySelector('p') ? node.querySelector('p').outerHTML : node.innerHTML).slice(0, 1200);",
                    scope)), flush=True)
            print('\n[html] mermaid-error\n' + str(check.js(
                "const node = document.querySelector('#probe-preview .mermaid-error');"
                "return node ? node.outerHTML.slice(0, 600) : 'missing';")), flush=True)

        print('\n== 聊天框（ChatPanel 用法：无 mermaid 插件）', flush=True)
        assert_markdown(check, '#probe-chat', '聊天框')
        assert_math(check, '#probe-chat', '聊天框')
        check.check('聊天框 mermaid 围栏保持代码块',
                    check.count("#probe-chat [data-streamdown='mermaid']") == 0
                    and 'flowchart LR' in check.text('#probe-chat'))

        print('\n== .md 预览（mermaid + 无控件）', flush=True)
        assert_markdown(check, '#probe-preview', '预览')
        assert_math(check, '#probe-preview', '预览')
        diagrams = check.count("#probe-preview [data-streamdown='mermaid'] svg")
        nodes = check.count("#probe-preview [data-streamdown='mermaid'] svg g.node")
        edges = check.count("#probe-preview [data-streamdown='mermaid'] svg path")
        check.check('mermaid svg 已渲染', diagrams == 1, 'svg=' + str(diagrams))
        check.check('flowchart 节点 >= 4', nodes >= 4, 'g.node=' + str(nodes))
        check.check('flowchart 连线存在', edges >= 2, 'path=' + str(edges))
        box = check.js(
            "const svg = document.querySelector(\"#probe-preview [data-streamdown='mermaid'] svg\");"
            "if (!svg) { return null; }"
            "const r = svg.getBoundingClientRect();"
            "return { width: Math.round(r.width), height: Math.round(r.height) };")
        check.check('svg 有实际尺寸', bool(box) and box['width'] > 50 and box['height'] > 20, json.dumps(box))
        fill = check.js(
            "const node = document.querySelector(\"#probe-preview [data-streamdown='mermaid'] svg g.node rect\");"
            "return node ? (node.getAttribute('style') || '') + ' | fill=' + (node.getAttribute('fill') || '') : 'none';")
        check.check('节点填充非空白', 'none' not in str(fill) and 'ffffff' not in str(fill).lower(), str(fill)[:90])
        theme_attr = check.js("return document.documentElement.dataset.theme")
        check.check('暗色主题生效', theme_attr == 'dark', str(theme_attr))
        errors = check.count('#probe-preview .mermaid-error')
        check.check('坏图降级为源码块', errors == 1, 'mermaid-error=' + str(errors))
        fallback = check.text_content('#probe-preview .mermaid-error')
        check.check('坏图显示了错误原因', 'Parse error' in fallback, fallback[:60].replace('\n', ' '))
        check.check('坏图显示了原始代码', 'flowchart LR' in fallback,
                    fallback[-40:].replace('\n', ' '))

        print('\n== 控制台', flush=True)
        noise = ('Download the React DevTools', 'favicon', 'DevTools')
        console = [entry for entry in driver.get_log('browser')
                   if entry['level'] in ('SEVERE', 'WARNING')
                   and not any(token in entry['message'] for token in noise)]
        check.check('无 SEVERE/WARNING 控制台消息', not console,
                    ' | '.join(entry['message'][:120] for entry in console[:3]))

        if args.screenshot:
            height = int(check.js('return document.documentElement.scrollHeight') or 1000)
            driver.execute_cdp_cmd('Emulation.setDeviceMetricsOverride', {
                'width': 1280, 'height': min(max(height, 800), 5000), 'deviceScaleFactor': 1, 'mobile': False,
            })
            time.sleep(0.4)
            driver.save_screenshot(args.screenshot)
            driver.execute_cdp_cmd('Emulation.clearDeviceMetricsOverride', {})
            print('\n[screenshot] ' + args.screenshot, flush=True)

        failed = [name for name, ok, _ in check.results if not ok]
        print('\n' + str(len(check.results) - len(failed)) + '/' + str(len(check.results))
              + ' 通过，用时 ' + str(round(time.time() - started, 1)) + 's', flush=True)
        if failed:
            print('失败：' + ', '.join(failed), flush=True)
        return 1 if failed else 0
    finally:
        driver.quit()
        httpd.shutdown()


if __name__ == '__main__':
    sys.exit(main())
