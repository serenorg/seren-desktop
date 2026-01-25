// Completion provider
export {
  registerInlineCompletionProvider,
  unregisterCompletionProvider,
  setCompletionHandler,
  type CompletionContext,
  type CompletionResult,
} from "./provider";

// Completion service (debouncing + caching)
export {
  initCompletionService,
  setApiHandler,
  setCompletionsEnabled,
  isCompletionsEnabled,
  setDebounceDelay,
  getDebounceDelay,
  clearCache,
} from "./service";

// Language filtering
export {
  isLanguageEnabled,
  enableLanguage,
  disableLanguage,
  resetLanguage,
  getCustomSettings,
  setCustomSettings,
  getDefaultCodeLanguages,
  getDefaultDisabledLanguages,
} from "./filter";
