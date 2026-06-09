/**
 * Text editor helpers for the chain clarification TUI.
 *
 * Pure functions for a minimal text editor: cursor movement,
 * word navigation, text insertion, and viewport rendering.
 * No dependencies on the ChainClarifyComponent class.
 */

export interface TextEditorState {
	buffer: string;
	cursor: number;
	viewportOffset: number;
}

export function createEditorState(initial = ""): TextEditorState {
	return { buffer: initial, cursor: initial.length, viewportOffset: 0 };
}

export function wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
	if (width <= 0) return { lines: [text], starts: [0] };
	const lines: string[] = [];
	const starts: number[] = [];
	let pos = 0;
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			starts.push(pos);
			pos++;
			continue;
		}
		let lineStart = 0;
		while (lineStart < paragraph.length) {
			const chunk = paragraph.slice(lineStart, lineStart + width);
			lines.push(chunk);
			starts.push(pos + lineStart);
			lineStart += chunk.length;
		}
		pos += paragraph.length + 1;
	}
	if (lines.length === 0) {
		lines.push("");
		starts.push(0);
	}
	return { lines, starts };
}

export function getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number } {
	let line = starts.length - 1;
	for (let i = 0; i < starts.length; i++) {
		if (starts[i]! > cursor) {
			line = i - 1;
			break;
		}
	}
	if (line < 0) line = 0;
	const col = cursor - (starts[line] ?? 0);
	return { line, col };
}

export function ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number {
	if (cursorLine < currentOffset) return cursorLine;
	if (cursorLine >= currentOffset + viewportHeight) return cursorLine - viewportHeight + 1;
	return currentOffset;
}

function isWordChar(ch: string): boolean {
	return /\w/.test(ch);
}

export function wordBackward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos > 0 && /\s/.test(buffer[pos - 1]!)) pos--;
	while (pos > 0 && isWordChar(buffer[pos - 1]!)) pos--;
	return pos;
}

export function wordForward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos < buffer.length && isWordChar(buffer[pos]!)) pos++;
	while (pos < buffer.length && /\s/.test(buffer[pos]!)) pos++;
	return pos;
}

function normalizeInsertText(data: string): string | null {
	// Strip ANSI escapes and control characters except newline/tab
	const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
	if (!cleaned) return null;
	return cleaned;
}

export function handleEditorInput(state: TextEditorState, data: string, textWidth: number): TextEditorState | null {
	const normalized = normalizeInsertText(data);
	if (normalized === null) return null;

	if (normalized === "\x7f" || normalized === "\b") {
		if (state.cursor === 0) return null;
		const newBuffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
		return { ...state, buffer: newBuffer, cursor: state.cursor - 1 };
	}

	if (normalized === "\x1b[D" || normalized === "\x1bOD") {
		return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : null;
	}
	if (normalized === "\x1b[C" || normalized === "\x1bOC") {
		return state.cursor < state.buffer.length ? { ...state, cursor: state.cursor + 1 } : null;
	}
	if (normalized === "\x1b[1;5D" || normalized === "\x1b[1;5C") {
		const wordFn = normalized.includes("5D") ? wordBackward : wordForward;
		const newCursor = wordFn(state.buffer, state.cursor);
		return newCursor !== state.cursor ? { ...state, cursor: newCursor } : null;
	}

	if (normalized === "\x1b[H") return { ...state, cursor: 0 };
	if (normalized === "\x1b[F") return { ...state, cursor: state.buffer.length };

	if (normalized === "\n" || normalized === "\r") {
		const newBuffer = state.buffer.slice(0, state.cursor) + "\n" + state.buffer.slice(state.cursor);
		return { ...state, buffer: newBuffer, cursor: state.cursor + 1 };
	}

	const newBuffer = state.buffer.slice(0, state.cursor) + normalized + state.buffer.slice(state.cursor);
	return { ...state, buffer: newBuffer, cursor: state.cursor + normalized.length };
}

export function renderWithCursor(text: string, cursorPos: number): string {
	const before = text.slice(0, cursorPos);
	const char = text[cursorPos] ?? " ";
	const after = text.slice(cursorPos + 1);
	return `${before}\x1b[7m${char}\x1b[0m${after}`;
}

export function renderEditor(state: TextEditorState, width: number, viewportHeight: number): string[] {
	const { lines, starts } = wrapText(state.buffer, width - 2);
	const { line: cursorLine, col: cursorCol } = getCursorDisplayPos(state.cursor, starts);
	state.viewportOffset = ensureCursorVisible(cursorLine, viewportHeight, state.viewportOffset);
	const rendered: string[] = [];
	for (let i = 0; i < viewportHeight; i++) {
		const lineIdx = state.viewportOffset + i;
		if (lineIdx >= lines.length) {
			rendered.push(" ".repeat(width - 2));
			continue;
		}
		const lineText = lines[lineIdx]!;
		if (lineIdx === cursorLine) {
			const displayLine = renderWithCursor(lineText.padEnd(width - 2), cursorCol);
			rendered.push(` ${displayLine} `);
		} else {
			rendered.push(` ${lineText.padEnd(width - 2)} `);
		}
	}
	return rendered;
}
