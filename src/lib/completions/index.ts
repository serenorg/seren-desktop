// Completion provider

// Language filtering
export {
  disableLanguage,
  enableLanguage,
  getCustomSettings,
  getDefaultCodeLanguages,
  getDefaultDisabledLanguages,
  isLanguageEnabled,
  resetLanguage,
  setCustomSettings,
} from "./filter";
export {
  type CompletionContext,
  type CompletionResult,
  registerInlineCompletionProvider,
  setCompletionHandler,
  unregisterCompletionProvider,
} from "./provider";
// Completion service (debouncing + caching)
export {
  clearCache,
  getDebounceDelay,
  initCompletionService,
  isCompletionsEnabled,
  setApiHandler,
  setCompletionsEnabled,
  setDebounceDelay,
} from "./service";
