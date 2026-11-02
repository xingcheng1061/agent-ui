/**
 * Throwaway harness for the renderer: mounts the real `Markdown` component in
 * both shapes the app uses and lets `e2e/render_check.py` assert on the DOM.
 *
 * `#probe-chat`    — exactly what ChatPanel renders (no mermaid plugin).
 * `#probe-preview` — exactly what the `.md` preview renders (mermaid, no chrome).
 */
import { createRoot } from 'react-dom/client';
import { Markdown } from './components/Markdown';
import './styles.css';

const BLOCK = [
	'# 渲染探针',
	'',
	'段落里有 **粗体**、*斜体*、`inline code`、[链接](https://example.com) 和 ~~删除线~~。',
	'',
	'- 列表一',
	'- 列表二',
	'',
	'| 列 A | 列 B |',
	'| --- | --- |',
	'| 1 | 2 |',
	'',
	'```ts',
	'const answer = 42;',
	'```',
	'',
	'$$',
	'\\int_0^1 x^2 \\, dx = \\tfrac{1}{3}',
	'$$',
	'',
	'行内公式 $$E = mc^2$$，另有 shell 变量 $HOME 与价格 $5 不应被当成公式。',
	'',
	'行内 \\(x^2\\) 与块级 \\[x^2\\] 保持字面（LaTeX 定界符暂不支持）。',
	'',
	'```mermaid',
	'flowchart LR',
	'  A[开始] --> B{判断}',
	'  B -->|是| C[完成]',
	'  B -->|否| D[重试]',
	'  D --> B',
	'```',
].join('\n');

/** Unparseable on purpose: the preview has to degrade to a readable block. */
const BROKEN = ['```mermaid', 'flowchart LR', '  X --> ', '```'].join('\n');

createRoot(document.getElementById('probe-root')!).render(
	<div className="probe">
		<section id="probe-chat" className="msg assistant rich">
			<Markdown text={BLOCK} />
		</section>
		<section id="probe-preview" className="markdown-preview">
			<Markdown text={`${BLOCK}\n\n${BROKEN}`} mermaid controls={false} />
		</section>
	</div>,
);
