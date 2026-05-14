use log::warn;

/// A budget entry specifying the maximum number of tools and token capacity for a model.
#[derive(Debug, Clone, Copy)]
pub struct ModelBudget {
    /// Maximum number of tools to include in the selection.
    pub max_tools: usize,
    /// Maximum token budget for tool descriptions and context.
    pub max_tokens: usize,
}

/// Default budget assigned to unrecognised model identifiers.
const DEFAULT_BUDGET: ModelBudget = ModelBudget {
    max_tools: 60,
    max_tokens: 8_000,
};

/// Declarative registry of per-model tool budgets.
///
/// Each entry maps a model identifier (matched as a case-sensitive prefix) to
/// the tool and token budget the model can reliably handle.  The array is
/// ordered most-specific-first so that sub-string collisions (e.g. `deepseek/`
/// vs `deepseek/deepseek-chat`) resolve in favour of the longer key.
///
/// To add support for a new model, insert a single line here — the lookup
/// logic in [`model_budget`] will pick it up automatically.
const MODEL_BUDGETS: &[(&str, ModelBudget)] = &[
    // ── Anthropic ──────────────────────────────────────────────────────
    (
        "anthropic/claude-sonnet-4",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "anthropic/claude-sonnet-3.5",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "anthropic/claude-opus-4",
        ModelBudget {
            max_tools: 250,
            max_tokens: 40_000,
        },
    ),
    (
        "anthropic/claude-opus-3.5",
        ModelBudget {
            max_tools: 250,
            max_tokens: 40_000,
        },
    ),
    (
        "anthropic/claude-haiku-3.5",
        ModelBudget {
            max_tools: 150,
            max_tokens: 20_000,
        },
    ),
    (
        "anthropic/",
        ModelBudget {
            max_tools: 200,
            max_tokens: 28_000,
        },
    ),
    // ── OpenAI ─────────────────────────────────────────────────────────
    (
        "openai/gpt-4o",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "openai/gpt-4-turbo",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "openai/gpt-4",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    (
        "openai/gpt-3.5-turbo",
        ModelBudget {
            max_tools: 120,
            max_tokens: 16_000,
        },
    ),
    (
        "openai/",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    // ── Google ─────────────────────────────────────────────────────────
    (
        "google/gemini-2.5-pro",
        ModelBudget {
            max_tools: 250,
            max_tokens: 48_000,
        },
    ),
    (
        "google/gemini-2.5-flash",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "google/gemini-2.0-flash",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "google/",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    // ── Meta / Llama ───────────────────────────────────────────────────
    (
        "meta/llama-3.1-405b",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "meta/llama-3.1-70b",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    (
        "meta/llama-3.1-8b",
        ModelBudget {
            max_tools: 120,
            max_tokens: 16_000,
        },
    ),
    (
        "meta/",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    // ── Mistral ────────────────────────────────────────────────────────
    (
        "mistral/mistral-large",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "mistral/",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    // ── DeepSeek ───────────────────────────────────────────────────────
    (
        "deepseek/deepseek-chat",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "deepseek/deepseek-reasoner",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "deepseek/deepseek-coder",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "deepseek/",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    // ── Kimi / Moonshot ────────────────────────────────────────────────
    (
        "moonshotai/kimi-k2.5",
        ModelBudget {
            max_tools: 250,
            max_tokens: 64_000,
        },
    ),
    (
        "moonshotai/",
        ModelBudget {
            max_tools: 200,
            max_tokens: 48_000,
        },
    ),
    // ── Amazon / AWS ───────────────────────────────────────────────────
    (
        "amazon/nova-pro",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    (
        "amazon/",
        ModelBudget {
            max_tools: 140,
            max_tokens: 20_000,
        },
    ),
    // ── Cohere ─────────────────────────────────────────────────────────
    (
        "cohere/command-r-plus",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "cohere/",
        ModelBudget {
            max_tools: 140,
            max_tokens: 20_000,
        },
    ),
    // ── xAI / Grok ─────────────────────────────────────────────────────
    (
        "xai/grok-3",
        ModelBudget {
            max_tools: 200,
            max_tokens: 32_000,
        },
    ),
    (
        "xai/",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    // ── AI21 Labs ──────────────────────────────────────────────────────
    (
        "ai21/jamba-1.5",
        ModelBudget {
            max_tools: 120,
            max_tokens: 16_000,
        },
    ),
    (
        "ai21/",
        ModelBudget {
            max_tools: 100,
            max_tokens: 12_000,
        },
    ),
    // ── Perplexity ─────────────────────────────────────────────────────
    (
        "perplexity/sonar-pro",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    (
        "perplexity/",
        ModelBudget {
            max_tools: 140,
            max_tokens: 20_000,
        },
    ),
    // ── Qwen / Alibaba ─────────────────────────────────────────────────
    (
        "qwen/qwen-2.5-72b",
        ModelBudget {
            max_tools: 180,
            max_tokens: 28_000,
        },
    ),
    (
        "qwen/",
        ModelBudget {
            max_tools: 160,
            max_tokens: 24_000,
        },
    ),
    // ── Microsoft ──────────────────────────────────────────────────────
    (
        "microsoft/phi-4",
        ModelBudget {
            max_tools: 120,
            max_tokens: 16_000,
        },
    ),
    (
        "microsoft/",
        ModelBudget {
            max_tools: 120,
            max_tokens: 16_000,
        },
    ),
];

/// Looks up the tool budget for a model ID by scanning the declarative
/// [`MODEL_BUDGETS`] registry.
///
/// The lookup uses prefix matching: the model ID is tested against each entry
/// in declaration order, and the **first** entry whose key is a prefix of the
/// model ID wins.  This means more-specific entries (e.g.
/// `"moonshotai/kimi-k2.5"`) must appear before generic prefix entries (e.g.
/// `"moonshotai/"`), which the array ordering guarantees.
///
/// Returns `None` when no entry matches.
fn lookup_model_budget(model_id: &str) -> Option<ModelBudget> {
    MODEL_BUDGETS
        .iter()
        .find(|(key, _)| model_id.starts_with(key))
        .map(|(_, budget)| *budget)
}

/// Returns the tool-and-token budget for the given model identifier.
///
/// The function first consults the declarative [`MODEL_BUDGETS`] registry.
/// If no match is found there, it falls back to a legacy if-else chain for
/// backward compatibility.  When both paths fail to identify the model a
/// warning is logged and the conservative [`DEFAULT_BUDGET`] is returned.
///
/// # Arguments
///
/// * `model_id` - Fully-qualified model identifier (e.g.
///   `"moonshotai/kimi-k2.5"`).
///
/// # Returns
///
/// A [`ModelBudget`] struct containing the maximum tool count and token
/// budget recommended for this model.
///
/// # Examples
///
///