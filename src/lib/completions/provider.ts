import type * as Monaco from "monaco-editor";
import { getMonaco } from "@/lib/editor";

export interface CompletionContext {
  prefix: string;
  suffix: string;
  language: string;
  filePath: string;
  lineNumber: number;
  column: number;
}

export interface CompletionResult {
  text: string;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

type CompletionHandler = (
  context: CompletionContext,
) => Promise<CompletionResult[]>;

let completionHandler: CompletionHandler | null = null;
let disposable: Monaco.IDisposable | null = null;

/**
 * Register a completion handler that will be called when completions are requested.
 * The handler should return an array of completion results.
 */
export function setCompletionHandler(handler: CompletionHandler): void {
  completionHandler = handler;
}

/**
 * Register the inline completion provider with Monaco.
 * Call this once after Monaco is initialized.
 */
export function registerInlineCompletionProvider(): Monaco.IDisposable {
  const monaco = getMonaco();

  // Dispose existing provider if any
  disposable?.dispose();

  disposable = monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" }, // All languages
    {
      provideInlineCompletions: async (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        _context: Monaco.languages.InlineCompletionContext,
        token: Monaco.CancellationToken,
      ): Promise<Monaco.languages.InlineCompletions | null> => {
        if (!completionHandler) {
          return null;
        }

        // Check if cancelled
        if (token.isCancellationRequested) {
          return null;
        }

        // Extract context for completion
        const completionContext = extractCompletionContext(model, position);

        try {
          const results = await completionHandler(completionContext);

          if (token.isCancellationRequested || results.length === 0) {
            return null;
          }

          return {
            items: results.map((result) => ({
              insertText: result.text,
              range: new monaco.Range(
                result.range.startLineNumber,
                result.range.startColumn,
                result.range.endLineNumber,
                result.range.endColumn,
              ),
            })),
          };
        } catch (error) {
          console.error("Completion error:", error);
          return null;
        }
      },

      disposeInlineCompletions: () => {
        // Cleanup if needed
      },
    },
  );

  return disposable;
}

/**
 * Extract context for completion from the model and position.
 */
function extractCompletionContext(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): CompletionContext {
  const maxPrefixChars = 4000;
  const maxSuffixChars = 1000;

  // Get prefix (text before cursor)
  const prefixRange = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
  let prefix = model.getValueInRange(prefixRange);

  // Trim prefix if too long (keep end)
  if (prefix.length > maxPrefixChars) {
    prefix = prefix.slice(-maxPrefixChars);
  }

  // Get suffix (text after cursor)
  const lineCount = model.getLineCount();
  const lastLineLength = model.getLineLength(lineCount);
  const suffixRange = {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: lineCount,
    endColumn: lastLineLength + 1,
  };
  let suffix = model.getValueInRange(suffixRange);

  // Trim suffix if too long (keep start)
  if (suffix.length > maxSuffixChars) {
    suffix = suffix.slice(0, maxSuffixChars);
  }

  // Get file path from model URI
  const uri = model.uri;
  const filePath = uri.path || uri.toString();

  return {
    prefix,
    suffix,
    language: model.getLanguageId(),
    filePath,
    lineNumber: position.lineNumber,
    column: position.column,
  };
}

/**
 * Unregister the completion provider.
 */
export function unregisterCompletionProvider(): void {
  disposable?.dispose();
  disposable = null;
}
