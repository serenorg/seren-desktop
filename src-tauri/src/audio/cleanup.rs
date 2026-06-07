// ABOUTME: Shared text-cleanup prompt assembly for meeting notes and dictation.
// ABOUTME: One vocabulary-aware engine so notes and dictation never duplicate logic.

/// Build the clause asking the model to respect the user's custom vocabulary.
/// Returns an empty string when no usable terms are supplied.
pub fn vocabulary_clause(vocabulary: &[String]) -> String {
    let terms: Vec<&str> = vocabulary
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return String::new();
    }
    format!(
        "Preserve and correctly spell these domain terms when they occur: {}.",
        terms.join(", ")
    )
}

/// The cleanup directives reused by both notes generation and dictation cleanup.
/// This is the single shared engine the two consumers compose into their prompts.
pub fn cleanup_directives(vocabulary: &[String]) -> String {
    let mut directives = String::from(
        "Remove filler words and false starts, fix punctuation and capitalization, \
         and keep the speaker's meaning and wording intact. Do not invent content.",
    );
    let vocab = vocabulary_clause(vocabulary);
    if !vocab.is_empty() {
        directives.push(' ');
        directives.push_str(&vocab);
    }
    directives
}

/// Prompt to clean a single block of dictated text (raw -> polished).
pub fn build_cleanup_prompt(raw_text: &str, vocabulary: &[String]) -> String {
    format!(
        "{}\n\nReturn only the cleaned text with no preamble or commentary.\n\nText:\n{}",
        cleanup_directives(vocabulary),
        raw_text.trim()
    )
}

/// Prompt to transform a selection per a spoken instruction (edit-by-voice).
pub fn build_transform_prompt(
    selection: &str,
    instruction: &str,
    vocabulary: &[String],
) -> String {
    let vocab = vocabulary_clause(vocabulary);
    let vocab_line = if vocab.is_empty() {
        String::new()
    } else {
        format!("\n{}", vocab)
    };
    format!(
        "Apply this instruction to the selected text and return only the rewritten text \
         with no preamble or commentary.{}\n\nInstruction: {}\n\nSelected text:\n{}",
        vocab_line,
        instruction.trim(),
        selection.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_clause_filters_blank_terms() {
        let vocab = vec![
            "Affinity".to_string(),
            "  ".to_string(),
            "".to_string(),
            "SerenBucks".to_string(),
        ];
        let clause = vocabulary_clause(&vocab);
        assert!(clause.contains("Affinity"));
        assert!(clause.contains("SerenBucks"));
        // Blank entries must not leave dangling separators.
        assert!(!clause.contains(", ,"));
    }

    #[test]
    fn vocabulary_clause_is_empty_without_terms() {
        assert!(vocabulary_clause(&[]).is_empty());
        assert!(vocabulary_clause(&["   ".to_string()]).is_empty());
    }

    #[test]
    fn cleanup_directives_appends_vocabulary_when_present() {
        let plain = cleanup_directives(&[]);
        assert!(!plain.contains("domain terms"));
        let with_vocab = cleanup_directives(&["Glide".to_string()]);
        assert!(with_vocab.contains("Glide"));
        assert!(with_vocab.contains("domain terms"));
    }

    #[test]
    fn build_cleanup_prompt_embeds_text_and_directives() {
        let prompt = build_cleanup_prompt("um so like the thing", &["Kraken".to_string()]);
        assert!(prompt.contains("um so like the thing"));
        assert!(prompt.contains("Remove filler words"));
        assert!(prompt.contains("Kraken"));
    }

    #[test]
    fn build_transform_prompt_embeds_instruction_and_selection() {
        let prompt = build_transform_prompt("first second third", "make this a bullet list", &[]);
        assert!(prompt.contains("make this a bullet list"));
        assert!(prompt.contains("first second third"));
    }
}
