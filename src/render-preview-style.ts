export const debugPreviewStyles = `
:root {
  color-scheme: light;
  --bg: #eef4fb;
  --panel: #ffffff;
  --ink: #0f172a;
  --muted: #475569;
  --line: #dbeafe;
  --accent: #1d4ed8;
  --accent-soft: #eff6ff;
  --user: #93c5fd;
  --assistant: #86efac;
  --tool: #cbd5e1;
  --system: #fcd34d;
  --neutral: #dbeafe;
  --json-key: rgb(17, 99, 41);
  --json-value: rgb(10, 48, 105);
  --json-punctuation: rgb(56, 58, 66);
  --json-boolean: rgb(10, 48, 105);
  --json-null: rgb(86, 95, 108);
  --xml-tag: rgb(31, 111, 235);
  --xml-attr: rgb(17, 99, 41);
  --xml-value: rgb(10, 48, 105);
}

@media (prefers-color-scheme: dark) {
  :root {
    --panel: #111827;
    --ink: #e5e7eb;
    --line: #243244;
    --accent-soft: #162033;
    --json-key: rgb(126, 231, 135);
    --json-value: rgb(165, 214, 255);
    --json-punctuation: rgb(212, 212, 212);
    --json-boolean: rgb(165, 214, 255);
    --json-null: rgb(156, 163, 175);
    --xml-tag: rgb(125, 211, 252);
    --xml-attr: rgb(126, 231, 135);
    --xml-value: rgb(165, 214, 255);
  }
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  padding: 24px;
  background: radial-gradient(circle at 10% -20%, #ecfeff 0%, #eff6ff 42%, #f8fafc 100%);
  font-family: "Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  color: var(--ink);
}

#debug-preview-root {
  width: 980px;
  margin: 0 auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
  overflow: hidden;
}

.header {
  padding: 18px 22px;
  background: #dbeafe;
  color: #1e3a5f;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 6px;
  font-weight: 700;
}

.title {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.1;
}

.title-sub {
  font-size: 20px;
  font-weight: 600;
  opacity: 0.9;
  margin-left: 4px;
}

.meta {
  font-size: 13px;
  opacity: 0.95;
  text-align: right;
  line-height: 1.5;
  max-width: 420px;
  word-break: break-word;
}

.content {
  padding: 0 0 20px;
}

.outline {
  margin: 0 22px;
  padding: 18px 0 12px;
  border-bottom: 1px solid #e2e8f0;
}

.outline-list {
  display: grid;
  gap: 2px;
}

.outline-item {
  margin: 0;
}

.outline-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  padding-left: calc((var(--outline-level, 1) - 1) * 18px);
  color: #1e40af;
  text-decoration: none;
  font-size: 13px;
  line-height: 1.5;
}

.outline-link:hover {
  color: #1d4ed8;
  text-decoration: underline;
}

.outline-link::before {
  content: "#";
  color: #93c5fd;
  font-weight: 700;
}

.section-block {
  margin: 0 22px;
  padding-top: 18px;
}

.section-block + .section-block {
  border-top: 1px solid #e2e8f0;
}

h1, h2, h3 {
  margin: 0;
  line-height: 1.25;
}

h1 {
  font-size: 28px;
  padding: 18px 22px 6px;
}

h2 {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 12px;
}

h3 {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 10px;
}

p, li {
  font-size: 13px;
  line-height: 1.65;
  color: #1e293b;
  word-break: break-word;
}

.text-block {
  margin: 0 0 18px;
}

.rich-inline-block {
  display: block;
}

.subsection-title {
  margin: 0 0 12px;
  color: #1e40af;
}

.subsection-block {
  margin: 0 0 18px;
}

.message-card {
  margin: 0 0 18px;
}

.message-card summary {
  list-style: none;
}

.message-card summary::-webkit-details-marker {
  display: none;
}

.role-user {
  color: #1d4ed8;
}

.role-assistant {
  color: #15803d;
}

.role-tool {
  color: #475569;
}

.role-system {
  color: #b45309;
}

.role-block,
.json-block,
.xml-block {
  margin: 0 0 18px;
  padding: 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  background: #f8fafc;
}

.message-card .role-block,
.message-card .json-block,
.message-card .xml-block {
  margin: 0;
}

.message-card.role-user .role-block {
  border-color: var(--user);
  background: #f6fbff;
}

.message-card.role-assistant .role-block {
  border-color: var(--assistant);
  background: #f3fff6;
}

.message-card.role-tool .role-block {
  border-color: var(--tool);
  background: #f8fafc;
}

.message-card.role-system .role-block {
  border-color: var(--system);
  background: #fffdf3;
}

.message-card.role-system .xml-block {
  border-color: var(--system);
  background: #fffdf3;
}

.system-prompt-details {
  border: 1px solid #fed7aa;
  border-radius: 14px;
  background: #fffdf3;
  overflow: hidden;
}

.system-prompt-summary {
  cursor: pointer;
  padding: 12px 14px;
  background: rgba(251, 191, 36, 0.08);
}

.system-prompt-summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.system-prompt-summary-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  color: #b45309;
  transition: transform 0.2s ease;
}

.system-prompt-details[open] .system-prompt-summary-arrow {
  transform: rotate(90deg);
}

.system-prompt-summary-title {
  font-size: 12px;
  font-weight: 700;
  color: #92400e;
}

.system-prompt-preview {
  margin: 0;
  padding: 10px 12px;
  border: 1px dashed #fcd34d;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.system-prompt-details[open] .system-prompt-preview {
  display: none;
}

.system-prompt-hidden-note {
  margin-top: 6px;
  padding-left: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: #94a3b8;
  font-style: italic;
}

.system-prompt-details[open] .system-prompt-hidden-note {
  display: none;
}

.system-prompt-body {
  padding: 0 14px 14px;
}

.message-card.role-assistant .xml-block {
  border-color: var(--assistant);
  background: #f3fff6;
}

.json-block {
  border-color: var(--neutral);
  background: #f8fbff;
}

.xml-block {
  border-color: #bfdbfe;
  background: #f8fbff;
}

.message-card.role-tool .tool-meta-block {
  border-color: #1d4ed8;
  background: #eff6ff;
}

.message-card.role-tool .tool-result-block {
  border-color: #94a3b8;
  background: #f8fafc;
}

.rich-content-block {
  white-space: normal;
  font-family: "Cascadia Code", "JetBrains Mono", "Consolas", "SFMono-Regular", monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #1e293b;
}

.rich-content-fragment {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
}

.chat-image-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 136px;
  height: 136px;
  margin: 6px 8px 6px 0;
  vertical-align: top;
  overflow: hidden;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4);
}

.chat-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

pre,
code {
  font-family: "Cascadia Code", "JetBrains Mono", "Consolas", "SFMono-Regular", monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #1e293b;
}

.inline-code {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: #1e3a8a;
  font-size: 12px;
}

.metadata-panel {
  margin: 0 0 18px;
  padding: 14px 16px;
  border: 1px solid #dbeafe;
  border-radius: 14px;
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
}

.xml-line,
.xml-field {
  font-family: "Cascadia Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.7;
}

.xml-line {
  color: #2563eb;
}

.xml-body {
  margin-left: 18px;
  padding-left: 14px;
  border-left: 2px solid #dbeafe;
}

.xml-field {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.xml-field + .xml-field {
  margin-top: 2px;
}

.xml-tag {
  color: #2563eb;
  white-space: nowrap;
}

.xml-value {
  color: #0f172a;
  word-break: break-word;
}

.json-details {
  margin-top: 12px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #ffffff;
  overflow: hidden;
}

.json-details > summary {
  cursor: pointer;
  list-style: none;
  padding: 10px 12px;
  font-family: "Cascadia Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #334155;
  background: #eff6ff;
}

.json-details > summary::-webkit-details-marker {
  display: none;
}

.json-details > summary::before {
  content: "▶";
  display: inline-block;
  margin-right: 8px;
  transition: transform 0.2s ease;
}

.json-details[open] > summary::before {
  transform: rotate(90deg);
}

.json-details-body {
  padding: 12px;
  border-top: 1px solid #dbeafe;
}

.json-key {
  color: var(--json-key);
}

.json-string {
  color: var(--json-value);
}

.json-number {
  color: var(--json-value);
}

.json-boolean {
  color: var(--json-boolean);
}

.json-null {
  color: var(--json-null);
}

.json-punctuation {
  color: var(--json-punctuation);
}

.xml-tag-token,
.xml-angle,
.xml-slash {
  color: var(--xml-tag);
}

.xml-attr-name {
  color: var(--xml-attr);
}

.xml-attr-value {
  color: var(--xml-value);
}
`