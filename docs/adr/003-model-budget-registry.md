# Model budget registry — declarative model-to-resource mapping.
# Replaces ad-hoc if-else chains in tool relevance calculations with a
# maintainable, single-source-of-truth registry. Every model known to the
# provider layer MUST have a corresponding budget entry here.

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, Final

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelBudget:
    """Resource budget allocated to a model during tool relevance scoring.

    Attributes
    ----------
    max_tools:
        Maximum number of tools the model may receive in a single
        relevance pass.
    token_budget:
        Maximum number of context-window tokens the orchestrator should
        reserve for tool descriptions.
    """

    max_tools: int
    token_budget: int


_BUDGET_TABLE: Final[Dict[str, ModelBudget]] = {
    # ---- Anthropic -------------------------------------------------------
    "anthropic/claude-3-haiku": ModelBudget(max_tools=80, token_budget=12_000),
    "anthropic/claude-3-opus": ModelBudget(max_tools=120, token_budget=24_000),
    "anthropic/claude-3-sonnet": ModelBudget(max_tools=100, token_budget=18_000),
    "anthropic/claude-sonnet-4": ModelBudget(max_tools=120, token_budget=32_000),
    # ---- Google / Gemini -------------------------------------------------
    "google/gemini-1.5-flash": ModelBudget(max_tools=80, token_budget=16_000),
    "google/gemini-1.5-pro": ModelBudget(max_tools=100, token_budget=24_000),
    "google/gemini-2.0-flash": ModelBudget(max_tools=90, token_budget=20_000),
    # ---- Meta / Llama ----------------------------------------------------
    "meta/llama-3.1-70b": ModelBudget(max_tools=80, token_budget=12_000),
    "meta/llama-3.1-405b": ModelBudget(max_tools=90, token_budget=16_000),
    # ---- Mistral ---------------------------------------------------------
    "mistral/mistral-large-2": ModelBudget(max_tools=100, token_budget=20_000),
    "mistral/mistral-small": ModelBudget(max_tools=70, token_budget=10_000),
    # ---- Moonshot / Kimi -------------------------------------------------
    "moonshotai/kimi-k2.5": ModelBudget(max_tools=120, token_budget=64_000),
    # ---- OpenAI ----------------------------------------------------------
    "openai/gpt-4": ModelBudget(max_tools=80, token_budget=12_000),
    "openai/gpt-4-turbo": ModelBudget(max_tools=100, token_budget=20_000),
    "openai/gpt-4o": ModelBudget(max_tools=120, token_budget=32_000),
    "openai/gpt-4o-mini": ModelBudget(max_tools=80, token_budget=16_000),
    "openai/o1": ModelBudget(max_tools=120, token_budget=48_000),
    "openai/o1-mini": ModelBudget(max_tools=80, token_budget=24_000),
    "openai/o3": ModelBudget(max_tools=120, token_budget=64_000),
}

_DEFAULT_BUDGET: Final[ModelBudget] = ModelBudget(
    max_tools=60,
    token_budget=8_000,
)


def model_budget(model_id: str) -> ModelBudget:
    """Return the resource budget configured for *model_id*.

    Parameters
    ----------
    model_id:
        Fully-qualified model identifier, e.g.
        ``"anthropic/claude-sonnet-4"``.

    Returns
    -------
    ModelBudget
        The allocated budget, or the conservative default if the
        model is not found.
    """
    return _BUDGET_TABLE.get(model_id, _DEFAULT_BUDGET)